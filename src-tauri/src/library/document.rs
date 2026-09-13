use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Command,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use image::ImageFormat;
use quick_xml::{Reader, Writer, events::{BytesText, Event}};
use sha2::{Digest, Sha256};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use super::policy::{
    authorize_candidate, authorize_source, canonical_path_string, exclusion_reason,
};
use super::{
    model::{
        AnnotationAnchor, AnnotationRecord, DocumentCapabilities, DocumentId, DocumentMode,
        DocumentOpenResult, DocumentRecord, DocumentSaveAsResult, DocumentSaveResult,
        DocumentStatus, LibraryError, LibraryErrorCode, LibraryResult, SnapshotRecord,
        SourceLocator, new_identifier, now_unix_ms,
    },
    scanner::LibraryService,
};

pub(crate) struct DocumentSaveInput<'a> {
    pub document_id: &'a DocumentId,
    pub expected_sha256: &'a str,
    pub content: &'a str,
    pub mode: DocumentMode,
}

pub(crate) struct DocumentBinarySaveInput<'a> {
    pub document_id: &'a DocumentId,
    pub expected_sha256: &'a str,
    pub content: &'a [u8],
    pub mode: DocumentMode,
}

impl LibraryService {
    pub(crate) fn open_document(
        &self,
        document_id: &DocumentId,
        mode: DocumentMode,
    ) -> LibraryResult<DocumentOpenResult> {
        let document = self.document(document_id)?;
        if document.status != DocumentStatus::Present {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentNotFound,
                "document is not currently available",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let bytes = fs::read(&path).map_err(|error| {
            LibraryError::new(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
            )
            .retryable()
            .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
        })?;
        let current_hash = sha256(&bytes);
        let is_text = matches!(document.format.as_str(), "markdown" | "text" | "csv");
        let content =
            if is_text {
                Some(String::from_utf8(bytes.clone()).map_err(|_| {
                    corrupt_error(document.format.as_str(), "文本编码不是有效的 UTF-8")
                })?)
            } else {
                None
            };
        let (binary_bytes, binary_media_type) =
            prepare_binary_preview(document.format.as_str(), &bytes)?;
        let binary_content = binary_bytes.map(|preview| STANDARD.encode(preview));
        let capabilities = capabilities_for(document.format.as_str(), mode);
        let source_locator = locator_for(&document, content.as_deref());
        let mut warnings = Vec::new();
        match document.format.as_str() {
            "doc" => warnings.push("传统 DOC 当前提供只读文件信息；正文解析暂未启用".to_owned()),
            "pptx" => warnings.push("当前格式仅支持预览，原文件不会被修改".to_owned()),
            // DOCX has a dedicated basic text adapter in the frontend. Do not
            // label it as read-only here; the warning obscures the edit entry.
            _ => {}
        }
        if mode == DocumentMode::Assist {
            warnings.push("协助修改模式下，AI 会先生成修改提案；只有你确认后才会写回原文件".to_owned());
        }
        Ok(DocumentOpenResult {
            session_id: new_identifier("session"),
            document,
            mode,
            read_only: mode == DocumentMode::ReadOnly || !capabilities.can_edit,
            expected_sha256: current_hash,
            content,
            binary_content,
            binary_media_type,
            capabilities,
            source_locator,
            warnings,
        })
    }

    pub(crate) fn save_document(
        &mut self,
        input: DocumentSaveInput<'_>,
    ) -> LibraryResult<DocumentSaveResult> {
        let document = self.document(input.document_id)?;
        if !matches!(document.format.as_str(), "markdown" | "text" | "csv") {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "this format cannot be written by the text adapter",
            ));
        }
        self.write_source_document(
            &document,
            input.expected_sha256,
            input.content.as_bytes(),
            input.mode,
        )
    }

    pub(crate) fn save_binary_document(
        &mut self,
        input: DocumentBinarySaveInput<'_>,
    ) -> LibraryResult<DocumentSaveResult> {
        let document = self.document(input.document_id)?;
        if !matches!(document.format.as_str(), "docx" | "xlsx") {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "当前仅允许写回 DOCX 或 XLSX 编辑结果",
            ));
        }
        self.write_source_document(&document, input.expected_sha256, input.content, input.mode)
    }

    /// Returns the text that can be safely addressed inside a DOCX document.
    /// It is used only to validate a focused AI replacement, never as a new
    /// source of file-system access.
    pub(crate) fn docx_text_for_ai(&self, document_id: &DocumentId) -> LibraryResult<String> {
        let document = self.document(document_id)?;
        if document.format.as_str() != "docx" {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "当前格式不支持 DOCX 定位修改",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let bytes = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "无法读取 DOCX 原文",
                error,
            )
        })?;
        Ok(docx_paragraph_slots(&bytes)?
            .into_iter()
            .map(|slots| slots.concat())
            .collect::<Vec<_>>()
            .join("\n"))
    }

    /// Applies one uniquely-addressable text replacement while retaining the
    /// rest of the OOXML package. The normal write path still creates the
    /// snapshot and performs the final hash check before replacing the file.
    pub(crate) fn apply_ai_docx_text_replacement(
        &mut self,
        document_id: &DocumentId,
        expected_sha256: &str,
        old_content: &str,
        new_content: &str,
        mode: DocumentMode,
    ) -> LibraryResult<DocumentSaveResult> {
        if old_content.trim().is_empty() || new_content.contains(['\r', '\n']) {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "DOCX 修改必须替换一段非空且不跨段的原文",
            ));
        }
        let document = self.document(document_id)?;
        if document.format.as_str() != "docx" {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "当前格式不支持 AI 直接修改",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let original = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "无法读取 DOCX 原文",
                error,
            )
        })?;
        let current_hash = sha256(&original);
        if current_hash != expected_sha256 {
            return Err(conflict_error(&document, expected_sha256, &current_hash));
        }
        if normalized_text(old_content) == normalized_text(new_content) {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "AI 修改没有产生正文变化",
            ));
        }
        let rewritten = replace_docx_text(&original, old_content, new_content)?;
        self.write_source_document(&document, expected_sha256, &rewritten, mode)
    }

    fn write_source_document(
        &mut self,
        document: &DocumentRecord,
        expected_sha256: &str,
        content: &[u8],
        mode: DocumentMode,
    ) -> LibraryResult<DocumentSaveResult> {
        if mode == DocumentMode::ReadOnly {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentReadOnly,
                "document is open in read-only mode",
            ));
        }
        validate_document_bytes(document.format.as_str(), content)?;
        let path = self.authorized_document_path(document)?;
        let original = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
                error,
            )
        })?;
        let current_hash = sha256(&original);
        if current_hash != expected_sha256 {
            return Err(conflict_error(document, expected_sha256, &current_hash));
        }
        let snapshot = self
            .database
            .create_snapshot(&document.id, &current_hash, &original)
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::SnapshotFailed,
                    "snapshot could not be created",
                )
                .retryable()
            })?;
        let temp_path = path.with_extension(format!(
            "{}{}.moji-tmp",
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!("{e}."))
                .unwrap_or_default(),
            snapshot.id
        ));
        let backup_path = path.with_extension(format!(
            "{}{}.moji-backup",
            path.extension()
                .and_then(|e| e.to_str())
                .map(|e| format!("{e}."))
                .unwrap_or_default(),
            snapshot.id
        ));
        let result = write_with_recovery(&path, &temp_path, &backup_path, content);
        if let Err(error) = result {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(&backup_path);
            return Err(error);
        }
        let new_bytes = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "saved document could not be verified",
                error,
            )
        })?;
        let new_hash = sha256(&new_bytes);
        let modified_at_ms = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_else(now_unix_ms);
        self.database.update_document_file_state(
            &document.id,
            &new_hash,
            new_bytes.len() as u64,
            modified_at_ms,
        )?;
        Ok(DocumentSaveResult {
            document_id: document.id.clone(),
            snapshot_id: snapshot.id,
            new_sha256: new_hash,
            target_path: None,
            source_preserved: false,
        })
    }

    pub(crate) fn save_document_copy(
        &self,
        document_id: &DocumentId,
        content: &[u8],
        target: &Path,
    ) -> LibraryResult<DocumentSaveAsResult> {
        let document = self.document(document_id)?;
        let source = self.authorized_document_path(&document)?;
        validate_document_bytes(document.format.as_str(), content)?;
        let source_extension = source.extension().and_then(|value| value.to_str());
        let target_extension = target.extension().and_then(|value| value.to_str());
        if source_extension.map(str::to_ascii_lowercase)
            != target_extension.map(str::to_ascii_lowercase)
        {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "另存文件必须保持原文档格式",
            ));
        }
        let parent = target
            .parent()
            .ok_or_else(|| LibraryError::new(LibraryErrorCode::InvalidArgument, "另存位置无效"))?;
        let canonical_parent = fs::canonicalize(parent).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "另存目录不可用",
                error,
            )
        })?;
        let file_name = target.file_name().ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::InvalidArgument, "另存文件名无效")
        })?;
        let target = canonical_parent.join(file_name);
        if canonical_path_string(&source) == canonical_path_string(&target) {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "另存目标不能覆盖源文件",
            ));
        }
        if target.exists() {
            return Err(LibraryError::new(
                LibraryErrorCode::SaveAsTargetExists,
                "另存目标已存在，请选择新文件名",
            ));
        }
        let temp = target.with_extension(format!(
            "{}{}.moji-tmp",
            target
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!("{value}."))
                .unwrap_or_default(),
            new_identifier("copy")
        ));
        write_new_file(&target, &temp, content)?;
        let new_hash = sha256(content);
        Ok(DocumentSaveAsResult {
            document_id: document.id,
            cancelled: false,
            target_name: target
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned),
            new_sha256: Some(new_hash),
            source_preserved: true,
        })
    }

    pub(crate) fn restore_snapshot(
        &mut self,
        document_id: &DocumentId,
        snapshot_id: &str,
        expected_sha256: &str,
    ) -> LibraryResult<DocumentSaveResult> {
        let document = self.document(document_id)?;
        let path = self.authorized_document_path(&document)?;
        let current = fs::read(&path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentReadFailed,
                "document could not be read",
                error,
            )
        })?;
        let current_hash = sha256(&current);
        if current_hash != expected_sha256 {
            return Err(conflict_error(&document, expected_sha256, &current_hash));
        }
        let (snapshot, content) =
            self.database
                .snapshot_content(snapshot_id)?
                .ok_or_else(|| {
                    LibraryError::new(LibraryErrorCode::SnapshotNotFound, "snapshot was not found")
                })?;
        if snapshot.document_id != *document_id {
            return Err(LibraryError::new(
                LibraryErrorCode::SnapshotNotFound,
                "snapshot does not belong to this document",
            ));
        }
        let before = self
            .database
            .create_snapshot(document_id, &current_hash, &current)
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::SnapshotFailed,
                    "snapshot could not be created",
                )
                .retryable()
            })?;
        let temp_path = path.with_extension(format!("restore-{}.moji-tmp", before.id));
        let backup_path = path.with_extension(format!("restore-{}.moji-backup", before.id));
        write_with_recovery(&path, &temp_path, &backup_path, &content)?;
        let modified_at_ms = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or_else(now_unix_ms);
        self.database.update_document_file_state(
            document_id,
            &sha256(&content),
            content.len() as u64,
            modified_at_ms,
        )?;
        Ok(DocumentSaveResult {
            document_id: document_id.clone(),
            snapshot_id: snapshot.id,
            new_sha256: sha256(&content),
            target_path: None,
            source_preserved: false,
        })
    }

    pub(crate) fn document(&self, document_id: &DocumentId) -> LibraryResult<DocumentRecord> {
        self.database.document_by_id(document_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::DocumentNotFound, "document was not found")
        })
    }

    /// Open a validated local document with the operating system's default
    /// application. The path is resolved from the authorized library record so
    /// the renderer cannot ask the shell to open an arbitrary path.
    pub(crate) fn open_document_external(&self, document_id: &DocumentId) -> LibraryResult<()> {
        let document = self.document(document_id)?;
        if document.format.as_str() != "pptx" {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "当前仅支持从 PPTX 预览打开本机应用",
            ));
        }
        let path = self.authorized_document_path(&document)?;
        let result = if cfg!(windows) {
            Command::new("explorer.exe").arg(&path).spawn()
        } else if cfg!(target_os = "macos") {
            Command::new("open").arg(&path).spawn()
        } else {
            Command::new("xdg-open").arg(&path).spawn()
        };
        result.map(|_| ()).map_err(|error| {
            LibraryError::new(
                LibraryErrorCode::DocumentReadFailed,
                "无法调用本机应用打开 PPTX，请确认 PowerPoint 或 WPS 已正确安装",
            )
            .retryable()
            .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
        })
    }

    pub(super) fn authorized_document_path(
        &self,
        document: &DocumentRecord,
    ) -> LibraryResult<PathBuf> {
        let source = self
            .database
            .source_by_id(&document.source_root_id)?
            .ok_or_else(|| {
                LibraryError::new(
                    LibraryErrorCode::UnauthorizedPath,
                    "document source is no longer authorized",
                )
            })?;
        let authorized_source = authorize_source(&source.canonical_path)?;
        let path = authorize_candidate(&authorized_source, &document.canonical_path)?;
        let recorded_path = fs::canonicalize(&document.canonical_path)
            .unwrap_or_else(|_| PathBuf::from(&document.canonical_path));
        if canonical_path_string(&path) != canonical_path_string(&recorded_path) {
            return Err(LibraryError::new(
                LibraryErrorCode::UnauthorizedPath,
                "document path no longer matches the authorized record",
            ));
        }
        let metadata = fs::metadata(&path).map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::DocumentNotFound,
                "document is not currently available",
            )
        })?;
        if !metadata.is_file() {
            return Err(LibraryError::new(
                LibraryErrorCode::UnauthorizedPath,
                "document target is not a regular file",
            ));
        }
        Ok(path)
    }

    pub(crate) fn snapshots(&self, document_id: &DocumentId) -> LibraryResult<Vec<SnapshotRecord>> {
        self.document(document_id)?;
        self.database.snapshots_for_document(document_id)
    }

    pub(crate) fn annotations(
        &self,
        document_id: &DocumentId,
    ) -> LibraryResult<Vec<AnnotationRecord>> {
        self.document(document_id)?;
        self.database.annotations_for_document(document_id)
    }

    pub(crate) fn add_annotation(
        &mut self,
        document_id: &DocumentId,
        author: String,
        body: String,
        anchor: AnnotationAnchor,
    ) -> LibraryResult<AnnotationRecord> {
        if body.trim().is_empty() {
            return Err(LibraryError::new(
                LibraryErrorCode::InvalidArgument,
                "annotation body cannot be empty",
            ));
        }
        self.document(document_id)?;
        let now = now_unix_ms();
        let annotation = AnnotationRecord {
            id: new_identifier("anno"),
            document_id: document_id.clone(),
            author: author.trim().to_owned(),
            body,
            anchor,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.database.add_annotation(&annotation)?;
        Ok(annotation)
    }

    pub(crate) fn delete_annotation(&mut self, annotation_id: &str) -> LibraryResult<()> {
        self.database.delete_annotation(annotation_id)
    }
}

