use super::{
    database::LibraryDatabase,
    model::{
        LibraryError, LibraryErrorCode, LibraryResult, ScanJobId, ScanJobRecord, ScanJobState,
        ScanJobUpdate, SourceRootId, invalid_state_error,
    },
};

pub(crate) struct ScanQueue<'a> {
    database: &'a mut LibraryDatabase,
}

impl<'a> ScanQueue<'a> {
    pub(crate) fn new(database: &'a mut LibraryDatabase) -> Self {
        Self { database }
    }

    pub(crate) fn enqueue(
        &mut self,
        source_root_id: &SourceRootId,
    ) -> LibraryResult<ScanJobRecord> {
        if let Some(active) = self.database.active_scan_job(source_root_id)? {
            if active.state == ScanJobState::Paused {
                return self.resume(&active.id);
            }
            return Ok(active);
        }
        self.database.create_scan_job(source_root_id)
    }

    pub(crate) fn start(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[ScanJobState::Queued],
            ScanJobState::Running,
            false,
            None,
        )
    }

    pub(crate) fn resume(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[ScanJobState::Paused],
            ScanJobState::Queued,
            false,
            None,
        )
    }

    pub(crate) fn pause(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[ScanJobState::Queued, ScanJobState::Running],
            ScanJobState::Paused,
            false,
            None,
        )
    }

    pub(crate) fn cancel(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[
                ScanJobState::Queued,
                ScanJobState::Running,
                ScanJobState::Paused,
                ScanJobState::Failed,
            ],
            ScanJobState::Cancelled,
            false,
            Some("SCAN_CANCELLED"),
        )
    }

    pub(crate) fn retry(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        let job = self.current(job_id)?;
        if !matches!(job.state, ScanJobState::Failed | ScanJobState::Cancelled) {
            return Err(invalid_state_error(
                &[ScanJobState::Failed, ScanJobState::Cancelled],
                job.state,
            ));
        }
        self.database.update_job(ScanJobUpdate {
            id: job_id,
            state: ScanJobState::Queued,
            scanned_count: job.scanned_count,
            total_count: job.total_count,
            current_file_name: job.current_file_name.as_deref(),
            changed_count: job.changed_count,
            failed_count: job.failed_count,
            retry_count: job.retry_count.saturating_add(1),
            error_code: None,
            started_at_ms: job.started_at_ms,
            completed_at_ms: None,
        })
    }

    pub(crate) fn current(&self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.database.job(job_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::ScanJobNotFound, "scan job was not found")
        })
    }

    fn transition(
        &mut self,
        job_id: &ScanJobId,
        expected: &[ScanJobState],
        next: ScanJobState,
        increment_retry: bool,
        error_code: Option<&str>,
    ) -> LibraryResult<ScanJobRecord> {
        let job = self.current(job_id)?;
        if !expected.contains(&job.state) {
            return Err(invalid_state_error(expected, job.state));
        }
        self.database.update_job(ScanJobUpdate {
            id: job_id,
            state: next,
            scanned_count: job.scanned_count,
            total_count: job.total_count,
            current_file_name: job.current_file_name.as_deref(),
            changed_count: job.changed_count,
            failed_count: job.failed_count,
            retry_count: if increment_retry {
                job.retry_count.saturating_add(1)
            } else {
                job.retry_count
            },
            error_code,
            started_at_ms: job.started_at_ms,
            completed_at_ms: (next == ScanJobState::Cancelled)
                .then_some(crate::library::model::now_unix_ms()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ScanQueue;
    use crate::library::{
        database::LibraryDatabase,
        model::{ScanJobState, SourceKind},
    };

    #[test]
    fn persists_pause_resume_cancel_and_retry_transitions() {
        let mut database = LibraryDatabase::in_memory().unwrap();
        let source = database
            .register_source(SourceKind::Directory, "C:/authorized", "authorized")
            .unwrap();
        let mut queue = ScanQueue::new(&mut database);
        let queued = queue.enqueue(&source.source.id).unwrap();
        assert_eq!(queued.state, ScanJobState::Queued);
        assert_eq!(queue.enqueue(&source.source.id).unwrap().id, queued.id);
        assert_eq!(queue.pause(&queued.id).unwrap().state, ScanJobState::Paused);
        assert_eq!(
            queue.resume(&queued.id).unwrap().state,
            ScanJobState::Queued
        );
        assert_eq!(
            queue.start(&queued.id).unwrap().state,
            ScanJobState::Running
        );
        assert_eq!(queue.pause(&queued.id).unwrap().state, ScanJobState::Paused);
        assert_eq!(
            queue.resume(&queued.id).unwrap().state,
            ScanJobState::Queued
        );
        assert_eq!(
            queue.start(&queued.id).unwrap().state,
            ScanJobState::Running
        );
        assert_eq!(
            queue.cancel(&queued.id).unwrap().state,
            ScanJobState::Cancelled
        );
        let retried = queue.retry(&queued.id).unwrap();
        assert_eq!(retried.state, ScanJobState::Queued);
        assert_eq!(retried.retry_count, 1);
    }

    #[test]
    fn rejects_invalid_transitions_with_structured_error() {
        let mut database = LibraryDatabase::in_memory().unwrap();
        let source = database
            .register_source(SourceKind::Directory, "C:/authorized", "authorized")
            .unwrap();
        let mut queue = ScanQueue::new(&mut database);
        let queued = queue.enqueue(&source.source.id).unwrap();
        let error = queue
            .resume(&queued.id)
            .expect_err("queued job cannot resume");
        assert_eq!(error.code, "INVALID_JOB_STATE");
    }

    #[test]
    fn enqueuing_a_paused_source_resumes_the_existing_job() {
        let mut database = LibraryDatabase::in_memory().unwrap();
        let source = database
            .register_source(SourceKind::Directory, "C:/authorized", "authorized")
            .unwrap();
        let mut queue = ScanQueue::new(&mut database);
        let queued = queue.enqueue(&source.source.id).unwrap();
        queue.pause(&queued.id).unwrap();

        let resumed = queue.enqueue(&source.source.id).unwrap();
        assert_eq!(resumed.id, queued.id);
        assert_eq!(resumed.state, ScanJobState::Queued);
    }
}
