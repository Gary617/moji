use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

use image::RgbImage;
use lopdf::Document as PdfDocument;
use ppocr_rs::{DocOrientationClassifier, OcrLite, OcrOptions};
use sha2::{Digest, Sha256};

use super::{
    model::{
        DocumentFormat, DocumentFragment, DocumentId, DocumentStatus, LibraryError,
        LibraryErrorCode, LibraryResult, OcrBoundingBox, OcrJobId, OcrJobRecord, OcrModelStatus,
        OcrPoint, OcrTextBox, ScanJobState, invalid_state_error,
    },
    scanner::LibraryService,
};

const MODEL_VERSION: &str = "PP-OCRv6-tiny-2026.08";
const RUNTIME_VERSION: &str = "ONNX Runtime CPU 1.28 (ort 2.0.0-rc.9)";
const MODEL_DIRECTORY: &str = "pp-ocrv6-tiny";

#[derive(Clone, Debug)]
struct ModelPaths {
    det: PathBuf,
    rec: PathBuf,
    dictionary: PathBuf,
    runtime: PathBuf,
    orientation: PathBuf,
    bytes: u64,
}

struct OcrPage {
    page: u32,
    source: &'static str,
    text: String,
    confidence: Option<f32>,
    width: u32,
    height: u32,
    rotation_degrees: u32,
    boxes: Vec<OcrTextBox>,
}

struct PpOcrEngine {
    engine: OcrLite,
}

