use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::private_fs::{
    ensure_private_dir, ensure_private_dir_with_legacy_tree, open_private_file,
    private_open_options, tighten_private_file_path,
};

pub const DEFAULT_FILES_ROOT_DIR: &str = "files";
pub const DEFAULT_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const DEFAULT_MAX_UPLOAD_FILES: usize = 16;
pub const DEFAULT_MAX_UPLOAD_REQUEST_BYTES: u64 = 100 * 1024 * 1024;
pub const DEFAULT_MAX_MESSAGE_FILES: usize = 16;
pub const DEFAULT_MAX_MESSAGE_REFERENCED_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const DEFAULT_MAX_STORE_BYTES: u64 = 1024 * 1024 * 1024;
pub const DEFAULT_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

const MAX_STORE_ENTRIES: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStoreOptions {
    pub root_dir: PathBuf,
    pub max_file_bytes: u64,
    pub max_upload_files: usize,
    pub max_upload_request_bytes: u64,
    pub max_message_files: usize,
    pub max_message_referenced_file_bytes: u64,
    pub max_store_bytes: u64,
    pub retention_secs: u64,
}

impl FileStoreOptions {
    pub fn new(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_upload_files: DEFAULT_MAX_UPLOAD_FILES,
            max_upload_request_bytes: DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
            max_message_files: DEFAULT_MAX_MESSAGE_FILES,
            max_message_referenced_file_bytes: DEFAULT_MAX_MESSAGE_REFERENCED_FILE_BYTES,
            max_store_bytes: DEFAULT_MAX_STORE_BYTES,
            retention_secs: DEFAULT_RETENTION_SECS,
        }
    }

    pub fn with_max_file_bytes(mut self, value: u64) -> Self {
        self.max_file_bytes = value;
        self
    }

    pub fn with_max_upload_files(mut self, value: usize) -> Self {
        self.max_upload_files = value;
        self
    }

    pub fn with_max_upload_request_bytes(mut self, value: u64) -> Self {
        self.max_upload_request_bytes = value;
        self
    }

    pub fn with_max_message_files(mut self, value: usize) -> Self {
        self.max_message_files = value;
        self
    }

    pub fn with_max_message_referenced_file_bytes(mut self, value: u64) -> Self {
        self.max_message_referenced_file_bytes = value;
        self
    }

    pub fn with_max_store_bytes(mut self, value: u64) -> Self {
        self.max_store_bytes = value;
        self
    }

    pub fn with_retention_secs(mut self, value: u64) -> Self {
        self.retention_secs = value;
        self
    }
}

#[derive(Debug, Clone)]
pub struct FileStore {
    inner: Arc<FileStoreInner>,
}

#[derive(Debug)]
struct FileStoreInner {
    options: FileStoreOptions,
    objects_dir: PathBuf,
    metadata_dir: PathBuf,
    tmp_dir: PathBuf,
    corrupt_dir: PathBuf,
    lock: Mutex<StoreUsage>,
    #[cfg(test)]
    full_verification_count: AtomicUsize,
}

#[derive(Debug, Default)]
struct StoreUsage {
    object_bytes: u64,
    retained_entries: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileSource {
    Upload,
    Published,
}

impl FileSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Published => "published",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub created_at: u64,
    pub retained_until: u64,
    pub source: FileSource,
    pub agent_path: PathBuf,
    pub description: Option<String>,
}