fn corrupt_error(format: &str, message: &str) -> LibraryError {
    LibraryError::new(LibraryErrorCode::DocumentCorrupt, message)
        .with_details(serde_json::json!({ "format": format }))
}

fn validate_ooxml(format: &str, bytes: &[u8]) -> LibraryResult<()> {
    let required_part = match format {
        "docx" => "word/document.xml",
        "pptx" => "ppt/presentation.xml",
        "xlsx" => "xl/workbook.xml",
        _ => return Ok(()),
    };
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| corrupt_error(format, "Office 文件包无法读取"))?;
    if archive.by_name("[Content_Types].xml").is_err() || archive.by_name(required_part).is_err() {
        return Err(corrupt_error(format, "Office 文件缺少必要的 OOXML 部件"));
    }
    Ok(())
}

fn docx_edit_error(message: &str) -> LibraryError {
    LibraryError::new(LibraryErrorCode::InvalidArgument, message)
}

#[cfg(test)]
fn docx_text_slots(bytes: &[u8]) -> LibraryResult<Vec<String>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| corrupt_error("docx", "Office 文件包无法读取"))?;
    let mut document_xml = Vec::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| corrupt_error("docx", "Office 文件缺少正文部件"))?
        .read_to_end(&mut document_xml)
        .map_err(|_| corrupt_error("docx", "无法读取 DOCX 正文"))?;
    text_slots_from_document_xml(&document_xml)
}

