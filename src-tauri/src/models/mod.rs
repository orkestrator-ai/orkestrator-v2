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
}

/// Default branch for backward compatibility with existing environments
fn default_branch() -> String {
    "main".to_string()
}

/// Sanitize a string for use as a git branch name
/// Replaces invalid characters with hyphens and ensures valid format
pub fn sanitize_branch_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    let mut last_was_hyphen = false;

    for c in name.chars() {
        // Valid git branch characters: alphanumeric, hyphen, underscore, forward slash, dot
        // But we avoid slashes and dots for simplicity
        if c.is_ascii_alphanumeric() || c == '_' {
            result.push(c);
            last_was_hyphen = false;
        } else if c == '-' || c == ' ' || c == '.' || c == '/' {
            // Replace spaces, dots, slashes with hyphens, avoiding consecutive hyphens
            if !last_was_hyphen && !result.is_empty() {
                result.push('-');
                last_was_hyphen = true;
            }
        }
        // Other characters (like ~, ^, :, ?, *, [, etc.) are silently dropped
    }

    // Remove trailing hyphens
    while result.ends_with('-') {
        result.pop();
    }

    // Ensure the branch name doesn't start with a hyphen
    if result.starts_with('-') {
        result = result.trim_start_matches('-').to_string();
    }

    // Fallback if result is empty
    if result.is_empty() {
        result = "env".to_string();
    }

    result
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
        }
    }

    /// Create an environment with a custom name (and matching branch)
    pub fn with_name(project_id: String, name: String) -> Self {
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
        }
    }

    /// Create a local environment with a custom name
    pub fn new_local(project_id: String, name: String) -> Self {
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
    /// Terminal appearance settings (font, size, colors)
    #[serde(default)]
    pub terminal_appearance: TerminalAppearance,
    /// Terminal scrollback buffer size (lines)
    #[serde(default = "default_terminal_scrollback")]
    pub terminal_scrollback: u32,
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
            terminal_appearance: TerminalAppearance::default(),
            terminal_scrollback: default_terminal_scrollback(),
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
}

impl Default for RepositoryConfig {
    fn default() -> Self {
        Self {
            default_branch: "main".to_string(),
            pr_base_branch: "main".to_string(),
            default_port_mappings: None,
            files_to_copy: None,
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
    }

    #[test]
    fn test_repository_config_default() {
        let config = RepositoryConfig::default();
        assert_eq!(config.default_branch, "main");
        assert_eq!(config.pr_base_branch, "main");
        assert!(config.default_port_mappings.is_none());
        assert!(config.files_to_copy.is_none());
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

        let deserialized: Environment = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, env.id);
        assert_eq!(deserialized.status, EnvironmentStatus::Stopped);
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
    fn test_environment_with_name() {
        let env =
            Environment::with_name("project-123".to_string(), "my feature branch".to_string());
        assert_eq!(env.name, "my feature branch");
        assert_eq!(env.branch, "my-feature-branch");
        assert_eq!(env.status, EnvironmentStatus::Stopped);
    }
}
