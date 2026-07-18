// Project types
export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  localPath: string | null;
  addedAt: string;
  /** Display order in the sidebar (lower values appear first) */
  order: number;
}

// Environment types
export type EnvironmentStatus = "running" | "stopped" | "error" | "creating" | "stopping";

/** Pull request state from GitHub */
export type PrState = "open" | "merged" | "closed";

/** Network access mode for environment containers */
export type NetworkAccessMode = "full" | "restricted";

/** Type of environment - containerized (Docker) or local (git worktree) */
export type EnvironmentType = "containerized" | "local";

/** Port protocol type for port mappings */
export type PortProtocol = "tcp" | "udp";

/** Port mapping configuration for container ports */
export interface PortMapping {
  /** Port number inside the container */
  containerPort: number;
  /** Port number on the host machine */
  hostPort: number;
  /** Protocol (tcp or udp), defaults to tcp */
  protocol: PortProtocol;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  /** Git branch name (defaults to "main" for legacy environments via serde default) */
  branch: string;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  /** State of the PR (open, merged, closed) */
  prState: PrState | null;
  /** Whether the PR has merge conflicts with the target branch */
  hasMergeConflicts: boolean | null;
  createdAt: string;
  /** Git commit that this environment was originally created from. */
  createdFromCommit?: string;
  /** Network access mode (defaults to "restricted" for security) */
  networkAccessMode: NetworkAccessMode;
  /** Custom allowed domains for this environment (overrides global if set) */
  allowedDomains?: string[];
  /** Display order within the project (lower values appear first) */
  order: number;
  /** Port mappings for container (require restart to apply changes) */
  portMappings?: PortMapping[];
  /** Container entry port (e.g. 3000 for a web server), copied from project settings */
  entryPort?: number;
  /** Dynamically allocated host port mapped to the project's entry port */
  hostEntryPort?: number;

  // === Local environment fields ===

  /** Type of environment (containerized or local, defaults to containerized) */
  environmentType: EnvironmentType;
  /** Path to git worktree (only for local environments) */
  worktreePath?: string;
  /** PID of the opencode serve process (only for local environments) */
  opencodePid?: number;
  /** PID of the claude-bridge process (only for local environments) */
  claudeBridgePid?: number;
  /** PID of the codex-bridge process (only for local environments) */
  codexBridgePid?: number;
  /** Host port for opencode server (local mode) */
  localOpencodePort?: number;
  /** Host port for claude-bridge server (local mode) */
  localClaudePort?: number;
  /** Host port for codex-bridge server (local mode) */
  localCodexPort?: number;

  // === Agent settings overrides ===
  /** Per-environment default agent override (undefined = use global config) */
  defaultAgent?: DefaultAgent;
  /** Per-environment Claude mode override (undefined = use global config) */
  claudeMode?: ClaudeMode;
  /**
   * Per-environment Claude native backend override (undefined = inherit from
   * repository, then global). Only meaningful when the resolved Claude mode
   * is "native".
   */
  claudeNativeBackend?: ClaudeNativeBackend;
  /** Per-environment OpenCode mode override (undefined = use global config) */
  opencodeMode?: OpenCodeMode;
  /** Per-environment Codex mode override (undefined = use global config) */
  codexMode?: CodexMode;
  /**
   * Whether setup scripts have completed for this environment. Persisted so
   * native chat tabs can skip the "waiting for setup" UI after app restart,
   * and so incomplete setup can be re-run on the next app session.
   */
  setupScriptsComplete?: boolean;
  /** Initial prompt used when this environment was created. */
  initialPrompt?: string;
  /** Prompt awaiting a backend-owned rename after the environment starts. */
  pendingRenamePrompt?: string;
}

/** Result of testing a domain for DNS resolution */
export interface DomainTestResult {
  domain: string;
  valid: boolean;
  resolvable: boolean | null;
  ips: string[];
  error: string | null;
}