fn docx_paragraph_slots(bytes: &[u8]) -> LibraryResult<Vec<Vec<String>>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| corrupt_error("docx", "Office 文件包无法读取"))?;
    let mut document_xml = Vec::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| corrupt_error("docx", "DOCX 文件缺少正文部件"))?
        .read_to_end(&mut document_xml)
        .map_err(|_| corrupt_error("docx", "无法读取 DOCX 正文"))?;
    paragraph_slots_from_document_xml(&document_xml)
}

fn is_word_text_tag(name: &[u8]) -> bool {
    name == b"w:t" || name == b"t"
}

#[cfg(test)]
fn text_slots_from_document_xml(xml: &[u8]) -> LibraryResult<Vec<String>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut text_depth = 0usize;
    let mut slots = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if is_word_text_tag(event.name().as_ref()) => text_depth += 1,
            Ok(Event::End(event)) if is_word_text_tag(event.name().as_ref()) => text_depth = text_depth.saturating_sub(1),
            Ok(Event::Text(event)) if text_depth > 0 => slots.push(event.decode().map_err(|_| corrupt_error("docx", "DOCX 正文编码无效"))?.into_owned()),
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(corrupt_error("docx", "DOCX 正文 XML 无法解析")),
        }
        buffer.clear();
    }
    Ok(slots)
}

