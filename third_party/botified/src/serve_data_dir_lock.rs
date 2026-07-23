use std::error::Error;
use std::fmt;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use botified::private_fs::{ensure_private_dir, open_private_file, private_open_options};

const LOCK_FILE_NAME: &str = ".botified-serve.lock";

pub(crate) struct ServeDataDirLock {
    _file: File,
}

impl ServeDataDirLock {
    pub(crate) fn acquire(data_dir: &Path) -> Result<Self, ServeDataDirLockError> {
        ensure_private_dir(data_dir).map_err(|source| ServeDataDirLockError::Io {
            operation: "create",
            path: data_dir.to_path_buf(),
            source,
        })?;

        let lock_path = data_dir.join(LOCK_FILE_NAME);
        let mut options = private_open_options();
        options.read(true).write(true).create(true).truncate(false);
        let file = open_private_file(&options, &lock_path).map_err(|source| {
            ServeDataDirLockError::Io {
                operation: "open lock file in",
                path: data_dir.to_path_buf(),
                source,
            }
        })?;

        loop {
            // SAFETY: file owns this valid descriptor for the duration of the call.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { _file: file });
            }

            let source = io::Error::last_os_error();
            if source.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if source
                .raw_os_error()
                .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
            {
                return Err(ServeDataDirLockError::AlreadyLocked {
                    data_dir: data_dir.to_path_buf(),
                });
            }
            return Err(ServeDataDirLockError::Io {
                operation: "lock",
                path: lock_path,
                source,
            });
        }
    }
}

#[derive(Debug)]
pub(crate) enum ServeDataDirLockError {
    AlreadyLocked {
        data_dir: PathBuf,
    },
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for ServeDataDirLockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyLocked { data_dir } => write!(
                formatter,
                "runtime data directory {} is already in use by another botified serve process",
                data_dir.display()
            ),
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "failed to {operation} runtime data directory {}: {source}",
                path.display()
            ),
        }
    }
}

impl Error for ServeDataDirLockError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::AlreadyLocked { .. } => None,
            Self::Io { source, .. } => Some(source),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn acquire_creates_and_tightens_data_dir_and_lock_file() {
        let root = tempfile::tempdir().expect("temp dir");
        let data_dir = root.path().join("data");
        {
            let _lock = ServeDataDirLock::acquire(&data_dir).expect("first lock");
        }
        let lock_path = data_dir.join(LOCK_FILE_NAME);
        assert_eq!(mode(&data_dir), 0o700);
        assert_eq!(mode(&lock_path), 0o600);

        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o755)).expect("widen data dir");
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o644))
            .expect("widen lock file");
        let _lock = ServeDataDirLock::acquire(&data_dir).expect("reopen lock");
        assert_eq!(mode(&data_dir), 0o700);
        assert_eq!(mode(&lock_path), 0o600);
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path)
            .expect("path metadata")
            .permissions()
            .mode()
            & 0o777
    }
}
