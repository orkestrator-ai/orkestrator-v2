// Data models for the application
// These mirror the TypeScript types in src/types/index.ts

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Project represents a Git repository that can have multiple environments
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub git_url: String,
    pub local_path: Option<String>,
    pub added_at: DateTime<Utc>,
    /// Display order in the sidebar (lower values appear first)
    #[serde(default)]
    pub order: i32,
}

impl Project {
    pub fn new(git_url: String, local_path: Option<String>) -> Self {
        let name = extract_repo_name(&git_url);
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            git_url,
            local_path,
            added_at: Utc::now(),
            order: 0,
        }
    }
}

/// Extract repository name from git URL
/// Handles both SSH (git@github.com:user/repo.git) and HTTPS (https://github.com/user/repo.git)
fn extract_repo_name(git_url: &str) -> String {
    let url = git_url.trim();

    // Remove .git suffix if present
    let url = url.strip_suffix(".git").unwrap_or(url);

    // Try to extract the last path component
    if let Some(name) = url.rsplit('/').next() {
        if !name.is_empty() {
            return name.to_string();
        }
    }

    // For SSH URLs like git@github.com:user/repo
    if let Some(name) = url.rsplit(':').next() {
        if let Some(name) = name.rsplit('/').next() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }

    // Fallback to the whole URL
    url.to_string()
}

/// Environment status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentStatus {
    Running,
    Stopped,
    Error,
    Creating,
    Stopping,
}

/// Pull request state from GitHub
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    /// PR is open and active
    Open,
    /// PR has been merged
    Merged,
    /// PR was closed without merging
    Closed,
}

/// Network access mode for environment containers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NetworkAccessMode {
    /// Full unrestricted internet access (no firewall rules)
    Full,
    /// Restricted access with domain whitelist (default for security)
    #[default]
    Restricted,
}

/// Type of environment - containerized (Docker) or local (git worktree)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentType {
    /// Docker container-based environment (default for backward compatibility)
    #[default]
    Containerized,
    /// Local git worktree-based environment
    Local,
}

/// Port protocol type for port mappings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum PortProtocol {
    #[default]
    Tcp,
    Udp,
}

impl std::fmt::Display for PortProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortProtocol::Tcp => write!(f, "tcp"),
            PortProtocol::Udp => write!(f, "udp"),
        }
    }
}

/// Port mapping configuration for container ports
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    /// Port number inside the container
    pub container_port: u16,
    /// Port number on the host machine
    pub host_port: u16,
    /// Protocol (tcp or udp), defaults to tcp
    #[serde(default)]
    pub protocol: PortProtocol,
}

impl std::fmt::Display for EnvironmentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnvironmentStatus::Running => write!(f, "running"),
            EnvironmentStatus::Stopped => write!(f, "stopped"),
            EnvironmentStatus::Error => write!(f, "error"),
            EnvironmentStatus::Creating => write!(f, "creating"),
            EnvironmentStatus::Stopping => write!(f, "stopping"),
        }
    }
}

/// Environment represents an isolated development environment for a project
/// Can be either a Docker container or a local git worktree
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// Git branch name for this environment (matches environment name)
    /// Defaults to "main" for backward compatibility with existing environments
    #[serde(default = "default_branch")]
    pub branch: String,
    pub container_id: Option<String>,
    pub status: EnvironmentStatus,
    pub pr_url: Option<String>,
    /// State of the PR (open, merged, closed)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_state: Option<PrState>,
    /// Whether the PR has merge conflicts with the target branch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_merge_conflicts: Option<bool>,
    pub created_at: DateTime<Utc>,
    /// Enable debug mode for verbose logging in container entrypoint
    #[serde(default)]
    pub debug_mode: bool,
    /// Network access mode (full or restricted)
    /// Defaults to Restricted for security
    #[serde(default)]
    pub network_access_mode: NetworkAccessMode,
    /// Custom allowed domains for this environment (overrides global if set)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Vec<String>>,
    /// Display order within the project (lower values appear first)
    #[serde(default)]
    pub order: i32,
    /// Port mappings for container (require restart to apply changes)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_mappings: Option<Vec<PortMapping>>,
    /// Container entry port (e.g. 3000 for a web server).
    /// Copied from the project's entry_port setting at container creation time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_port: Option<u16>,
    /// Dynamically allocated host port mapped to the project's entry port.
    /// Set after container creation when the project has an entry_port configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_entry_port: Option<u16>,

    // === Local environment fields ===
    /// Type of environment (containerized or local)
    /// Defaults to Containerized for backward compatibility
    #[serde(default)]
    pub environment_type: EnvironmentType,
    /// Path to git worktree (only for local environments)
    /// e.g., ~/orkestrator-ai/workspaces/project-name-abc123
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// PID of the opencode serve process (only for local environments)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_pid: Option<u32>,
    /// PID of the claude-bridge process (only for local environments)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_bridge_pid: Option<u32>,
    /// PID of the codex-bridge process (only for local environments)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_bridge_pid: Option<u32>,
    /// Host port for opencode server (local mode - static allocation)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_opencode_port: Option<u16>,
    /// Host port for claude-bridge server (local mode - static allocation)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_claude_port: Option<u16>,
    /// Host port for codex-bridge server (local mode - static allocation)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_codex_port: Option<u16>,

    // === Agent settings overrides ===
    /// Per-environment default agent override (None = use global config)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<DefaultAgent>,
    /// Per-environment Claude mode override (None = use global config)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_mode: Option<ClaudeMode>,
    /// Per-environment OpenCode mode override (None = use global config)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_mode: Option<OpenCodeMode>,
    /// Per-environment Codex mode override (None = use global config)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_mode: Option<CodexMode>,

    /// Whether setup scripts (from orkestrator-ai.json setupLocal or container
    /// workspace initialization) have completed for this environment. Persisted
    /// so native chat tabs can skip the "waiting for setup" UI after app restart,
    /// and so incomplete setup can be re-run on the next app session.
    #[serde(default)]
    pub setup_scripts_complete: bool,
    /// Initial prompt used when the environment was created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
}