fn paragraph_slots_from_document_xml(xml: &[u8]) -> LibraryResult<Vec<Vec<String>>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut paragraph_depth = 0usize;
    let mut text_depth = 0usize;
    let mut paragraphs: Vec<Vec<String>> = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.name().as_ref() == b"w:p" || event.name().as_ref() == b"p" => {
                paragraph_depth += 1;
                if paragraph_depth == 1 {
                    paragraphs.push(Vec::new());
                }
            }
            Ok(Event::End(event)) if event.name().as_ref() == b"w:p" || event.name().as_ref() == b"p" => {
                paragraph_depth = paragraph_depth.saturating_sub(1);
            }
            Ok(Event::Start(event)) if paragraph_depth > 0 && is_word_text_tag(event.name().as_ref()) => text_depth += 1,
            Ok(Event::End(event)) if is_word_text_tag(event.name().as_ref()) => text_depth = text_depth.saturating_sub(1),
            Ok(Event::Text(event)) if paragraph_depth > 0 && text_depth > 0 => {
                if let Some(slots) = paragraphs.last_mut() {
                    slots.push(event.decode().map_err(|_| corrupt_error("docx", "DOCX 正文编码无效"))?.into_owned());
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(corrupt_error("docx", "DOCX 正文 XML 无法解析")),
        }
        buffer.clear();
    }
    Ok(paragraphs)
}

fn normalized_text(value: &str) -> String {
    value.chars().filter(|character| !character.is_whitespace()).collect()
}

fn replace_docx_text(bytes: &[u8], old_content: &str, new_content: &str) -> LibraryResult<Vec<u8>> {
    let paragraphs = docx_paragraph_slots(bytes)?;
    let mut matched: Option<(usize, usize, usize)> = None;
    for (paragraph_index, slots) in paragraphs.iter().enumerate() {
        let combined = slots.concat();
        let Some(match_start_byte) = combined.find(old_content) else { continue };
        if combined[match_start_byte + old_content.len()..].contains(old_content) {
            return Err(docx_edit_error("AI 指定的原文出现多次，无法安全判断要修改的位置"));
        }
        if matched.is_some() {
            return Err(docx_edit_error("AI 指定的原文出现多次，无法安全判断要修改的位置"));
        }
        let match_start = combined[..match_start_byte].chars().count();
        matched = Some((paragraph_index, match_start, match_start + old_content.chars().count()));
    }
    let Some((paragraph_index, match_start, match_end)) = matched else {
        return Err(docx_edit_error("AI 指定的原文不在当前 DOCX 的单个段落中，请重新生成修改建议"));
    };
    let replacements = paragraphs
        .into_iter()
        .enumerate()
        .flat_map(|(index, slots)| {
            if index == paragraph_index {
                replace_text_slots(&slots, match_start, match_end, new_content)
            } else {
                slots
            }
        })
        .collect::<Vec<_>>();
    rewrite_docx_archive(bytes, &replacements)
}

fn replace_text_slots(slots: &[String], match_start: usize, match_end: usize, replacement: &str) -> Vec<String> {
    let mut cursor = 0usize;
    slots
        .iter()
        .map(|slot| {
            let characters = slot.chars().collect::<Vec<_>>();
            let slot_start = cursor;
            let slot_end = slot_start + characters.len();
            cursor = slot_end;
            if slot_end <= match_start || slot_start >= match_end {
                return slot.clone();
            }
            let prefix_end = match_start.saturating_sub(slot_start).min(characters.len());
            let suffix_start = match_end.saturating_sub(slot_start).min(characters.len());
            let mut value = characters[..prefix_end].iter().collect::<String>();
            if slot_start <= match_start && match_start < slot_end {
                value.push_str(replacement);
            }
            if match_end >= slot_start && match_end <= slot_end {
                value.extend(characters[suffix_start..].iter());
            }
            value
        })
        .collect()
}

fn rewrite_document_xml(xml: &[u8], replacements: &[String]) -> LibraryResult<Vec<u8>> {
    let mut reader = Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(false);
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buffer = Vec::new();
    let mut text_depth = 0usize;
    let mut slot_index = 0usize;
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|_| corrupt_error("docx", "DOCX 正文 XML 无法解析"))?;
        match event {
            Event::Start(ref start) if is_word_text_tag(start.name().as_ref()) => {
                text_depth += 1;
                writer.write_event(event.into_owned()).map_err(|_| corrupt_error("docx", "DOCX 正文无法写回"))?;
            }
            Event::End(ref end) if is_word_text_tag(end.name().as_ref()) => {
                text_depth = text_depth.saturating_sub(1);
                writer.write_event(event.into_owned()).map_err(|_| corrupt_error("docx", "DOCX 正文无法写回"))?;
            }
            Event::Text(_) if text_depth > 0 => {
                let replacement = replacements.get(slot_index).ok_or_else(|| corrupt_error("docx", "DOCX 正文结构发生变化"))?;
                slot_index += 1;
                writer.write_event(Event::Text(BytesText::new(replacement))).map_err(|_| corrupt_error("docx", "DOCX 正文无法写回"))?;
            }
            Event::Eof => break,
            _ => writer.write_event(event.into_owned()).map_err(|_| corrupt_error("docx", "DOCX 正文无法写回"))?,
        }
        buffer.clear();
    }
    if slot_index != replacements.len() {
        return Err(corrupt_error("docx", "DOCX 正文结构发生变化"));
    }
    Ok(writer.into_inner().into_inner())
}