impl LibraryService {
    pub(crate) fn ocr_model_status(&self) -> OcrModelStatus {
        match model_paths(&self.ocr_model_dir) {
            Ok(paths) => OcrModelStatus {
                model_version: MODEL_VERSION.to_owned(),
                runtime_version: RUNTIME_VERSION.to_owned(),
                available: true,
                model_bytes: paths.bytes,
                missing_assets: Vec::new(),
            },
            Err(error) => OcrModelStatus {
                model_version: MODEL_VERSION.to_owned(),
                runtime_version: RUNTIME_VERSION.to_owned(),
                available: false,
                model_bytes: 0,
                missing_assets: error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("missingAssets"))
                    .and_then(|assets| assets.as_array())
                    .map(|assets| {
                        assets
                            .iter()
                            .filter_map(|asset| asset.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            },
        }
    }

    pub(crate) fn enqueue_ocr(&mut self, document_id: &DocumentId) -> LibraryResult<OcrJobRecord> {
        let status = self.ocr_model_status();
        self.database.create_ocr_job(
            document_id,
            &status.model_version,
            &status.runtime_version,
            status.model_bytes,
        )
    }

    pub(crate) fn pause_ocr(&mut self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        let job = self.ocr_job(job_id)?;
        if !matches!(job.state, ScanJobState::Queued | ScanJobState::Running) {
            return Err(invalid_state_error(
                &[ScanJobState::Queued, ScanJobState::Running],
                job.state,
            ));
        }
        self.database.update_ocr_job(
            job_id,
            ScanJobState::Paused,
            job.page_count,
            job.processed_count,
            job.failed_count,
            job.retry_count,
            None,
            job.duration_ms,
        )
    }

    pub(crate) fn resume_ocr(&mut self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        let job = self.ocr_job(job_id)?;
        if job.state != ScanJobState::Paused {
            return Err(invalid_state_error(&[ScanJobState::Paused], job.state));
        }
        self.database.update_ocr_job(
            job_id,
            ScanJobState::Queued,
            job.page_count,
            job.processed_count,
            job.failed_count,
            job.retry_count,
            None,
            job.duration_ms,
        )
    }

    pub(crate) fn cancel_ocr(&mut self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        let job = self.ocr_job(job_id)?;
        if !matches!(
            job.state,
            ScanJobState::Queued
                | ScanJobState::Running
                | ScanJobState::Paused
                | ScanJobState::Failed
        ) {
            return Err(invalid_state_error(
                &[
                    ScanJobState::Queued,
                    ScanJobState::Running,
                    ScanJobState::Paused,
                    ScanJobState::Failed,
                ],
                job.state,
            ));
        }
        self.database.update_ocr_job(
            job_id,
            ScanJobState::Cancelled,
            job.page_count,
            job.processed_count,
            job.failed_count,
            job.retry_count,
            Some("OCR_CANCELLED"),
            job.duration_ms,
        )
    }

    pub(crate) fn retry_ocr(&mut self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        let job = self.ocr_job(job_id)?;
        if !matches!(job.state, ScanJobState::Failed | ScanJobState::Cancelled) {
            return Err(invalid_state_error(
                &[ScanJobState::Failed, ScanJobState::Cancelled],
                job.state,
            ));
        }
        self.database.update_ocr_job(
            job_id,
            ScanJobState::Queued,
            job.page_count,
            job.processed_count,
            job.failed_count,
            job.retry_count.saturating_add(1),
            None,
            None,
        )
    }

    pub(crate) fn ocr_job(&self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        self.database.ocr_job(job_id)?.ok_or_else(|| {
            LibraryError::new(LibraryErrorCode::OcrJobNotFound, "OCR job was not found")
        })
    }

    pub(crate) fn ocr_fragments(
        &self,
        document_id: &DocumentId,
        page: Option<u32>,
    ) -> LibraryResult<Vec<DocumentFragment>> {
        self.database.document_fragments(document_id, page)
    }

    pub(crate) fn run_ocr_job(&mut self, job_id: &OcrJobId) -> LibraryResult<OcrJobRecord> {
        let started = Instant::now();
        let mut job = self.ocr_job(job_id)?;
        if job.state != ScanJobState::Queued {
            return Err(invalid_state_error(&[ScanJobState::Queued], job.state));
        }
        job = self.database.update_ocr_job(
            job_id,
            ScanJobState::Running,
            job.page_count,
            job.processed_count,
            job.failed_count,
            job.retry_count,
            None,
            None,
        )?;
        let result = self.run_ocr_job_inner(&job, started);
        match result {
            Ok(job) => Ok(job),
            Err(error) => {
                let current = self.ocr_job(job_id)?;
                if current.state == ScanJobState::Running {
                    let _ = self.database.update_ocr_job(
                        job_id,
                        ScanJobState::Failed,
                        current.page_count,
                        current.processed_count,
                        current.failed_count.saturating_add(1),
                        current.retry_count,
                        Some(&error.code),
                        Some(started.elapsed().as_millis() as u64),
                    );
                }
                Err(error)
            }
        }
    }

    fn run_ocr_job_inner(
        &mut self,
        job: &OcrJobRecord,
        started: Instant,
    ) -> LibraryResult<OcrJobRecord> {
        let document = self
            .database
            .document_by_id(&job.document_id)?
            .ok_or_else(|| {
                LibraryError::new(LibraryErrorCode::DocumentNotFound, "document was not found")
            })?;
        if document.status != DocumentStatus::Present {
            return Err(LibraryError::new(
                LibraryErrorCode::DocumentNotFound,
                "document is not currently available",
            ));
        }
        let input = PathBuf::from(&document.canonical_path);
        let current_hash = hash_file(&input)?;
        if current_hash != job.input_sha256 {
            return Err(LibraryError::new(
                LibraryErrorCode::OcrInputChanged,
                "document changed after OCR was queued",
            )
            .retryable());
        }

        if document.format == DocumentFormat::Pdf {
            let text_pages = extract_pdf_text_pages(&input)?;
            if text_pages.iter().any(|page| has_effective_text(&page.text)) {
                return self.store_text_layer(job, text_pages, started);
            }
            return self.run_scanned_pdf(job, &input, text_pages.len() as u32, started);
        }

        let image = image::open(&input)
            .map_err(|_| {
                LibraryError::new(
                    LibraryErrorCode::OcrCorruptDocument,
                    "image could not be decoded for OCR",
                )
                .retryable()
            })?
            .to_rgb8();
        self.run_images(job, vec![(1, image)], started)
    }

    fn store_text_layer(
        &mut self,
        job: &OcrJobRecord,
        pages: Vec<OcrPage>,
        started: Instant,
    ) -> LibraryResult<OcrJobRecord> {
        self.database.clear_ocr_results(&job.document_id)?;
        let page_count = pages.len() as u32;
        for (index, page) in pages.into_iter().enumerate() {
            if let Some(interrupted) = self.interrupted_ocr_job(&job.id)? {
                return Ok(interrupted);
            }
            self.database.replace_ocr_page(
                &job.document_id,
                page.page,
                page.source,
                &page.text,
                page.confidence,
                page.width,
                page.height,
                page.rotation_degrees,
                &page.boxes,
            )?;
            self.database
                .add_ocr_metric(&job.id, Some(page.page), "text_layer", 0, 0)?;
            self.database
                .update_running_ocr_progress(&job.id, page_count, index as u32 + 1, 0)?;
        }
        self.complete_ocr_job(job, page_count, page_count, 0, started)
    }

    fn run_scanned_pdf(
        &mut self,
        job: &OcrJobRecord,
        input: &Path,
        page_count: u32,
        started: Instant,
    ) -> LibraryResult<OcrJobRecord> {
        // Report a model/runtime setup problem before asking the local renderer to do work.
        model_paths(&self.ocr_model_dir)?;
        if page_count == 0 {
            return Err(LibraryError::new(
                LibraryErrorCode::OcrCorruptDocument,
                "PDF has no pages",
            ));
        }
        let work_dir = std::env::temp_dir().join(format!("moji-ocr-{}", job.id.0));
        fs::create_dir_all(&work_dir).map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::OcrPageFailed,
                "OCR workspace could not be created",
            )
            .retryable()
        })?;
        let mut rendered = Vec::new();
        for page in 1..=page_count {
            let result = render_pdf_page(input, page, &work_dir);
            match result {
                Ok(image) => rendered.push((page, image)),
                Err(error) => {
                    remove_ocr_workspace(&work_dir);
                    return Err(error);
                }
            }
        }
        let outcome = self.run_images(job, rendered, started);
        remove_ocr_workspace(&work_dir);
        outcome
    }

    fn run_images(
        &mut self,
        job: &OcrJobRecord,
        images: Vec<(u32, RgbImage)>,
        started: Instant,
    ) -> LibraryResult<OcrJobRecord> {
        let model = model_paths(&self.ocr_model_dir)?;
        let mut engine = PpOcrEngine::load(&model)?;
        self.database.clear_ocr_results(&job.document_id)?;
        let page_count = images.len() as u32;
        for (index, (page, image)) in images.into_iter().enumerate() {
            if let Some(interrupted) = self.interrupted_ocr_job(&job.id)? {
                return Ok(interrupted);
            }
            let page_started = Instant::now();
            let result = engine.recognize(image)?;
            self.database.replace_ocr_page(
                &job.document_id,
                page,
                result.source,
                &result.text,
                result.confidence,
                result.width,
                result.height,
                result.rotation_degrees,
                &result.boxes,
            )?;
            self.database.add_ocr_metric(
                &job.id,
                Some(page),
                "inference",
                page_started.elapsed().as_millis() as u64,
                model.bytes,
            )?;
            let Some(_) = self.database.update_running_ocr_progress(
                &job.id,
                page_count,
                index as u32 + 1,
                0,
            )?
            else {
                return self.ocr_job(&job.id);
            };
        }
        self.complete_ocr_job(job, page_count, page_count, 0, started)
    }

    fn complete_ocr_job(
        &mut self,
        job: &OcrJobRecord,
        page_count: u32,
        processed: u32,
        failed: u32,
        started: Instant,
    ) -> LibraryResult<OcrJobRecord> {
        self.database.add_ocr_metric(
            &job.id,
            None,
            "total",
            started.elapsed().as_millis() as u64,
            job.model_bytes,
        )?;
        self.database.update_ocr_job(
            &job.id,
            ScanJobState::Completed,
            page_count,
            processed,
            failed,
            job.retry_count,
            None,
            Some(started.elapsed().as_millis() as u64),
        )
    }

    fn interrupted_ocr_job(&self, job_id: &OcrJobId) -> LibraryResult<Option<OcrJobRecord>> {
        let job = self.ocr_job(job_id)?;
        Ok((job.state != ScanJobState::Running).then_some(job))
    }
}

