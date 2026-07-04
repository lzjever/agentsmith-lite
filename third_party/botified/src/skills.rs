use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;

use crate::path_utils::{is_same_or_descendant, lexical_absolute};
use crate::types::ContentPart;

const MAX_SKILL_NAME_LEN: usize = 64;
const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_DISCOVERY_DEPTH: usize = 6;
const MAX_ARGUMENT_INDEX: usize = 64;
const SKILL_PATH_PREFIX: &str = "skill://";
const BOTIFIED_METADATA_KEY: &str = "agents/botified.yaml";
const BOTIFIED_SHARE_DIR_ENV: &str = "BOTIFIED_SHARE_DIR";
const BOTIFIED_RESERVED_SKILL_PREFIX: &str = "botified-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub location: SkillLocation,
    pub model_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_invocable: Option<bool>,
}

impl Skill {
    pub fn is_explicit(&self) -> bool {
        self.content.is_some()
    }

    pub fn visible_in_available_skills(&self) -> bool {
        self.model_visible && !self.is_explicit()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillLocation {
    User,
    Project,
    System,
    Admin,
    Legacy,
    Workspace,
    Explicit,
}

impl SkillLocation {
    pub fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::System => "system",
            Self::Admin => "admin",
            Self::Legacy => "legacy",
            Self::Workspace => "workspace",
            Self::Explicit => "explicit",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSkills {
    pub skills: Vec<Skill>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SkillIdentity {
    source_path: PathBuf,
    normalized_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RequestedSkillContexts {
    pub contexts: Vec<String>,
    pub identities: HashSet<SkillIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrozenSkillBodies {
    bodies: HashMap<SkillIdentity, String>,
}

impl FrozenSkillBodies {
    pub(crate) fn from_skills(skills: &[Skill]) -> Self {
        let bodies = skills
            .iter()
            .map(|skill| {
                let body = skill
                    .content
                    .clone()
                    .or_else(|| fs::read_to_string(&skill.path).ok())
                    .unwrap_or_default();
                (skill_identity(skill), body)
            })
            .collect();
        Self { bodies }
    }

    fn body_for(&self, skill: &Skill) -> Option<&str> {
        self.bodies.get(&skill_identity(skill)).map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillLoadError {
    message: String,
}

impl SkillLoadError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for SkillLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for SkillLoadError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillLoadConfig {
    pub cwd: PathBuf,
    #[serde(default)]
    pub data_dir: Option<PathBuf>,
    pub botified_home: Option<PathBuf>,
    pub explicit: Vec<String>,
    pub default_discovery: bool,
}

impl SkillLoadConfig {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            data_dir: None,
            botified_home: None,
            explicit: Vec::new(),
            default_discovery: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedSkill {
    name: String,
    description: String,
    disable_model_invocation: bool,
    content: String,
    path: PathBuf,
    when_to_use: Option<String>,
    allowed_tools: Vec<String>,
    argument_hint: Option<String>,
    arguments: Option<JsonValue>,
    metadata: Option<JsonValue>,
    user_invocable: Option<bool>,
}

#[derive(Debug, Clone)]
struct RootSpec {
    path: PathBuf,
    location: SkillLocation,
}

pub fn load_skills(config: &SkillLoadConfig) -> LoadedSkills {
    try_load_skills(config).expect("invalid skill load configuration")
}

pub fn try_load_skills(config: &SkillLoadConfig) -> Result<LoadedSkills, SkillLoadError> {
    let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = lexical_absolute(&config.cwd, &process_cwd);
    let data_dir = config
        .data_dir
        .as_ref()
        .map(|path| lexical_absolute(path, &cwd));
    let mut loader = SkillLoader {
        skills: HashMap::new(),
        warnings: Vec::new(),
        discovered_roots: HashSet::new(),
        data_dir,
        comparison_base: cwd.clone(),
    };
    let roots = discovery_roots(config, &cwd);

    if config.default_discovery {
        for root in &roots {
            loader.discover_root(root);
        }
    }

    for explicit in &config.explicit {
        loader.load_explicit(explicit, &cwd, &roots)?;
    }

    Ok(loader.into_loaded_skills())
}

pub fn parse_skill_file(path: &Path) -> Result<SkillMetadata, String> {
    let content = read_skill_file(path)?;
    let parsed = parse_skill_content(path, content)?;
    Ok(SkillMetadata {
        name: parsed.name,
        description: parsed.description,
        disable_model_invocation: parsed.disable_model_invocation,
        when_to_use: parsed.when_to_use,
        allowed_tools: parsed.allowed_tools,
        argument_hint: parsed.argument_hint,
        arguments: parsed.arguments,
        metadata: parsed.metadata,
        user_invocable: parsed.user_invocable,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub disable_model_invocation: bool,
    pub when_to_use: Option<String>,
    pub allowed_tools: Vec<String>,
    pub argument_hint: Option<String>,
    pub arguments: Option<JsonValue>,
    pub metadata: Option<JsonValue>,
    pub user_invocable: Option<bool>,
}

pub fn render_skill_invocation(
    skills: &[Skill],
    name: Option<&str>,
    path: Option<&Path>,
    arguments: Option<&str>,
    cwd: &Path,
) -> Option<String> {
    let skill = resolve_skill_invocation(skills, name, path, cwd)?;
    Some(render_skill_block(&skill, arguments))
}

pub fn expand_text_skill_mentions(text: &str, skills: &[Skill]) -> Option<String> {
    expand_text_skill_mentions_with_cwd(text, skills, Path::new(""))
}

pub fn expand_text_skill_mentions_with_cwd(
    text: &str,
    skills: &[Skill],
    cwd: &Path,
) -> Option<String> {
    let rendered = render_text_skill_mentions_with_cwd(text, skills, cwd);

    if rendered.is_empty() {
        None
    } else {
        let mut expanded = text.to_owned();
        expanded.push_str("\n\n");
        expanded.push_str(&rendered.join("\n\n"));
        Some(expanded)
    }
}

pub fn render_requested_skill_contexts_for_content(
    content: &[ContentPart],
    skills: &[Skill],
    cwd: &Path,
) -> Vec<String> {
    render_requested_skill_contexts_for_contents(std::iter::once(content), skills, cwd).contexts
}

pub(crate) fn render_requested_skill_contexts_for_contents<'a>(
    contents: impl IntoIterator<Item = &'a [ContentPart]>,
    skills: &[Skill],
    cwd: &Path,
) -> RequestedSkillContexts {
    render_requested_skill_contexts_for_contents_with_frozen_bodies(contents, skills, cwd, None)
}

pub(crate) fn render_requested_skill_contexts_for_contents_with_frozen_bodies<'a>(
    contents: impl IntoIterator<Item = &'a [ContentPart]>,
    skills: &[Skill],
    cwd: &Path,
    frozen_bodies: Option<&FrozenSkillBodies>,
) -> RequestedSkillContexts {
    let mut collector = RequestedSkillContextCollector::default();
    for content in contents {
        collector.extend_content(content, skills, cwd, frozen_bodies);
    }
    collector.into_contexts()
}

fn render_text_skill_mentions_with_cwd(text: &str, skills: &[Skill], cwd: &Path) -> Vec<String> {
    if text.contains("<skill>") && text.contains("</skill>") {
        return Vec::new();
    }

    let mut rendered = Vec::new();
    let mut seen = HashSet::new();

    for mention in skill_mentions(text) {
        let path = mention
            .path
            .map(|path| Path::new(normalize_skill_path(path)));
        let Some(skill) = resolve_skill_invocation(skills, Some(mention.name), path, cwd) else {
            continue;
        };
        if seen.insert(skill_identity(&skill)) {
            rendered.push(render_skill_block(&skill, None));
        }
    }

    rendered
}

#[derive(Debug, Clone)]
struct RequestedSkillEntry {
    identity: SkillIdentity,
    skill: Skill,
    arguments: Option<String>,
    frozen_body: Option<String>,
    has_structured_invocation: bool,
}

#[derive(Debug, Clone)]
enum RequestedSkillContextItem {
    Skill(Box<RequestedSkillEntry>),
    Error(String),
}

#[derive(Debug, Default)]
struct RequestedSkillContextCollector {
    items: Vec<RequestedSkillContextItem>,
    seen: HashSet<SkillIdentity>,
}

impl RequestedSkillContextCollector {
    fn extend_content(
        &mut self,
        content: &[ContentPart],
        skills: &[Skill],
        cwd: &Path,
        frozen_bodies: Option<&FrozenSkillBodies>,
    ) {
        for part in content {
            match part {
                ContentPart::Text { text } => self.extend_text(text, skills, cwd, frozen_bodies),
                ContentPart::Skill {
                    name,
                    path,
                    arguments,
                } => self.push_structured(
                    name.as_deref(),
                    path.as_deref(),
                    arguments,
                    skills,
                    cwd,
                    frozen_bodies,
                ),
                ContentPart::ImageUrl { .. }
                | ContentPart::ImageBase64 { .. }
                | ContentPart::File { .. } => {}
            }
        }
    }

    fn extend_text(
        &mut self,
        text: &str,
        skills: &[Skill],
        cwd: &Path,
        frozen_bodies: Option<&FrozenSkillBodies>,
    ) {
        if text.contains("<skill>") && text.contains("</skill>") {
            return;
        }

        for mention in skill_mentions(text) {
            let path = mention
                .path
                .map(|path| Path::new(normalize_skill_path(path)));
            let Some(skill) = resolve_skill_invocation(skills, Some(mention.name), path, cwd)
            else {
                continue;
            };
            let frozen_body = frozen_bodies.and_then(|bodies| bodies.body_for(&skill));
            self.push_skill(skill, None, false, frozen_body);
        }
    }

    fn push_structured(
        &mut self,
        name: Option<&str>,
        path: Option<&str>,
        arguments: &Option<String>,
        skills: &[Skill],
        cwd: &Path,
        frozen_bodies: Option<&FrozenSkillBodies>,
    ) {
        let skill_path = path.map(Path::new);
        let Some(skill) = resolve_skill_invocation(skills, name, skill_path, cwd) else {
            self.items.push(RequestedSkillContextItem::Error(format!(
                "Requested skill was not found or was ambiguous: {}",
                name.or(skill_path.and_then(Path::to_str)).unwrap_or("")
            )));
            return;
        };
        let frozen_body = frozen_bodies.and_then(|bodies| bodies.body_for(&skill));
        self.push_skill(skill, arguments.clone(), true, frozen_body);
    }

    fn push_skill(
        &mut self,
        skill: Skill,
        arguments: Option<String>,
        is_structured: bool,
        frozen_body: Option<&str>,
    ) {
        let identity = skill_identity(&skill);
        if self.seen.insert(identity.clone()) {
            self.items.push(RequestedSkillContextItem::Skill(Box::new(
                RequestedSkillEntry {
                    identity,
                    skill,
                    arguments,
                    frozen_body: frozen_body.map(ToOwned::to_owned),
                    has_structured_invocation: is_structured,
                },
            )));
            return;
        }

        if !is_structured {
            return;
        }

        let Some(entry) = self.items.iter_mut().find_map(|item| match item {
            RequestedSkillContextItem::Skill(entry) if entry.identity == identity => Some(entry),
            RequestedSkillContextItem::Skill(_) | RequestedSkillContextItem::Error(_) => None,
        }) else {
            return;
        };
        if !entry.has_structured_invocation {
            entry.arguments = arguments;
            entry.has_structured_invocation = true;
        }
    }

    fn into_contexts(self) -> RequestedSkillContexts {
        let contexts = self
            .items
            .into_iter()
            .map(|item| match item {
                RequestedSkillContextItem::Skill(entry) => render_skill_block_with_body(
                    &entry.skill,
                    entry.arguments.as_deref(),
                    entry.frozen_body.as_deref(),
                ),
                RequestedSkillContextItem::Error(error) => error,
            })
            .collect();

        RequestedSkillContexts {
            contexts,
            identities: self.seen,
        }
    }
}

pub fn materialize_skill_invocations(
    content: Vec<ContentPart>,
    skills: &[Skill],
    cwd: &Path,
) -> Vec<ContentPart> {
    content
        .into_iter()
        .map(|part| match part {
            ContentPart::Text { text } => expand_text_skill_mentions_with_cwd(&text, skills, cwd)
                .map(ContentPart::text)
                .unwrap_or(ContentPart::Text { text }),
            ContentPart::File { binding } => ContentPart::File { binding },
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => {
                let skill_path = path.as_deref().map(Path::new);
                render_skill_invocation(
                    skills,
                    name.as_deref(),
                    skill_path,
                    arguments.as_deref(),
                    cwd,
                )
                .map(ContentPart::text)
                .unwrap_or_else(|| {
                    ContentPart::text(format!(
                        "Requested skill was not found or was ambiguous: {}",
                        name.as_deref()
                            .or(skill_path.and_then(Path::to_str))
                            .unwrap_or("")
                    ))
                })
            }
            other => other,
        })
        .collect()
}

fn resolve_skill_invocation(
    skills: &[Skill],
    name: Option<&str>,
    path: Option<&Path>,
    cwd: &Path,
) -> Option<Skill> {
    let skill = if let Some(path) = path {
        resolve_loaded_skill_path(skills, path, cwd).cloned()
    } else {
        name.and_then(|name| resolve_unambiguous_skill_name(skills, name).cloned())
    }?;

    if name.is_some_and(|name| name != skill.name) {
        return None;
    }

    Some(skill)
}

fn resolve_loaded_skill_path<'a>(
    skills: &'a [Skill],
    path: &Path,
    cwd: &Path,
) -> Option<&'a Skill> {
    let requested_path = canonical_invocation_skill_path(path, cwd)?;
    let mut matches = skills.iter().filter(|skill| {
        skill_allows_path_invocation(skill)
            && fs::canonicalize(&skill.path).unwrap_or_else(|_| skill.path.clone())
                == requested_path
    });
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn canonical_invocation_skill_path(path: &Path, cwd: &Path) -> Option<PathBuf> {
    let path = normalize_invocation_path(path);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let skill_path = if path.is_dir() {
        path.join("SKILL.md")
    } else {
        path
    };
    fs::canonicalize(skill_path).ok()
}

fn skill_allows_path_invocation(skill: &Skill) -> bool {
    skill.model_visible || skill.content.is_some()
}

fn resolve_unambiguous_skill_name<'a>(skills: &'a [Skill], name: &str) -> Option<&'a Skill> {
    let matches = skills
        .iter()
        .filter(|skill| skill.name == name)
        .collect::<Vec<_>>();
    if is_reserved_official_skill_name(name) {
        let mut official_matches = matches
            .iter()
            .copied()
            .filter(|skill| is_official_location(skill.location));
        if let Some(first) = official_matches.next() {
            if official_matches.next().is_none() {
                return Some(first);
            }
        }
    }

    let mut matches = matches.into_iter();
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TextSkillMention<'a> {
    name: &'a str,
    path: Option<&'a str>,
}

fn skill_mentions(text: &str) -> Vec<TextSkillMention<'_>> {
    let mut mentions = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'[' {
            if let Some((name, path, end_index)) = parse_linked_skill_mention(text, bytes, index) {
                if is_skill_link_path(path) {
                    mentions.push(TextSkillMention {
                        name,
                        path: Some(path),
                    });
                }
                index = end_index;
                continue;
            }
        }

        if bytes[index] != b'$' {
            index += 1;
            continue;
        }

        let start = index + 1;
        let Some(first) = bytes.get(start) else {
            index += 1;
            continue;
        };
        if !is_mention_start_char(*first) {
            index += 1;
            continue;
        }

        let end = mention_name_end(bytes, start);

        let name = &text[start..end];
        if is_env_var_style_mention(name) {
            index = end;
            continue;
        }
        mentions.push(TextSkillMention { name, path: None });
        index = end.max(index + 1);
    }

    mentions
}

fn parse_linked_skill_mention<'a>(
    text: &'a str,
    bytes: &[u8],
    start: usize,
) -> Option<(&'a str, &'a str, usize)> {
    let sigil_index = start + 1;
    if bytes.get(sigil_index) != Some(&b'$') {
        return None;
    }

    let name_start = sigil_index + 1;
    let first = bytes.get(name_start)?;
    if !is_mention_start_char(*first) {
        return None;
    }

    let name_end = mention_name_end(bytes, name_start);
    if bytes.get(name_end) != Some(&b']') {
        return None;
    }

    let mut path_start = name_end + 1;
    while bytes
        .get(path_start)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        path_start += 1;
    }
    if bytes.get(path_start) != Some(&b'(') {
        return None;
    }

    let mut path_end = path_start + 1;
    while bytes.get(path_end).is_some_and(|byte| *byte != b')') {
        path_end += 1;
    }
    if bytes.get(path_end) != Some(&b')') {
        return None;
    }

    let path = text[path_start + 1..path_end].trim();
    if path.is_empty() {
        return None;
    }

    Some((&text[name_start..name_end], path, path_end + 1))
}

fn is_skill_link_path(path: &str) -> bool {
    path.starts_with(SKILL_PATH_PREFIX)
        || path
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case("SKILL.md"))
}

fn normalize_skill_path(path: &str) -> &str {
    path.strip_prefix(SKILL_PATH_PREFIX).unwrap_or(path)
}

pub(crate) fn skill_identity(skill: &Skill) -> SkillIdentity {
    SkillIdentity {
        source_path: skill_identity_path(skill),
        normalized_name: normalize_skill_name(&skill.name),
    }
}

fn skill_identity_path(skill: &Skill) -> PathBuf {
    fs::canonicalize(&skill.path).unwrap_or_else(|_| skill.path.clone())
}

fn normalize_skill_name(name: &str) -> String {
    name.trim().to_owned()
}

fn is_mention_start_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn mention_name_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start + 1;
    while end < bytes.len() {
        if is_mention_start_char(bytes[end])
            || (bytes[end] == b':'
                && bytes
                    .get(end + 1)
                    .is_some_and(|byte| is_mention_start_char(*byte)))
        {
            end += 1;
        } else {
            break;
        }
    }
    end
}