/** Result from starting an environment */
export interface StartEnvironmentResult {
  /** Legacy setup command plan. New Electron starts run setup in backend-owned terminal sessions. */
  setupCommands?: string[];
  /** True when Electron owns setup execution instead of handing commands to React. */
  setupManagedByBackend?: boolean;
  /** True when setup is currently running in a backend-owned terminal session. */
  setupStarted?: boolean;
  /** Backend PTY session id for the setup terminal, when setup started. */
  setupSessionId?: string;
}

export interface EnsureEnvironmentSetupResult extends StartEnvironmentResult {
  environment: Environment;
}

export interface EnvironmentSetupSession {
  environmentId: string;
  sessionId: string;
  running: boolean;
  startedAt: string;
  completedAt?: string;
  success?: boolean;
  error?: string;
  terminalRunning: boolean;
}

// Session types - Terminal session tracking for environments

/** Type of terminal session */
export type SessionType = "plain" | "claude" | "opencode" | "codex" | "root";

/** Connection status of a terminal session */
export type SessionStatus = "connected" | "disconnected";

/** Terminal session represents a PTY session within an environment container */
export interface Session {
  /** Unique session ID (UUID) */
  id: string;
  /** Parent environment ID */
  environmentId: string;
  /** Docker container ID (from environment) */
  containerId: string;
  /** Frontend tab ID for session restoration */
  tabId: string;
  /** Type of session (plain, claude, opencode, root) */
  sessionType: SessionType;
  /** Connection status */
  status: SessionStatus;
  /** When the session was created (ISO timestamp) */
  createdAt: string;
  /** Last activity timestamp (ISO timestamp) */
  lastActivityAt: string;
  /** Custom name for the session (user-defined) */
  name?: string;
  /** Display order within the environment (lower = higher in list) */
  order: number;
  /** Whether the auto-launch command (e.g., claude) was executed */
  hasLaunchedCommand?: boolean;
}

// Configuration types
export interface ContainerResources {
  cpuCores: number;
  memoryGb: number;  // Note: lowercase 'b' to match Rust serde rename_all = "camelCase"
}

/** Preferred editor for opening containers */
export type PreferredEditor = "vscode" | "cursor";

/** Default agent for new environments */
export type DefaultAgent = "claude" | "opencode" | "codex";

/** OpenCode mode - terminal CLI or native chat interface */
export type OpenCodeMode = "terminal" | "native";

/** Claude mode - terminal CLI or native chat interface */
export type ClaudeMode = "terminal" | "native";

/**
 * Implementation behind "native" Claude mode. The Agent SDK was the original
 * backend; `tmux` drives the `claude` CLI under tmux and surfaces a native-
 * style UI via the JSONL transcript + Claude Code hooks. This is resolved
 * three-tier: environment override → repo override → global default.
 */
export type ClaudeNativeBackend = "sdk" | "tmux";
/** Codex mode - terminal CLI or native chat interface */
export type CodexMode = "terminal" | "native";
/** Agent style - terminal CLI or native chat interface (used for project-level override) */
export type AgentStyle = "terminal" | "native";
/** Codex reasoning effort preference */
export type CodexReasoningEffortPreference =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

/** Terminal appearance settings */
export interface TerminalAppearance {
  /** Font family for terminal and code editor */
  fontFamily: string;
  /** Font size in pixels */
  fontSize: number;
  /** Background color (hex format) */
  backgroundColor: string;
}