/// Default branch for backward compatibility with existing environments
fn default_branch() -> String {
    "main".to_string()
}

/// Sanitize a string into a URL/identifier-safe slug.
///
/// Keeps ASCII alphanumerics and underscores, replaces spaces, dots, slashes,
/// and hyphens with a single hyphen, drops everything else, and trims leading/
/// trailing hyphens and dots. Returns `fallback` when the result would be empty.
/// Truncates to `max_len` characters (on a char boundary, without a trailing hyphen).
pub fn sanitize_slug(name: &str, fallback: &str, max_len: usize) -> String {
    let mut result = String::with_capacity(name.len());
    let mut last_was_hyphen = false;

    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            result.push(c.to_ascii_lowercase());
            last_was_hyphen = false;
        } else if c == '-' || c == ' ' || c == '.' || c == '/' {
            if !last_was_hyphen && !result.is_empty() {
                result.push('-');
                last_was_hyphen = true;
            }
        }
        // Other characters are silently dropped
    }

    // Remove trailing hyphens
    while result.ends_with('-') {
        result.pop();
    }

    // Ensure the name doesn't start with a hyphen or dot
    result = result
        .trim_start_matches(|c: char| c == '-' || c == '.')
        .to_string();

    // Truncate to max_len on a char boundary, then trim any trailing hyphen
    if max_len > 0 && result.len() > max_len {
        result.truncate(max_len);
        while result.ends_with('-') {
            result.pop();
        }
    }

    if result.is_empty() {
        result = fallback.to_string();
    }

    result
}

/// Sanitize a string for use as a git branch name.
/// Delegates to [`sanitize_slug`] with a branch-appropriate fallback.
pub fn sanitize_branch_name(name: &str) -> String {
    sanitize_slug(name, "env", 0)
}

/// Sanitize a string for use as an environment name.
/// Produces a lowercase kebab-case slug matching the branch/container name convention.
/// Delegates to [`sanitize_slug`] with a max length of 100 characters.
pub fn sanitize_environment_name(name: &str) -> String {
    sanitize_slug(name, "env", 100)
}

impl Environment {
    pub fn new(project_id: String) -> Self {
        let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
        let name = timestamp.to_string();
        // Branch name matches environment name for easy identification
        let branch = sanitize_branch_name(&name);

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            name,
            branch,
            container_id: None,
            status: EnvironmentStatus::Stopped,
            pr_url: None,
            pr_state: None,
            has_merge_conflicts: None,
            created_at: Utc::now(),
            debug_mode: false,
            network_access_mode: NetworkAccessMode::default(),
            allowed_domains: None,
            order: 0,
            port_mappings: None,
            entry_port: None,
            host_entry_port: None,
            // Local environment fields default to None/Containerized
            environment_type: EnvironmentType::default(),
            worktree_path: None,
            opencode_pid: None,
            claude_bridge_pid: None,
            codex_bridge_pid: None,
            local_opencode_port: None,
            local_claude_port: None,
            local_codex_port: None,
            default_agent: None,
            claude_mode: None,
            opencode_mode: None,
            codex_mode: None,
            setup_scripts_complete: false,
            initial_prompt: None,
        }
    }

    /// Create an environment with a custom name (and matching branch)
    pub fn with_name(project_id: String, name: String) -> Self {
        let name = sanitize_environment_name(&name);
        let branch = sanitize_branch_name(&name);

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            name,
            branch,
            container_id: None,
            status: EnvironmentStatus::Stopped,
            pr_url: None,
            pr_state: None,
            has_merge_conflicts: None,
            created_at: Utc::now(),
            debug_mode: false,
            network_access_mode: NetworkAccessMode::default(),
            allowed_domains: None,
            order: 0,
            port_mappings: None,
            entry_port: None,
            host_entry_port: None,
            // Local environment fields default to None/Containerized
            environment_type: EnvironmentType::default(),
            worktree_path: None,
            opencode_pid: None,
            claude_bridge_pid: None,
            codex_bridge_pid: None,
            local_opencode_port: None,
            local_claude_port: None,
            local_codex_port: None,
            default_agent: None,
            claude_mode: None,
            opencode_mode: None,
            codex_mode: None,
            setup_scripts_complete: false,
            initial_prompt: None,
        }
    }

    /// Create a local environment with a custom name
    pub fn new_local(project_id: String, name: String) -> Self {
        let name = sanitize_environment_name(&name);
        let branch = sanitize_branch_name(&name);

        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            name,
            branch,
            container_id: None,
            status: EnvironmentStatus::Stopped,
            pr_url: None,
            pr_state: None,
            has_merge_conflicts: None,
            created_at: Utc::now(),
            debug_mode: false,
            network_access_mode: NetworkAccessMode::Full, // Local environments have full network access
            allowed_domains: None,
            order: 0,
            port_mappings: None,
            entry_port: None,
            host_entry_port: None,
            // Local environment specific
            environment_type: EnvironmentType::Local,
            worktree_path: None,
            opencode_pid: None,
            claude_bridge_pid: None,
            codex_bridge_pid: None,
            local_opencode_port: None,
            local_claude_port: None,
            local_codex_port: None,
            default_agent: None,
            claude_mode: None,
            opencode_mode: None,
            codex_mode: None,
            setup_scripts_complete: false,
            initial_prompt: None,
        }
    }

    /// Check if this is a local (worktree-based) environment
    pub fn is_local(&self) -> bool {
        matches!(self.environment_type, EnvironmentType::Local)
    }

    /// Check if this is a containerized (Docker-based) environment
    pub fn is_containerized(&self) -> bool {
        matches!(self.environment_type, EnvironmentType::Containerized)
    }
}

