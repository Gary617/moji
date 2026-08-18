use super::{
    database::LibraryDatabase,
    model::{
        LibraryError, LibraryErrorCode, LibraryResult, ScanJobId, ScanJobRecord, ScanJobState,
        SourceRootId, invalid_state_error,
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
        self.database.create_scan_job(source_root_id)
    }

    pub(crate) fn start(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[ScanJobState::Queued, ScanJobState::Paused],
            ScanJobState::Running,
            false,
            None,
        )
    }

    pub(crate) fn pause(&mut self, job_id: &ScanJobId) -> LibraryResult<ScanJobRecord> {
        self.transition(
            job_id,
            &[ScanJobState::Running],
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
        self.database.update_job(
            job_id,
            ScanJobState::Queued,
            job.scanned_count,
            job.changed_count,
            job.failed_count,
            job.retry_count.saturating_add(1),
            None,
        )
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
        self.database.update_job(
            job_id,
            next,
            job.scanned_count,
            job.changed_count,
            job.failed_count,
            if increment_retry {
                job.retry_count.saturating_add(1)
            } else {
                job.retry_count
            },
            error_code,
        )
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
        assert_eq!(
            queue.start(&queued.id).unwrap().state,
            ScanJobState::Running
        );
        assert_eq!(queue.pause(&queued.id).unwrap().state, ScanJobState::Paused);
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
            .pause(&queued.id)
            .expect_err("queued job cannot pause");
        assert_eq!(error.code, "INVALID_JOB_STATE");
    }
}
