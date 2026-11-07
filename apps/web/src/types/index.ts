// Project types: the protocol schema's type (plan item 7005).
export type { Project } from "@orkestrator/protocol/contract/domains/projects";

// Environment types
// Shared with the backend: both sides order the same activity reports, so a
// second definition of the vocabulary is a drift waiting to happen.
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
// The environment vocabularies are the protocol schemas' types (plan item 7003).
import type {
  ClientEnvironment,
  EnvironmentSetupSessionSnapshot,
  EnvironmentSetupStartResult,
  EnvironmentStatus,
  PrState,
  NetworkAccessMode,
  EnvironmentType,
  EnvironmentLifecycleOperation,
  InitialPromptImageAttachment,
  PortMapping,
  PortProtocol,
  EnvironmentUnreadReason,
} from "@orkestrator/protocol/contract/domains/environments";
export type {
  EnvironmentStatus,
  PrState,
  NetworkAccessMode,
  EnvironmentType,
  EnvironmentLifecycleOperation,
  InitialPromptImageAttachment,
  PortMapping,
  PortProtocol,
  EnvironmentUnreadReason,
};
// The settings model and its vocabularies are the `config` domain's schemas'
// types (plan items 7005 and 7010); the web's `GlobalConfig`/`AppConfig` below
// are the renderer view derived from them.
import type {
  AppConfig as ProtocolAppConfig,
  GlobalConfig as ProtocolGlobalConfig,
  RepositoryConfig,
} from "@orkestrator/protocol/contract/domains/config";
export type {
  AgentLaunchMode as AgentStyle,
  AgentLaunchMode as ClaudeMode,
  AgentLaunchMode as CodexMode,
  AgentLaunchMode as OpenCodeMode,
  ClaudeNativeBackend,
  RepositoryConfig,
} from "@orkestrator/protocol/contract/domains/config";
export type { AgentPlatform as DefaultAgent } from "@orkestrator/protocol/agent-platforms";

export type { AgentActivityState };