fn is_env_var_style_mention(name: &str) -> bool {
    name.bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && name.bytes().any(|byte| byte.is_ascii_uppercase())
}

fn render_skill_block(skill: &Skill, arguments: Option<&str>) -> String {
    render_skill_block_with_body(skill, arguments, None)
}

fn render_skill_block_with_body(
    skill: &Skill,
    arguments: Option<&str>,
    frozen_body: Option<&str>,
) -> String {
    let raw_content = frozen_body
        .map(ToOwned::to_owned)
        .or_else(|| skill.content.clone())
        .or_else(|| fs::read_to_string(&skill.path).ok())
        .unwrap_or_default();
    let skill_dir = skill.path.parent().unwrap_or_else(|| Path::new(""));
    let mut content = substitute_arguments(&raw_content, arguments, skill_dir);

    if let Some(arguments) = arguments.filter(|arguments| !arguments.trim().is_empty()) {
        if !uses_argument_placeholder(&raw_content) {
            content.push_str("\n\nARGUMENTS: ");
            content.push_str(arguments);
        }
    }

    format!(
        "<skill>\n<name>{}</name>\n<path>{}</path>\n<content>\n{}\n</content>\n</skill>",
        escape_xml(&skill.name),
        escape_xml(&skill.path.display().to_string()),
        content.trim_end()
    )
}

