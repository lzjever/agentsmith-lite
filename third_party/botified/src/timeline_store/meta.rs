use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::event::EventCursor;
use crate::private_fs::{ensure_private_dir, open_private_file, private_open_options};

use super::{sync_dir, TimelineStoreError};

pub(super) const META_FILE: &str = "meta.json";
const META_TMP_FILE: &str = "meta.json.tmp";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct TimelineStoreMeta {
    pub(super) version: u32,
    pub(super) instance: String,
    pub(super) latest_seq: u64,
    pub(super) latest_cursor: String,
    #[serde(default)]
    pub(super) last_append_time_unix_ms: i64,
    #[serde(default)]
    pub(super) earliest_seq: Option<u64>,
    #[serde(default)]
    pub(super) earliest_cursor: Option<String>,
    #[serde(default)]
    pub(super) latest_retained_seq: Option<u64>,
    #[serde(default)]
    pub(super) latest_retained_cursor: Option<String>,
}

#[derive(Debug)]
pub(super) enum MetaRead {
    Missing,
    Invalid,
    Valid(TimelineStoreMeta),
}

pub(super) fn read_meta(path: &Path) -> Result<MetaRead, TimelineStoreError> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(meta) if valid_meta(&meta) => Ok(MetaRead::Valid(meta)),
            Ok(_) | Err(_) => Ok(MetaRead::Invalid),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(MetaRead::Missing),
        Err(source) => Err(TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn valid_meta(meta: &TimelineStoreMeta) -> bool {
    meta.version == 1
        && EventCursor::for_instance(meta.instance.clone(), meta.latest_seq)
            .map(|cursor| cursor.to_string() == meta.latest_cursor)
            .unwrap_or(false)
}

pub(super) fn write_meta_atomic(path: &Path, bytes: &[u8]) -> Result<(), TimelineStoreError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    ensure_private_dir(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })?;

    let tmp_path = parent.join(META_TMP_FILE);
    remove_file_if_exists(&tmp_path)?;
    if let Err(error) = write_meta_tmp(&tmp_path, path, bytes) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    fs::rename(&tmp_path, path).map_err(|source| {
        let _ = fs::remove_file(&tmp_path);
        TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }
    })?;
    sync_dir(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn write_meta_tmp(
    tmp_path: &Path,
    target_path: &Path,
    bytes: &[u8],
) -> Result<(), TimelineStoreError> {
    let mut options = private_open_options();
    options.create_new(true).write(true);
    let mut file =
        open_private_file(&options, tmp_path).map_err(|source| TimelineStoreError::Io {
            path: tmp_path.to_path_buf(),
            source,
        })?;
    file.write_all(bytes)
        .map_err(|source| TimelineStoreError::Io {
            path: target_path.to_path_buf(),
            source,
        })?;
    file.flush().map_err(|source| TimelineStoreError::Io {
        path: target_path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| TimelineStoreError::Io {
        path: target_path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), TimelineStoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}