impl FileRecord {
    pub fn external(&self) -> ExternalFileMetadata {
        ExternalFileMetadata {
            file_id: self.file_id.clone(),
            filename: self.filename.clone(),
            mime_type: self.mime_type.clone(),
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
            download_url: format!("/v1/files/{}", self.file_id),
            source: self.source,
            description: self.description.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalFileMetadata {
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub download_url: String,
    pub source: FileSource,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDownload {
    pub metadata: FileRecord,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStoreErrorKind {
    InvalidFileId,
    InvalidFilename,
    FileTooLarge,
    StoreTooLarge,
    FileNotFound,
    FileExpired,
    ObjectMissing,
    CorruptMetadata,
    Storage,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct FileStoreError {
    kind: FileStoreErrorKind,
    code: &'static str,
    message: String,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl FileStoreError {
    pub fn kind(&self) -> FileStoreErrorKind {
        self.kind
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    fn new(kind: FileStoreErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
            source: None,
        }
    }

    fn with_source(
        kind: FileStoreErrorKind,
        code: &'static str,
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            kind,
            code,
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    fn invalid_file_id(file_id: &str) -> Self {
        Self::new(
            FileStoreErrorKind::InvalidFileId,
            "invalid_file_id",
            format!("invalid file id: {file_id}"),
        )
    }

    fn invalid_filename(filename: &str) -> Self {
        Self::new(
            FileStoreErrorKind::InvalidFilename,
            "invalid_filename",
            format!("invalid filename: {filename}"),
        )
    }

    fn file_too_large(limit: u64) -> Self {
        Self::new(
            FileStoreErrorKind::FileTooLarge,
            "file_too_large",
            format!("file exceeds max_file_bytes limit of {limit}"),
        )
    }

    fn store_too_large(limit: u64) -> Self {
        Self::new(
            FileStoreErrorKind::StoreTooLarge,
            "store_too_large",
            format!("store exceeds max_store_bytes limit of {limit}"),
        )
    }

    fn too_many_store_entries(limit: usize) -> Self {
        Self::new(
            FileStoreErrorKind::StoreTooLarge,
            "store_too_large",
            format!("store exceeds retained entry limit of {limit}"),
        )
    }

    fn not_found(file_id: &str) -> Self {
        Self::new(
            FileStoreErrorKind::FileNotFound,
            "file_not_found",
            format!("file not found: {file_id}"),
        )
    }

    fn expired(file_id: &str) -> Self {
        Self::new(
            FileStoreErrorKind::FileExpired,
            "file_expired",
            format!("file expired: {file_id}"),
        )
    }

    fn object_missing(file_id: &str) -> Self {
        Self::new(
            FileStoreErrorKind::ObjectMissing,
            "file_object_missing",
            format!("file object missing: {file_id}"),
        )
    }

    fn corrupt_metadata(
        file_id: &str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::with_source(
            FileStoreErrorKind::CorruptMetadata,
            "corrupt_metadata",
            format!("file metadata is corrupt: {file_id}"),
            source,
        )
    }

    fn corrupt_metadata_message(file_id: &str) -> Self {
        Self::new(
            FileStoreErrorKind::CorruptMetadata,
            "corrupt_metadata",
            format!("file metadata is corrupt: {file_id}"),
        )
    }

    fn storage(operation: impl Into<String>, source: io::Error) -> Self {
        Self::with_source(
            FileStoreErrorKind::Storage,
            "storage_error",
            operation.into(),
            source,
        )
    }

    fn storage_message(message: impl Into<String>) -> Self {
        Self::new(FileStoreErrorKind::Storage, "storage_error", message)
    }
}

impl FileStore {
    pub fn open(options: FileStoreOptions) -> Result<Self, FileStoreError> {
        if options.root_dir.as_os_str().is_empty() {
            return Err(FileStoreError::storage_message(
                "files.root_dir must not be empty",
            ));
        }

        let objects_dir = options.root_dir.join("objects");
        let metadata_dir = options.root_dir.join("metadata");
        let tmp_dir = options.root_dir.join("tmp");
        let corrupt_dir = options.root_dir.join("corrupt");
        for dir in [&options.root_dir, &objects_dir, &metadata_dir, &tmp_dir] {
            ensure_private_dir(dir).map_err(|error| {
                FileStoreError::storage(format!("failed to create {}", dir.display()), error)
            })?;
        }
        ensure_private_dir_with_legacy_tree(&corrupt_dir).map_err(|error| {
            FileStoreError::storage(
                format!("failed to create or secure {}", corrupt_dir.display()),
                error,
            )
        })?;

        let usage = recover_store(&objects_dir, &metadata_dir, &tmp_dir, &corrupt_dir)?;

        Ok(Self {
            inner: Arc::new(FileStoreInner {
                options,
                objects_dir,
                metadata_dir,
                tmp_dir,
                corrupt_dir,
                lock: Mutex::new(usage),
                #[cfg(test)]
                full_verification_count: AtomicUsize::new(0),
            }),
        })
    }

    pub fn options(&self) -> &FileStoreOptions {
        &self.inner.options
    }

    pub fn store_bytes(
        &self,
        filename: &str,
        mime_type: Option<&str>,
        bytes: &[u8],
        source: FileSource,
        description: Option<String>,
    ) -> Result<FileRecord, FileStoreError> {
        self.store_reader(filename, mime_type, Cursor::new(bytes), source, description)
    }

    pub fn copy_from_path(
        &self,
        path: &Path,
        filename: Option<&str>,
        mime_type: Option<&str>,
        source: FileSource,
        description: Option<String>,
    ) -> Result<FileRecord, FileStoreError> {
        let metadata = fs::metadata(path).map_err(|error| {
            FileStoreError::storage(format!("failed to inspect {}", path.display()), error)
        })?;
        if !metadata.is_file() {
            return Err(FileStoreError::storage_message(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        let filename = filename
            .map(ToOwned::to_owned)
            .or_else(|| {
                path.file_name()
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .ok_or_else(|| FileStoreError::invalid_filename(""))?;
        let file = File::open(path).map_err(|error| {
            FileStoreError::storage(format!("failed to open {}", path.display()), error)
        })?;
        self.store_open_file(&filename, mime_type, file, source, description)
    }

    pub fn store_open_file(
        &self,
        filename: &str,
        mime_type: Option<&str>,
        file: File,
        source: FileSource,
        description: Option<String>,
    ) -> Result<FileRecord, FileStoreError> {
        let metadata = file
            .metadata()
            .map_err(|error| FileStoreError::storage("failed to inspect open file", error))?;
        if !metadata.is_file() {
            return Err(FileStoreError::storage_message(
                "open file is not a regular file",
            ));
        }
        self.store_reader(filename, mime_type, file, source, description)
    }

    pub fn metadata(&self, file_id: &str) -> Result<FileRecord, FileStoreError> {
        let file_id = validate_file_id(file_id)?;
        let record = self.read_metadata(&file_id)?;
        self.ensure_available(&record)?;
        Ok(record)
    }

    pub fn external_metadata(&self, file_id: &str) -> Result<ExternalFileMetadata, FileStoreError> {
        Ok(self.metadata(file_id)?.external())
    }

    pub(crate) fn verify_file(&self, file_id: &str) -> Result<FileRecord, FileStoreError> {
        self.verify_file_with_consumer(file_id, io::sink())
            .map(|(metadata, _)| metadata)
    }

    #[cfg(test)]
    pub(crate) fn full_verification_count(&self) -> usize {
        self.inner.full_verification_count.load(Ordering::Relaxed)
    }

    pub fn download_bytes(&self, file_id: &str) -> Result<FileDownload, FileStoreError> {
        let (metadata, bytes) = self.verify_file_with_consumer(file_id, Vec::new())?;
        Ok(FileDownload { metadata, bytes })
    }

    fn verify_file_with_consumer<W: Write>(
        &self,
        file_id: &str,
        mut consumer: W,
    ) -> Result<(FileRecord, W), FileStoreError> {
        let file_id = validate_file_id(file_id)?;
        let metadata = self.read_metadata(&file_id)?;
        let mut object = self.open_available_object(&metadata)?;
        let object_len = object
            .metadata()
            .map_err(|error| FileStoreError::storage("failed to inspect stored object", error))?
            .len();
        if object_len != metadata.size_bytes
            || object_len > self.inner.options.max_file_bytes
            || usize::try_from(object_len).is_err()
        {
            return Err(FileStoreError::corrupt_metadata_message(&file_id));
        }
        let read_limit = object_len
            .checked_add(1)
            .ok_or_else(|| FileStoreError::corrupt_metadata_message(&file_id))?;
        let mut reader = (&mut object).take(read_limit);
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| FileStoreError::storage("failed to read stored object", error))?;
            if read == 0 {
                break;
            }
            size_bytes = size_bytes
                .checked_add(read as u64)
                .ok_or_else(|| FileStoreError::corrupt_metadata_message(&file_id))?;
            hasher.update(&buffer[..read]);
            consumer.write_all(&buffer[..read]).map_err(|error| {
                FileStoreError::storage("failed to consume stored object", error)
            })?;
        }
        let actual_sha256 = hex::encode(hasher.finalize());
        #[cfg(test)]
        self.inner
            .full_verification_count
            .fetch_add(1, Ordering::Relaxed);
        if size_bytes != metadata.size_bytes || actual_sha256 != metadata.sha256 {
            return Err(FileStoreError::corrupt_metadata_message(&file_id));
        }
        Ok((metadata, consumer))
    }

    pub fn touch(&self, file_id: &str) -> Result<FileRecord, FileStoreError> {
        let records = self.touch_many(&[file_id.to_owned()])?;
        records
            .into_iter()
            .next()
            .ok_or_else(|| FileStoreError::storage_message("touch did not update metadata"))
    }

    pub fn touch_many(&self, file_ids: &[String]) -> Result<Vec<FileRecord>, FileStoreError> {
        let file_ids = file_ids
            .iter()
            .map(|file_id| validate_file_id(file_id))
            .collect::<Result<Vec<_>, _>>()?;
        if file_ids.is_empty() {
            return Ok(Vec::new());
        }

        let _guard = self
            .inner
            .lock
            .lock()
            .map_err(|_| FileStoreError::storage_message("file store lock poisoned"))?;
        let retained_until = unix_now().saturating_add(self.inner.options.retention_secs);
        let mut records = Vec::with_capacity(file_ids.len());
        for file_id in &file_ids {
            let mut record = self.read_metadata(file_id)?;
            self.ensure_available(&record)?;
            record.retained_until = record.retained_until.max(retained_until);
            records.push(record);
        }
        for record in &records {
            self.write_metadata_atomic(record, "touch")?;
        }
        Ok(records)
    }

    pub fn cleanup(&self, protected_file_ids: &HashSet<String>) -> Result<(), FileStoreError> {
        let protected_file_ids = protected_file_ids
            .iter()
            .map(|file_id| validate_file_id(file_id))
            .collect::<Result<HashSet<_>, _>>()?;
        let mut usage = self
            .inner
            .lock
            .lock()
            .map_err(|_| FileStoreError::storage_message("file store lock poisoned"))?;
        self.cleanup_locked(&protected_file_ids, &mut usage)
    }

    pub fn remove_file(&self, file_id: &str) -> Result<(), FileStoreError> {
        let file_id = validate_file_id(file_id)?;
        let mut usage = self
            .inner
            .lock
            .lock()
            .map_err(|_| FileStoreError::storage_message("file store lock poisoned"))?;
        remove_file_if_exists(self.object_path(&file_id))?;
        remove_file_if_exists(self.metadata_path(&file_id))?;
        *usage = self.current_store_usage()?;
        Ok(())
    }

    fn store_reader(
        &self,
        filename: &str,
        mime_type: Option<&str>,
        mut reader: impl Read,
        source: FileSource,
        description: Option<String>,
    ) -> Result<FileRecord, FileStoreError> {
        let filename = validate_filename(filename)?;
        let mime_type = normalize_mime_type(mime_type);
        let mut usage = self
            .inner
            .lock
            .lock()
            .map_err(|_| FileStoreError::storage_message("file store lock poisoned"))?;
        let file_id = self.new_file_id()?;
        let object_path = self.object_path(&file_id);
        let object_tmp = self.tmp_path(&format!("{file_id}.object.tmp"));
        let metadata_tmp = self.tmp_path(&format!("{file_id}.metadata.tmp"));

        let write_result = self.write_object_tmp(&object_tmp, &mut reader);
        let (size_bytes, sha256) = match write_result {
            Ok(result) => result,
            Err(error) => {
                let _ = fs::remove_file(&object_tmp);
                return Err(error);
            }
        };

        if let Err(error) = self.cleanup_locked(&HashSet::new(), &mut usage) {
            let _ = fs::remove_file(&object_tmp);
            return Err(error);
        }
        let exceeds_byte_capacity = usage
            .object_bytes
            .checked_add(size_bytes)
            .is_none_or(|bytes| bytes > self.inner.options.max_store_bytes);
        if exceeds_byte_capacity {
            let _ = fs::remove_file(&object_tmp);
            return Err(FileStoreError::store_too_large(
                self.inner.options.max_store_bytes,
            ));
        }
        let exceeds_entry_capacity = usage
            .retained_entries
            .checked_add(1)
            .is_none_or(|entries| entries > MAX_STORE_ENTRIES);
        if exceeds_entry_capacity {
            let _ = fs::remove_file(&object_tmp);
            return Err(FileStoreError::too_many_store_entries(MAX_STORE_ENTRIES));
        }

        fs::rename(&object_tmp, &object_path).map_err(|error| {
            let _ = fs::remove_file(&object_tmp);
            FileStoreError::storage(
                format!(
                    "failed to publish object {} to {}",
                    object_tmp.display(),
                    object_path.display()
                ),
                error,
            )
        })?;
        if let Err(error) = sync_dir(&self.inner.objects_dir) {
            let _ = fs::remove_file(&object_path);
            return Err(FileStoreError::storage(
                format!("failed to sync {}", self.inner.objects_dir.display()),
                error,
            ));
        }

        let now = unix_now();
        let retained_until = now.saturating_add(self.inner.options.retention_secs);
        let record = FileRecord {
            file_id: file_id.clone(),
            filename,
            mime_type,
            size_bytes,
            sha256,
            created_at: now,
            retained_until,
            source,
            agent_path: object_path.clone(),
            description,
        };

        if let Err(error) = self.write_metadata_tmp(&metadata_tmp, &record) {
            let _ = fs::remove_file(&metadata_tmp);
            let _ = fs::remove_file(&object_path);
            return Err(error);
        }
        let metadata_path = self.metadata_path(&file_id);
        fs::rename(&metadata_tmp, &metadata_path).map_err(|error| {
            let _ = fs::remove_file(&metadata_tmp);
            let _ = fs::remove_file(&object_path);
            FileStoreError::storage(
                format!(
                    "failed to publish metadata {} to {}",
                    metadata_tmp.display(),
                    metadata_path.display()
                ),
                error,
            )
        })?;
        if let Err(error) = sync_dir(&self.inner.metadata_dir) {
            let _ = fs::remove_file(&metadata_path);
            let _ = fs::remove_file(&object_path);
            return Err(FileStoreError::storage(
                format!("failed to sync {}", self.inner.metadata_dir.display()),
                error,
            ));
        }

        usage.object_bytes += size_bytes;
        usage.retained_entries += 1;
        Ok(record)
    }

    fn write_object_tmp(
        &self,
        object_tmp: &Path,
        reader: &mut impl Read,
    ) -> Result<(u64, String), FileStoreError> {
        let mut file = create_new_file(object_tmp)?;
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| FileStoreError::storage("failed to read file content", error))?;
            if read == 0 {
                break;
            }
            size_bytes = size_bytes
                .checked_add(read as u64)
                .ok_or_else(|| FileStoreError::file_too_large(self.inner.options.max_file_bytes))?;
            if size_bytes > self.inner.options.max_file_bytes {
                return Err(FileStoreError::file_too_large(
                    self.inner.options.max_file_bytes,
                ));
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).map_err(|error| {
                FileStoreError::storage(format!("failed to write {}", object_tmp.display()), error)
            })?;
        }
        file.flush().map_err(|error| {
            FileStoreError::storage(format!("failed to flush {}", object_tmp.display()), error)
        })?;
        file.sync_all().map_err(|error| {
            FileStoreError::storage(format!("failed to sync {}", object_tmp.display()), error)
        })?;
        drop(file);
        Ok((size_bytes, hex::encode(hasher.finalize())))
    }

    fn write_metadata_tmp(
        &self,
        metadata_tmp: &Path,
        record: &FileRecord,
    ) -> Result<(), FileStoreError> {
        let mut file = create_new_file(metadata_tmp)?;
        serde_json::to_writer_pretty(&mut file, record).map_err(|error| {
            FileStoreError::with_source(
                FileStoreErrorKind::Storage,
                "storage_error",
                format!("failed to serialize {}", metadata_tmp.display()),
                error,
            )
        })?;
        file.write_all(b"\n").map_err(|error| {
            FileStoreError::storage(format!("failed to write {}", metadata_tmp.display()), error)
        })?;
        file.flush().map_err(|error| {
            FileStoreError::storage(format!("failed to flush {}", metadata_tmp.display()), error)
        })?;
        file.sync_all().map_err(|error| {
            FileStoreError::storage(format!("failed to sync {}", metadata_tmp.display()), error)
        })?;
        Ok(())
    }

    fn write_metadata_atomic(
        &self,
        record: &FileRecord,
        operation: &str,
    ) -> Result<(), FileStoreError> {
        let metadata_tmp = self.tmp_path(&format!("{}.metadata.{operation}.tmp", record.file_id));
        remove_file_if_exists(metadata_tmp.clone())?;
        if let Err(error) = self.write_metadata_tmp(&metadata_tmp, record) {
            let _ = fs::remove_file(&metadata_tmp);
            return Err(error);
        }
        let metadata_path = self.metadata_path(&record.file_id);
        fs::rename(&metadata_tmp, &metadata_path).map_err(|error| {
            let _ = fs::remove_file(&metadata_tmp);
            FileStoreError::storage(
                format!(
                    "failed to publish metadata {} to {}",
                    metadata_tmp.display(),
                    metadata_path.display()
                ),
                error,
            )
        })?;
        sync_dir(&self.inner.metadata_dir).map_err(|error| {
            FileStoreError::storage(
                format!("failed to sync {}", self.inner.metadata_dir.display()),
                error,
            )
        })
    }

    fn read_metadata(&self, file_id: &str) -> Result<FileRecord, FileStoreError> {
        let path = self.metadata_path(file_id);
        let mut options = private_open_options();
        options.read(true);
        let mut file = open_private_file(&options, &path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                FileStoreError::not_found(file_id)
            } else if invalid_private_file_type(&error) {
                FileStoreError::corrupt_metadata_message(file_id)
            } else {
                FileStoreError::storage(format!("failed to open {}", path.display()), error)
            }
        })?;
        let mut raw = Vec::new();
        file.read_to_end(&mut raw).map_err(|error| {
            FileStoreError::storage(format!("failed to read {}", path.display()), error)
        })?;
        let record: FileRecord = serde_json::from_slice(&raw)
            .map_err(|error| FileStoreError::corrupt_metadata(file_id, error))?;
        if record.file_id != file_id {
            return Err(FileStoreError::corrupt_metadata_message(file_id));
        }
        if record.agent_path != self.object_path(file_id) {
            return Err(FileStoreError::corrupt_metadata_message(file_id));
        }
        Ok(record)
    }

    fn ensure_available(&self, record: &FileRecord) -> Result<(), FileStoreError> {
        self.open_available_object(record).map(|_| ())
    }

    fn open_available_object(&self, record: &FileRecord) -> Result<File, FileStoreError> {
        if record.retained_until <= unix_now() {
            return Err(FileStoreError::expired(&record.file_id));
        }
        let path = self.object_path(&record.file_id);
        let mut options = private_open_options();
        options.read(true);
        open_private_file(&options, &path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound || invalid_private_file_type(&error) {
                FileStoreError::object_missing(&record.file_id)
            } else {
                FileStoreError::storage(format!("failed to open {}", path.display()), error)
            }
        })
    }

    fn current_store_usage(&self) -> Result<StoreUsage, FileStoreError> {
        let mut usage = StoreUsage::default();
        for entry in fs::read_dir(&self.inner.objects_dir).map_err(|error| {
            FileStoreError::storage(
                format!("failed to read {}", self.inner.objects_dir.display()),
                error,
            )
        })? {
            let entry = entry.map_err(|error| {
                FileStoreError::storage(
                    format!("failed to read {}", self.inner.objects_dir.display()),
                    error,
                )
            })?;
            let metadata = entry.metadata().map_err(|error| {
                FileStoreError::storage(format!("failed to inspect {:?}", entry.path()), error)
            })?;
            if metadata.is_file() {
                usage.object_bytes = usage.object_bytes.saturating_add(metadata.len());
            }
        }
        for entry in fs::read_dir(&self.inner.metadata_dir).map_err(|error| {
            FileStoreError::storage(
                format!("failed to read {}", self.inner.metadata_dir.display()),
                error,
            )
        })? {
            let entry = entry.map_err(|error| {
                FileStoreError::storage(
                    format!("failed to read {}", self.inner.metadata_dir.display()),
                    error,
                )
            })?;
            let path = entry.path();
            if !entry
                .file_type()
                .map_err(|error| {
                    FileStoreError::storage(format!("failed to inspect {}", path.display()), error)
                })?
                .is_file()
            {
                continue;
            }
            let is_record = path
                .file_name()
                .and_then(|value| value.to_str())
                .and_then(|value| value.strip_suffix(".json"))
                .is_some_and(|file_id| validate_file_id(file_id).is_ok());
            if is_record {
                usage.retained_entries += 1;
            }
        }
        Ok(usage)
    }

    fn cleanup_locked(
        &self,
        protected_file_ids: &HashSet<String>,
        usage: &mut StoreUsage,
    ) -> Result<(), FileStoreError> {
        let now = unix_now();
        let mut expired = Vec::new();
        for entry in fs::read_dir(&self.inner.metadata_dir).map_err(|error| {
            FileStoreError::storage(
                format!("failed to read {}", self.inner.metadata_dir.display()),
                error,
            )
        })? {
            let entry = entry.map_err(|error| {
                FileStoreError::storage(
                    format!("failed to read {}", self.inner.metadata_dir.display()),
                    error,
                )
            })?;
            if !entry.file_type().map(|ty| ty.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(file_id) = file_name.strip_suffix(".json") else {
                continue;
            };
            if validate_file_id(file_id).is_err() {
                continue;
            }
            match self.read_metadata(file_id) {
                Ok(record)
                    if record.retained_until <= now && !protected_file_ids.contains(file_id) =>
                {
                    expired.push(record.file_id);
                }
                Ok(_) => {}
                Err(error) if error.kind() == FileStoreErrorKind::CorruptMetadata => {
                    move_corrupt_metadata(&path, &self.inner.corrupt_dir)?;
                    remove_file_if_exists(self.object_path(file_id))?;
                }
                Err(error) => return Err(error),
            }
        }

        for file_id in expired {
            remove_file_if_exists(self.object_path(&file_id))?;
            remove_file_if_exists(self.metadata_path(&file_id))?;
        }
        *usage = self.current_store_usage()?;
        Ok(())
    }

    fn new_file_id(&self) -> Result<String, FileStoreError> {
        for _ in 0..16 {
            let mut bytes = [0_u8; 16];
            OsRng.fill_bytes(&mut bytes);
            let file_id = format!("file_{}", hex::encode(bytes));
            if !self.object_path(&file_id).exists() && !self.metadata_path(&file_id).exists() {
                return Ok(file_id);
            }
        }
        Err(FileStoreError::storage_message(
            "failed to allocate unique file id",
        ))
    }

    fn object_path(&self, file_id: &str) -> PathBuf {
        self.inner.objects_dir.join(file_id)
    }

    fn metadata_path(&self, file_id: &str) -> PathBuf {
        self.inner.metadata_dir.join(format!("{file_id}.json"))
    }

    fn tmp_path(&self, filename: &str) -> PathBuf {
        self.inner.tmp_dir.join(filename)
    }
}

fn recover_store(
    objects_dir: &Path,
    metadata_dir: &Path,
    tmp_dir: &Path,
    corrupt_dir: &Path,
) -> Result<StoreUsage, FileStoreError> {
    clear_directory(tmp_dir)?;
    let mut metadata_ids = HashSet::new();

    for entry in fs::read_dir(metadata_dir).map_err(|error| {
        FileStoreError::storage(format!("failed to read {}", metadata_dir.display()), error)
    })? {
        let entry = entry.map_err(|error| {
            FileStoreError::storage(format!("failed to read {}", metadata_dir.display()), error)
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            FileStoreError::storage(format!("failed to inspect {}", path.display()), error)
        })?;
        if file_type.is_symlink() {
            remove_file_if_exists(path)?;
            continue;
        }
        if !file_type.is_file() {
            move_corrupt_metadata(&path, corrupt_dir)?;
            continue;
        }
        tighten_private_file_path(&path).map_err(|error| {
            FileStoreError::storage(format!("failed to secure {}", path.display()), error)
        })?;
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            move_corrupt_metadata(&path, corrupt_dir)?;
            continue;
        };
        let Some(file_id) = file_name.strip_suffix(".json") else {
            move_corrupt_metadata(&path, corrupt_dir)?;
            continue;
        };
        if validate_file_id(file_id).is_err() {
            move_corrupt_metadata(&path, corrupt_dir)?;
            continue;
        }
        match fs::read(&path)
            .map_err(|error| {
                FileStoreError::storage(format!("failed to read {}", path.display()), error)
            })
            .and_then(|raw| {
                serde_json::from_slice::<FileRecord>(&raw)
                    .map_err(|error| FileStoreError::corrupt_metadata(file_id, error))
            }) {
            Ok(record)
                if record.file_id == file_id && record.agent_path == objects_dir.join(file_id) =>
            {
                metadata_ids.insert(file_id.to_owned());
            }
            Ok(_) | Err(_) => {
                move_corrupt_metadata(&path, corrupt_dir)?;
            }
        }
    }

    let mut object_bytes = 0_u64;
    for entry in fs::read_dir(objects_dir).map_err(|error| {
        FileStoreError::storage(format!("failed to read {}", objects_dir.display()), error)
    })? {
        let entry = entry.map_err(|error| {
            FileStoreError::storage(format!("failed to read {}", objects_dir.display()), error)
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            FileStoreError::storage(format!("failed to inspect {}", path.display()), error)
        })?;
        if file_type.is_symlink() {
            remove_file_if_exists(path)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(FileStoreError::storage_message(format!(
                "{} is not a regular file",
                path.display()
            )));
        }
        let Some(file_id) = path.file_name().and_then(|value| value.to_str()) else {
            remove_file_if_exists(path)?;
            continue;
        };
        if validate_file_id(file_id).is_err() || !metadata_ids.contains(file_id) {
            remove_file_if_exists(path)?;
        } else {
            tighten_private_file_path(&path).map_err(|error| {
                FileStoreError::storage(format!("failed to secure {}", path.display()), error)
            })?;
            object_bytes = object_bytes.saturating_add(
                entry
                    .metadata()
                    .map_err(|error| {
                        FileStoreError::storage(
                            format!("failed to inspect {}", path.display()),
                            error,
                        )
                    })?
                    .len(),
            );
        }
    }

    Ok(StoreUsage {
        object_bytes,
        retained_entries: metadata_ids.len(),
    })
}

fn clear_directory(dir: &Path) -> Result<(), FileStoreError> {
    for entry in fs::read_dir(dir).map_err(|error| {
        FileStoreError::storage(format!("failed to read {}", dir.display()), error)
    })? {
        let entry = entry.map_err(|error| {
            FileStoreError::storage(format!("failed to read {}", dir.display()), error)
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            FileStoreError::storage(format!("failed to inspect {}", path.display()), error)
        })?;
        if file_type.is_dir() {
            fs::remove_dir_all(&path).map_err(|error| {
                FileStoreError::storage(format!("failed to remove {}", path.display()), error)
            })?;
        } else {
            fs::remove_file(&path).map_err(|error| {
                FileStoreError::storage(format!("failed to remove {}", path.display()), error)
            })?;
        }
    }
    Ok(())
}

fn move_corrupt_metadata(path: &Path, corrupt_dir: &Path) -> Result<(), FileStoreError> {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "metadata.json".to_owned());
    let destination = corrupt_dir.join(format!("{}.{}", unix_now_nanos(), file_name));
    fs::rename(path, &destination).or_else(|rename_error| {
        fs::copy(path, &destination).and_then(|_| fs::remove_file(path)).map_err(|copy_error| {
            FileStoreError::storage(
                format!(
                    "failed to isolate corrupt metadata {} (rename: {rename_error}; copy/remove: {copy_error})",
                    path.display()
                ),
                copy_error,
            )
        })
    })?;
    Ok(())
}

fn create_new_file(path: &Path) -> Result<File, FileStoreError> {
    let mut options = private_open_options();
    options.write(true).create_new(true);
    open_private_file(&options, path).map_err(|error| {
        FileStoreError::storage(format!("failed to create {}", path.display()), error)
    })
}

fn remove_file_if_exists(path: PathBuf) -> Result<(), FileStoreError> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FileStoreError::storage(
            format!("failed to remove {}", path.display()),
            error,
        )),
    }
}

fn sync_dir(path: &Path) -> io::Result<()> {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) if is_unsupported_dir_sync(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn is_unsupported_dir_sync(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
    ) || error.raw_os_error() == Some(22)
}

fn invalid_private_file_type(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::InvalidInput || error.raw_os_error() == Some(libc::ELOOP)
}

fn validate_file_id(file_id: &str) -> Result<String, FileStoreError> {
    let suffix = file_id
        .strip_prefix("file_")
        .ok_or_else(|| FileStoreError::invalid_file_id(file_id))?;
    if suffix.len() != 32 || !suffix.as_bytes().iter().all(u8::is_ascii_hexdigit) {
        return Err(FileStoreError::invalid_file_id(file_id));
    }
    Ok(file_id.to_owned())
}

fn validate_filename(filename: &str) -> Result<String, FileStoreError> {
    let filename = filename.trim();
    if filename.is_empty()
        || filename.len() > 255
        || filename.contains('/')
        || filename.contains('\\')
        || filename.chars().any(|ch| ch.is_control())
    {
        return Err(FileStoreError::invalid_filename(filename));
    }
    Ok(filename.to_owned())
}

fn normalize_mime_type(value: Option<&str>) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return "application/octet-stream".to_owned();
    };
    if value.chars().any(|ch| ch.is_control()) {
        "application/octet-stream".to_owned()
    } else {
        value.to_owned()
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn unix_now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos()
}