fn substitute_arguments(content: &str, arguments: Option<&str>, skill_dir: &Path) -> String {
    let arguments = arguments.unwrap_or_default();
    let mut substituted = content.to_owned();
    substituted = substituted.replace("${SKILL_DIR}", &skill_dir.display().to_string());

    let parts = arguments.split_whitespace().collect::<Vec<_>>();
    for index in (0..MAX_ARGUMENT_INDEX).rev() {
        let value = parts.get(index).copied().unwrap_or_default();
        substituted = substituted.replace(&format!("$ARGUMENTS[{index}]"), value);
        substituted = substituted.replace(&format!("${index}"), value);
    }
    substituted = substituted.replace("$ARGUMENTS", arguments);
    substituted
}

fn uses_argument_placeholder(content: &str) -> bool {
    if content.contains("$ARGUMENTS") {
        return true;
    }
    (0..MAX_ARGUMENT_INDEX).any(|index| content.contains(&format!("${index}")))
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

struct SkillLoader {
    skills: HashMap<PathBuf, Skill>,
    warnings: Vec<String>,
    discovered_roots: HashSet<PathBuf>,
    data_dir: Option<PathBuf>,
    comparison_base: PathBuf,
}

impl SkillLoader {
    fn discover_root(&mut self, root: &RootSpec) {
        let Ok(canonical_root) = fs::canonicalize(&root.path) else {
            return;
        };
        if self.should_skip_for_data_dir(&canonical_root) {
            return;
        }
        if !self.discovered_roots.insert(canonical_root.clone()) {
            return;
        }
        self.walk_root(&canonical_root, root.location);
    }

    fn walk_root(&mut self, root: &Path, location: SkillLocation) {
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        let mut visited = HashSet::new();

        while let Some((path, depth)) = stack.pop() {
            let Ok(canonical) = fs::canonicalize(&path) else {
                continue;
            };
            if !canonical.starts_with(root) {
                continue;
            }
            if self.should_skip_for_data_dir(&canonical) {
                continue;
            }
            if !visited.insert(canonical.clone()) {
                continue;
            }

            let skill_path = canonical.join("SKILL.md");
            if skill_path.is_file() {
                let Ok(canonical_skill_path) = fs::canonicalize(&skill_path) else {
                    continue;
                };
                if !canonical_skill_path.starts_with(root) {
                    continue;
                }
                if self.should_skip_for_data_dir(&canonical_skill_path) {
                    continue;
                }
                if let Some(parsed) = self.read_skill(&canonical_skill_path) {
                    let model_visible = !parsed.disable_model_invocation
                        && allow_implicit_invocation(&canonical_skill_path).unwrap_or(true);
                    self.insert_skill(parsed, location, model_visible, false);
                }
            }

            if depth >= MAX_DISCOVERY_DEPTH {
                continue;
            }

            let Ok(entries) = fs::read_dir(&canonical) else {
                continue;
            };
            let mut dirs = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            dirs.sort();
            dirs.reverse();

            for dir in dirs {
                if is_hidden_child(&dir) || self.should_skip_for_data_dir(&dir) {
                    continue;
                }
                stack.push((dir, depth + 1));
            }
        }
    }

    fn load_explicit(
        &mut self,
        value: &str,
        cwd: &Path,
        roots: &[RootSpec],
    ) -> Result<(), SkillLoadError> {
        let Some(skill_path) = self.resolve_explicit_skill(value, cwd, roots)? else {
            self.warnings.push(format!("skill not found: {value}"));
            return Ok(());
        };
        self.ensure_explicit_not_under_data_dir(value, &skill_path)?;
        let Some(parsed) = self.read_skill(&skill_path) else {
            return Ok(());
        };
        let location = explicit_skill_location(&skill_path, roots);
        self.insert_skill(parsed, location, true, true);
        Ok(())
    }

    fn read_skill(&mut self, path: &Path) -> Option<ParsedSkill> {
        let content = match read_skill_file(path) {
            Ok(content) => content,
            Err(error) => {
                self.warnings.push(error);
                return None;
            }
        };

        match parse_skill_content(path, content) {
            Ok(skill) => Some(skill),
            Err(warning) => {
                self.warnings.push(warning);
                None
            }
        }
    }

    fn insert_skill(
        &mut self,
        parsed: ParsedSkill,
        location: SkillLocation,
        model_visible: bool,
        include_content: bool,
    ) {
        let path = fs::canonicalize(&parsed.path).unwrap_or_else(|_| parsed.path.clone());
        let skill = Skill {
            name: parsed.name,
            description: parsed.description,
            path: path.clone(),
            location,
            model_visible,
            content: include_content.then_some(parsed.content),
            when_to_use: parsed.when_to_use,
            allowed_tools: parsed.allowed_tools,
            argument_hint: parsed.argument_hint,
            arguments: parsed.arguments,
            metadata: parsed.metadata,
            user_invocable: parsed.user_invocable,
        };

        if self.skills.insert(path.clone(), skill).is_some() {
            self.warnings.push(format!(
                "duplicate skill path '{}', using higher priority entry",
                path.display()
            ));
        }
    }

    fn into_loaded_skills(mut self) -> LoadedSkills {
        let mut skills = self.skills.into_values().collect::<Vec<_>>();
        skills = filter_reserved_non_official_skills(skills, &mut self.warnings);
        skills.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
        LoadedSkills {
            skills,
            warnings: self.warnings,
        }
    }

    fn resolve_explicit_skill(
        &self,
        value: &str,
        cwd: &Path,
        roots: &[RootSpec],
    ) -> Result<Option<PathBuf>, SkillLoadError> {
        let raw_path = Path::new(value);
        if looks_like_path(value) {
            let path = if raw_path.is_absolute() {
                raw_path.to_path_buf()
            } else {
                cwd.join(raw_path)
            };
            self.ensure_explicit_not_under_data_dir(value, &path)?;
            return Ok(skill_file_from_path(&path));
        }

        let mut state = ExplicitResolveState::default();
        for root in roots.iter().rev() {
            if let Some(path) =
                self.skill_file_from_root_for_explicit(&root.path, value, &mut state)?
            {
                return Ok(Some(path));
            }
            if let Some(path) = self.find_skill_named_for_explicit(&root.path, value, &mut state)? {
                return Ok(Some(path));
            }
        }

        let fallback_path = cwd.join(raw_path);
        if let Some(path) =
            self.skill_file_from_path_for_explicit(&fallback_path, value, &mut state)?
        {
            return Ok(Some(path));
        }
        if let Some(excluded) = state.excluded_data_dir_source {
            return Err(self.explicit_data_dir_source_error(value, &excluded));
        }
        Ok(None)
    }

    fn skill_file_from_root_for_explicit(
        &self,
        root: &Path,
        name: &str,
        state: &mut ExplicitResolveState,
    ) -> Result<Option<PathBuf>, SkillLoadError> {
        self.skill_file_from_path_for_explicit(&root.join(name), name, state)
    }

    fn skill_file_from_path_for_explicit(
        &self,
        path: &Path,
        value: &str,
        state: &mut ExplicitResolveState,
    ) -> Result<Option<PathBuf>, SkillLoadError> {
        if self.record_excluded_explicit_source(path, state)? {
            return Ok(None);
        }
        let Some(skill_path) = skill_file_from_path(path) else {
            return Ok(None);
        };
        self.ensure_explicit_not_under_data_dir(value, &skill_path)?;
        Ok(Some(skill_path))
    }

    fn find_skill_named_for_explicit(
        &self,
        root: &Path,
        name: &str,
        state: &mut ExplicitResolveState,
    ) -> Result<Option<PathBuf>, SkillLoadError> {
        if self.record_excluded_explicit_source(root, state)? {
            return Ok(None);
        }
        let root = match fs::canonicalize(root) {
            Ok(root) => root,
            Err(_) => return Ok(None),
        };
        let mut stack = vec![(root.clone(), 0usize)];
        let mut visited = HashSet::new();

        while let Some((path, depth)) = stack.pop() {
            let Ok(canonical) = fs::canonicalize(path) else {
                continue;
            };
            if !canonical.starts_with(&root) {
                continue;
            }
            if self.record_excluded_explicit_source(&canonical, state)? {
                continue;
            }
            if !visited.insert(canonical.clone()) {
                continue;
            }

            let skill_path = canonical.join("SKILL.md");
            if skill_path.is_file() {
                let Ok(canonical_skill_path) = fs::canonicalize(&skill_path) else {
                    continue;
                };
                if !canonical_skill_path.starts_with(&root) {
                    continue;
                }
                if self.record_excluded_explicit_source(&canonical_skill_path, state)? {
                    continue;
                }
                let Ok(content) = read_skill_file(&canonical_skill_path) else {
                    continue;
                };
                if parse_skill_content(&canonical_skill_path, content)
                    .ok()
                    .is_some_and(|skill| skill.name == name)
                {
                    return Ok(Some(canonical_skill_path));
                }
            }

            if depth >= MAX_DISCOVERY_DEPTH {
                continue;
            }

            let Ok(entries) = fs::read_dir(&canonical) else {
                continue;
            };
            let mut dirs = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir() && !is_hidden_child(path))
                .collect::<Vec<_>>();
            dirs.sort();
            dirs.reverse();
            for dir in dirs {
                if self.record_excluded_explicit_source(&dir, state)? {
                    continue;
                }
                stack.push((dir, depth + 1));
            }
        }
        Ok(None)
    }

    fn record_excluded_explicit_source(
        &self,
        path: &Path,
        state: &mut ExplicitResolveState,
    ) -> Result<bool, SkillLoadError> {
        match self.data_dir_relation(path) {
            Ok(true) => {
                if state.excluded_data_dir_source.is_none()
                    && (path.exists() || path.join("SKILL.md").exists())
                {
                    state.excluded_data_dir_source = Some(path.to_path_buf());
                }
                Ok(true)
            }
            Ok(false) => Ok(false),
            Err(message) => Err(SkillLoadError::new(message)),
        }
    }

    fn ensure_explicit_not_under_data_dir(
        &self,
        value: &str,
        path: &Path,
    ) -> Result<(), SkillLoadError> {
        match self.data_dir_relation(path) {
            Ok(true) => Err(self.explicit_data_dir_source_error(value, path)),
            Ok(false) => Ok(()),
            Err(message) => Err(SkillLoadError::new(message)),
        }
    }

    fn explicit_data_dir_source_error(&self, value: &str, path: &Path) -> SkillLoadError {
        let data_dir = self
            .data_dir
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        SkillLoadError::new(format!(
            "explicit skill rejected: {value} resolves to '{}' under runtime.data_dir '{}'",
            path.display(),
            data_dir
        ))
    }

    fn should_skip_for_data_dir(&mut self, path: &Path) -> bool {
        match self.data_dir_relation(path) {
            Ok(is_under) => is_under,
            Err(message) => {
                self.warnings
                    .push(format!("{message}; skipping skill source"));
                true
            }
        }
    }

    fn data_dir_relation(&self, path: &Path) -> Result<bool, String> {
        let Some(data_dir) = self.data_dir.as_ref() else {
            return Ok(false);
        };
        is_same_or_descendant(path, data_dir, &self.comparison_base).map_err(|error| {
            format!(
                "unable to compare skill path '{}' with runtime.data_dir '{}': {error}",
                path.display(),
                data_dir.display()
            )
        })
    }
}

