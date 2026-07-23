use std::env;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::private_fs::{
    ensure_private_dir, ensure_private_dir_with_legacy_tree, open_private_file,
    private_open_options,
};

use super::writer::{
    append_serialized_session_line, fail_if_compaction_poisoned, SessionAppendDurability,
};
use super::{
    encode_session_name, existing_shared_session_path, replay, session_path_lock,
    shared_session_path, sync_session_parent_dir, FileSessionRecorder, LoadedSession,
    OpenedSession, SessionError, SessionFileIo, SessionLine, SESSION_VERSION,
};

pub fn open_or_create_session(name: &str) -> Result<OpenedSession, SessionError> {
    open_or_create_session_with_cwd(name, current_dir_string()?)
}

pub fn open_or_create_session_with_cwd(
    name: &str,
    cwd: impl Into<String>,
) -> Result<OpenedSession, SessionError> {
    open_or_create_session_in_home_with_cwd(name, default_botified_home(), cwd)
}

pub fn open_or_create_session_in_home(
    name: &str,
    home: impl AsRef<Path>,
) -> Result<OpenedSession, SessionError> {
    open_or_create_session_in_home_with_cwd(name, home, current_dir_string()?)
}

pub fn open_or_create_session_in_home_with_cwd(
    name: &str,
    home: impl AsRef<Path>,
    cwd: impl Into<String>,
) -> Result<OpenedSession, SessionError> {
    if name.trim().is_empty() {
        return Err(SessionError::EmptyName);
    }

    let home = home.as_ref();
    let cwd = cwd.into();
    let sessions_dir = home.join("sessions");
    ensure_private_dir(home).map_err(|source| SessionError::Io {
        path: home.to_path_buf(),
        source,
    })?;
    ensure_private_dir_with_legacy_tree(&sessions_dir).map_err(|source| SessionError::Io {
        path: sessions_dir.clone(),
        source,
    })?;

    let path = sessions_dir.join(format!("{}.jsonl", encode_session_name(name)));
    let path_lock = session_path_lock(&path);
    let _operation = path_lock.lock().expect("session path lock poisoned");
    let existing_shared = existing_shared_session_path(&path);
    if let Some(shared) = existing_shared.as_ref() {
        let append = shared
            .append
            .lock()
            .expect("session append state mutex poisoned");
        fail_if_compaction_poisoned(&path, &append)?;
    }
    cleanup_session_checkpoint_temps(&path)?;
    let loaded = if path.exists() {
        let mut options = private_open_options();
        options.read(true);
        open_private_file(&options, &path).map_err(|source| SessionError::Io {
            path: path.clone(),
            source,
        })?;
        load_existing_session(&path, name, &cwd)?
    } else {
        let mut options = private_open_options();
        options.write(true).create_new(true);
        match open_private_file(&options, &path) {
            Ok(mut file) => {
                write_session_header(&path, &mut file, name, &cwd)?;
                sync_session_parent_dir(&path)?;
                LoadedSession::default()
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                load_existing_session(&path, name, &cwd)?
            }
            Err(source) => {
                return Err(SessionError::Io {
                    path: path.clone(),
                    source,
                });
            }
        }
    };

    let shared = if let Some(shared) = existing_shared {
        shared
    } else {
        let mut options = private_open_options();
        options.append(true);
        let file = open_private_file(&options, &path).map_err(|source| SessionError::Io {
            path: path.clone(),
            source,
        })?;
        shared_session_path(&path, file, path_lock.clone())
    };

    Ok(OpenedSession {
        name: name.to_owned(),
        path: path.clone(),
        initial_messages: loaded.initial_messages,
        pending_messages: loaded.pending_messages,
        known_user_messages: loaded.known_user_messages,
        message_cursors: loaded.message_cursors,
        pending_delivery_intents: loaded.pending_delivery_intents,
        restart_boundary: loaded.restart_boundary,
        warnings: loaded.warnings,
        recorder: Arc::new(FileSessionRecorder::new(path, shared)),
    })
}

fn cleanup_session_checkpoint_temps(path: &Path) -> Result<(), SessionError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    let prefix = format!(".{file_name}.checkpoint-");
    for entry in fs::read_dir(parent).map_err(|source| SessionError::Io {
        path: parent.to_path_buf(),
        source,
    })? {
        let entry = entry.map_err(|source| SessionError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
        {
            fs::remove_file(entry.path()).map_err(|source| SessionError::Io {
                path: entry.path(),
                source,
            })?;
        }
    }
    Ok(())
}

fn load_existing_session(
    path: &Path,
    expected_name: &str,
    cwd: &str,
) -> Result<LoadedSession, SessionError> {
    let metadata = fs::metadata(path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() == 0 {
        let mut options = private_open_options();
        options.write(true).truncate(true);
        let mut file = open_private_file(&options, path).map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        write_session_header(path, &mut file, expected_name, cwd)?;
        return Ok(LoadedSession {
            warnings: vec![format!(
                "session recovery rewrite_empty_session_header path={} line=1 offset=0",
                path.display()
            )],
            ..LoadedSession::default()
        });
    }
    replay::load_session(path, expected_name)
}

fn write_session_header(
    path: &Path,
    file: &mut File,
    name: &str,
    cwd: &str,
) -> Result<(), SessionError> {
    write_session_header_with_writer(path, file, name, cwd)
}

pub(super) fn write_session_header_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
    name: &str,
    cwd: &str,
) -> Result<(), SessionError> {
    let header = serde_json::to_string(&SessionLine::Header {
        version: SESSION_VERSION,
        name: name.to_owned(),
        created_at: created_at_seconds()?,
        cwd: cwd.to_owned(),
    })
    .map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    append_serialized_session_line(path, file, &header, SessionAppendDurability::SyncData)
}

fn default_botified_home() -> PathBuf {
    env::var_os("BOTIFIED_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".botified")))
        .unwrap_or_else(|| PathBuf::from(".botified"))
}

fn current_dir_string() -> Result<String, SessionError> {
    let path = env::current_dir().map_err(|source| SessionError::Io {
        path: PathBuf::from("."),
        source,
    })?;
    Ok(path.display().to_string())
}

fn created_at_seconds() -> Result<u64, SessionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|source| SessionError::BadHeader {
            path: PathBuf::new(),
            message: source.to_string(),
        })
}

pub(super) fn truncate_session_file(path: &Path, len: u64) -> Result<(), SessionError> {
    let mut options = private_open_options();
    options.write(true);
    let mut file = open_private_file(&options, path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    truncate_session_file_with_writer(path, &mut file, len)
}

pub(super) fn truncate_session_file_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
    len: u64,
) -> Result<(), SessionError> {
    file.set_len(len).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })
}

pub(super) fn append_session_newline(path: &Path) -> Result<(), SessionError> {
    let mut options = private_open_options();
    options.append(true);
    let mut file = open_private_file(&options, path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    append_session_newline_with_writer(path, &mut file)
}

pub(super) fn append_session_newline_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
) -> Result<(), SessionError> {
    file.write_bytes(b"\n").map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })
}
