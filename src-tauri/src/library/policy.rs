use std::{
    fs,
    path::{Path, PathBuf},
};

use super::model::{DocumentFormat, LibraryError, LibraryErrorCode, LibraryResult, SourceKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthorizedSource {
    pub kind: SourceKind,
    pub canonical_path: PathBuf,
    pub display_name: String,
}

pub(crate) fn authorize_source(input: impl AsRef<Path>) -> LibraryResult<AuthorizedSource> {
    reject_reparse_path(input.as_ref())?;
    let canonical_path = canonicalize_existing(input.as_ref())?;
    let metadata = fs::symlink_metadata(&canonical_path).map_err(|error| {
        LibraryError::new(
            LibraryErrorCode::MetadataReadFailed,
            "source metadata could not be read",
        )
        .retryable()
        .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
    })?;
    if let Some(reason) = exclusion_reason(&canonical_path, &metadata) {
        // Windows marks volume roots (for example `D:\\`) as hidden/system.
        // The root itself is a valid user-selected source; protected folders
        // below it remain excluded by `exclusion_reason` during traversal.
        let volume_root_attributes =
            is_volume_root(&canonical_path) && matches!(reason, "hidden" | "system");
        if !volume_root_attributes {
            return Err(LibraryError::new(
                LibraryErrorCode::ExcludedPath,
                "this source is excluded by default",
            )
            .with_details(serde_json::json!({ "reason": reason })));
        }
    }
    let kind = if metadata.is_dir() {
        SourceKind::Directory
    } else if metadata.is_file() {
        SourceKind::SingleFile
    } else {
        return Err(LibraryError::new(
            LibraryErrorCode::InvalidArgument,
            "source must be a file or directory",
        ));
    };
    let display_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| source_display_name(&canonical_path));
    Ok(AuthorizedSource {
        kind,
        canonical_path,
        display_name,
    })
}

fn is_volume_root(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.components().count() <= 2
    }
    #[cfg(not(windows))]
    {
        path == Path::new("/")
    }
}

fn source_display_name(path: &Path) -> String {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        let mut chars = value.chars();
        if let (Some(letter), Some(':')) = (chars.next(), chars.next())
            && letter.is_ascii_alphabetic()
        {
            return format!("{letter}盘");
        }
    }
    "source".to_owned()
}

pub(crate) fn authorize_candidate(
    source: &AuthorizedSource,
    input: impl AsRef<Path>,
) -> LibraryResult<PathBuf> {
    reject_reparse_path(input.as_ref())?;
    let candidate = canonicalize_existing_or_absolute(input.as_ref())?;
    if !is_within(&source.canonical_path, &candidate, source.kind) {
        return Err(LibraryError::new(
            LibraryErrorCode::UnauthorizedPath,
            "path is outside the authorized source",
        ));
    }
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        LibraryError::new(
            LibraryErrorCode::MetadataReadFailed,
            "file metadata could not be read",
        )
        .retryable()
        .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
    })?;
    if let Some(reason) = exclusion_reason(&candidate, &metadata) {
        return Err(LibraryError::new(
            LibraryErrorCode::ExcludedPath,
            "path is excluded by default",
        )
        .with_details(serde_json::json!({ "reason": reason })));
    }
    Ok(candidate)
}

fn reject_reparse_path(path: &Path) -> LibraryResult<()> {
    // Check the user-supplied spelling before canonicalization. Checking only the resolved
    // path loses the evidence that a link/reparse point was used and leaves a TOCTOU gap.
    let mut current = Some(path);
    while let Some(item) = current {
        if let Ok(metadata) = fs::symlink_metadata(item)
            && let Some(reason) = exclusion_reason(item, &metadata)
            && (reason == "symlink" || reason == "junction_or_reparse_point")
        {
            return Err(LibraryError::new(
                LibraryErrorCode::ExcludedPath,
                "links and reparse points are excluded by default",
            )
            .with_details(serde_json::json!({ "reason": reason })));
        }
        current = item.parent();
    }
    Ok(())
}

pub(crate) fn canonical_path_string(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        value.trim_end_matches('\\').to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    value.trim_end_matches('/').to_owned()
}

pub(crate) fn format_from_path(path: &Path) -> Option<DocumentFormat> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "doc" => Some(DocumentFormat::Doc),
        "docx" => Some(DocumentFormat::Docx),
        "pptx" => Some(DocumentFormat::Pptx),
        "xlsx" => Some(DocumentFormat::Xlsx),
        "pdf" => Some(DocumentFormat::Pdf),
        "md" | "markdown" => Some(DocumentFormat::Markdown),
        "txt" => Some(DocumentFormat::Text),
        "csv" => Some(DocumentFormat::Csv),
        _ => None,
    }
}