#[derive(Debug, Default)]
struct ExplicitResolveState {
    excluded_data_dir_source: Option<PathBuf>,
}

fn discovery_roots(config: &SkillLoadConfig, cwd: &Path) -> Vec<RootSpec> {
    let mut roots = Vec::new();
    let home = home_dir();

    if let Some(home) = home.as_ref() {
        roots.push(RootSpec {
            path: home.join(".agents").join("skills"),
            location: SkillLocation::User,
        });
    }

    if let Some(botified_home) = config.botified_home.as_ref() {
        roots.push(RootSpec {
            path: botified_home.join("skills"),
            location: SkillLocation::User,
        });
    }

    let mut ancestry = cwd.ancestors().collect::<Vec<_>>();
    ancestry.reverse();
    for dir in ancestry {
        roots.push(RootSpec {
            path: dir.join(".agents").join("skills"),
            location: SkillLocation::Project,
        });
    }

    roots.push(RootSpec {
        path: cwd.join(".botified").join("skills"),
        location: SkillLocation::Project,
    });

    roots.push(RootSpec {
        path: cwd.join("skills"),
        location: SkillLocation::Workspace,
    });

    roots.extend(official_skill_roots().into_iter().map(|path| RootSpec {
        path,
        location: SkillLocation::System,
    }));

    roots
}

