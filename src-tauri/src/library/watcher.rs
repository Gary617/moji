use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::{
    model::{LibraryError, LibraryErrorCode, LibraryResult, SourceKind},
    policy::{AuthorizedSource, canonical_path_string},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WatchChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WatchChange {
    pub kind: WatchChangeKind,
    pub path: PathBuf,
}

pub(crate) struct LibraryWatcher {
    _watcher: RecommendedWatcher,
    receiver: Receiver<notify::Result<Event>>,
    source: AuthorizedSource,
}

impl LibraryWatcher {
    pub(crate) fn start(source: AuthorizedSource) -> LibraryResult<Self> {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = sender.send(event);
            },
            Config::default(),
        )
        .map_err(|_error| {
            LibraryError::new(
                LibraryErrorCode::WatcherUnavailable,
                "filesystem watcher could not start",
            )
            .retryable()
            .with_details(serde_json::json!({ "kind": "watcher_init" }))
        })?;
        watcher
            .watch(&source.canonical_path, RecursiveMode::Recursive)
            .map_err(|_error| {
                LibraryError::new(
                    LibraryErrorCode::WatcherUnavailable,
                    "authorized source could not be watched",
                )
                .retryable()
                .with_details(serde_json::json!({ "kind": "watcher_watch" }))
            })?;
        Ok(Self {
            _watcher: watcher,
            receiver,
            source,
        })
    }

    pub(crate) fn drain(&self) -> Vec<WatchChange> {
        let mut changes = Vec::new();
        while let Ok(result) = self.receiver.try_recv() {
            if let Ok(event) = result {
                changes.extend(normalize_event(&self.source, event));
            }
        }
        changes
    }
}

fn normalize_event(source: &AuthorizedSource, event: Event) -> Vec<WatchChange> {
    let kind = match event.kind {
        EventKind::Create(_) => WatchChangeKind::Created,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => WatchChangeKind::Renamed,
        EventKind::Modify(_) => WatchChangeKind::Modified,
        EventKind::Remove(_) => WatchChangeKind::Removed,
        _ => return Vec::new(),
    };
    event
        .paths
        .into_iter()
        .filter(|path| path_is_within(source, path))
        .map(|path| WatchChange { kind, path })
        .collect()
}

fn path_is_within(source: &AuthorizedSource, path: &Path) -> bool {
    let root = canonical_path_string(&source.canonical_path);
    let candidate = canonical_path_string(path);
    if source.kind == SourceKind::SingleFile {
        return candidate == root;
    }
    candidate == root || candidate.starts_with(&(root + "\\"))
}

#[cfg(test)]
mod tests {
    use notify::{
        Event, EventKind,
        event::{CreateKind, ModifyKind, RenameMode},
    };
    use std::path::PathBuf;

    use super::{WatchChangeKind, normalize_event};
    use crate::library::{model::SourceKind, policy::AuthorizedSource};

    #[test]
    fn normalizes_and_filters_notify_events_to_authorized_root() {
        let source = AuthorizedSource {
            kind: SourceKind::Directory,
            canonical_path: PathBuf::from("C:/authorized"),
            display_name: "authorized".to_owned(),
        };
        let event = Event::new(EventKind::Create(CreateKind::File))
            .add_path(PathBuf::from("C:/authorized/report.docx"))
            .add_path(PathBuf::from("C:/other/secret.docx"));
        let changes = normalize_event(&source, event);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, WatchChangeKind::Created);
        assert_eq!(changes[0].path, PathBuf::from("C:/authorized/report.docx"));
        let renamed = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(PathBuf::from("C:/authorized/renamed.docx"));
        assert_eq!(
            normalize_event(&source, renamed)[0].kind,
            WatchChangeKind::Renamed
        );
    }
}