pub(crate) fn exclusion_reason(path: &Path, metadata: &fs::Metadata) -> Option<&'static str> {
    if metadata.file_type().is_symlink() {
        return Some("symlink");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let attributes = metadata.file_attributes();
        if attributes & 0x400 != 0 {
            return Some("junction_or_reparse_point");
        }
        if attributes & 0x2 != 0 {
            return Some("hidden");
        }
        if attributes & 0x4 != 0 {
            return Some("system");
        }
    }
    for component in path.components() {
        let value = component.as_os_str().to_string_lossy();
        let lower = value.to_ascii_lowercase();
        if value.starts_with('.') && value.len() > 1 {
            return Some("hidden");
        }
        if matches!(
            lower.as_str(),
            "node_modules"
                | "$recycle.bin"
                | "recycler"
                | "system volume information"
                | "windows"
                | "program files"
                | "program files (x86)"
                | "programdata"
        ) {
            return Some("system_or_excluded_directory");
        }
    }
    None
}

fn canonicalize_existing(path: &Path) -> LibraryResult<PathBuf> {
    if !path.exists() {
        return Err(LibraryError::new(
            LibraryErrorCode::SourceNotFound,
            "source path does not exist",
        ));
    }
    fs::canonicalize(path).map_err(|error| {
        LibraryError::new(
            LibraryErrorCode::SourceNotFound,
            "source path could not be canonicalized",
        )
        .retryable()
        .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
    })
}

fn canonicalize_existing_or_absolute(path: &Path) -> LibraryResult<PathBuf> {
    if path.exists() {
        return canonicalize_existing(path);
    }
    std::path::absolute(path).map_err(|error| {
        LibraryError::new(
            LibraryErrorCode::SourceNotFound,
            "path could not be normalized",
        )
        .retryable()
        .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
    })
}

fn is_within(root: &Path, candidate: &Path, kind: SourceKind) -> bool {
    if kind == SourceKind::SingleFile {
        return paths_equal(root, candidate);
    }
    #[cfg(windows)]
    {
        let root = canonical_path_string(root);
        let candidate = canonical_path_string(candidate);
        candidate == root || candidate.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        candidate == root || candidate.starts_with(root)
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        canonical_path_string(left) == canonical_path_string(right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        authorize_candidate, authorize_source, canonical_path_string, exclusion_reason,
        format_from_path,
    };
    use crate::library::model::DocumentFormat;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "moji-indexer-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).expect("temp tree should be created");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn authorizes_directory_and_rejects_sibling_traversal() {
        let tree = TempTree::new();
        let source = authorize_source(&tree.0).expect("directory should be authorized");
        let nested = tree.0.join("nested.docx");
        fs::write(&nested, "doc").expect("file should be written");
        assert_eq!(
            authorize_candidate(&source, &nested).expect("nested file should be allowed"),
            fs::canonicalize(nested).unwrap()
        );
        let outside = tree.0.parent().unwrap().join(format!(
            "{}-outside.docx",
            tree.0.file_name().unwrap().to_string_lossy()
        ));
        fs::write(&outside, "doc").expect("outside file should be written");
        let error = authorize_candidate(&source, &outside).expect_err("sibling must be rejected");
        assert_eq!(error.code, "UNAUTHORIZED_PATH");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn rejects_excluded_directory_names_and_symlinks() {
        let tree = TempTree::new();
        let node_modules = tree.0.join("node_modules");
        fs::create_dir(&node_modules).expect("excluded dir should exist");
        let metadata = fs::symlink_metadata(&node_modules).unwrap();
        assert_eq!(
            exclusion_reason(&node_modules, &metadata),
            Some("system_or_excluded_directory")
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_file_symlink_before_canonicalization() {
        use std::os::windows::fs::symlink_file;
        let tree = TempTree::new();
        let source = authorize_source(&tree.0).expect("directory should be authorized");
        let outside = tree.0.parent().unwrap().join(format!(
            "{}-outside.txt",
            tree.0.file_name().unwrap().to_string_lossy()
        ));
        fs::write(&outside, "outside").unwrap();
        let link = tree.0.join("linked.txt");
        if symlink_file(&outside, &link).is_err() {
            let _ = fs::remove_file(&outside);
            return;
        }
        let error = authorize_candidate(&source, &link).expect_err("symlink must be rejected");
        assert_eq!(error.code, "EXCLUDED_PATH");
        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn maps_supported_extensions_without_exposing_path_as_id() {
        assert_eq!(
            format_from_path(PathBuf::from("报告.DOCX").as_path()),
            Some(DocumentFormat::Docx)
        );
        assert_eq!(
            format_from_path(PathBuf::from("notes.unknown").as_path()),
            None
        );
        assert!(
            canonical_path_string(PathBuf::from("C:/docs/report.docx").as_path())
                .contains("report.docx")
        );
    }

    #[cfg(windows)]
    #[test]
    fn labels_volume_roots_without_treating_them_as_excluded_sources() {
        assert!(super::is_volume_root(Path::new(r"D:\")));
        assert_eq!(super::source_display_name(Path::new(r"D:\")), "D盘");
    }
}