fn rewrite_docx_archive(bytes: &[u8], replacements: &[String]) -> LibraryResult<Vec<u8>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| corrupt_error("docx", "Office 文件包无法读取"))?;
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| corrupt_error("docx", "Office 文件条目无法读取"))?;
        let name = entry.name().to_owned();
        let is_directory = entry.is_dir();
        let mut contents = Vec::new();
        if !is_directory {
            entry.read_to_end(&mut contents).map_err(|_| corrupt_error("docx", "Office 文件条目无法读取"))?;
        }
        if is_directory {
            writer.add_directory(name, SimpleFileOptions::default()).map_err(|_| corrupt_error("docx", "Office 文件无法写回"))?;
        } else {
            writer.start_file(name.clone(), SimpleFileOptions::default()).map_err(|_| corrupt_error("docx", "Office 文件无法写回"))?;
            if name == "word/document.xml" {
                writer.write_all(&rewrite_document_xml(&contents, replacements)?).map_err(|_| corrupt_error("docx", "Office 正文无法写回"))?;
            } else {
                writer.write_all(&contents).map_err(|_| corrupt_error("docx", "Office 文件无法写回"))?;
            }
        }
    }
    writer.finish().map_err(|_| corrupt_error("docx", "Office 文件无法完成写回")).map(|cursor| cursor.into_inner())
}

fn expected_image_format(format: &str) -> Option<ImageFormat> {
    match format {
        "png" => Some(ImageFormat::Png),
        "jpg" => Some(ImageFormat::Jpeg),
        "tiff" => Some(ImageFormat::Tiff),
        "bmp" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

fn validate_image(format: &str, bytes: &[u8]) -> LibraryResult<image::DynamicImage> {
    let expected =
        expected_image_format(format).ok_or_else(|| corrupt_error(format, "图片格式不受支持"))?;
    let detected =
        image::guess_format(bytes).map_err(|_| corrupt_error(format, "图片文件头无法识别"))?;
    if detected != expected {
        return Err(corrupt_error(format, "图片内容与扩展名不匹配"));
    }
    image::load_from_memory_with_format(bytes, expected)
        .map_err(|_| corrupt_error(format, "图片数据已损坏或无法解码"))
}

fn validate_pdf(bytes: &[u8]) -> LibraryResult<()> {
    let document = lopdf::Document::load_mem(bytes)
        .map_err(|_| corrupt_error("pdf", "PDF 结构已损坏或无法读取"))?;
    if document.get_pages().is_empty() {
        return Err(corrupt_error("pdf", "PDF 不包含可读取页面"));
    }
    Ok(())
}

fn validate_document_bytes(format: &str, bytes: &[u8]) -> LibraryResult<()> {
    match format {
        "markdown" | "text" | "csv" => std::str::from_utf8(bytes)
            .map(|_| ())
            .map_err(|_| corrupt_error(format, "文本编码不是有效的 UTF-8")),
        "pdf" => validate_pdf(bytes),
        "docx" | "xlsx" => validate_ooxml(format, bytes),
        "pptx" => Err(LibraryError::new(
            LibraryErrorCode::DocumentWriteFailed,
            "PPTX 当前仅支持只读",
        )),
        "png" | "jpg" | "tiff" | "bmp" => validate_image(format, bytes).map(|_| ()),
        _ => Ok(()),
    }
}

fn prepare_binary_preview(
    format: &str,
    bytes: &[u8],
) -> LibraryResult<(Option<Vec<u8>>, Option<String>)> {
    match format {
        "pdf" => {
            validate_pdf(bytes)?;
            Ok((Some(bytes.to_vec()), Some("application/pdf".to_owned())))
        }
        "docx" | "pptx" | "xlsx" => {
            validate_ooxml(format, bytes)?;
            let media_type = match format {
                "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "pptx" => {
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                }
                _ => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            };
            Ok((Some(bytes.to_vec()), Some(media_type.to_owned())))
        }
        "png" | "jpg" => {
            validate_image(format, bytes)?;
            let media_type = if format == "png" {
                "image/png"
            } else {
                "image/jpeg"
            };
            Ok((Some(bytes.to_vec()), Some(media_type.to_owned())))
        }
        "tiff" | "bmp" => {
            let image = validate_image(format, bytes)?;
            let mut output = Cursor::new(Vec::new());
            image
                .write_to(&mut output, ImageFormat::Png)
                .map_err(|_| corrupt_error(format, "图片预览转换失败"))?;
            Ok((Some(output.into_inner()), Some("image/png".to_owned())))
        }
        _ => Ok((None, None)),
    }
}

fn capabilities_for(format: &str, mode: DocumentMode) -> DocumentCapabilities {
    let text = matches!(format, "markdown" | "text" | "csv");
    let office = matches!(format, "docx" | "xlsx");
    DocumentCapabilities {
        can_edit: (text || office) && mode != DocumentMode::ReadOnly,
        can_save: (text || office) && mode != DocumentMode::ReadOnly,
        can_save_as: text || office,
        can_annotate: true,
        supports_page_anchor: format == "pdf",
        supports_paragraph_anchor: text,
    }
}

fn locator_for(document: &DocumentRecord, content: Option<&str>) -> SourceLocator {
    let kind = match document.format.as_str() {
        "pdf" => "page",
        "pptx" => "slide",
        "markdown" | "text" | "csv" | "docx" => "paragraph",
        _ => "document",
    };
    let text = matches!(document.format.as_str(), "markdown" | "text" | "csv") && content.is_some();
    let pdf = document.format.as_str() == "pdf";
    let document_level = matches!(document.format.as_str(), "png" | "jpg" | "tiff" | "bmp");
    let available = text || pdf || document_level;
    SourceLocator {
        kind: kind.to_owned(),
        page: pdf.then_some(1),
        slide: None,
        paragraph: text.then_some(1),
        bounding_box: None,
        available,
        reason: (!available)
            .then(|| "该格式没有稳定的页码、幻灯片或段落定位；批注保留文档级回退".to_owned()),
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn conflict_error(
    document: &DocumentRecord,
    expected_hash: &str,
    current_hash: &str,
) -> LibraryError {
    LibraryError::new(LibraryErrorCode::DocumentConflict, "文件在编辑期间已被外部修改").with_details(serde_json::json!({ "documentId": document.id, "expectedSha256": expected_hash, "currentSha256": current_hash, "actions": ["abandon", "save_as", "compare", "restore"] }))
}

fn io_error(code: LibraryErrorCode, message: &str, error: std::io::Error) -> LibraryError {
    let locked = matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
    ) || matches!(error.raw_os_error(), Some(32 | 33));
    LibraryError::new(
        if locked {
            LibraryErrorCode::DocumentLocked
        } else {
            code
        },
        message,
    )
    .retryable()
    .with_details(serde_json::json!({ "kind": format!("{:?}", error.kind()) }))
}

fn write_with_recovery(
    path: &std::path::Path,
    temp: &std::path::Path,
    backup: &std::path::Path,
    bytes: &[u8],
) -> LibraryResult<()> {
    let result = (|| {
        assert_regular_target(path)?;
        let original = fs::read(path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be read",
                error,
            )
        })?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(|error| {
                io_error(
                    LibraryErrorCode::DocumentWriteFailed,
                    "temporary document could not be created",
                    error,
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be written",
                error,
            )
        })?;
        file.sync_all().map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be flushed",
                error,
            )
        })?;
        let mut backup_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(backup)
            .map_err(|error| {
                io_error(
                    LibraryErrorCode::DocumentWriteFailed,
                    "document backup could not be created",
                    error,
                )
            })?;
        backup_file.write_all(&original).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be written",
                error,
            )
        })?;
        backup_file.sync_all().map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document backup could not be flushed",
                error,
            )
        })?;
        assert_regular_target(path)?;
        atomic_replace(path, temp).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "document could not be replaced",
                error,
            )
        })?;
        assert_regular_target(path)?;
        let written = fs::read(path).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "written document could not be verified",
                error,
            )
        })?;
        if written != bytes {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "written document failed integrity verification",
            )
            .retryable());
        }
        fs::remove_file(backup).ok();
        Ok(())
    })();
    if result.is_err() && backup.exists() {
        let _ = atomic_replace(path, backup);
    }
    result
}