impl PpOcrEngine {
    fn load(paths: &ModelPaths) -> LibraryResult<Self> {
        // ort/load-dynamic reads this once when it creates the first session. The worker is
        // the only component that initializes OCR, and all inference remains CPU-only.
        unsafe {
            std::env::set_var("ORT_DYLIB_PATH", &paths.runtime);
        }
        let mut engine = OcrLite::new();
        engine
            .init_models_no_angle(
                path_string(&paths.det)?,
                path_string(&paths.rec)?,
                path_string(&paths.dictionary)?,
                2,
            )
            .map_err(model_error)?;
        if paths.orientation.exists() {
            let classifier =
                DocOrientationClassifier::from_path(&paths.orientation).map_err(model_error)?;
            engine.set_doc_orientation_model(classifier);
        }
        Ok(Self { engine })
    }

    fn recognize(&mut self, image: RgbImage) -> LibraryResult<OcrPage> {
        let width = image.width();
        let height = image.height();
        let output = self
            .engine
            .detect_with_options(
                &image,
                10,
                1920,
                0.6,
                0.3,
                1.6,
                false,
                false,
                OcrOptions {
                    use_doc_orientation: true,
                    ..OcrOptions::default()
                },
            )
            .map_err(model_error)?;
        let rotation_degrees = output.page_angle;
        let boxes = output
            .text_blocks
            .into_iter()
            .filter_map(|block| {
                let text = block.text.trim().to_owned();
                (!text.is_empty()).then(|| OcrTextBox {
                    text,
                    confidence: block.text_score,
                    bounding_box: OcrBoundingBox {
                        points: block
                            .box_points
                            .into_iter()
                            .map(|point| {
                                unrotate_point(point.x, point.y, rotation_degrees, width, height)
                            })
                            .collect(),
                    },
                })
            })
            .collect::<Vec<_>>();
        let text = boxes
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let confidence = (!boxes.is_empty())
            .then(|| boxes.iter().map(|item| item.confidence).sum::<f32>() / boxes.len() as f32);
        Ok(OcrPage {
            page: 0,
            source: if boxes.is_empty() { "blank" } else { "ocr" },
            text,
            confidence,
            width,
            height,
            rotation_degrees,
            boxes,
        })
    }
}

