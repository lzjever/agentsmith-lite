use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::multipart::MultipartRejection;
use axum::extract::{Multipart, Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit};
use tokio::time::{timeout_at, Instant};

use crate::files::{ExternalFileMetadata, FileRecord, FileSource, FileStore};

use super::{authorize, run_file_store_task, ApiError, HttpState, HTTP_UPLOAD_BODY_READ_TIMEOUT};

#[derive(Debug, Serialize)]
pub(super) struct FilesUploadResponse {
    ok: bool,
    files: Vec<ExternalFileMetadata>,
}

pub(super) async fn upload_files_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Json<FilesUploadResponse>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = state
        .file_store
        .as_ref()
        .ok_or_else(ApiError::file_store_unavailable)?
        .clone();
    let upload_permit = state
        .file_upload_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::file_upload_limit())?;
    let multipart = multipart.map_err(ApiError::from_multipart_rejection)?;
    let body_read_deadline = Instant::now() + HTTP_UPLOAD_BODY_READ_TIMEOUT;
    let records =
        upload_multipart_files(store, multipart, upload_permit, body_read_deadline).await?;

    Ok(Json(FilesUploadResponse {
        ok: true,
        files: records
            .into_iter()
            .map(|record| record.external())
            .collect(),
    }))
}

async fn upload_multipart_files(
    store: FileStore,
    mut multipart: Multipart,
    upload_permit: OwnedSemaphorePermit,
    body_read_deadline: Instant,
) -> Result<Vec<FileRecord>, ApiError> {
    let mut transaction = UploadTransaction::start(store.clone(), upload_permit);
    let mut records = Vec::new();
    let mut uploaded_bytes = 0_u64;

    while let Some(field) = match timeout_at(body_read_deadline, multipart.next_field()).await {
        Ok(Ok(field)) => field,
        Ok(Err(error)) => {
            return Err(transaction
                .rollback_with_error(ApiError::from_multipart_error(error))
                .await);
        }
        Err(_) => {
            return Err(transaction
                .rollback_with_error(ApiError::request_body_timeout())
                .await);
        }
    } {
        if field.name() != Some("file") {
            continue;
        }
        if records.len() >= store.options().max_upload_files {
            return Err(transaction
                .rollback_with_error(ApiError::too_many_files())
                .await);
        }

        let filename = match field
            .file_name()
            .map(str::to_owned)
            .filter(|value| !value.trim().is_empty())
        {
            Some(filename) => filename,
            None => {
                return Err(transaction
                    .rollback_with_error(ApiError::invalid_filename(
                        "multipart file part requires a filename",
                    ))
                    .await);
            }
        };
        let mime_type = field.content_type().map(str::to_owned);
        let bytes = match timeout_at(body_read_deadline, field.bytes()).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                return Err(transaction
                    .rollback_with_error(ApiError::from_multipart_error(error))
                    .await);
            }
            Err(_) => {
                return Err(transaction
                    .rollback_with_error(ApiError::request_body_timeout())
                    .await);
            }
        };
        uploaded_bytes = uploaded_bytes.saturating_add(bytes.len() as u64);
        if uploaded_bytes > store.options().max_upload_request_bytes {
            return Err(transaction
                .rollback_with_error(ApiError::upload_too_large())
                .await);
        }

        let stored = transaction.store(filename, mime_type, bytes).await?;
        records.push(stored);
    }

    if records.is_empty() {
        return Err(transaction.rollback_with_error(ApiError::no_files()).await);
    }
    transaction.commit().await?;
    Ok(records)
}

struct UploadTransaction {
    commands: Option<mpsc::UnboundedSender<UploadCommand>>,
    worker: Option<tokio::task::JoinHandle<()>>,
}