fn official_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(share_dir) = std::env::var_os(BOTIFIED_SHARE_DIR_ENV).map(PathBuf::from) {
        let nested = share_dir.join("botified").join("skills");
        let flat = share_dir.join("skills");
        if nested.is_dir() {
            push_unique_existing_root(&mut roots, nested);
        } else {
            push_unique_existing_root(&mut roots, flat);
        }
        return roots;
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(prefix) = current_exe.parent().and_then(Path::parent) {
            push_unique_existing_root(
                &mut roots,
                prefix.join("share").join("botified").join("skills"),
            );
        }
    }

    roots
}

fn push_unique_existing_root(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.is_dir() {
        return;
    }
    let canonical = fs::canonicalize(&path).unwrap_or(path);
    if !roots.iter().any(|existing| existing == &canonical) {
        roots.push(canonical);
    }
}

fn explicit_skill_location(path: &Path, roots: &[RootSpec]) -> SkillLocation {
    if roots
        .iter()
        .filter(|root| is_official_location(root.location))
        .any(|root| is_under_root(path, &root.path))
    {
        SkillLocation::System
    } else {
        SkillLocation::Explicit
    }
}

fn is_under_root(path: &Path, root: &Path) -> bool {
    let Ok(path) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    path.starts_with(root)
}

