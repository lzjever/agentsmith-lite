use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;
#[cfg(unix)]
const PRIVATE_TREE_MARKER: &str = ".botified-private-tree-v1";
#[cfg(unix)]
const PRIVATE_TREE_MARKER_CONTENT: &[u8] = b"botified-private-tree-v1\n";

pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    reject_symlink_components(path)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(PRIVATE_DIR_MODE);
    builder.create(path)?;
    reject_symlink_components(path)?;
    tighten_dir(path)
}

pub fn ensure_private_dir_with_legacy_tree(path: &Path) -> io::Result<()> {
    ensure_private_dir(path)?;

    #[cfg(unix)]
    {
        let marker_path = path.join(PRIVATE_TREE_MARKER);
        match private_tree_marker_state(&marker_path)? {
            PrivateTreeMarkerState::Valid => return Ok(()),
            PrivateTreeMarkerState::Invalid => fs::remove_file(&marker_path)?,
            PrivateTreeMarkerState::Missing => {}
        }

        tighten_private_tree(path)?;
        create_private_tree_marker(&marker_path)?;
    }
    Ok(())
}

pub fn private_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        options
            .mode(PRIVATE_FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW);
    }
    options
}

pub fn open_private_file(options: &OpenOptions, path: &Path) -> io::Result<File> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        reject_symlink_components(parent)?;
    }
    reject_final_symlink(path)?;
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid_path_type(path, "regular file"));
    }
    tighten_file(&file)?;
    Ok(file)
}

