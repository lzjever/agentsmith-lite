use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::path_utils::{is_same_or_descendant, lexical_absolute};

const CONTEXT_FILE_OVERRIDE_NAME: &str = "AGENTS.override.md";
const CONTEXT_FILE_NAME: &str = "AGENTS.md";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextFile {
    pub path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextFileLoadConfig {
    pub cwd: PathBuf,
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    #[serde(default)]
    pub botified_home: Option<PathBuf>,
    pub default_discovery: bool,
    pub max_total_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedContextFiles {
    pub files: Vec<ContextFile>,
    pub warnings: Vec<String>,
}

pub fn load_context_files(config: &ContextFileLoadConfig) -> LoadedContextFiles {
    if !config.default_discovery {
        return LoadedContextFiles {
            files: Vec::new(),
            warnings: Vec::new(),
        };
    }

    let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = lexical_absolute(&config.cwd, &process_cwd);
    let data_dir = config
        .data_dir
        .as_ref()
        .map(|path| lexical_absolute(path, &cwd));
    let mut loader = ContextFileLoader {
        files: Vec::new(),
        warnings: Vec::new(),
        seen: HashSet::new(),
        bytes_used: 0,
        max_total_bytes: config.max_total_bytes,
        data_dir,
        comparison_base: cwd.clone(),
    };

    if let Some(botified_home) = config.botified_home.as_ref() {
        loader.load_first_non_empty_candidate(botified_home);
    }

    for directory in discovery_directories(&cwd) {
        loader.load_first_non_empty_candidate(&directory);
    }

    LoadedContextFiles {
        files: loader.files,
        warnings: loader.warnings,
    }
}

struct ContextFileLoader {
    files: Vec<ContextFile>,
    warnings: Vec<String>,
    seen: HashSet<PathBuf>,
    bytes_used: usize,
    max_total_bytes: usize,
    data_dir: Option<PathBuf>,
    comparison_base: PathBuf,
}

impl ContextFileLoader {
    fn load_first_non_empty_candidate(&mut self, directory: &Path) {
        if self.should_skip_for_data_dir(directory) {
            return;
        }
        for path in context_file_candidates(directory) {
            match self.load_candidate(path) {
                CandidateLoad::MissingOrEmpty => {}
                CandidateLoad::Loaded | CandidateLoad::Unavailable => return,
            }
        }
    }

    fn load_candidate(&mut self, path: PathBuf) -> CandidateLoad {
        if self.should_skip_for_data_dir(&path) {
            return CandidateLoad::MissingOrEmpty;
        }
        if !path.is_file() {
            return CandidateLoad::MissingOrEmpty;
        }

        let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !self.seen.insert(canonical) {
            return CandidateLoad::Loaded;
        }

        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                self.warnings.push(format!(
                    "unable to read context file '{}': {error}",
                    path.display()
                ));
                return CandidateLoad::Unavailable;
            }
        };

        if String::from_utf8_lossy(&bytes).trim().is_empty() {
            return CandidateLoad::MissingOrEmpty;
        }

        let remaining = self.max_total_bytes.saturating_sub(self.bytes_used);
        let truncated = bytes.len() > remaining;
        let loaded_bytes = if truncated {
            self.warnings.push(format!(
                "context file '{}' truncated to fit {} byte context file budget",
                path.display(),
                self.max_total_bytes
            ));
            let loaded_len = utf8_prefix_boundary_at_or_before(&bytes, remaining);
            bytes[..loaded_len].to_vec()
        } else {
            bytes
        };
        self.bytes_used = self.bytes_used.saturating_add(loaded_bytes.len());

        let content = match String::from_utf8(loaded_bytes) {
            Ok(content) => content,
            Err(error) => {
                self.warnings.push(format!(
                    "context file '{}' contained invalid UTF-8; loaded with replacement characters",
                    path.display()
                ));
                String::from_utf8_lossy(&error.into_bytes()).into_owned()
            }
        };

        self.files.push(ContextFile { path, content });
        CandidateLoad::Loaded
    }

    fn should_skip_for_data_dir(&mut self, path: &Path) -> bool {
        let Some(data_dir) = self.data_dir.as_ref() else {
            return false;
        };
        match is_same_or_descendant(path, data_dir, &self.comparison_base) {
            Ok(is_under) => is_under,
            Err(error) => {
                self.warnings.push(format!(
                    "unable to compare context path '{}' with runtime.data_dir '{}'; skipping context source: {error}",
                    path.display(),
                    data_dir.display()
                ));
                true
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateLoad {
    Loaded,
    MissingOrEmpty,
    Unavailable,
}

fn context_file_candidates(directory: &Path) -> [PathBuf; 2] {
    [
        directory.join(CONTEXT_FILE_OVERRIDE_NAME),
        directory.join(CONTEXT_FILE_NAME),
    ]
}

fn utf8_prefix_boundary_at_or_before(bytes: &[u8], max_len: usize) -> usize {
    if max_len == 0 || max_len >= bytes.len() || !is_utf8_continuation(bytes[max_len]) {
        return max_len.min(bytes.len());
    }

    let mut start = max_len;
    while start > 0 && is_utf8_continuation(bytes[start]) {
        start -= 1;
    }

    let Some(width) = utf8_sequence_width(bytes[start]) else {
        return max_len;
    };
    let end = start.saturating_add(width);
    if max_len > start
        && max_len < end
        && end <= bytes.len()
        && std::str::from_utf8(&bytes[start..end]).is_ok()
    {
        start
    } else {
        max_len
    }
}

fn is_utf8_continuation(byte: u8) -> bool {
    (byte & 0b1100_0000) == 0b1000_0000
}

fn utf8_sequence_width(byte: u8) -> Option<usize> {
    match byte {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

fn discovery_directories(cwd: &Path) -> Vec<PathBuf> {
    let Some(root) = project_root(cwd) else {
        return vec![cwd.to_path_buf()];
    };

    let mut directories = Vec::new();
    for ancestor in cwd.ancestors() {
        directories.push(ancestor.to_path_buf());
        if ancestor == root {
            break;
        }
    }
    directories.reverse();
    directories
}

fn project_root(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors()
        .find(|directory| is_git_marker(&directory.join(".git")))
        .map(Path::to_path_buf)
}

fn is_git_marker(path: &Path) -> bool {
    path.is_file() || path.is_dir()
}