fn filter_reserved_non_official_skills(
    skills: Vec<Skill>,
    warnings: &mut Vec<String>,
) -> Vec<Skill> {
    skills
        .into_iter()
        .filter_map(|skill| {
            if is_reserved_official_skill_name(&skill.name) && !is_official_location(skill.location)
            {
                warnings.push(format!(
                    "ignored non-official skill '{}' at '{}' because the botified-* namespace is reserved for official bundled skills",
                    skill.name,
                    skill.path.display()
                ));
                None
            } else {
                Some(skill)
            }
        })
        .collect()
}

fn is_official_location(location: SkillLocation) -> bool {
    matches!(location, SkillLocation::System)
}

fn is_reserved_official_skill_name(name: &str) -> bool {
    name.starts_with(BOTIFIED_RESERVED_SKILL_PREFIX)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn is_hidden_child(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\') || value == "." || value == ".."
}

fn skill_file_from_path(path: &Path) -> Option<PathBuf> {
    if path.is_dir() {
        let skill_path = path.join("SKILL.md");
        return skill_path.is_file().then_some(skill_path);
    }
    path.is_file().then_some(path.to_path_buf())
}

fn normalize_invocation_path(path: &Path) -> PathBuf {
    path.to_str()
        .and_then(|path| path.strip_prefix(SKILL_PATH_PREFIX))
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

fn read_skill_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to read skill {}: {error}", path.display()))?;
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return Err(format!(
            "skill {} exceeds {} bytes",
            path.display(),
            MAX_SKILL_FILE_BYTES
        ));
    }
    fs::read_to_string(path)
        .map_err(|error| format!("failed to read skill {}: {error}", path.display()))
}

