use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use botified::{load_context_files, ContextFileLoadConfig};

const DEFAULT_CONTEXT_BUDGET: usize = 32 * 1024;

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-context-files-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn config(cwd: &Path) -> ContextFileLoadConfig {
    ContextFileLoadConfig {
        cwd: cwd.to_path_buf(),
        data_dir: None,
        botified_home: None,
        default_discovery: true,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    }
}

fn config_with_data_dir(cwd: &Path, data_dir: &Path) -> ContextFileLoadConfig {
    ContextFileLoadConfig {
        cwd: cwd.to_path_buf(),
        data_dir: Some(data_dir.to_path_buf()),
        botified_home: None,
        default_discovery: true,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    }
}

fn config_with_home(cwd: &Path, botified_home: &Path) -> ContextFileLoadConfig {
    ContextFileLoadConfig {
        cwd: cwd.to_path_buf(),
        data_dir: None,
        botified_home: Some(botified_home.to_path_buf()),
        default_discovery: true,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    }
}

fn disabled_config(cwd: &Path) -> ContextFileLoadConfig {
    ContextFileLoadConfig {
        cwd: cwd.to_path_buf(),
        data_dir: None,
        botified_home: None,
        default_discovery: false,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    }
}

fn disabled_config_with_home(cwd: &Path, botified_home: &Path) -> ContextFileLoadConfig {
    ContextFileLoadConfig {
        cwd: cwd.to_path_buf(),
        data_dir: None,
        botified_home: Some(botified_home.to_path_buf()),
        default_discovery: false,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    }
}

fn write(path: &Path, content: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dir");
    }
    fs::write(path, content).expect("write file");
}

fn loaded_paths(loaded: &botified::LoadedContextFiles) -> Vec<PathBuf> {
    loaded.files.iter().map(|file| file.path.clone()).collect()
}

fn loaded_contents(loaded: &botified::LoadedContextFiles) -> Vec<String> {
    loaded
        .files
        .iter()
        .map(|file| file.content.clone())
        .collect()
}