// ============================================================================
// Kanban Models - Task board for project management
// ============================================================================

/// Status of a kanban task
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum KanbanStatus {
    Backlog,
    InProgress,
    Review,
    Done,
}

/// A comment on a kanban task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanComment {
    pub id: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

/// An image attached to a kanban task.
/// Image data is stored as a WebP file on disk at `{data_dir}/kanban-images/{id}.webp`.
/// The JSON only stores this reference metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanImage {
    pub id: String,
    /// Original filename before conversion
    pub filename: String,
    pub created_at: DateTime<Utc>,
}

/// A kanban task/ticket
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTask {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub acceptance_criteria: String,
    pub status: KanbanStatus,
    pub comments: Vec<KanbanComment>,
    #[serde(default)]
    pub images: Vec<KanbanImage>,
    pub created_at: DateTime<Utc>,
    pub order: i32,
    /// Linked build environment ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<String>,
    /// Active build pipeline ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_pipeline_id: Option<String>,
    /// PR URL associated with this task (set when PR is created during build)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    /// PR state (open, merged, closed) - mirrors PrState but stored on the task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_state: Option<String>,
    /// Whether a merge/close comment has already been added (prevents duplicate comments)
    #[serde(default)]
    pub pr_merge_commented: bool,
}

impl KanbanTask {
    pub fn new(project_id: String, title: String, description: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            title,
            description,
            acceptance_criteria: String::new(),
            status: KanbanStatus::Backlog,
            comments: Vec::new(),
            images: Vec::new(),
            created_at: Utc::now(),
            order: 0,
            environment_id: None,
            build_pipeline_id: None,
            pr_url: None,
            pr_state: None,
            pr_merge_commented: false,
        }
    }
}

/// Project-level notes stored alongside kanban data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNotes {
    pub project_id: String,
    pub content: String,
    pub updated_at: DateTime<Utc>,
}

// ============================================================================
// Session Models - Terminal session tracking for environments
// ============================================================================

/// Type of terminal session
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionType {
    /// Plain shell session (no Claude)
    Plain,
    /// Claude Code session with normal permissions
    Claude,
    /// Claude Code session with --dangerously-skip-permissions
    ClaudeYolo,
    /// OpenCode session
    Opencode,
    /// Codex session
    Codex,
    /// Root shell session (logged in as root)
    Root,
}

impl Default for SessionType {
    fn default() -> Self {
        SessionType::Plain
    }
}

impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::Plain => write!(f, "plain"),
            SessionType::Claude => write!(f, "claude"),
            SessionType::ClaudeYolo => write!(f, "claude-yolo"),
            SessionType::Opencode => write!(f, "opencode"),
            SessionType::Codex => write!(f, "codex"),
            SessionType::Root => write!(f, "root"),
        }
    }
}

/// Connection status of a terminal session
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// Session is actively connected (terminal tab is open)
    Connected,
    /// Session was disconnected (tab closed, but session may be resumable)
    Disconnected,
}

impl Default for SessionStatus {
    fn default() -> Self {
        SessionStatus::Disconnected
    }
}

impl std::fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionStatus::Connected => write!(f, "connected"),
            SessionStatus::Disconnected => write!(f, "disconnected"),
        }
    }
}