fn parse_skill_content(path: &Path, content: String) -> Result<ParsedSkill, String> {
    let parent_name = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let (frontmatter, _) = split_frontmatter(&content);
    let yaml = parse_frontmatter_yaml(path, frontmatter)?;
    let metadata = skill_metadata(&yaml, path);

    let name = yaml_string(&yaml, "name")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| parent_name.to_owned());
    let name = compress_whitespace(&name);
    if !valid_skill_name(&name) {
        return Err(format!(
            "skill {} has invalid name '{name}'",
            path.display()
        ));
    }

    let description = yaml_string(&yaml, "description").map(|value| compress_whitespace(&value));
    let Some(description) = description.filter(|value| !value.is_empty()) else {
        return Err(format!("skill {} missing description", path.display()));
    };

    let disable_model_invocation = yaml_bool(&yaml, "disable-model-invocation").unwrap_or(false);

    Ok(ParsedSkill {
        name,
        description,
        disable_model_invocation,
        content,
        path: path.to_path_buf(),
        when_to_use: yaml_string(&yaml, "when_to_use").map(|value| compress_whitespace(&value)),
        allowed_tools: yaml_string_list(&yaml, "allowed-tools"),
        argument_hint: yaml_string(&yaml, "argument-hint").map(|value| compress_whitespace(&value)),
        arguments: yaml_get(&yaml, "arguments").and_then(yaml_to_json),
        metadata,
        user_invocable: yaml_bool(&yaml, "user-invocable"),
    })
}

fn split_frontmatter(content: &str) -> (&str, &str) {
    let mut offset = 0usize;
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return ("", "");
    };
    offset += first.len();
    if first.trim() != "---" {
        return ("", content);
    }

    let frontmatter_start = offset;
    for line in lines {
        if line.trim() == "---" {
            let frontmatter = &content[frontmatter_start..offset];
            let body_start = offset + line.len();
            return (frontmatter, &content[body_start..]);
        }
        offset += line.len();
    }

    ("", content)
}