fn model_paths(root: &Path) -> LibraryResult<ModelPaths> {
    let directory = root.join(MODEL_DIRECTORY);
    let files = [
        ("det.onnx", directory.join("det.onnx")),
        ("rec.onnx", directory.join("rec.onnx")),
        ("dictionary.txt", directory.join("dictionary.txt")),
        (
            "runtime/onnxruntime.dll",
            root.join("runtime").join("onnxruntime.dll"),
        ),
    ];
    let missing = files
        .iter()
        .filter_map(|(name, path)| (!path.is_file()).then(|| (*name).to_owned()))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(LibraryError::new(
            LibraryErrorCode::OcrModelMissing,
            "local OCR model or CPU runtime is unavailable",
        )
        .retryable()
        .with_details(
            serde_json::json!({ "missingAssets": missing, "modelDirectory": "ocr-models" }),
        ));
    }
    let bytes = files
        .iter()
        .filter_map(|(_, path)| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .sum();
    Ok(ModelPaths {
        det: files[0].1.clone(),
        rec: files[1].1.clone(),
        dictionary: files[2].1.clone(),
        runtime: files[3].1.clone(),
        orientation: directory.join("orientation.onnx"),
        bytes,
    })
}

fn extract_pdf_text_pages(path: &Path) -> LibraryResult<Vec<OcrPage>> {
    let document = PdfDocument::load(path).map_err(|_| {
        LibraryError::new(
            LibraryErrorCode::OcrCorruptDocument,
            "PDF could not be read",
        )
        .retryable()
    })?;
    let pages = document.get_pages();
    if pages.is_empty() {
        return Err(LibraryError::new(
            LibraryErrorCode::OcrCorruptDocument,
            "PDF has no pages",
        ));
    }
    pages
        .into_keys()
        .map(|page| {
            let text = document.extract_text(&[page]).unwrap_or_default();
            Ok(OcrPage {
                page,
                source: if has_effective_text(&text) {
                    "text_layer"
                } else {
                    "blank"
                },
                text,
                confidence: None,
                width: 0,
                height: 0,
                rotation_degrees: 0,
                boxes: Vec::new(),
            })
        })
        .collect()
}