/// Terminal session represents a PTY session within an environment container
/// Sessions track connection state and can be reconnected with restored terminal output
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Unique session ID (UUID)
    pub id: String,
    /// Parent environment ID
    pub environment_id: String,
    /// Docker container ID (from environment)
    pub container_id: String,
    /// Frontend tab ID for session restoration
    pub tab_id: String,
    /// Type of session (plain, claude, claude-yolo)
    #[serde(default)]
    pub session_type: SessionType,
    /// Connection status
    #[serde(default)]
    pub status: SessionStatus,
    /// When the session was created
    pub created_at: DateTime<Utc>,
    /// Last activity timestamp (updated periodically during use)
    pub last_activity_at: DateTime<Utc>,
    /// Custom name for the session (user-defined)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Display order within the environment (lower = higher in list)
    #[serde(default)]
    pub order: i32,
    /// Whether the auto-launch command (e.g., claude) was executed for this session
    /// Used to prevent re-launching Claude on app restart/reconnection
    #[serde(default)]
    pub has_launched_command: bool,
}

impl Session {
    /// Create a new session for an environment
    pub fn new(
        environment_id: String,
        container_id: String,
        tab_id: String,
        session_type: SessionType,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            environment_id,
            container_id,
            tab_id,
            session_type,
            status: SessionStatus::Connected,
            created_at: now,
            last_activity_at: now,
            name: None,
            order: 0, // Will be set properly when added to storage
            has_launched_command: false,
        }
    }

    /// Update the last activity timestamp to now
    pub fn touch(&mut self) {
        self.last_activity_at = Utc::now();
    }
}

/// Container resource limits
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerResources {
    pub cpu_cores: u32,
    pub memory_gb: u32,
}

impl Default for ContainerResources {
    fn default() -> Self {
        Self {
            cpu_cores: 2,
            memory_gb: 4,
        }
    }
}

/// Default allowed domains for restricted network mode
fn default_allowed_domains() -> Vec<String> {
    vec![
        "github.com".to_string(),
        "api.github.com".to_string(),
        "registry.npmjs.org".to_string(),
        "bun.sh".to_string(),
        "api.anthropic.com".to_string(),
        "sentry.io".to_string(),
        "statsig.anthropic.com".to_string(),
        "statsig.com".to_string(),
        "marketplace.visualstudio.com".to_string(),
        "vscode.blob.core.windows.net".to_string(),
        "update.code.visualstudio.com".to_string(),
        "mcp.context7.com".to_string(),
    ]
}

/// Preferred editor for opening containers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PreferredEditor {
    #[default]
    Vscode,
    Cursor,
}

/// Default agent for new environments
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DefaultAgent {
    #[default]
    Claude,
    Opencode,
    Codex,
}

/// OpenCode mode - terminal CLI or native chat interface
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OpenCodeMode {
    /// Terminal mode - launches OpenCode CLI in terminal
    #[default]
    Terminal,
    /// Native mode - uses OpenCode SDK with chat interface
    Native,
}

/// Claude mode - terminal CLI or native chat interface
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeMode {
    /// Terminal mode - launches Claude CLI in terminal
    #[default]
    Terminal,
    /// Native mode - uses Claude Agent SDK with chat interface
    Native,
}

/// Codex mode - terminal CLI or native chat interface
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CodexMode {
    /// Terminal mode - launches Codex CLI in terminal
    Terminal,
    /// Native mode - uses the Codex bridge chat interface
    #[default]
    Native,
}

/// Agent style - terminal CLI or native chat interface (used for project-level override)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStyle {
    /// Terminal mode - launches agent CLI in terminal
    Terminal,
    /// Native mode - uses agent SDK with chat interface
    Native,
}

impl PreferredEditor {
    /// Get the CLI command for this editor
    pub fn cli_command(&self) -> &'static str {
        match self {
            PreferredEditor::Vscode => "code",
            PreferredEditor::Cursor => "cursor",
        }
    }

    /// Get the display name for this editor
    pub fn display_name(&self) -> &'static str {
        match self {
            PreferredEditor::Vscode => "VS Code",
            PreferredEditor::Cursor => "Cursor",
        }
    }
}

/// Terminal appearance settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAppearance {
    /// Font family for terminal and code editor
    #[serde(default = "default_terminal_font_family")]
    pub font_family: String,
    /// Font size in pixels
    #[serde(default = "default_terminal_font_size")]
    pub font_size: u32,
    /// Background color (hex format)
    #[serde(default = "default_terminal_background_color")]
    pub background_color: String,
}

fn default_terminal_font_family() -> String {
    "FiraCode Nerd Font".to_string()
}

fn default_terminal_font_size() -> u32 {
    14
}

fn default_terminal_background_color() -> String {
    "#1e1e1e".to_string()
}

fn default_terminal_scrollback() -> u32 {
    1000
}

fn default_experimental_codex_raw_event_logging() -> bool {
    true
}

fn default_opencode_model() -> String {
    "opencode/grok-code".to_string()
}

fn default_codex_model() -> String {
    "gpt-5.3-codex".to_string()
}

fn default_codex_reasoning_effort() -> String {
    "medium".to_string()
}