export type ClaudeCatalogEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelCatalogEntry {
  id: string;
  resolvedModel?: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeCatalogEffortLevel[];
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

/**
 * An environment as the renderer holds it: the protocol's `ClientEnvironment`
 * (plan items 7003 and 7010), plus the startup attachments a detail read
 * (`get_environment`) adds and the list projection strips. Without
 * `containerLifecycle`: a list answers the lifecycle snapshot there and a
 * detail read the durable record, so the renderer reads the snapshot through
 * `get_container_lifecycle_snapshot` instead.
 */
export type Environment = Omit<ClientEnvironment, "containerLifecycle"> & {
  /** Files waiting to be written into the workspace before the first prompt. */
  initialPromptAttachments?: InitialPromptImageAttachment[];
};

/** Result of testing a domain for DNS resolution */
export interface DomainTestResult {
  domain: string;
  valid: boolean;
  resolvable: boolean | null;
  ips: string[];
  error: string | null;
}

/** What starting an environment reports about its setup (`EnvironmentSetupStartResult`). */
export type StartEnvironmentResult = Partial<
  Pick<EnvironmentSetupStartResult, "setupStarted" | "setupSessionId">
>;

export interface EnsureEnvironmentSetupResult extends StartEnvironmentResult {
  environment: Environment;
}

export interface PersistedWorkflowRecord<T = unknown> {
  version: number;
  id: string;
  environmentId: string;
  snapshot: T;
  updatedAt: string;
  revision: number;
  controllerLease?: {
    ownerId: string;
    expiresAt: string;
  };
}

/**
 * A build pipeline as the backend stores it. The backend owns durability and
 * the compare-and-swap `revision`; this application owns the snapshot schema
 * and validates it on the way back in.
 */
export interface PersistedBuildPipeline<T = unknown> {
  version: number;
  id: string;
  projectId: string;
  /** Blank between pipeline creation and its environment existing. */
  environmentId: string;
  snapshot: T;
  updatedAt: string;
  revision: number;
}

export interface PersistedNativeAgentSession {
  version: 1;
  key: string;
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
  providerSessionId: string;
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  owner?: import("@orkestrator/protocol/coordinator").AgentSessionOwner;
  executionPolicy?: "coordinator-read-only";
  controls?: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate;
  dispatchedRequestIds?: string[];
  openCodeIncompleteTurnNotice?: {
    kind: "failed" | "exhausted";
    assistantMessageId: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * A tab's undispatched prompt queue as the backend stores it. Message bodies
 * stay opaque to the backend; each agent defines its own shape.
 */
export interface PersistedPromptQueue<T = unknown> {
  queueKey: string;
  environmentId: string;
  messages: T[];
  inFlight?: {
    message: T;
    requestId: string;
    reservedAt: string;
    /** Durable fail-closed marker written before an irreversible dispatch. */
    submittingAt?: string;
    /** Durable acknowledgement-only marker written after confirmed dispatch. */
    submittedAt?: string;
  };
  dispatchError?: {
    requestId: string;
    messageId: string;
    messageFingerprint: string;
    message: string;
    failedAt: string;
  };
  updatedAt: string;
  revision: number;
}

/** Unsent user input persisted by the backend; `value` is the composer's own shape. */
export type PersistedComposeDraft<T = unknown> = Omit<ProtocolComposeDraft, "value"> & {
  value: T;
};

/**
 * Sensitive provider-to-provider handoff persisted by the backend.
 *
 * `snapshot` is validated by `lib/agent-handoff.ts`; the backend deliberately
 * treats it as opaque JSON so provider message changes do not migrate storage.
 */
export type PersistedAgentHandoff<T = unknown> = Omit<ProtocolAgentHandoff, "snapshot"> & {
  snapshot: T;
};

/** A setup terminal's state: the protocol's `EnvironmentSetupSessionSnapshot`. */
export type EnvironmentSetupSession = EnvironmentSetupSessionSnapshot;

// Terminal session records: the `native-sessions` domain's schemas' types.
import type {
  PersistedAgentHandoff as ProtocolAgentHandoff,
  PersistedComposeDraft as ProtocolComposeDraft,
} from "@orkestrator/protocol/contract/domains/native-sessions";
export type {
  PersistedFileDraft,
  Session,
  SessionStatus,
  SessionType,
} from "@orkestrator/protocol/contract/domains/native-sessions";

// Configuration types: parts of the protocol's settings model.
export type ContainerResources = ProtocolGlobalConfig["containerResources"];

/** Preferred editor for opening containers */
export type PreferredEditor = NonNullable<ProtocolGlobalConfig["preferredEditor"]>;

/** Codex reasoning effort preference */
export type CodexReasoningEffortPreference =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Terminal appearance settings */
export type TerminalAppearance = ProtocolGlobalConfig["terminalAppearance"];

/** Which credential the Cursor SDK bridge is using. */
export interface CursorSdkAuthStatus {
  authenticated: boolean;
  source: "api-key-env" | "api-key-config" | "host-snapshot" | "stored-login" | "none";
  email?: string;
  expiresAt?: string;
}

export interface CursorSdkLoginProgress {
  state: "pending" | "authenticated" | "failed" | "idle";
  loginUrl?: string;
  error?: string;
  auth: CursorSdkAuthStatus;
}

/**
 * Fields of the renderer's settings this renderer reads as optional: the
 * redacted credentials' `*Configured`/`*Source` and the Codex thread limit,
 * which older backends and settings drafts leave out.
 */
type RendererOptionalGlobalField =
  | "codexMaxConcurrentThreads"
  | "githubTokenConfigured"
  | "anthropicApiKeyConfigured"
  | "anthropicApiKeySource"
  | "cursorApiKeyConfigured"
  | "cursorApiKeySource"
  | "openCodeZenApiKeyConfigured"
  | "openCodeZenApiKeySource";

/** The global settings as the renderer holds them: the protocol's `GlobalConfig`, derived. */
export type GlobalConfig = Omit<ProtocolGlobalConfig, RendererOptionalGlobalField> &
  Partial<Pick<ProtocolGlobalConfig, RendererOptionalGlobalField>>;

export type { GatewayTokenSettings, WebClientStatus } from "./webClient.js";

/**
 * Legacy last-create state retained so older config and renderer versions can
 * still be decoded. Current create dialogs ignore it and use Settings defaults.
 *
 * @deprecated
 */
export type LastEnvironmentAgentSelection = NonNullable<
  RepositoryConfig["lastEnvironmentAgentSelection"]
>;

/** The settings as the renderer holds them: the protocol's `AppConfig` with {@link GlobalConfig}. */
export type AppConfig = Omit<ProtocolAppConfig, "global"> & { global: GlobalConfig };

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
  /** Display name (e.g., "NativeComposeBar.tsx") */
  filename: string;
  /** Full relative path (e.g., "src/components/chat/NativeComposeBar.tsx") */
  relativePath: string;
}

/** A file candidate for the @ mention dropdown */
export interface FileCandidate {
  /** Filename only (e.g., "NativeComposeBar.tsx") */
  filename: string;
  /** Full relative path (e.g., "src/components/chat/NativeComposeBar.tsx") */
  relativePath: string;
  /** File extension (e.g., ".tsx") */
  extension?: string;
  /** Whether this is a directory */
  isDirectory?: boolean;
}