impl UploadTransaction {
    fn start(store: FileStore, upload_permit: OwnedSemaphorePermit) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let worker = tokio::task::spawn_blocking(move || {
            upload_transaction_worker(store, upload_permit, receiver)
        });
        Self {
            commands: Some(commands),
            worker: Some(worker),
        }
    }

    async fn store(
        &mut self,
        filename: String,
        mime_type: Option<String>,
        bytes: Bytes,
    ) -> Result<FileRecord, ApiError> {
        let (result, result_rx) = oneshot::channel();
        let command = UploadCommand::Store {
            filename,
            mime_type,
            bytes,
            result,
        };
        if self
            .commands
            .as_ref()
            .is_none_or(|commands| commands.send(command).is_err())
        {
            self.commands.take();
            return self.worker_failed().await;
        }
        match result_rx.await {
            Ok(result) => result.map_err(ApiError::from_upload_file_store),
            Err(_) => {
                self.commands.take();
                self.worker_failed().await
            }
        }
    }

    async fn commit(mut self) -> Result<(), ApiError> {
        let (ready, ready_rx) = oneshot::channel();
        let (accepted, accepted_rx) = oneshot::channel();
        let Some(commands) = self.commands.take() else {
            return self.worker_failed().await;
        };
        if commands
            .send(UploadCommand::Commit { ready, accepted_rx })
            .is_err()
        {
            return self.worker_failed().await;
        }
        drop(commands);
        if ready_rx.await.is_err() {
            return self.worker_failed().await;
        }
        if accepted.send(()).is_err() {
            return self.worker_failed().await;
        }
        drop(self.worker.take());
        Ok(())
    }

    async fn rollback_with_error(mut self, error: ApiError) -> ApiError {
        self.commands.take();
        match self.wait_worker().await {
            Ok(()) => error,
            Err(worker_error) => worker_error,
        }
    }

    async fn worker_failed<T>(&mut self) -> Result<T, ApiError> {
        match self.wait_worker().await {
            Ok(()) => Err(ApiError::file_worker_failed("file upload")),
            Err(error) => Err(error),
        }
    }

    async fn wait_worker(&mut self) -> Result<(), ApiError> {
        let Some(worker) = self.worker.take() else {
            return Err(ApiError::file_worker_failed("file upload"));
        };
        worker
            .await
            .map_err(|error| ApiError::from_file_worker_join("file upload", error))
    }
}

enum UploadCommand {
    Store {
        filename: String,
        mime_type: Option<String>,
        bytes: Bytes,
        result: oneshot::Sender<Result<FileRecord, crate::files::FileStoreError>>,
    },
    Commit {
        ready: oneshot::Sender<()>,
        accepted_rx: oneshot::Receiver<()>,
    },
    #[cfg(test)]
    Panic,
}

enum UploadWorkerOutcome {
    Commit,
    Rollback,
    RollbackWithError {
        result: oneshot::Sender<Result<FileRecord, crate::files::FileStoreError>>,
        error: crate::files::FileStoreError,
    },
}

fn upload_transaction_worker(
    store: FileStore,
    _upload_permit: OwnedSemaphorePermit,
    receiver: mpsc::UnboundedReceiver<UploadCommand>,
) {
    let mut records = Vec::new();
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        upload_transaction_loop(&store, &mut records, receiver)
    }));
    match outcome {
        Ok(UploadWorkerOutcome::Commit) => {}
        Ok(UploadWorkerOutcome::Rollback) => rollback_upload_records(&store, &records),
        Ok(UploadWorkerOutcome::RollbackWithError { result, error }) => {
            rollback_upload_records(&store, &records);
            let _ = result.send(Err(error));
        }
        Err(payload) => {
            rollback_upload_records(&store, &records);
            std::panic::resume_unwind(payload);
        }
    }
}

fn upload_transaction_loop(
    store: &FileStore,
    records: &mut Vec<FileRecord>,
    mut receiver: mpsc::UnboundedReceiver<UploadCommand>,
) -> UploadWorkerOutcome {
    loop {
        match receiver.blocking_recv() {
            Some(UploadCommand::Store {
                filename,
                mime_type,
                bytes,
                result,
            }) => match store.store_bytes(
                &filename,
                mime_type.as_deref(),
                &bytes,
                FileSource::Upload,
                None,
            ) {
                Ok(record) => {
                    records.push(record.clone());
                    if result.send(Ok(record)).is_err() {
                        return UploadWorkerOutcome::Rollback;
                    }
                }
                Err(error) => {
                    return UploadWorkerOutcome::RollbackWithError { result, error };
                }
            },
            Some(UploadCommand::Commit { ready, accepted_rx }) => {
                if ready.send(()).is_err() || accepted_rx.blocking_recv().is_err() {
                    return UploadWorkerOutcome::Rollback;
                }
                return UploadWorkerOutcome::Commit;
            }
            #[cfg(test)]
            Some(UploadCommand::Panic) => panic!("injected upload transaction panic"),
            None => return UploadWorkerOutcome::Rollback,
        }
    }
}

fn rollback_upload_records(store: &FileStore, records: &[FileRecord]) {
    for record in records {
        let _ = store.remove_file(&record.file_id);
    }
}