fn has_effective_text(text: &str) -> bool {
    text.chars()
        .filter(|character| {
            character.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(character)
        })
        .count()
        >= 8
}

fn render_pdf_page(input: &Path, page: u32, work_dir: &Path) -> LibraryResult<RgbImage> {
    let prefix = work_dir.join(format!("page-{page}"));
    let output = Command::new("pdftoppm")
        .args([
            "-f",
            &page.to_string(),
            "-l",
            &page.to_string(),
            "-r",
            "200",
            "-png",
        ])
        .arg(input)
        .arg(&prefix)
        .output()
        .map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::OcrPdfRendererUnavailable,
                "local PDF renderer is unavailable",
            )
            .retryable()
        })?;
    if !output.status.success() {
        return Err(LibraryError::new(
            LibraryErrorCode::OcrPageFailed,
            "PDF page could not be rendered for OCR",
        )
        .retryable());
    }
    let rendered = fs::read_dir(work_dir)
        .map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::OcrPageFailed,
                "rendered PDF page could not be read",
            )
            .retryable()
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
                && path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&format!("page-{page}-")))
        })
        .ok_or_else(|| {
            LibraryError::new(
                LibraryErrorCode::OcrPageFailed,
                "PDF renderer did not create a page image",
            )
            .retryable()
        })?;
    image::open(&rendered)
        .map_err(|_| {
            LibraryError::new(
                LibraryErrorCode::OcrPageFailed,
                "rendered PDF page could not be decoded",
            )
            .retryable()
        })
        .map(|image| image.to_rgb8())
}

fn hash_file(path: &Path) -> LibraryResult<String> {
    let bytes = fs::read(path).map_err(|_| {
        LibraryError::new(
            LibraryErrorCode::OcrInputChanged,
            "document could not be read for OCR",
        )
        .retryable()
    })?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn remove_ocr_workspace(work_dir: &Path) {
    let temp_root = std::env::temp_dir();
    if work_dir.starts_with(&temp_root)
        && work_dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("moji-ocr-"))
    {
        let _ = fs::remove_dir_all(work_dir);
    }
}

fn path_string(path: &Path) -> LibraryResult<&str> {
    path.to_str().ok_or_else(|| {
        LibraryError::new(
            LibraryErrorCode::OcrModelInvalid,
            "OCR model path is not valid Unicode",
        )
    })
}

fn model_error(error: impl std::fmt::Display) -> LibraryError {
    let message = error.to_string();
    let code = if message.to_ascii_lowercase().contains("dll")
        || message.to_ascii_lowercase().contains("runtime")
    {
        LibraryErrorCode::OcrRuntimeUnavailable
    } else {
        LibraryErrorCode::OcrModelInvalid
    };
    LibraryError::new(code, "local OCR model could not be initialized or run").retryable()
}

fn unrotate_point(x: u32, y: u32, rotation_degrees: u32, width: u32, height: u32) -> OcrPoint {
    let (x, y) = match rotation_degrees {
        90 => (width.saturating_sub(1).saturating_sub(y), x),
        180 => (
            width.saturating_sub(1).saturating_sub(x),
            height.saturating_sub(1).saturating_sub(y),
        ),
        270 => (y, height.saturating_sub(1).saturating_sub(x)),
        _ => (x, y),
    };
    OcrPoint { x, y }
}

#[cfg(test)]
mod tests {
    use super::{has_effective_text, model_paths};

    #[test]
    fn treats_cjk_and_latin_pdf_text_as_a_valid_text_layer() {
        assert!(has_effective_text("This PDF already has searchable text."));
        assert!(has_effective_text("这是一段已经存在的可搜索中文文本内容。"));
        assert!(!has_effective_text("   "));
    }

    #[test]
    fn reports_all_required_offline_assets_when_the_model_is_not_installed() {
        let root =
            std::env::temp_dir().join(format!("moji-ocr-model-missing-{}", std::process::id()));
        let error = model_paths(&root).expect_err("missing model assets must be explicit");
        assert_eq!(error.code, "OCR_MODEL_MISSING");
        let missing = error.details.unwrap()["missingAssets"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(missing, 4);
    }
}