export interface GlobalConfig {
  containerResources: ContainerResources;
  envFilePatterns: string[];
  anthropicApiKey?: string;
  githubToken?: string;
  /** Domains allowed when environments are in restricted network mode */
  allowedDomains: string[];
  /** Preferred editor for opening containers (VS Code or Cursor) */
  preferredEditor?: PreferredEditor;
  /** Default agent for new environments (Claude or OpenCode) */
  defaultAgent: DefaultAgent;
  /** Default model for OpenCode */
  opencodeModel: string;
  /** Default model for Claude Native/tmux tabs */
  claudeModel?: string;
  /** Default model for Codex Native tabs */
  codexModel: string;
  /** Default reasoning effort for Codex Native tabs */
  codexReasoningEffort: CodexReasoningEffortPreference;
  /** OpenCode mode - terminal CLI or native chat interface */
  opencodeMode: OpenCodeMode;
  /** Claude mode - terminal CLI or native chat interface */
  claudeMode: ClaudeMode;
  /** Default backend used when Claude mode is "native" (sdk or tmux) */
  claudeNativeBackend: ClaudeNativeBackend;
  /** Enable fast mode by default for new Claude Native tabs */
  claudeNativeFastModeDefault?: boolean;
  /** Codex mode - terminal CLI or native chat interface */
  codexMode: CodexMode;
  /** Enable fast mode by default for new Codex Native tabs */
  codexNativeFastModeDefault?: boolean;
  /** Terminal appearance settings (font, size, colors) */
  terminalAppearance: TerminalAppearance;
  /** Terminal scrollback buffer size (lines) */
  terminalScrollback: number;
  /** Capture raw Codex bridge events for subagent transcript debugging */
  experimentalCodexRawEventLogging?: boolean;
  /** Enable debug logging to disk (requires app restart) */
  debugLogging?: boolean;
  /** Serve the app to authenticated browsers on the host's Tailscale network */
  webClientEnabled?: boolean;
  /** Custom template for action-bar code reviews; omitted to use the built-in prompt */
  reviewPrompt?: string;
}

export type { GatewayTokenSettings, WebClientStatus } from "./webClient.js";

export interface RepositoryConfig {
  defaultBranch: string;
  prBaseBranch: string;
  /** Last environment type successfully created in this repository */
  lastEnvironmentType?: EnvironmentType;
  /** Default port mappings for new environments in this repository */
  defaultPortMappings?: PortMapping[];
  /** Additional files to copy from local project path to environments (relative paths) */
  filesToCopy?: string[];
  /** Default model ID for the configured default agent (e.g. "claude-sonnet-5") */
  defaultModel?: string;
  /** Default effort/thinking level for the configured default agent */
  defaultEffort?: string;
  /** Entry port inside the container (e.g. 3000 for a web server).
   * New containers will automatically map this to an available host port. */
  entryPort?: number;
  /** Project-level default agent override (undefined = use app default) */
  defaultAgent?: DefaultAgent;
  /** Project-level agent style override (undefined = use app default) */
  agentStyle?: AgentStyle;
  /**
   * Project-level Claude native backend override (undefined = inherit from
   * global). Only meaningful when the resolved Claude mode is "native".
   */
  claudeNativeBackend?: ClaudeNativeBackend;
}

export interface AppConfig {
  version: string;
  desktopConnections?: import("@orkestrator/protocol/connections").StoredDesktopConnections;
  global: GlobalConfig;
  repositories: Record<string, RepositoryConfig>;
}

// UI State types
export interface UIState {
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  sidebarWidth: number;
  /** Project IDs that are collapsed in the hierarchical sidebar */
  collapsedProjects: string[];
}

// Pane layout types
export * from "./paneLayout.js";

// File mention types for @ references in compose bar

/** A file mention inserted via @ reference */
export interface FileMention {
  /** Unique ID for React keys */
  id: string;
  /** Display name (e.g., "ClaudeComposeBar.tsx") */
  filename: string;
  /** Full relative path (e.g., "src/components/claude/ClaudeComposeBar.tsx") */
  relativePath: string;
}

/** A file candidate for the @ mention dropdown */
export interface FileCandidate {
  /** Filename only (e.g., "ClaudeComposeBar.tsx") */
  filename: string;
  /** Full relative path (e.g., "src/components/claude/ClaudeComposeBar.tsx") */
  relativePath: string;
  /** File extension (e.g., ".tsx") */
  extension?: string;
  /** Whether this is a directory */
  isDirectory?: boolean;
}