pub(super) async fn download_file_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    AxumPath(file_id): AxumPath<String>,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = state
        .file_store
        .as_ref()
        .ok_or_else(ApiError::file_store_unavailable)?
        .clone();
    let download_permit = Arc::new(
        state
            .file_download_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::file_download_limit())?,
    );
    let blocking_permit = Arc::clone(&download_permit);
    let download = run_file_store_task("file download", move || {
        let _permit = blocking_permit;
        store.download_bytes(&file_id)
    })
    .await?
    .map_err(ApiError::from_download_file_store)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&download.metadata.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&download.bytes.len().to_string())
            .expect("content length should be ascii"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&download.metadata.filename))
            .expect("content-disposition should be ascii"),
    );
    headers.insert(
        "x-botified-sha256",
        HeaderValue::from_str(&download.metadata.sha256).expect("sha256 should be ascii"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", download.metadata.sha256))
            .expect("etag should be ascii"),
    );

    let body = Body::from(Bytes::from_owner(DownloadBodyOwner {
        bytes: download.bytes,
        _permit: download_permit,
    }));
    Ok((headers, body).into_response())
}

struct DownloadBodyOwner {
    bytes: Vec<u8>,
    _permit: Arc<OwnedSemaphorePermit>,
}

impl AsRef<[u8]> for DownloadBodyOwner {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

fn content_disposition(filename: &str) -> String {
    let safe = filename
        .chars()
        .map(|ch| match ch {
            '"' | '\\' => '_',
            ch if ch.is_ascii_graphic() || ch == ' ' => ch,
            _ => '_',
        })
        .collect::<String>();
    format!("attachment; filename=\"{safe}\"")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Arc;

    use axum::body::to_bytes;
    use axum::body::Bytes;
    use axum::response::IntoResponse;
    use serde_json::Value;
    use tokio::sync::Semaphore;

    use crate::files::{FileStore, FileStoreOptions};

    use super::{content_disposition, UploadCommand, UploadTransaction};

    #[test]
    fn content_disposition_replaces_double_quotes() {
        assert_eq!(
            content_disposition("report\"draft.txt"),
            "attachment; filename=\"report_draft.txt\""
        );
    }

    #[tokio::test]
    async fn upload_transaction_worker_panic_rolls_back_prior_success_and_maps_to_safe_500() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let store = FileStore::open(FileStoreOptions::new(temp.path())).expect("open file store");
        let permit = Arc::new(Semaphore::new(1))
            .acquire_owned()
            .await
            .expect("semaphore should be open");
        let mut transaction = UploadTransaction::start(store, permit);
        transaction
            .store(
                "prior.txt".to_owned(),
                Some("text/plain".to_owned()),
                Bytes::from_static(b"prior"),
            )
            .await
            .expect("store prior file");
        transaction
            .commands
            .take()
            .expect("transaction sender")
            .send(UploadCommand::Panic)
            .expect("send panic command");
        let error = transaction
            .worker_failed::<()>()
            .await
            .expect_err("worker panic should fail upload");
        let response = error.into_response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read error response");
        let body: Value = serde_json::from_slice(&bytes).expect("parse error response");
        assert_eq!(body["error"]["code"], "storage_error");
        assert_eq!(body["error"]["message"], "file upload worker failed");
        assert_eq!(directory_entry_count(temp.path().join("objects")), 0);
        assert_eq!(directory_entry_count(temp.path().join("metadata")), 0);
    }

    #[tokio::test]
    async fn dropped_store_result_receiver_rolls_back_before_worker_exit() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let store = FileStore::open(FileStoreOptions::new(temp.path())).expect("open file store");
        let permit = Arc::new(Semaphore::new(1))
            .acquire_owned()
            .await
            .expect("semaphore should be open");
        let mut transaction = UploadTransaction::start(store, permit);
        let (result, result_rx) = tokio::sync::oneshot::channel();
        transaction
            .commands
            .take()
            .expect("transaction sender")
            .send(UploadCommand::Store {
                filename: "unclaimed.txt".to_owned(),
                mime_type: Some("text/plain".to_owned()),
                bytes: Bytes::from_static(b"unclaimed"),
                result,
            })
            .expect("send store command");
        drop(result_rx);
        transaction
            .wait_worker()
            .await
            .expect("worker should roll back normally");

        assert_eq!(directory_entry_count(temp.path().join("objects")), 0);
        assert_eq!(directory_entry_count(temp.path().join("metadata")), 0);
    }

    fn directory_entry_count(path: std::path::PathBuf) -> usize {
        fs::read_dir(path).expect("read store directory").count()
    }
}