impl Default for TerminalAppearance {
    fn default() -> Self {
        Self {
            font_family: default_terminal_font_family(),
            font_size: default_terminal_font_size(),
            background_color: default_terminal_background_color(),
        }
    }
}

/// Global configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfig {
    pub container_resources: ContainerResources,
    pub env_file_patterns: Vec<String>,
    /// Anthropic API key for Claude Code in containers
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_api_key: Option<String>,
    /// GitHub Personal Access Token for HTTPS git operations
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
    /// Domains allowed when environments are in restricted network mode
    #[serde(default = "default_allowed_domains")]
    pub allowed_domains: Vec<String>,
    /// Preferred editor for opening containers (vscode or cursor)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_editor: Option<PreferredEditor>,
    /// Default agent for new environments (claude or opencode)
    #[serde(default)]
    pub default_agent: DefaultAgent,
    /// Default model for OpenCode (e.g., "opencode/grok-code")
    #[serde(default = "default_opencode_model")]
    pub opencode_model: String,
    /// Default model for Codex Native tabs
    #[serde(default = "default_codex_model")]
    pub codex_model: String,
    /// Default reasoning effort for Codex Native tabs
    #[serde(default = "default_codex_reasoning_effort")]
    pub codex_reasoning_effort: String,
    /// OpenCode mode - terminal CLI or native chat interface
    #[serde(default)]
    pub opencode_mode: OpenCodeMode,
    /// Claude mode - terminal CLI or native chat interface
    #[serde(default)]
    pub claude_mode: ClaudeMode,
    /// Enable fast mode by default for new Claude Native tabs
    #[serde(default)]
    pub claude_native_fast_mode_default: bool,
    /// Codex mode - terminal CLI or native chat interface
    #[serde(default)]
    pub codex_mode: CodexMode,
    /// Enable fast mode by default for new Codex Native tabs
    #[serde(default)]
    pub codex_native_fast_mode_default: bool,
    /// Terminal appearance settings (font, size, colors)
    #[serde(default)]
    pub terminal_appearance: TerminalAppearance,
    /// Terminal scrollback buffer size (lines)
    #[serde(default = "default_terminal_scrollback")]
    pub terminal_scrollback: u32,
    /// Capture raw Codex bridge events for transcript debugging
    #[serde(default = "default_experimental_codex_raw_event_logging")]
    pub experimental_codex_raw_event_logging: bool,
    /// Enable debug logging to a file on disk (requires app restart)
    #[serde(default)]
    pub debug_logging: bool,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            container_resources: ContainerResources::default(),
            env_file_patterns: vec![".env".to_string(), ".env.local".to_string()],
            anthropic_api_key: None,
            github_token: None,
            allowed_domains: default_allowed_domains(),
            preferred_editor: None,
            default_agent: DefaultAgent::default(),
            opencode_model: default_opencode_model(),
            codex_model: default_codex_model(),
            codex_reasoning_effort: default_codex_reasoning_effort(),
            opencode_mode: OpenCodeMode::default(),
            claude_mode: ClaudeMode::default(),
            claude_native_fast_mode_default: false,
            codex_mode: CodexMode::default(),
            codex_native_fast_mode_default: false,
            terminal_appearance: TerminalAppearance::default(),
            terminal_scrollback: default_terminal_scrollback(),
            experimental_codex_raw_event_logging: default_experimental_codex_raw_event_logging(),
            debug_logging: false,
        }
    }
}

/// Repository-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfig {
    pub default_branch: String,
    pub pr_base_branch: String,
    /// Default port mappings for new environments in this repository
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_port_mappings: Option<Vec<PortMapping>>,
    /// Additional files to copy from local project path to environments (relative paths)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_to_copy: Option<Vec<String>>,
    /// Default model ID for the configured default agent (e.g. "claude-sonnet-4-6")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Default effort/thinking level for the configured default agent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// Entry port inside the container (e.g. 3000 for a web server).
    /// New containers will automatically map this to an available host port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_port: Option<u16>,
    /// Project-level default agent override (None = use app default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_agent: Option<DefaultAgent>,
    /// Project-level agent style override (None = use app default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_style: Option<AgentStyle>,
}

impl Default for RepositoryConfig {
    fn default() -> Self {
        Self {
            default_branch: "main".to_string(),
            pr_base_branch: "main".to_string(),
            default_port_mappings: None,
            files_to_copy: None,
            default_model: None,
            default_effort: None,
            entry_port: None,
            default_agent: None,
            agent_style: None,
        }
    }
}