#[test]
fn global_agents_override_md_is_loaded_before_global_agents_md() {
    let cwd = temp_dir("global-override-cwd");
    let botified_home = temp_dir("global-override-home");
    let override_path = botified_home.join("AGENTS.override.md");
    write(&botified_home.join("AGENTS.md"), "global base");
    write(&override_path, "global override");

    let loaded = load_context_files(&config_with_home(&cwd, &botified_home));

    assert_eq!(loaded_paths(&loaded), vec![override_path]);
    assert_eq!(loaded_contents(&loaded), vec!["global override"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn global_agents_md_is_loaded_when_global_override_is_missing() {
    let cwd = temp_dir("global-fallback-cwd");
    let botified_home = temp_dir("global-fallback-home");
    let path = botified_home.join("AGENTS.md");
    write(&path, "global base");

    let loaded = load_context_files(&config_with_home(&cwd, &botified_home));

    assert_eq!(loaded_paths(&loaded), vec![path]);
    assert_eq!(loaded_contents(&loaded), vec!["global base"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn loads_global_first_then_project_agents_from_git_root_to_cwd() {
    let botified_home = temp_dir("global-project-order-home");
    let parent = temp_dir("global-project-order-parent");
    let root = parent.join("repo");
    let mid = root.join("crates").join("botified");
    let cwd = mid.join("src");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&botified_home.join("AGENTS.md"), "global");
    write(&root.join("AGENTS.md"), "root");
    write(&mid.join("AGENTS.md"), "mid");
    write(&cwd.join("AGENTS.md"), "cwd");

    let loaded = load_context_files(&config_with_home(&cwd, &botified_home));

    assert_eq!(
        loaded_paths(&loaded),
        vec![
            botified_home.join("AGENTS.md"),
            root.join("AGENTS.md"),
            mid.join("AGENTS.md"),
            cwd.join("AGENTS.md")
        ]
    );
    assert_eq!(
        loaded_contents(&loaded),
        vec!["global", "root", "mid", "cwd"]
    );
    assert!(loaded.warnings.is_empty());
}

#[test]
fn empty_context_files_are_ignored_and_empty_overrides_fallback_to_agents_md() {
    let botified_home = temp_dir("empty-fallback-home");
    let root = temp_dir("empty-fallback-root");
    let cwd = root.join("nested");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&botified_home.join("AGENTS.override.md"), "  \n\t");
    write(&botified_home.join("AGENTS.md"), "global base");
    write(&root.join("AGENTS.override.md"), "\n");
    write(&root.join("AGENTS.md"), "root base");
    write(&cwd.join("AGENTS.md"), " \n ");

    let loaded = load_context_files(&config_with_home(&cwd, &botified_home));

    assert_eq!(
        loaded_paths(&loaded),
        vec![botified_home.join("AGENTS.md"), root.join("AGENTS.md")]
    );
    assert_eq!(loaded_contents(&loaded), vec!["global base", "root base"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn no_context_files_returns_empty_without_warnings() {
    let cwd = temp_dir("empty");

    let loaded = load_context_files(&config(&cwd));

    assert!(loaded.files.is_empty());
    assert!(loaded.warnings.is_empty());
}

#[test]
fn loads_cwd_agents_md_when_discovery_is_enabled() {
    let cwd = temp_dir("cwd");
    let path = cwd.join("AGENTS.md");
    write(&path, "cwd instructions\n");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(loaded_paths(&loaded), vec![path]);
    assert_eq!(loaded_contents(&loaded), vec!["cwd instructions\n"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn loads_cwd_agents_override_md_instead_of_agents_md() {
    let cwd = temp_dir("cwd-override");
    let override_path = cwd.join("AGENTS.override.md");
    write(&cwd.join("AGENTS.md"), "base instructions\n");
    write(&override_path, "override instructions\n");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(loaded_paths(&loaded), vec![override_path]);
    assert_eq!(loaded_contents(&loaded), vec!["override instructions\n"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn unreadable_cwd_agents_override_md_does_not_fallback_to_agents_md() {
    use std::os::unix::fs::PermissionsExt;

    let cwd = temp_dir("cwd-unreadable-override");
    let override_path = cwd.join("AGENTS.override.md");
    write(&cwd.join("AGENTS.md"), "base instructions\n");
    write(&override_path, "override instructions\n");

    let mut permissions = fs::metadata(&override_path)
        .expect("read override metadata")
        .permissions();
    permissions.set_mode(0o000);
    fs::set_permissions(&override_path, permissions).expect("make override unreadable");

    if fs::read(&override_path).is_ok() {
        eprintln!(
            "skipping unreadable override assertion: current environment can read {} after chmod 000",
            override_path.display()
        );

        let mut permissions = fs::metadata(&override_path)
            .expect("read override metadata")
            .permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&override_path, permissions).expect("restore override permissions");
        return;
    }

    let loaded = load_context_files(&config(&cwd));

    let mut permissions = fs::metadata(&override_path)
        .expect("read override metadata")
        .permissions();
    permissions.set_mode(0o644);
    fs::set_permissions(&override_path, permissions).expect("restore override permissions");

    assert!(loaded.files.is_empty());
    assert!(
        loaded.warnings.iter().any(|warning: &String| {
            warning.contains("unable to read")
                && warning.contains(&override_path.display().to_string())
        }),
        "expected unreadable override warning, got {:?}",
        loaded.warnings
    );
}

#[test]
fn disabled_discovery_returns_empty_even_when_agents_md_exists() {
    let cwd = temp_dir("disabled");
    write(&cwd.join("AGENTS.md"), "do not load");

    let loaded = load_context_files(&disabled_config(&cwd));

    assert!(loaded.files.is_empty());
    assert!(loaded.warnings.is_empty());
}

#[test]
fn disabled_discovery_returns_empty_even_when_global_and_project_agents_exist() {
    let botified_home = temp_dir("disabled-home");
    let root = temp_dir("disabled-root");
    let cwd = root.join("nested");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&botified_home.join("AGENTS.md"), "do not load global");
    write(&root.join("AGENTS.md"), "do not load root");
    write(&cwd.join("AGENTS.md"), "do not load cwd");

    let loaded = load_context_files(&disabled_config_with_home(&cwd, &botified_home));

    assert!(loaded.files.is_empty());
    assert!(loaded.warnings.is_empty());
}

#[test]
fn loads_project_agents_md_from_git_root_to_cwd_and_stops_at_boundary() {
    let parent = temp_dir("git-boundary-parent");
    let root = parent.join("repo");
    let mid = root.join("crates").join("botified");
    let cwd = mid.join("src");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&parent.join("AGENTS.md"), "parent");
    write(&root.join("AGENTS.md"), "root");
    write(&root.join("AGENTS.override.md"), "root override");
    write(&mid.join("AGENTS.md"), "mid");
    write(&mid.join("AGENTS.override.md"), "mid override");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(
        loaded_paths(&loaded),
        vec![
            root.join("AGENTS.override.md"),
            mid.join("AGENTS.override.md")
        ]
    );
    assert_eq!(
        loaded_contents(&loaded),
        vec!["root override", "mid override"]
    );
}

#[test]
fn git_marker_file_also_bounds_project_scan() {
    let parent = temp_dir("git-file-boundary-parent");
    let root = parent.join("repo");
    let cwd = root.join("nested");
    fs::create_dir_all(&cwd).expect("create cwd");
    write(&root.join(".git"), "gitdir: ../actual.git\n");

    write(&parent.join("AGENTS.md"), "parent");
    write(&root.join("AGENTS.md"), "root");
    write(&cwd.join("AGENTS.md"), "cwd");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(
        loaded_paths(&loaded),
        vec![root.join("AGENTS.md"), cwd.join("AGENTS.md")]
    );
    assert_eq!(loaded_contents(&loaded), vec!["root", "cwd"]);
}

#[test]
fn without_git_marker_only_cwd_agents_md_is_loaded() {
    let parent = temp_dir("no-git-parent");
    let root = parent.join("repo");
    let cwd = root.join("nested");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&parent.join("AGENTS.md"), "parent");
    write(&root.join("AGENTS.md"), "root");
    write(&cwd.join("AGENTS.md"), "cwd");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(loaded_paths(&loaded), vec![cwd.join("AGENTS.md")]);
    assert_eq!(loaded_contents(&loaded), vec!["cwd"]);
}

#[test]
fn ignores_directories_and_non_p0_filenames() {
    let cwd = temp_dir("filenames");
    fs::create_dir_all(cwd.join("AGENTS.md")).expect("create AGENTS.md dir");
    write(&cwd.join("AGENTS.MD"), "uppercase");
    write(&cwd.join("ALT_AGENT.md"), "alternate");
    write(&cwd.join("ALT_AGENT.MD"), "alternate uppercase");
    let override_path = cwd.join("AGENTS.override.md");
    write(&override_path, "override");

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(loaded_paths(&loaded), vec![override_path]);
    assert_eq!(loaded_contents(&loaded), vec!["override"]);
    assert!(loaded.warnings.is_empty());
}

#[test]
fn invalid_utf8_is_read_lossy_and_warned() {
    let cwd = temp_dir("invalid-utf8");
    let bytes = [b'a', 0xff, b'b'];
    write(&cwd.join("AGENTS.md"), bytes);

    let loaded = load_context_files(&config(&cwd));

    assert_eq!(loaded.files.len(), 1);
    assert_eq!(
        loaded.files[0].content,
        String::from_utf8_lossy(&bytes).into_owned()
    );
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning: &String| warning.contains("UTF-8") || warning.contains("utf-8")),
        "expected invalid UTF-8 warning, got {:?}",
        loaded.warnings
    );
}

#[test]
fn total_raw_byte_budget_truncates_later_content_and_warns() {
    let root = temp_dir("budget-root");
    let cwd = root.join("nested");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");
    write(&root.join("AGENTS.md"), "1234567890");
    write(&cwd.join("AGENTS.md"), "abcdef");

    let loaded = load_context_files(&ContextFileLoadConfig {
        cwd: cwd.clone(),
        data_dir: None,
        botified_home: None,
        default_discovery: true,
        max_total_bytes: 12,
    });

    assert_eq!(
        loaded_paths(&loaded),
        vec![root.join("AGENTS.md"), cwd.join("AGENTS.md")]
    );
    assert_eq!(loaded_contents(&loaded), vec!["1234567890", "ab"]);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning: &String| warning.contains("truncated") || warning.contains("budget")),
        "expected truncation warning, got {:?}",
        loaded.warnings
    );
}

#[test]
fn total_raw_byte_budget_loads_global_before_project() {
    let botified_home = temp_dir("budget-global-first-home");
    let root = temp_dir("budget-global-first-root");
    let cwd = root.join("nested");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&cwd).expect("create cwd");

    write(&botified_home.join("AGENTS.md"), "global");
    write(&root.join("AGENTS.md"), "root");

    let loaded = load_context_files(&ContextFileLoadConfig {
        cwd: cwd.clone(),
        data_dir: None,
        botified_home: Some(botified_home.clone()),
        default_discovery: true,
        max_total_bytes: 8,
    });

    assert_eq!(
        loaded_paths(&loaded),
        vec![botified_home.join("AGENTS.md"), root.join("AGENTS.md")]
    );
    assert_eq!(loaded_contents(&loaded), vec!["global", "ro"]);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning: &String| warning.contains("truncated") || warning.contains("budget")),
        "expected truncation warning, got {:?}",
        loaded.warnings
    );
}

#[test]
fn total_raw_byte_budget_truncates_to_utf8_boundary_without_invalid_utf8_warning() {
    let cwd = temp_dir("budget-utf8-boundary");
    let path = cwd.join("AGENTS.md");
    write(&path, "abc\u{4e2d}def");

    let loaded = load_context_files(&ContextFileLoadConfig {
        cwd: cwd.clone(),
        data_dir: None,
        botified_home: None,
        default_discovery: true,
        max_total_bytes: 4,
    });

    assert_eq!(loaded_paths(&loaded), vec![path]);
    assert_eq!(loaded_contents(&loaded), vec!["abc"]);
    assert!(!loaded.files[0].content.contains('\u{fffd}'));
    assert!(
        loaded
            .warnings
            .iter()
            .any(|warning: &String| warning.contains("truncated") || warning.contains("budget")),
        "expected truncation warning, got {:?}",
        loaded.warnings
    );
    assert!(
        !loaded
            .warnings
            .iter()
            .any(|warning: &String| warning.contains("UTF-8") || warning.contains("utf-8")),
        "did not expect invalid UTF-8 warning, got {:?}",
        loaded.warnings
    );
}

#[test]
fn duplicate_canonical_agents_paths_are_loaded_once() {
    let root = temp_dir("dedupe");
    let real = root.join("real");
    let linked = root.join("linked");
    fs::create_dir_all(root.join(".git")).expect("create .git dir");
    fs::create_dir_all(&real).expect("create real dir");
    write(&real.join("AGENTS.md"), "shared");
    std::os::unix::fs::symlink(&real, &linked).expect("create symlink");
    std::os::unix::fs::symlink(real.join("AGENTS.md"), root.join("AGENTS.md"))
        .expect("create file symlink");

    let loaded = load_context_files(&config(&linked));

    assert_eq!(loaded.files.len(), 1);
    assert_eq!(loaded.files[0].content, "shared");
}

#[test]
fn discovery_excludes_data_dir_agents_and_symlink_alias_without_hiding_similar_names() {
    let root = temp_dir("data-dir-exclusion");
    let cwd = root.join("work");
    let data_dir = cwd.join(".botified").join("state");
    let alias = cwd.join("state-link");
    let similar = cwd.join(".botified").join("stateful");
    fs::create_dir_all(cwd.join(".git")).expect("create .git dir");
    fs::create_dir_all(&data_dir).expect("create data dir");
    fs::create_dir_all(&similar).expect("create similar dir");
    write(&data_dir.join("AGENTS.md"), "state instructions");
    write(&similar.join("AGENTS.md"), "stateful instructions");
    std::os::unix::fs::symlink(&data_dir, &alias).expect("create data dir alias");

    let loaded_from_data_dir = load_context_files(&config_with_data_dir(&data_dir, &data_dir));
    let loaded_from_alias = load_context_files(&config_with_data_dir(&alias, &data_dir));
    let loaded_from_similar = load_context_files(&config_with_data_dir(&similar, &data_dir));

    assert!(loaded_from_data_dir.files.is_empty());
    assert!(loaded_from_alias.files.is_empty());
    assert_eq!(
        loaded_contents(&loaded_from_similar),
        vec!["stateful instructions"]
    );
}

#[test]
fn absolute_data_dir_is_excluded_from_global_context_sources() {
    let cwd = temp_dir("absolute-data-dir-cwd");
    let state_home = temp_dir("absolute-data-dir-home");
    let similar_home = temp_dir("absolute-data-dir-home-similar");
    write(&state_home.join("AGENTS.md"), "state instructions");
    write(&similar_home.join("AGENTS.md"), "stateful instructions");

    let loaded_from_state = load_context_files(&ContextFileLoadConfig {
        cwd: cwd.clone(),
        data_dir: Some(state_home.clone()),
        botified_home: Some(state_home),
        default_discovery: true,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    });
    let loaded_from_similar = load_context_files(&ContextFileLoadConfig {
        cwd,
        data_dir: Some(temp_dir("absolute-data-dir-state")),
        botified_home: Some(similar_home.clone()),
        default_discovery: true,
        max_total_bytes: DEFAULT_CONTEXT_BUDGET,
    });

    assert!(loaded_from_state.files.is_empty());
    assert_eq!(
        loaded_paths(&loaded_from_similar),
        vec![similar_home.join("AGENTS.md")]
    );
}
