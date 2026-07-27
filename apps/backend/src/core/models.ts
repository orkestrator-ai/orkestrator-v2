export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  localPath: string | null;
  addedAt: string;
  order: number;
}

export type EnvironmentStatus = "running" | "stopped" | "error" | "creating" | "stopping";
export type PrState = "open" | "merged" | "closed";
export type NetworkAccessMode = "full" | "restricted";
export type EnvironmentType = "containerized" | "local";
export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: PortProtocol;
}

export type DefaultAgent = "claude" | "opencode" | "codex";
export type OpenCodeMode = "terminal" | "native";
export type ClaudeMode = "terminal" | "native";
export type ClaudeNativeBackend = "sdk" | "tmux";
export type CodexMode = "terminal" | "native";
export type AgentStyle = "terminal" | "native";
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelCatalogEntry {
  id: string;
  resolvedModel?: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeEffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsAutoMode?: boolean;
}

export interface ClaudeModelCatalogSnapshot {
  environmentId: string;
  models: ClaudeModelCatalogEntry[];
  source: "sdk" | "last-known-good" | "fallback";
  fetchedAt: string;
  sdkVersion?: string;
  cliVersion?: string;
  stale: boolean;
  error?: string;
}

export interface Environment {
  id: string;
  projectId: string;
  /** Persisted association used to recover a build pipeline after renderer remount. */
  buildPipelineId?: string;
  name: string;
  branch: string;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  createdAt: string;
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt?: string;
  createdFromCommit?: string;
  networkAccessMode: NetworkAccessMode;
  allowedDomains?: string[];
  order: number;
  portMappings?: PortMapping[];
  entryPort?: number;
  hostEntryPort?: number;
  environmentType: EnvironmentType;
  worktreePath?: string;
  opencodePid?: number;
  claudeBridgePid?: number;
  codexBridgePid?: number;
  localOpencodePort?: number;
  localClaudePort?: number;
  localCodexPort?: number;
  /** Last backend-owned Claude model catalog for this environment. */
  claudeModelCatalog?: ClaudeModelCatalogSnapshot;
  defaultAgent?: DefaultAgent;
  claudeMode?: ClaudeMode;
  claudeNativeBackend?: ClaudeNativeBackend;
  opencodeMode?: OpenCodeMode;
  codexMode?: CodexMode;
  setupScriptsComplete?: boolean;
  initialPrompt?: string;
  /** Prompt awaiting a backend-owned rename after the environment starts. */
  pendingRenamePrompt?: string;
}

export type SessionType = "plain" | "claude" | "opencode" | "codex" | "root";
export type SessionStatus = "connected" | "disconnected";

export interface Session {
  id: string;
  environmentId: string;
  containerId: string;
  tabId: string;
  sessionType: SessionType;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  name?: string;
  order: number;
  hasLaunchedCommand?: boolean;
}

export const PANE_LAYOUT_VERSION = 1;

/**
 * Versioned pane/tab layout persisted by the backend for restore-on-connect.
 * The backend deliberately treats `root` as opaque; the frontend owns the
 * PaneNode schema and validates it before installing a restored layout.
 */
export interface PersistedPaneLayout {
  version: number;
  environmentId: string;
  containerId: string | null;
  activePaneId: string;
  root: unknown;
  updatedAt: string;
  revision: number;
}

/**
 * Versioned looped-review workflow persisted by the backend.
 *
 * The backend owns durability and compare-and-swap revisions while the web
 * application owns and runtime-validates the workflow snapshot schema. Keeping
 * the snapshot opaque here lets the workflow evolve without coupling backend
 * releases to every report-contract field.
 */
export interface PersistedLoopedReviewWorkflow {
  version: number;
  id: string;
  environmentId: string;
  snapshot: unknown;
  updatedAt: string;
  revision: number;
}

export interface RepositoryConfig {
  defaultBranch: string;
  prBaseBranch: string;
  lastEnvironmentType?: EnvironmentType;
  defaultPortMappings?: PortMapping[];
  filesToCopy?: string[];
  defaultModel?: string;
  defaultEffort?: string;
  entryPort?: number;
  defaultAgent?: DefaultAgent;
  agentStyle?: AgentStyle;
  claudeNativeBackend?: ClaudeNativeBackend;
}

export type AgentModelConfigKey = "claudeModel" | "codexModel" | "opencodeModel";

export interface AppConfig {
  version: string;
  desktopConnections?: import("@orkestrator/protocol/connections").StoredDesktopConnections;
  global: {
    containerResources: { cpuCores: number; memoryGb: number };
    envFilePatterns: string[];
    anthropicApiKey?: string;
    githubToken?: string;
    allowedDomains: string[];
    preferredEditor?: "vscode" | "cursor";
    defaultAgent: DefaultAgent;
    opencodeModel: string;
    claudeModel?: string;
    codexModel: string;
    codexReasoningEffort:
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | "ultra";
    opencodeMode: OpenCodeMode;
    claudeMode: ClaudeMode;
    claudeNativeBackend: ClaudeNativeBackend;
    claudeNativeFastModeDefault?: boolean;
    codexMode: CodexMode;
    codexNativeFastModeDefault?: boolean;
    /** Maximum concurrently open spawned-agent threads per native Codex session. */
    codexMaxConcurrentThreads: number;
    terminalAppearance: {
      fontFamily: string;
      fontSize: number;
      backgroundColor: string;
    };
    terminalScrollback: number;
    experimentalCodexRawEventLogging?: boolean;
    debugLogging?: boolean;
    webClientEnabled?: boolean;
    /** Editable preference embedded inside Orkestrator's fixed review contract. */
    reviewInstruction?: string;
  };
  repositories: Record<string, RepositoryConfig>;
}