fn parse_frontmatter_yaml(path: &Path, frontmatter: &str) -> Result<YamlValue, String> {
    if frontmatter.trim().is_empty() {
        return Ok(YamlValue::Mapping(Default::default()));
    }
    serde_yaml::from_str(frontmatter).map_err(|error| {
        format!(
            "skill {} has invalid YAML frontmatter: {error}",
            path.display()
        )
    })
}

fn yaml_get<'a>(yaml: &'a YamlValue, key: &str) -> Option<&'a YamlValue> {
    let map = yaml.as_mapping()?;
    map.get(YamlValue::String(key.to_owned()))
}

fn yaml_string(yaml: &YamlValue, key: &str) -> Option<String> {
    match yaml_get(yaml, key)? {
        YamlValue::String(value) => Some(value.to_owned()),
        YamlValue::Number(value) => Some(value.to_string()),
        YamlValue::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn yaml_bool(yaml: &YamlValue, key: &str) -> Option<bool> {
    match yaml_get(yaml, key)? {
        YamlValue::Bool(value) => Some(*value),
        YamlValue::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn yaml_string_list(yaml: &YamlValue, key: &str) -> Vec<String> {
    match yaml_get(yaml, key) {
        Some(YamlValue::Sequence(values)) => values
            .iter()
            .filter_map(|value| match value {
                YamlValue::String(value) => Some(value.to_owned()),
                YamlValue::Number(value) => Some(value.to_string()),
                _ => None,
            })
            .collect(),
        Some(YamlValue::String(value)) => split_allowed_tools(value),
        _ => Vec::new(),
    }
}

fn split_allowed_tools(value: &str) -> Vec<String> {
    let mut tools = Vec::new();
    let mut current = String::new();
    let mut paren_depth = 0usize;

    for character in value.chars() {
        match character {
            '(' => {
                paren_depth += 1;
                current.push(character);
            }
            ')' => {
                paren_depth = paren_depth.saturating_sub(1);
                current.push(character);
            }
            ',' if paren_depth == 0 => push_allowed_tool(&mut tools, &mut current),
            character if character.is_whitespace() && paren_depth == 0 => {
                push_allowed_tool(&mut tools, &mut current)
            }
            _ => current.push(character),
        }
    }
    push_allowed_tool(&mut tools, &mut current);
    tools
}

fn push_allowed_tool(tools: &mut Vec<String>, current: &mut String) {
    let value = current.trim();
    if !value.is_empty() {
        tools.push(value.to_owned());
    }
    current.clear();
}

fn yaml_to_json(value: &YamlValue) -> Option<JsonValue> {
    serde_json::to_value(value).ok()
}

fn skill_metadata(yaml: &YamlValue, skill_path: &Path) -> Option<JsonValue> {
    merge_metadata(
        yaml_get(yaml, "metadata").and_then(yaml_to_json),
        botified_yaml_metadata(skill_path),
    )
}

fn merge_metadata(
    frontmatter: Option<JsonValue>,
    botified: Option<JsonValue>,
) -> Option<JsonValue> {
    match (frontmatter, botified) {
        (None, None) => None,
        (Some(metadata), None) => Some(metadata),
        (None, Some(botified)) => Some(metadata_with_botified(botified)),
        (Some(JsonValue::Object(mut metadata)), Some(botified)) => {
            metadata.insert(BOTIFIED_METADATA_KEY.to_owned(), botified);
            Some(JsonValue::Object(metadata))
        }
        (Some(metadata), Some(botified)) => {
            let mut object = serde_json::Map::new();
            object.insert("frontmatter".to_owned(), metadata);
            object.insert(BOTIFIED_METADATA_KEY.to_owned(), botified);
            Some(JsonValue::Object(object))
        }
    }
}

fn metadata_with_botified(botified: JsonValue) -> JsonValue {
    let mut object = serde_json::Map::new();
    object.insert(BOTIFIED_METADATA_KEY.to_owned(), botified);
    JsonValue::Object(object)
}

fn botified_yaml_metadata(skill_path: &Path) -> Option<JsonValue> {
    let skill_dir = skill_path.parent()?;
    let content = fs::read_to_string(skill_dir.join("agents").join("botified.yaml")).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    yaml_to_json(&yaml)
}

fn compress_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= MAX_SKILL_NAME_LEN
}

fn allow_implicit_invocation(skill_path: &Path) -> Option<bool> {
    let skill_dir = skill_path.parent()?;
    let path = skill_dir.join("agents").join("botified.yaml");
    let content = fs::read_to_string(path).ok()?;
    let yaml: YamlValue = serde_yaml::from_str(&content).ok()?;
    let policy = yaml_get(&yaml, "policy")?;
    match policy {
        YamlValue::Mapping(map) => {
            match map.get(YamlValue::String("allow_implicit_invocation".to_owned()))? {
                YamlValue::Bool(value) => Some(*value),
                YamlValue::String(value) => match value.trim().to_ascii_lowercase().as_str() {
                    "true" | "yes" | "1" => Some(true),
                    "false" | "no" | "0" => Some(false),
                    _ => None,
                },
                _ => None,
            }
        }
        _ => None,
    }
}
