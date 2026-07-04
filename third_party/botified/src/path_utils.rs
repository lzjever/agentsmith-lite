use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

pub fn lexical_absolute(path: &Path, base: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    lexical_normalize(&absolute)
}

pub fn hybrid_canonical_path(path: &Path, base: &Path) -> io::Result<PathBuf> {
    let absolute = lexical_absolute(path, base);
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();

    while !ancestor.as_os_str().is_empty() && !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            missing.push(name.to_os_string());
        }
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }

    let mut resolved = fs::canonicalize(ancestor)?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Ok(lexical_normalize(&resolved))
}

pub fn is_same_or_descendant(candidate: &Path, ancestor: &Path, base: &Path) -> io::Result<bool> {
    let candidate = hybrid_canonical_path(candidate, base)?;
    let ancestor = hybrid_canonical_path(ancestor, base)?;
    Ok(candidate == ancestor || candidate.starts_with(&ancestor))
}

pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match normalized.components().next_back() {
                Some(Component::Normal(_)) => {
                    normalized.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                Some(Component::ParentDir) | Some(Component::CurDir) | None => {
                    normalized.push(component.as_os_str());
                }
            },
            Component::Normal(_) | Component::RootDir | Component::Prefix(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}