fn write_new_file(target: &Path, temp: &Path, bytes: &[u8]) -> LibraryResult<()> {
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(|error| {
                io_error(
                    LibraryErrorCode::DocumentWriteFailed,
                    "另存临时文件无法创建",
                    error,
                )
            })?;
        file.write_all(bytes).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "另存文件写入失败",
                error,
            )
        })?;
        file.sync_all().map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "另存文件无法写入磁盘",
                error,
            )
        })?;
        fs::rename(temp, target).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "另存文件无法完成",
                error,
            )
        })?;
        let written = fs::read(target).map_err(|error| {
            io_error(
                LibraryErrorCode::DocumentWriteFailed,
                "另存文件无法验证",
                error,
            )
        })?;
        if written != bytes {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentWriteFailed,
                "另存文件完整性验证失败",
            ));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
        let _ = fs::remove_file(target);
    }
    result
}

fn assert_regular_target(path: &Path) -> LibraryResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        LibraryError::new(
            LibraryErrorCode::UnauthorizedPath,
            "document target is unavailable",
        )
    })?;
    if exclusion_reason(path, &metadata).is_some() || !metadata.is_file() {
        return Err(LibraryError::new(
            LibraryErrorCode::UnauthorizedPath,
            "document target is not a regular authorized file",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(path: &Path, temp: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = temp
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let ok = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(path: &Path, temp: &Path) -> std::io::Result<()> {
    fs::rename(temp, path)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::library::{
        model::{DocumentFormat, DocumentRecord, SourceKind},
        scanner::LibraryService,
    };

    struct TempTree(PathBuf);
    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "moji-document-test-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scanned_text_service() -> (TempTree, LibraryService, DocumentId) {
        let tree = TempTree::new();
        let path = tree.0.join("notes.md");
        fs::write(&path, "before").unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let source = service
            .database
            .register_source(
                SourceKind::Directory,
                tree.0.to_string_lossy().as_ref(),
                "temp",
            )
            .unwrap();
        let document_id = DocumentId("doc-notes".to_owned());
        service
            .database
            .upsert_document(
                &DocumentRecord {
                    id: document_id.clone(),
                    source_root_id: source.source.id,
                    canonical_path: path.to_string_lossy().to_string(),
                    display_name: "notes.md".to_owned(),
                    format: DocumentFormat::Markdown,
                    size_bytes: 6,
                    modified_at_ms: 1,
                    file_identity: None,
                    content_sha256: sha256(b"before"),
                    status: DocumentStatus::Present,
                    content_state: "pending".to_owned(),
                },
                &super::super::model::ScanJobId("job-test".to_owned()),
            )
            .unwrap();
        (tree, service, document_id)
    }

    fn scanned_binary_service(
        file_name: &str,
        format: DocumentFormat,
        bytes: &[u8],
    ) -> (TempTree, LibraryService, DocumentId) {
        let tree = TempTree::new();
        let path = tree.0.join(file_name);
        fs::write(&path, bytes).unwrap();
        let mut service = LibraryService::in_memory().unwrap();
        let source = service
            .database
            .register_source(
                SourceKind::Directory,
                tree.0.to_string_lossy().as_ref(),
                "temp",
            )
            .unwrap();
        let document_id = DocumentId(format!("doc-{}", format.as_str()));
        service
            .database
            .upsert_document(
                &DocumentRecord {
                    id: document_id.clone(),
                    source_root_id: source.source.id,
                    canonical_path: path.to_string_lossy().to_string(),
                    display_name: file_name.to_owned(),
                    format,
                    size_bytes: bytes.len() as u64,
                    modified_at_ms: 1,
                    file_identity: None,
                    content_sha256: sha256(bytes),
                    status: DocumentStatus::Present,
                    content_state: "pending".to_owned(),
                },
                &super::super::model::ScanJobId("job-binary".to_owned()),
            )
            .unwrap();
        (tree, service, document_id)
    }

    fn office_fixture(name: &str) -> Vec<u8> {
        fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/office/generated")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn saves_text_only_after_snapshot_and_restores_original_bytes() {
        let (tree, mut service, document_id) = scanned_text_service();
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        let saved = service
            .save_document(DocumentSaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: "after",
                mode: DocumentMode::Edit,
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "after"
        );
        assert_eq!(service.snapshots(&document_id).unwrap().len(), 1);
        let restored = service
            .restore_snapshot(&document_id, &saved.snapshot_id, &saved.new_sha256)
            .unwrap();
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "before"
        );
        assert_eq!(restored.new_sha256, sha256(b"before"));
    }

    #[test]
    fn detects_external_modification_without_overwriting_file() {
        let (tree, mut service, document_id) = scanned_text_service();
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        fs::write(tree.0.join("notes.md"), "external").unwrap();
        let error = service
            .save_document(DocumentSaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: "local",
                mode: DocumentMode::Edit,
            })
            .unwrap_err();
        assert_eq!(error.code, "DOCUMENT_CONFLICT");
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "external"
        );
        assert!(service.snapshots(&document_id).unwrap().is_empty());
    }

    #[test]
    fn persists_annotations_with_explicit_unstable_anchor_fallback() {
        let (_tree, mut service, document_id) = scanned_text_service();
        let annotation = service
            .add_annotation(
                &document_id,
                "Gary".to_owned(),
                "check this".to_owned(),
                AnnotationAnchor {
                    kind: "character-range".to_owned(),
                    page: None,
                    slide: None,
                    paragraph: Some(1),
                    char_start: Some(0),
                    char_end: Some(5),
                    quote: Some("before".to_owned()),
                    stable: false,
                },
            )
            .unwrap();
        let annotations = service.annotations(&document_id).unwrap();
        assert_eq!(annotations, vec![annotation]);
    }

    #[test]
    fn rejects_corrupt_pdf_image_and_office_documents_with_a_stable_error() {
        for (name, format) in [
            ("broken.pdf", DocumentFormat::Pdf),
            ("broken.png", DocumentFormat::Png),
            ("broken.docx", DocumentFormat::Docx),
        ] {
            let (_tree, service, document_id) =
                scanned_binary_service(name, format, b"not a valid document");
            let error = service
                .open_document(&document_id, DocumentMode::ReadOnly)
                .unwrap_err();
            assert_eq!(error.code, "DOCUMENT_CORRUPT");
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details["format"].as_str()),
                Some(format.as_str())
            );
        }
    }

    #[test]
    fn saves_valid_office_output_after_snapshot_and_can_restore_the_source() {
        let original = office_fixture("docx-basic.docx");
        let edited = office_fixture("docx-long-text.docx");
        let (tree, mut service, document_id) =
            scanned_binary_service("report.docx", DocumentFormat::Docx, &original);
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        let saved = service
            .save_binary_document(DocumentBinarySaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: &edited,
                mode: DocumentMode::Edit,
            })
            .unwrap();

        assert_eq!(fs::read(tree.0.join("report.docx")).unwrap(), edited);
        assert_eq!(service.snapshots(&document_id).unwrap().len(), 1);
        service
            .restore_snapshot(&document_id, &saved.snapshot_id, &saved.new_sha256)
            .unwrap();
        assert_eq!(fs::read(tree.0.join("report.docx")).unwrap(), original);
    }

    #[test]
    fn replaces_a_unique_docx_phrase_without_discarding_the_ooxml_package() {
        let original = office_fixture("docx-basic.docx");
        let before = docx_text_slots(&original).unwrap().concat();
        assert!(before.contains("正文"));

        let replaced = replace_docx_text(&original, "正文", "AI 修改后的内容").unwrap();
        validate_ooxml("docx", &replaced).unwrap();
        let after = docx_text_slots(&replaced).unwrap().concat();
        assert!(after.contains("AI 修改后的内容"));
        assert!(!after.contains("正文"));
    }

    #[test]
    fn applies_an_ai_docx_replacement_through_the_snapshot_write_path() {
        let original = office_fixture("docx-basic.docx");
        let (tree, mut service, document_id) =
            scanned_binary_service("report.docx", DocumentFormat::Docx, &original);
        let opened = service
            .open_document(&document_id, DocumentMode::ReadOnly)
            .unwrap();

        let saved = service
            .apply_ai_docx_text_replacement(
                &document_id,
                &opened.expected_sha256,
                "正文",
                "AI 已改写的正文",
                DocumentMode::Assist,
            )
            .unwrap();

        let written = fs::read(tree.0.join("report.docx")).unwrap();
        validate_ooxml("docx", &written).unwrap();
        assert!(docx_text_slots(&written)
            .unwrap()
            .concat()
            .contains("AI 已改写的正文"));
        assert_eq!(service.snapshots(&document_id).unwrap().len(), 1);
        assert_ne!(saved.new_sha256, opened.expected_sha256);
    }

    #[test]
    fn rejects_a_docx_replacement_that_only_repackages_the_archive() {
        let original = office_fixture("docx-basic.docx");
        let (tree, mut service, document_id) =
            scanned_binary_service("report.docx", DocumentFormat::Docx, &original);
        let opened = service
            .open_document(&document_id, DocumentMode::ReadOnly)
            .unwrap();

        let error = service
            .apply_ai_docx_text_replacement(
                &document_id,
                &opened.expected_sha256,
                "正文",
                "正 文",
                DocumentMode::Assist,
            )
            .unwrap_err();

        assert_eq!(error.code, "DOCUMENT_WRITE_FAILED");
        assert_eq!(fs::read(tree.0.join("report.docx")).unwrap(), original);
        assert!(service.snapshots(&document_id).unwrap().is_empty());
    }

    #[test]
    fn blocks_office_writeback_after_an_external_change() {
        let original = office_fixture("docx-basic.docx");
        let edited = office_fixture("docx-long-text.docx");
        let (tree, mut service, document_id) =
            scanned_binary_service("report.docx", DocumentFormat::Docx, &original);
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        fs::write(tree.0.join("report.docx"), &edited).unwrap();
        let error = service
            .save_binary_document(DocumentBinarySaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: &original,
                mode: DocumentMode::Edit,
            })
            .unwrap_err();

        assert_eq!(error.code, "DOCUMENT_CONFLICT");
        assert_eq!(fs::read(tree.0.join("report.docx")).unwrap(), edited);
        assert!(service.snapshots(&document_id).unwrap().is_empty());
    }

    #[test]
    fn xlsx_binary_save_checks_version_readonly_and_creates_snapshot() {
        let original = office_fixture("xlsx-basic.xlsx");
        let (_tree, mut service, document_id) = scanned_binary_service("sheet.xlsx", DocumentFormat::Xlsx, &original);
        let opened = service.open_document(&document_id, DocumentMode::Edit).unwrap();
        assert!(opened.capabilities.can_edit);
        assert!(service.save_binary_document(DocumentBinarySaveInput {
            document_id: &document_id, expected_sha256: "stale", content: &original, mode: DocumentMode::Edit,
        }).is_err());
        assert!(service.save_binary_document(DocumentBinarySaveInput {
            document_id: &document_id, expected_sha256: &opened.expected_sha256, content: &original, mode: DocumentMode::ReadOnly,
        }).is_err());
        let result = service.save_binary_document(DocumentBinarySaveInput {
            document_id: &document_id, expected_sha256: &opened.expected_sha256, content: &original, mode: DocumentMode::Edit,
        }).unwrap();
        assert!(!result.snapshot_id.is_empty());
        assert_eq!(service.open_document(&document_id, DocumentMode::ReadOnly).unwrap().binary_content, opened.binary_content);
    }

    #[test]
    fn rejects_pptx_binary_writeback() {
        for (name, format, fixture) in [
            ("slides.pptx", DocumentFormat::Pptx, "pptx-basic.pptx"),
        ] {
            let original = office_fixture(fixture);
            let (_tree, mut service, document_id) = scanned_binary_service(name, format, &original);
            let opened = service
                .open_document(&document_id, DocumentMode::Edit)
                .unwrap();
            let error = service
                .save_binary_document(DocumentBinarySaveInput {
                    document_id: &document_id,
                    expected_sha256: &opened.expected_sha256,
                    content: &original,
                    mode: DocumentMode::Edit,
                })
                .unwrap_err();

            assert_eq!(error.code, "DOCUMENT_WRITE_FAILED");
        }
    }

    #[test]
    fn save_as_creates_a_new_file_and_preserves_the_source() {
        let (tree, service, document_id) = scanned_text_service();
        let target = tree.0.join("notes-copy.md");
        let result = service
            .save_document_copy(&document_id, b"local draft", &target)
            .unwrap();

        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "before"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "local draft");
        assert_eq!(result.target_name.as_deref(), Some("notes-copy.md"));
        assert!(result.source_preserved);
    }

    #[test]
    fn a_failed_recovery_write_keeps_the_original_bytes() {
        let tree = TempTree::new();
        let source = tree.0.join("source.txt");
        let temp = tree.0.join("occupied.tmp");
        let backup = tree.0.join("source.backup");
        fs::write(&source, "original").unwrap();
        fs::write(&temp, "occupied").unwrap();

        let error = write_with_recovery(&source, &temp, &backup, b"replacement").unwrap_err();
        assert_eq!(error.code, "DOCUMENT_WRITE_FAILED");
        assert_eq!(fs::read_to_string(source).unwrap(), "original");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_write_lock_is_reported_without_snapshot_or_source_change() {
        use std::os::windows::fs::OpenOptionsExt;

        let (tree, mut service, document_id) = scanned_text_service();
        let opened = service
            .open_document(&document_id, DocumentMode::Edit)
            .unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(tree.0.join("notes.md"))
            .unwrap();
        let error = service
            .save_document(DocumentSaveInput {
                document_id: &document_id,
                expected_sha256: &opened.expected_sha256,
                content: "replacement",
                mode: DocumentMode::Edit,
            })
            .unwrap_err();
        drop(lock);

        assert_eq!(error.code, "DOCUMENT_LOCKED");
        assert_eq!(
            fs::read_to_string(tree.0.join("notes.md")).unwrap(),
            "before"
        );
        assert!(service.snapshots(&document_id).unwrap().is_empty());
    }
}
