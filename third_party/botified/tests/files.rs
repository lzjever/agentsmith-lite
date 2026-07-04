use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use botified::files::{FileRecord, FileSource, FileStore, FileStoreErrorKind, FileStoreOptions};

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[test]
fn file_store_writes_bytes_with_metadata_object_layout_and_sha256() {
    let root = temp_dir("bytes-layout");
    let store = FileStore::open(FileStoreOptions::new(root.clone())).expect("open store");

    let record = store
        .store_bytes(
            "report.txt",
            Some("text/plain"),
            b"hello",
            FileSource::Upload,
            None,
        )
        .expect("store bytes");

    assert!(record.file_id.starts_with("file_"));
    assert_eq!(record.filename, "report.txt");
    assert_eq!(record.mime_type, "text/plain");
    assert_eq!(record.size_bytes, 5);
    assert_eq!(
        record.sha256,
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    assert_eq!(record.source, FileSource::Upload);
    assert!(record.agent_path.starts_with(root.join("objects")));
    assert_eq!(
        fs::read(&record.agent_path).expect("object bytes"),
        b"hello"
    );
    assert!(root
        .join("metadata")
        .join(format!("{}.json", record.file_id))
        .exists());

    let external = serde_json::to_value(record.external()).expect("external metadata json");
    assert_eq!(
        external["download_url"],
        format!("/v1/files/{}", record.file_id)
    );
    assert!(
        external.get("agent_path").is_none(),
        "external metadata must not leak agent_path"
    );
}

#[test]
fn file_store_copies_files_and_allows_empty_objects() {
    let root = temp_dir("copy-empty");
    let source = root.join("source.bin");
    fs::create_dir_all(&root).expect("create root");
    fs::write(&source, []).expect("write source");
    let store = FileStore::open(FileStoreOptions::new(root.join("store"))).expect("open store");

    let record = store
        .copy_from_path(
            &source,
            Some("empty.bin"),
            None,
            FileSource::Published,
            Some("empty result".to_owned()),
        )
        .expect("copy source");

    assert_eq!(record.filename, "empty.bin");
    assert_eq!(record.mime_type, "application/octet-stream");
    assert_eq!(record.size_bytes, 0);
    assert_eq!(record.sha256, EMPTY_SHA256);
    assert_eq!(record.source, FileSource::Published);
    assert_eq!(record.description.as_deref(), Some("empty result"));
    assert_eq!(
        store
            .download_bytes(&record.file_id)
            .expect("download empty")
            .bytes,
        b""
    );
}

#[test]
fn file_store_rejects_invalid_file_ids_and_filenames() {
    let store = FileStore::open(FileStoreOptions::new(temp_dir("invalid"))).expect("open store");

    let invalid_id = store.metadata("../escape").expect_err("invalid file id");
    assert_eq!(invalid_id.kind(), FileStoreErrorKind::InvalidFileId);

    let invalid_path_id = store
        .download_bytes("file_0000000000000000000000000000000/")
        .expect_err("path id should fail");
    assert_eq!(invalid_path_id.kind(), FileStoreErrorKind::InvalidFileId);

    let empty_name = store
        .store_bytes("", Some("text/plain"), b"x", FileSource::Upload, None)
        .expect_err("empty filename should fail");
    assert_eq!(empty_name.kind(), FileStoreErrorKind::InvalidFilename);

    let path_name = store
        .store_bytes(
            "../secret.txt",
            Some("text/plain"),
            b"x",
            FileSource::Upload,
            None,
        )
        .expect_err("path filename should fail");
    assert_eq!(path_name.kind(), FileStoreErrorKind::InvalidFilename);
}

#[test]
fn file_store_recovery_is_non_blocking_for_corrupt_metadata_and_missing_objects() {
    let root = temp_dir("recovery");
    let store = FileStore::open(FileStoreOptions::new(root.clone())).expect("open store");
    let valid = store
        .store_bytes(
            "valid.txt",
            Some("text/plain"),
            b"valid",
            FileSource::Upload,
            None,
        )
        .expect("store valid");
    let missing = store
        .store_bytes(
            "missing.txt",
            Some("text/plain"),
            b"gone",
            FileSource::Upload,
            None,
        )
        .expect("store missing");

    fs::remove_file(&missing.agent_path).expect("remove object");
    let corrupt_id = "file_11111111111111111111111111111111";
    fs::write(
        root.join("metadata").join(format!("{corrupt_id}.json")),
        b"{not json",
    )
    .expect("write corrupt metadata");
    fs::write(
        root.join("objects")
            .join("file_22222222222222222222222222222222"),
        b"orphan",
    )
    .expect("write orphan object");

    let reopened = FileStore::open(FileStoreOptions::new(root.clone())).expect("reopen store");
    assert_eq!(
        reopened
            .download_bytes(&valid.file_id)
            .expect("valid object still downloads")
            .bytes,
        b"valid"
    );
    let missing_object = reopened
        .download_bytes(&missing.file_id)
        .expect_err("metadata without object should be structured");
    assert_eq!(missing_object.kind(), FileStoreErrorKind::ObjectMissing);
    assert!(
        !root
            .join("objects")
            .join("file_22222222222222222222222222222222")
            .exists(),
        "orphan object should be cleaned during recovery"
    );
    assert!(
        fs::read_dir(root.join("corrupt"))
            .expect("read corrupt dir")
            .any(|entry| entry
                .expect("corrupt entry")
                .file_name()
                .to_string_lossy()
                .contains(corrupt_id)),
        "corrupt metadata should be isolated"
    );
}

#[test]
fn file_store_expired_files_return_structured_errors() {
    let store = FileStore::open(FileStoreOptions::new(temp_dir("expired")).with_retention_secs(0))
        .expect("open store");
    let record = store
        .store_bytes(
            "old.txt",
            Some("text/plain"),
            b"old",
            FileSource::Upload,
            None,
        )
        .expect("store expired file");

    let error = store
        .download_bytes(&record.file_id)
        .expect_err("expired download should fail");

    assert_eq!(error.kind(), FileStoreErrorKind::FileExpired);
    assert_eq!(error.code(), "file_expired");
}

#[test]
fn file_store_touch_extends_retained_until() {
    let root = temp_dir("touch");
    let store = FileStore::open(FileStoreOptions::new(root.clone()).with_retention_secs(3600))
        .expect("open store");
    let record = store
        .store_bytes(
            "touch.txt",
            Some("text/plain"),
            b"touch",
            FileSource::Upload,
            None,
        )
        .expect("store file");
    let shortened = write_retained_until(&root, &record, unix_now_secs().saturating_add(60));

    let touched = store.touch(&record.file_id).expect("touch should succeed");
    let persisted = read_metadata_record(&root, &record.file_id);

    assert!(touched.retained_until > shortened.retained_until);
    assert_eq!(persisted.retained_until, touched.retained_until);
}

#[test]
fn file_store_cleanup_deletes_expired_unprotected_and_keeps_protected() {
    let root = temp_dir("cleanup");
    let store = FileStore::open(FileStoreOptions::new(root.clone()).with_retention_secs(3600))
        .expect("open store");
    let expired = store
        .store_bytes(
            "expired.txt",
            Some("text/plain"),
            b"expired",
            FileSource::Upload,
            None,
        )
        .expect("store expired");
    let protected = store
        .store_bytes(
            "protected.txt",
            Some("text/plain"),
            b"protected",
            FileSource::Upload,
            None,
        )
        .expect("store protected");
    write_retained_until(&root, &expired, unix_now_secs().saturating_sub(1));
    write_retained_until(&root, &protected, unix_now_secs().saturating_sub(1));

    let protected_ids = HashSet::from([protected.file_id.clone()]);
    store
        .cleanup(&protected_ids)
        .expect("cleanup should succeed");

    assert!(!expired.agent_path.exists());
    assert!(!metadata_path(&root, &expired.file_id).exists());
    assert!(protected.agent_path.exists());
    assert!(metadata_path(&root, &protected.file_id).exists());
}

#[test]
fn file_store_capacity_check_cleans_expired_objects_first() {
    let root = temp_dir("capacity-cleanup");
    let store = FileStore::open(
        FileStoreOptions::new(root)
            .with_retention_secs(0)
            .with_max_store_bytes(5),
    )
    .expect("open store");
    let first = store
        .store_bytes(
            "first.txt",
            Some("text/plain"),
            b"12345",
            FileSource::Upload,
            None,
        )
        .expect("store first");

    let second = store
        .store_bytes(
            "second.txt",
            Some("text/plain"),
            b"abcde",
            FileSource::Upload,
            None,
        )
        .expect("expired first object should be cleaned before capacity check");

    assert!(!first.agent_path.exists());
    assert!(second.agent_path.exists());
}

#[test]
fn file_store_runtime_corrupt_metadata_does_not_block_new_writes() {
    let root = temp_dir("runtime-corrupt-cleanup");
    let store = FileStore::open(FileStoreOptions::new(root.clone())).expect("open store");
    let corrupt_id = "file_33333333333333333333333333333333";
    fs::write(metadata_path(&root, corrupt_id), b"{not json").expect("write corrupt metadata");

    let stored = store
        .store_bytes(
            "after-corrupt.txt",
            Some("text/plain"),
            b"after corrupt",
            FileSource::Upload,
            None,
        )
        .expect("store_bytes should isolate corrupt metadata and continue");

    assert!(stored.agent_path.exists());
    assert!(!metadata_path(&root, corrupt_id).exists());
    assert!(
        corrupt_dir_contains(&root, corrupt_id),
        "corrupt metadata should be isolated"
    );

    let corrupt_open_id = "file_44444444444444444444444444444444";
    fs::write(metadata_path(&root, corrupt_open_id), b"{still not json")
        .expect("write second corrupt metadata");
    let source = root.join("source-open.txt");
    fs::write(&source, b"open file").expect("write source file");
    let file = File::open(&source).expect("open source file");

    let copied = store
        .store_open_file(
            "open-after-corrupt.txt",
            Some("text/plain"),
            file,
            FileSource::Upload,
            None,
        )
        .expect("store_open_file should isolate corrupt metadata and continue");

    assert!(copied.agent_path.exists());
    assert!(!metadata_path(&root, corrupt_open_id).exists());
    assert!(
        corrupt_dir_contains(&root, corrupt_open_id),
        "second corrupt metadata should be isolated"
    );
}

fn write_retained_until(root: &Path, record: &FileRecord, retained_until: u64) -> FileRecord {
    let mut updated = record.clone();
    updated.retained_until = retained_until;
    let path = metadata_path(root, &record.file_id);
    let mut bytes = serde_json::to_vec_pretty(&updated).expect("metadata should serialize");
    bytes.push(b'\n');
    fs::write(path, bytes).expect("metadata should write");
    updated
}

fn read_metadata_record(root: &Path, file_id: &str) -> FileRecord {
    let raw = fs::read(metadata_path(root, file_id)).expect("metadata should read");
    serde_json::from_slice(&raw).expect("metadata should parse")
}

fn metadata_path(root: &Path, file_id: &str) -> PathBuf {
    root.join("metadata").join(format!("{file_id}.json"))
}

fn corrupt_dir_contains(root: &Path, file_id: &str) -> bool {
    fs::read_dir(root.join("corrupt"))
        .expect("read corrupt dir")
        .any(|entry| {
            entry
                .expect("corrupt entry")
                .file_name()
                .to_string_lossy()
                .contains(file_id)
        })
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_secs()
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-files-test-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}