/// Application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: String,
    pub global: GlobalConfig,
    pub repositories: std::collections::HashMap<String, RepositoryConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: "1.0.0".to_string(),
            global: GlobalConfig::default(),
            repositories: std::collections::HashMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_repo_name_https() {
        assert_eq!(
            extract_repo_name("https://github.com/user/repo.git"),
            "repo"
        );
        assert_eq!(extract_repo_name("https://github.com/user/repo"), "repo");
        assert_eq!(
            extract_repo_name("https://gitlab.com/org/project.git"),
            "project"
        );
    }

    #[test]
    fn test_extract_repo_name_ssh() {
        assert_eq!(extract_repo_name("git@github.com:user/repo.git"), "repo");
        assert_eq!(extract_repo_name("git@github.com:user/repo"), "repo");
        assert_eq!(
            extract_repo_name("git@gitlab.com:org/project.git"),
            "project"
        );
    }

    #[test]
    fn test_extract_repo_name_edge_cases() {
        assert_eq!(
            extract_repo_name("  https://github.com/user/repo.git  "),
            "repo"
        );
        assert_eq!(
            extract_repo_name("https://github.com/user/my-repo.git"),
            "my-repo"
        );
        assert_eq!(
            extract_repo_name("https://github.com/user/my_repo.git"),
            "my_repo"
        );
    }

    #[test]
    fn test_project_creation() {
        let project = Project::new("https://github.com/test/myrepo.git".to_string(), None);
        assert_eq!(project.name, "myrepo");
        assert!(!project.id.is_empty());
        assert!(project.local_path.is_none());
    }

    #[test]
    fn test_project_creation_with_local_path() {
        let project = Project::new(
            "https://github.com/test/myrepo.git".to_string(),
            Some("/path/to/local".to_string()),
        );
        assert_eq!(project.name, "myrepo");
        assert_eq!(project.local_path, Some("/path/to/local".to_string()));
    }

    #[test]
    fn test_environment_naming() {
        let env = Environment::new("project-123".to_string());
        // Name should be timestamp format: YYYYMMDD-HHMMSS
        let timestamp_regex = regex::Regex::new(r"^\d{8}-\d{6}$").unwrap();
        assert!(
            timestamp_regex.is_match(&env.name),
            "Environment name '{}' does not match expected format YYYYMMDD-HHMMSS",
            env.name
        );
        assert_eq!(env.status, EnvironmentStatus::Stopped);
        assert_eq!(env.project_id, "project-123");
        assert!(env.container_id.is_none());
        assert!(env.pr_url.is_none());
        assert!(!env.debug_mode);
    }

    #[test]
    fn test_environment_status_display() {
        assert_eq!(EnvironmentStatus::Running.to_string(), "running");
        assert_eq!(EnvironmentStatus::Stopped.to_string(), "stopped");
        assert_eq!(EnvironmentStatus::Error.to_string(), "error");
        assert_eq!(EnvironmentStatus::Creating.to_string(), "creating");
    }

    #[test]
    fn test_environment_status_equality() {
        assert_eq!(EnvironmentStatus::Running, EnvironmentStatus::Running);
        assert_ne!(EnvironmentStatus::Running, EnvironmentStatus::Stopped);
    }

    #[test]
    fn test_container_resources_default() {
        let resources = ContainerResources::default();
        assert_eq!(resources.cpu_cores, 2);
        assert_eq!(resources.memory_gb, 4);
    }

    #[test]
    fn test_global_config_default() {
        let config = GlobalConfig::default();
        assert_eq!(config.container_resources.cpu_cores, 2);
        assert_eq!(config.container_resources.memory_gb, 4);
        assert!(config.env_file_patterns.contains(&".env".to_string()));
        assert!(config.env_file_patterns.contains(&".env.local".to_string()));
        assert!(config.anthropic_api_key.is_none());
        assert!(config.github_token.is_none());
        assert_eq!(config.codex_mode, CodexMode::Native);
        assert!(!config.claude_native_fast_mode_default);
        assert!(!config.codex_native_fast_mode_default);
        assert!(config.experimental_codex_raw_event_logging);
    }

    #[test]
    fn test_global_config_deserializes_missing_native_fast_mode_defaults() {
        let json = r#"{
            "containerResources": { "cpuCores": 2, "memoryGb": 4 },
            "envFilePatterns": [".env"]
        }"#;

        let config: GlobalConfig = serde_json::from_str(json).unwrap();

        assert!(!config.claude_native_fast_mode_default);
        assert!(!config.codex_native_fast_mode_default);
    }

    #[test]
    fn test_global_config_serializes_native_fast_mode_defaults() {
        let mut config = GlobalConfig::default();
        config.claude_native_fast_mode_default = true;
        config.codex_native_fast_mode_default = true;

        let json = serde_json::to_string(&config).unwrap();

        assert!(json.contains("\"claudeNativeFastModeDefault\":true"));
        assert!(json.contains("\"codexNativeFastModeDefault\":true"));

        let deserialized: GlobalConfig = serde_json::from_str(&json).unwrap();
        assert!(deserialized.claude_native_fast_mode_default);
        assert!(deserialized.codex_native_fast_mode_default);
    }

    #[test]
    fn test_repository_config_default() {
        let config = RepositoryConfig::default();
        assert_eq!(config.default_branch, "main");
        assert_eq!(config.pr_base_branch, "main");
        assert!(config.default_port_mappings.is_none());
        assert!(config.files_to_copy.is_none());
        assert!(config.default_agent.is_none());
        assert!(config.agent_style.is_none());
    }

    #[test]
    fn test_app_config_default() {
        let config = AppConfig::default();
        assert_eq!(config.version, "1.0.0");
        assert!(config.repositories.is_empty());
    }

    #[test]
    fn test_project_serialization() {
        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"gitUrl\":"));
        assert!(json.contains("\"addedAt\":"));

        let deserialized: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, project.id);
        assert_eq!(deserialized.name, project.name);
    }

    #[test]
    fn test_environment_serialization() {
        let env = Environment::new("project-123".to_string());
        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"projectId\":"));
        assert!(json.contains("\"containerId\":"));
        assert!(json.contains("\"status\":\"stopped\""));
        assert!(!json.contains("initialPrompt"));

        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, env.id);
        assert_eq!(deserialized.status, EnvironmentStatus::Stopped);
        assert_eq!(deserialized.initial_prompt, None);
    }

    #[test]
    fn test_environment_initial_prompt_serialization() {
        let mut env = Environment::new("project-123".to_string());
        env.initial_prompt = Some("Review the migration plan".to_string());

        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"initialPrompt\":\"Review the migration plan\""));

        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deserialized.initial_prompt,
            Some("Review the migration plan".to_string())
        );
    }

    #[test]
    fn test_environment_serialization_round_trip_with_codex_mode() {
        let mut env = Environment::new("project-123".to_string());
        env.codex_mode = Some(CodexMode::Terminal);

        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"codexMode\":\"terminal\""));

        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.codex_mode, Some(CodexMode::Terminal));
    }

    #[test]
    fn test_app_config_serialization() {
        let mut config = AppConfig::default();
        config.repositories.insert(
            "repo-1".to_string(),
            RepositoryConfig {
                default_branch: "develop".to_string(),
                pr_base_branch: "main".to_string(),
                default_port_mappings: None,
                files_to_copy: None,
                default_model: None,
                default_effort: None,
                entry_port: None,
                default_agent: None,
                agent_style: None,
            },
        );

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: AppConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.repositories.len(), 1);
        assert!(deserialized.repositories.contains_key("repo-1"));
        assert_eq!(
            deserialized
                .repositories
                .get("repo-1")
                .unwrap()
                .default_branch,
            "develop"
        );
    }

    #[test]
    fn test_sanitize_branch_name() {
        // Basic valid names pass through
        assert_eq!(sanitize_branch_name("feature-branch"), "feature-branch");
        assert_eq!(sanitize_branch_name("my_feature"), "my_feature");

        // Spaces converted to hyphens
        assert_eq!(sanitize_branch_name("my feature"), "my-feature");

        // Invalid git ref characters removed
        assert_eq!(sanitize_branch_name("feature~branch"), "featurebranch");
        assert_eq!(sanitize_branch_name("test^name"), "testname");
        assert_eq!(sanitize_branch_name("branch:name"), "branchname");
        assert_eq!(sanitize_branch_name("test?name"), "testname");
        assert_eq!(sanitize_branch_name("test*name"), "testname");

        // Consecutive special chars don't create multiple hyphens
        assert_eq!(sanitize_branch_name("test  name"), "test-name");
        assert_eq!(sanitize_branch_name("test---name"), "test-name");

        // Leading/trailing hyphens removed
        assert_eq!(sanitize_branch_name("-test-"), "test");
        assert_eq!(sanitize_branch_name("--test--"), "test");

        // Empty input gets fallback
        assert_eq!(sanitize_branch_name(""), "env");
        assert_eq!(sanitize_branch_name("~~~"), "env");
    }

    #[test]
    fn test_sanitize_slug_truncation() {
        // Truncates to max_len
        let result = sanitize_slug(&"a".repeat(50), "fallback", 20);
        assert_eq!(result.len(), 20);

        // Strips trailing hyphen after truncation
        // "aaaa...a word" => "aaaa...-word", truncate at 11 => "aaaa...aaaa-" => strip => "aaaa...aaaa"
        let result = sanitize_slug(&format!("{} word", "a".repeat(10)), "fb", 11);
        assert!(!result.ends_with('-'));
        assert!(result.len() <= 11);

        // max_len of 0 means no limit
        let result = sanitize_slug(&"b".repeat(500), "fb", 0);
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_sanitize_slug_custom_fallback() {
        assert_eq!(sanitize_slug("", "my-fallback", 0), "my-fallback");
        assert_eq!(sanitize_slug("!@#", "other", 0), "other");
    }

    #[test]
    fn test_environment_with_name() {
        let env =
            Environment::with_name("project-123".to_string(), "my feature branch".to_string());
        assert_eq!(env.name, "my-feature-branch");
        assert_eq!(env.branch, "my-feature-branch");
        assert_eq!(env.status, EnvironmentStatus::Stopped);
    }

    #[test]
    fn test_environment_name_lowercase() {
        let env =
            Environment::with_name("project-123".to_string(), "My Feature Branch".to_string());
        assert_eq!(env.name, "my-feature-branch");
        assert_eq!(env.branch, "my-feature-branch");
    }

    #[test]
    fn test_sanitize_environment_name() {
        assert_eq!(sanitize_environment_name("My Feature"), "my-feature");
        assert_eq!(
            sanitize_environment_name("feat: add login!"),
            "feat-add-login"
        );
        assert_eq!(sanitize_environment_name("Hello World"), "hello-world");
        assert_eq!(sanitize_environment_name(""), "env");
    }

    #[test]
    fn test_environment_new_local() {
        let env = Environment::new_local("project-456".to_string(), "My Local Env".to_string());
        assert_eq!(env.name, "my-local-env");
        assert_eq!(env.branch, "my-local-env");
        assert_eq!(env.project_id, "project-456");
        assert_eq!(env.environment_type, EnvironmentType::Local);
        assert_eq!(env.network_access_mode, NetworkAccessMode::Full);
        assert_eq!(env.status, EnvironmentStatus::Stopped);
    }

    #[test]
    fn test_environment_entry_port_serialization() {
        let mut env = Environment::new("project-123".to_string());
        env.entry_port = Some(3000);
        env.host_entry_port = Some(49152);

        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"entryPort\":3000"));
        assert!(json.contains("\"hostEntryPort\":49152"));

        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.entry_port, Some(3000));
        assert_eq!(deserialized.host_entry_port, Some(49152));
    }

    #[test]
    fn test_environment_entry_port_omitted_when_none() {
        let env = Environment::new("project-123".to_string());
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("entryPort"));
        assert!(!json.contains("hostEntryPort"));

        // Deserializing without the field should yield None
        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.entry_port, None);
        assert_eq!(deserialized.host_entry_port, None);
    }

    #[test]
    fn test_environment_is_local_and_is_containerized() {
        let local_env = Environment::new_local("project-1".to_string(), "local-env".to_string());
        assert!(local_env.is_local());
        assert!(!local_env.is_containerized());

        let container_env =
            Environment::with_name("project-2".to_string(), "container-env".to_string());
        assert!(!container_env.is_local());
        assert!(container_env.is_containerized());
    }

    #[test]
    fn test_kanban_task_pr_fields_default() {
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        assert!(task.pr_url.is_none());
        assert!(task.pr_state.is_none());
        assert!(!task.pr_merge_commented);
    }

    #[test]
    fn test_kanban_task_pr_fields_roundtrip() {
        let mut task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        task.pr_url = Some("https://github.com/org/repo/pull/5".to_string());
        task.pr_state = Some("open".to_string());
        task.pr_merge_commented = false;

        let json = serde_json::to_string(&task).unwrap();
        let deser: KanbanTask = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.pr_url, task.pr_url);
        assert_eq!(deser.pr_state, task.pr_state);
        assert_eq!(deser.pr_merge_commented, task.pr_merge_commented);
    }

    #[test]
    fn test_kanban_task_pr_fields_omitted_in_json_when_none() {
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        let json = serde_json::to_string(&task).unwrap();
        // pr_url and pr_state should be omitted (skip_serializing_if = "Option::is_none")
        assert!(!json.contains("\"prUrl\""));
        assert!(!json.contains("\"prState\""));
        // pr_merge_commented is always serialized (no skip_serializing_if)
        assert!(json.contains("\"prMergeCommented\""));
    }

    #[test]
    fn test_agent_style_serialization_round_trip() {
        let config = RepositoryConfig {
            default_branch: "main".to_string(),
            pr_base_branch: "main".to_string(),
            default_port_mappings: None,
            files_to_copy: None,
            default_model: None,
            default_effort: None,
            entry_port: None,
            default_agent: Some(DefaultAgent::Opencode),
            agent_style: Some(AgentStyle::Native),
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"defaultAgent\":\"opencode\""));
        assert!(json.contains("\"agentStyle\":\"native\""));

        let deserialized: RepositoryConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.default_agent, Some(DefaultAgent::Opencode));
        assert_eq!(deserialized.agent_style, Some(AgentStyle::Native));
    }

    #[test]
    fn test_agent_style_omitted_when_none() {
        let config = RepositoryConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("defaultAgent"));
        assert!(!json.contains("agentStyle"));

        // Deserializing without the fields should yield None
        let deserialized: RepositoryConfig = serde_json::from_str(&json).unwrap();
        assert!(deserialized.default_agent.is_none());
        assert!(deserialized.agent_style.is_none());
    }

    #[test]
    fn test_agent_style_all_variants() {
        // Verify all AgentStyle variants serialize correctly
        for (style, expected) in [
            (AgentStyle::Terminal, "terminal"),
            (AgentStyle::Native, "native"),
        ] {
            let json = serde_json::to_value(style).unwrap();
            assert_eq!(json, expected);
        }
        // Verify all DefaultAgent variants in RepositoryConfig context
        for (agent, expected) in [
            (DefaultAgent::Claude, "claude"),
            (DefaultAgent::Opencode, "opencode"),
            (DefaultAgent::Codex, "codex"),
        ] {
            let json = serde_json::to_value(agent).unwrap();
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn test_session_type_codex_serialization_round_trip() {
        let json = serde_json::to_string(&SessionType::Codex).unwrap();
        assert_eq!(json, "\"codex\"");

        let deserialized: SessionType = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, SessionType::Codex);
    }
}