pub fn tighten_private_file_path(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut options = private_open_options();
        options.read(true);
        open_private_file(&options, path)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn tighten_private_tree(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() {
            return Err(invalid_path_type(path, "non-symlink private tree entry"));
        }
        if metadata.is_file() {
            tighten_private_file_path(path)?;
            return Ok(());
        }
        if !metadata.is_dir() {
            return Ok(());
        }

        tighten_dir(path)?;
        for entry in fs::read_dir(path)? {
            tighten_private_tree(&entry?.path())?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn tighten_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        reject_symlink_components(path)?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
        let directory = options.open(path)?;
        let metadata = directory.metadata()?;
        if !metadata.is_dir() {
            return Err(invalid_path_type(path, "directory"));
        }
        if metadata.permissions().mode() & 0o7777 != PRIVATE_DIR_MODE {
            directory.set_permissions(fs::Permissions::from_mode(PRIVATE_DIR_MODE))?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn tighten_file(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        let permissions = file.metadata()?.permissions();
        if permissions.mode() & 0o7777 != PRIVATE_FILE_MODE {
            file.set_permissions(fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Ok(())
    }
}

fn reject_symlink_components(path: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(invalid_path_type(&current, "non-symlink path component"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn reject_final_symlink(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid_path_type(path, "non-symlink regular file"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn invalid_path_type(path: &Path, expected: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{} must be a {expected}", path.display()),
    )
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrivateTreeMarkerState {
    Missing,
    Valid,
    Invalid,
}

#[cfg(unix)]
fn private_tree_marker_state(path: &Path) -> io::Result<PrivateTreeMarkerState> {
    let mut options = private_open_options();
    options.read(true);
    let mut marker = match open_private_file(&options, path) {
        Ok(marker) => marker,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PrivateTreeMarkerState::Missing);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::with_capacity(PRIVATE_TREE_MARKER_CONTENT.len() + 1);
    Read::by_ref(&mut marker)
        .take((PRIVATE_TREE_MARKER_CONTENT.len() + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(if bytes == PRIVATE_TREE_MARKER_CONTENT {
        PrivateTreeMarkerState::Valid
    } else {
        PrivateTreeMarkerState::Invalid
    })
}

#[cfg(unix)]
fn create_private_tree_marker(path: &Path) -> io::Result<()> {
    let mut options = private_open_options();
    options.write(true).create_new(true);
    let mut marker = match open_private_file(&options, path) {
        Ok(marker) => marker,
        // This caller already completed the full scan. A concurrent caller owns
        // marker publication; future opens still validate its version content.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    let result = marker
        .write_all(PRIVATE_TREE_MARKER_CONTENT)
        .and_then(|()| marker.sync_all());
    if let Err(error) = result {
        drop(marker);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn private_helpers_create_and_tighten_exact_unix_modes() {
        let root = tempfile::tempdir().expect("temp dir");
        let private_dir = root.path().join("private");
        ensure_private_dir(&private_dir).expect("create private dir");
        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);

        let private_file = private_dir.join("secret");
        let mut options = private_open_options();
        options.write(true).create_new(true);
        open_private_file(&options, &private_file).expect("create private file");
        assert_eq!(mode(&private_file), PRIVATE_FILE_MODE);

        fs::set_permissions(&private_dir, fs::Permissions::from_mode(0o755))
            .expect("widen dir mode");
        fs::set_permissions(&private_file, fs::Permissions::from_mode(0o644))
            .expect("widen file mode");
        tighten_private_tree(&private_dir).expect("tighten existing tree");
        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
        assert_eq!(mode(&private_file), PRIVATE_FILE_MODE);
    }

    #[test]
    fn legacy_tree_migration_scans_private_root_without_marker() {
        let root = tempfile::tempdir().expect("temp dir");
        let private_dir = root.path().join("private");
        let nested_dir = private_dir.join("nested");
        let private_file = nested_dir.join("secret");
        fs::create_dir_all(&nested_dir).expect("create legacy tree");
        fs::write(&private_file, b"secret").expect("write legacy file");
        fs::set_permissions(&private_dir, fs::Permissions::from_mode(PRIVATE_DIR_MODE))
            .expect("make legacy root private");
        fs::set_permissions(&nested_dir, fs::Permissions::from_mode(0o755))
            .expect("widen nested dir");
        fs::set_permissions(&private_file, fs::Permissions::from_mode(0o644))
            .expect("widen nested file");

        ensure_private_dir_with_legacy_tree(&private_dir).expect("migrate legacy tree");

        assert_eq!(mode(&private_dir), PRIVATE_DIR_MODE);
        assert_eq!(mode(&nested_dir), PRIVATE_DIR_MODE);
        assert_eq!(mode(&private_file), PRIVATE_FILE_MODE);
        let marker = private_dir.join(PRIVATE_TREE_MARKER);
        assert_eq!(mode(&marker), PRIVATE_FILE_MODE);
        assert_eq!(
            fs::read(marker).expect("read migration marker"),
            PRIVATE_TREE_MARKER_CONTENT
        );
    }

    #[test]
    fn private_file_open_rejects_symlink_without_mutating_target() {
        let root = tempfile::tempdir().expect("temp dir");
        let private_dir = root.path().join("private");
        ensure_private_dir(&private_dir).expect("create private dir");
        let target = root.path().join("target");
        fs::write(&target, b"preserve me").expect("write target");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).expect("set target mode");
        let link = private_dir.join("secret");
        symlink(&target, &link).expect("create file symlink");

        let mut options = private_open_options();
        options.write(true).create(true).truncate(true);
        open_private_file(&options, &link).expect_err("private open must reject symlink");

        assert_eq!(fs::read(&target).expect("read target"), b"preserve me");
        assert_eq!(mode(&target), 0o644);
    }

    #[test]
    fn private_directory_helpers_reject_symlink_components() {
        let root = tempfile::tempdir().expect("temp dir");
        let outside = root.path().join("outside");
        fs::create_dir(&outside).expect("create outside dir");
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).expect("set outside mode");
        let link = root.path().join("linked");
        symlink(&outside, &link).expect("create directory symlink");

        ensure_private_dir(&link.join("child"))
            .expect_err("private directory creation must reject symlink component");

        assert!(!outside.join("child").exists());
        assert_eq!(mode(&outside), 0o755);
    }

    #[test]
    fn failed_legacy_symlink_scan_does_not_publish_marker() {
        let root = tempfile::tempdir().expect("temp dir");
        let private_dir = root.path().join("private");
        fs::create_dir(&private_dir).expect("create legacy root");
        let target = root.path().join("target");
        fs::write(&target, b"preserve me").expect("write target");
        let link = private_dir.join("legacy-link");
        symlink(&target, &link).expect("create legacy symlink");

        ensure_private_dir_with_legacy_tree(&private_dir)
            .expect_err("legacy migration must reject symlink");

        assert!(!private_dir.join(PRIVATE_TREE_MARKER).exists());
        assert_eq!(fs::read(target).expect("read target"), b"preserve me");
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path)
            .expect("path metadata")
            .permissions()
            .mode()
            & 0o777
    }
}
