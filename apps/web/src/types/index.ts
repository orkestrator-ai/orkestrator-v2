// Project types: the protocol schema's type (plan item 7005).
export type { Project } from "@orkestrator/protocol/contract/domains/projects";

// Environment types
// Shared with the backend: both sides order the same activity reports, so a
// second definition of the vocabulary is a drift waiting to happen.
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
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

// The model catalogues: the `agent-servers` domain's schemas' types (plan
// items 7009 and 7010).
export type {
  ClaudeEffortLevel as ClaudeCatalogEffortLevel,
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
  CodexReasoningEffort as CodexReasoningEffortPreference,
} from "@orkestrator/protocol/contract/domains/agent-servers";

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

/** Result of testing a domain for DNS resolution (`test_domain_resolution`). */
export type { DomainResolution as DomainTestResult } from "@orkestrator/protocol/contract/domains/native-sessions";

/** What starting an environment reports about its setup (`EnvironmentSetupStartResult`). */
export type StartEnvironmentResult = Partial<
  Pick<EnvironmentSetupStartResult, "setupStarted" | "setupSessionId">
>;

export interface EnsureEnvironmentSetupResult extends StartEnvironmentResult {
  environment: Environment;
}

// The stored workflow envelopes: the `multi-review` and `pipelines` domains'
// records (plan items 7007 and 7010), generic over the snapshot the renderer
// canonicalises and guards itself.
import type { MultiReviewWorkflowRecord } from "@orkestrator/protocol/contract/domains/multi-review";
import type { BuildPipelineRecord } from "@orkestrator/protocol/contract/domains/pipelines";

/** A Multi Review workflow as the backend answers it (no controller lease). */
export type PersistedWorkflowRecord<T = unknown> = Omit<MultiReviewWorkflowRecord, "snapshot"> & {
  snapshot: T;
};

/**
 * A build pipeline as the backend stores it. The backend owns durability and
 * the compare-and-swap `revision`; this application owns the snapshot schema
 * and validates it on the way back in.
 */
export type PersistedBuildPipeline<T = unknown> = Omit<BuildPipelineRecord, "snapshot"> & {
  snapshot: T;
};

/**
 * The durable mapping between a tab and its provider session: the
 * `native-sessions` domain's record (plan item 7010).
 */
export type { PersistedNativeAgentSession } from "@orkestrator/protocol/contract/domains/native-sessions";

/**
 * A tab's undispatched prompt queue as the backend stores it: the
 * `native-sessions` domain's record, generic over its messages. Message bodies
 * stay opaque to the backend; each agent defines its own shape.
 */
export type PersistedPromptQueue<T = unknown> = Omit<
  ProtocolPromptQueue,
  "messages" | "inFlight"
> & {
  messages: T[];
  inFlight?: Omit<NonNullable<ProtocolPromptQueue["inFlight"]>, "message"> & { message: T };
};

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
  PersistedPromptQueue as ProtocolPromptQueue,
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

/** Terminal appearance settings */
export type TerminalAppearance = ProtocolGlobalConfig["terminalAppearance"];

/** The Cursor SDK sign-in: the `accounts` domain's schemas' types (plan item 7010). */
export type {
  CursorSdkAuthStatus,
  CursorSdkLoginProgress,
} from "@orkestrator/protocol/contract/domains/accounts";

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
