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

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  createdAt: string;
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
  defaultAgent?: DefaultAgent;
  claudeMode?: ClaudeMode;
  claudeNativeBackend?: ClaudeNativeBackend;
  opencodeMode?: OpenCodeMode;
  codexMode?: CodexMode;
  setupScriptsComplete?: boolean;
  initialPrompt?: string;
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
    terminalAppearance: {
      fontFamily: string;
      fontSize: number;
      backgroundColor: string;
    };
    terminalScrollback: number;
    experimentalCodexRawEventLogging?: boolean;
    debugLogging?: boolean;
    webClientEnabled?: boolean;
  };
  repositories: Record<string, RepositoryConfig>;
}
