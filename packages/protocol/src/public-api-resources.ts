/**
 * Public resource summaries for the `orkestrator` client.
 *
 * These are allowlisted projections. They never carry initial prompts,
 * attachments, provider session IDs, credentials, raw configuration documents,
 * or transcript content (transcripts are an explicit, bounded read). IDs are
 * opaque and stable: a public session ID survives provider resumes because it
 * is derived from the environment and tab, never from the provider's own ID.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import type { ChangeFileRow, ChangeHistoryEntry, ChangeProjection } from "./change-resources.js";
import type {
  PublicActionName,
  PublicCompletionSupport,
  PublicErrorCode,
  PublicInteractionRef,
  PublicOperationState,
} from "./public-api.js";

// ---------------------------------------------------------------------------
// Session handles

const SESSION_PREFIX = "ses_";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Stable public session handle for the native tab `tabId` of `environmentId`. */
export function encodePublicSessionId(environmentId: string, tabId: string): string {
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId) || !TAB_ID_PATTERN.test(tabId)) {
    throw new Error("Session identity is invalid");
  }
  return `${SESSION_PREFIX}${toBase64Url(`${environmentId}\n${tabId}`)}`;
}

export function decodePublicSessionId(
  sessionId: unknown,
): { environmentId: string; tabId: string } | null {
  if (typeof sessionId !== "string" || !sessionId.startsWith(SESSION_PREFIX)) return null;
  if (sessionId.length > 700) return null;
  const decoded = fromBase64Url(sessionId.slice(SESSION_PREFIX.length));
  if (decoded === null) return null;
  const separator = decoded.indexOf("\n");
  if (separator < 0 || decoded.indexOf("\n", separator + 1) >= 0) return null;
  const environmentId = decoded.slice(0, separator);
  const tabId = decoded.slice(separator + 1);
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId) || !TAB_ID_PATTERN.test(tabId)) return null;
  // Reject non-canonical encodings so one session has exactly one handle.
  if (encodePublicSessionId(environmentId, tabId) !== sessionId) return null;
  return { environmentId, tabId };
}

/** The logical session key every native tab uses (`env-<environment>:<tab>`). */
export function nativeTabLogicalSessionKey(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

// ---------------------------------------------------------------------------
// Pagination

export interface PublicPage<T> {
  items: T[];
  total: number;
  /** Opaque continuation; absent on the last page. */
  nextCursor?: string;
}

interface PageCursor {
  v: 1;
  offset: number;
  /** Fingerprint of the collection the cursor was issued against. */
  fp: string;
}

export function encodePublicPageCursor(offset: number, fingerprint: string): string {
  return toBase64Url(JSON.stringify({ v: 1, offset, fp: fingerprint } satisfies PageCursor));
}

/**
 * Decodes a page cursor. `expired` means the collection changed since the
 * cursor was issued; the caller must restart from the first page rather than
 * risk skipping or repeating items.
 */
export function decodePublicPageCursor(
  cursor: string,
  fingerprint: string,
): { offset: number } | "invalid" | "expired" {
  if (cursor.length > 512) return "invalid";
  const decoded = fromBase64Url(cursor);
  if (decoded === null) return "invalid";
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return "invalid";
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as PageCursor).v !== 1 ||
    !Number.isSafeInteger((parsed as PageCursor).offset) ||
    (parsed as PageCursor).offset < 0 ||
    typeof (parsed as PageCursor).fp !== "string"
  ) {
    return "invalid";
  }
  if ((parsed as PageCursor).fp !== fingerprint) return "expired";
  return { offset: (parsed as PageCursor).offset };
}

// ---------------------------------------------------------------------------
// Summaries

export interface PublicProjectSummary {
  id: string;
  name: string;
  /** Credential-free remote URL. */
  gitUrl: string;
  /** Backend filesystem path of the checkout, when one is attached. */
  localPath: string | null;
  folder: string | null;
  addedAt: string;
  order: number;
  /** Content revision of the project record; pass it back as `expectedRevision`. */
  revision: string;
  environmentCount: number;
}

export type PublicEnvironmentType = "local" | "container";

export interface PublicEnvironmentSummary {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  environmentType: PublicEnvironmentType;
  status: "running" | "stopped" | "error" | "creating" | "stopping";
  /** Running and setup complete (or explicitly overridden). */
  ready: boolean;
  setup: {
    phase: "pending" | "running" | "ready" | "failed";
    complete: boolean;
    overridden: boolean;
    startedAt?: string;
    completedAt?: string;
  };
  lifecycle: {
    operation: "deleting" | "merging" | "moving" | null;
    error: string | null;
    deletionRequested: boolean;
  };
  activity: {
    state: string | null;
    hasUnreadWork: boolean;
  };
  pendingAgentLaunch: boolean;
  startupSession: {
    sessionId: string;
    agent: string;
    status: "starting" | "running" | "error";
    error?: string;
  } | null;
  /** Backend path of a local worktree; null for container environments. */
  workspacePath: string | null;
  base: { branch: string | null; commit: string | null };
  pr: { url: string | null; state: string | null };
  createdAt: string;
  lastActivityAt: string | null;
  /** Content revision of the environment settings; used by `environment.config.set`. */
  settingsRevision: string;
}

export type PublicSessionActivity = "idle" | "working" | "waiting" | "unknown";

export interface PublicSessionSummary {
  id: string;
  environmentId: string;
  tabId: string;
  agent: AgentPlatform;
  title: string | null;
  /** Whether a provider conversation has been attached to the tab. */
  hasProviderSession: boolean;
  /** In-memory observation only; `unknown` after a backend restart until observed. */
  activity: PublicSessionActivity;
  latestRequestId: string | null;
  recoverableDispatch: {
    requestId: string;
    kind: "prompt" | "steer";
    status: "reconciling" | "action-required";
  } | null;
  pendingInteractionCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Slash commands

/**
 * One row of a session's slash-command catalogue. The descriptor ID and
 * binding revision are opaque selection keys; the provider's private binding
 * (skill paths, template files, provider command names) is never exposed.
 */
export interface PublicSessionCommand {
  id: string;
  name: string;
  aliases: string[];
  description: string | null;
  argumentHint: string | null;
  source: string;
  /** Changes when what the command runs changes; pass it back to refuse a changed command. */
  bindingRevision: string | null;
  available: boolean;
  unavailableReason: string | null;
  /** `optional` when the provider states no policy. */
  arguments: "none" | "optional" | "required";
  /** `idle`: refused while the agent is busy. */
  busy: "queue" | "idle" | "running" | null;
}

export interface PublicSessionCommandList {
  sessionId: string;
  agent: AgentPlatform;
  /**
   * `ready`/`stale`/`loading`/`unavailable`/`unsupported` as the backend's
   * catalogue reports it; `unknown` when the session has not been read yet
   * (use `refresh`).
   */
  catalogue: {
    status: string;
    revision: number | null;
    fetchedAt: string | null;
    error: string | null;
  };
  commands: PublicSessionCommand[];
  /** Present when `refresh` was requested: what the refresh did. */
  refresh?: { outcome: string; message?: string };
}

// ---------------------------------------------------------------------------
// Agent options

export type PublicCatalogueState = "ready" | "empty" | "stale" | "unavailable";

export interface PublicModelOption {
  id: string;
  label: string;
  reasoning: string[];
  defaultReasoningId: string | null;
  supportsSpeed: boolean;
  supportsMode: boolean;
}

export interface PublicAgentOption {
  agent: AgentPlatform;
  enabled: boolean;
  completion: PublicCompletionSupport;
  controls: { model: boolean; reasoning: boolean; speed: boolean; mode: boolean };
  steer: boolean;
  resume: boolean;
  fork: boolean;
  catalogue: {
    state: PublicCatalogueState;
    source: "live" | "cache" | "none";
    error?: string;
    models: PublicModelOption[];
  };
  defaults: { model: string | null; reasoningEffort: string | null; fastMode: boolean | null };
}

export interface PublicAgentOptions {
  projectId: string;
  environmentId: string | null;
  defaultAgent: AgentPlatform;
  agents: PublicAgentOption[];
}

// ---------------------------------------------------------------------------
// Interactions

export interface PublicInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PublicInteractionQuestion {
  id: string;
  prompt: string;
  required: boolean;
  multiple: boolean;
  secret: boolean;
  allowFreeText: boolean;
  options: PublicInteractionOption[];
}

/**
 * Countdown pause state, as the deadline's authority publishes it
 * (`AgentInteractionHold`). Absent when nothing publishes a deadline.
 */
export interface PublicInteractionHold {
  /** Whether `session.interaction.hold` can pause (or, while paused, resume) now. */
  available: boolean;
  /** When the countdown was paused; present only while paused. */
  heldAt?: number;
  /** Why a pause is limited (`provider-limit`, `upstream-may-expire`) or unavailable. */
  reason?: string;
}

export interface PublicInteraction extends PublicInteractionRef {
  sessionId: string;
  state: string;
  hold?: PublicInteractionHold;
  title: string;
  body?: string;
  questions: PublicInteractionQuestion[];
  /** Actions this interaction accepts. */
  actions: Array<"answer" | "approve-for-session" | "decline" | "deny" | "cancel">;
  createdAt: number;
}

export interface PublicInteractionAnswerInput {
  questionId: string;
  optionIds?: string[];
  freeText?: string;
}

// ---------------------------------------------------------------------------
// Transcripts

export interface PublicTranscriptPart {
  type: string;
  toolName?: string;
  status?: string;
  title?: string;
  /** Tool input/output bodies are never inlined; they are only counted. */
  detailOmitted?: boolean;
}

export interface PublicTranscriptMessage {
  id: string;
  role: string;
  createdAt: string | null;
  text: string;
  textTruncated: boolean;
  parts: PublicTranscriptPart[];
}

export interface PublicTranscriptPage {
  sessionId: string;
  /** Always oldest first within a page. */
  order: "oldest-first";
  messages: PublicTranscriptMessage[];
  /** Cursor for the page of older messages; absent when history is complete. */
  olderCursor?: string;
  complete: boolean;
  truncated: boolean;
  truncation?: { reason: string; omittedMessages?: number };
  /** Opaque token for change detection when polling. */
  token: string | null;
  historyEpoch: string | null;
  freshness: "current" | "cached" | "empty";
}

// ---------------------------------------------------------------------------
// Change tracking

/**
 * Scopes `changes.view` can read. `environment` is the environment's baseline
 * to its current workspace (`environment-net`).
 */
export const PUBLIC_CHANGE_SCOPES = Object.freeze(["environment"] as const);
export type PublicChangeScope = (typeof PUBLIC_CHANGE_SCOPES)[number];

/** One page of a projection's file rows, pinned to the projection's revision. */
export interface PublicChangeFilePage {
  rows: ChangeFileRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Null when the backend does not know the total. */
  totalRows: number | null;
}

/**
 * `changes.view`: the backend's own {@link ChangeProjection} — the one every
 * desktop and web client renders — verbatim, plus the requested page of file
 * rows. On the first page `files` repeats `projection.filePage`. Clients never
 * count lines, sum pages or read a missing count as zero.
 */
export interface PublicChangesView {
  environmentId: string;
  scope: PublicChangeScope;
  projection: ChangeProjection;
  files: PublicChangeFilePage;
}

/**
 * A history entry as the backend reports it, with the projection of every
 * resource its presentation names (keyed by resource key, without file rows).
 * A resource the backend cannot project is absent, never zero.
 */
export interface PublicChangesHistoryEntry extends ChangeHistoryEntry {
  projections: Record<string, ChangeProjection>;
}

/** `changes.history`: one page of a session's turns, oldest first. */
export interface PublicChangesHistory {
  sessionId: string;
  entries: PublicChangesHistoryEntry[];
  /** Pass back as `cursor` for the next (newer) page; null on the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Settings

export type PublicSettingScope = "project" | "environment";

export type PublicSettingType =
  | "string"
  | "port"
  | "boolean"
  | "string-list"
  | "domain-list"
  | "port-mappings"
  | "agent"
  | "agent-mode";

/**
 * When a changed setting takes effect.
 *
 * - `next-environment`: environments created afterwards.
 * - `next-start`: the next start/recreate of this environment.
 * - `next-session`: native sessions started afterwards; live sessions keep
 *   their controls (change those with `session.config.set`).
 * - `applied`: the running environment adopts it immediately.
 */
export type PublicSettingApplication =
  "next-environment" | "next-start" | "next-session" | "applied";

export interface PublicSettingDescriptor {
  key: string;
  scope: PublicSettingScope;
  type: PublicSettingType;
  /** Whether unsetting restores an inherited value (vs. a fixed default). */
  inherits: boolean;
  environmentTypes?: readonly PublicEnvironmentType[];
  application: PublicSettingApplication;
  description: string;
}

const AGENT_PLATFORM_KEYS = ["claude", "codex", "cursor", "grok", "opencode", "pi"] as const;

function agentSettingDescriptors(scope: PublicSettingScope): PublicSettingDescriptor[] {
  const application: PublicSettingApplication = "next-session";
  return [
    {
      key: "agent.defaultAgent",
      scope,
      type: "agent",
      inherits: true,
      application,
      description: "Agent platform used when a launch does not name one.",
    },
    ...AGENT_PLATFORM_KEYS.flatMap((platform): PublicSettingDescriptor[] => [
      {
        key: `agent.${platform}.mode`,
        scope,
        type: "agent-mode",
        inherits: true,
        application,
        description: `Launch mode (native or terminal) for ${platform}.`,
      },
      {
        key: `agent.${platform}.model`,
        scope,
        type: "string",
        inherits: true,
        application,
        description: `Default model for new ${platform} sessions.`,
      },
      {
        key: `agent.${platform}.reasoningEffort`,
        scope,
        type: "string",
        inherits: true,
        application,
        description: `Default reasoning level for new ${platform} sessions.`,
      },
      {
        key: `agent.${platform}.fastMode`,
        scope,
        type: "boolean",
        inherits: true,
        application,
        description: `Default speed for new ${platform} sessions (true is Fast).`,
      },
    ]),
  ];
}

export const PUBLIC_PROJECT_SETTINGS: readonly PublicSettingDescriptor[] = Object.freeze([
  {
    key: "defaultBranch",
    scope: "project",
    type: "string",
    inherits: false,
    application: "next-environment",
    description: "Branch new environments are created from.",
  },
  {
    key: "prBaseBranch",
    scope: "project",
    type: "string",
    inherits: false,
    application: "applied",
    description: "Base branch for pull requests and diff baselines.",
  },
  {
    key: "defaultPortMappings",
    scope: "project",
    type: "port-mappings",
    inherits: false,
    environmentTypes: ["container"],
    application: "next-environment",
    description: "Port mappings copied into new container environments.",
  },
  {
    key: "filesToCopy",
    scope: "project",
    type: "string-list",
    inherits: false,
    application: "next-environment",
    description: "Untracked files copied into new environments.",
  },
  {
    key: "entryPort",
    scope: "project",
    type: "port",
    inherits: false,
    application: "next-environment",
    description: "Default preview entry port for new environments.",
  },
  ...agentSettingDescriptors("project"),
]);

export const PUBLIC_ENVIRONMENT_SETTINGS: readonly PublicSettingDescriptor[] = Object.freeze([
  {
    key: "portMappings",
    scope: "environment",
    type: "port-mappings",
    inherits: false,
    environmentTypes: ["container"],
    application: "next-start",
    description: "Container port mappings; a running container adopts them on recreate.",
  },
  {
    key: "allowedDomains",
    scope: "environment",
    type: "domain-list",
    inherits: true,
    environmentTypes: ["container"],
    application: "next-start",
    description:
      "Restricted-network allowlist; unset inherits the global list. A running container whose image supports it applies the change immediately (reported as applied).",
  },
  ...agentSettingDescriptors("environment"),
]);

export function publicSettingDescriptor(
  scope: PublicSettingScope,
  key: string,
): PublicSettingDescriptor | undefined {
  return (scope === "project" ? PUBLIC_PROJECT_SETTINGS : PUBLIC_ENVIRONMENT_SETTINGS).find(
    (descriptor) => descriptor.key === key,
  );
}

export interface PublicSettingValue {
  key: string;
  /** Value stored at this scope; null when this scope does not decide. */
  value: unknown;
  /** Value in force after inheritance. */
  effective: unknown;
  source: "environment" | "repository" | "global" | "default" | "unset";
  application: PublicSettingApplication;
}

export interface PublicSettingsSnapshot {
  scope: PublicSettingScope;
  targetId: string;
  revision: string;
  settings: PublicSettingValue[];
}

export interface PublicSettingsPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  expectedRevision?: string;
}

export interface PublicSettingsChange {
  key: string;
  change: "set" | "unset";
  application: PublicSettingApplication;
}

// ---------------------------------------------------------------------------
// Exec

export interface PublicExecOutputWindow {
  stream: "stdout" | "stderr";
  /** UTF-8 decoded with replacement; `base64` carries the exact bytes. */
  text: string;
  base64: string;
  offset: number;
  totalBytes: number;
  truncatedHead: boolean;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Attention

/** One thing that needs a person: a pending interaction, a settled run, a finished setup. */
export type PublicAttentionItem =
  | {
      kind: "interaction";
      at: string;
      sessionId: string;
      environmentId: string;
      environmentName: string;
      agent: string;
      interactionId: string;
      interactionKind: string;
      revision: number;
      blocking: boolean;
      /** Bounded; the body is read with `session.interactions`. */
      title: string;
    }
  | {
      kind: "run";
      at: string;
      operationId: string;
      action: PublicActionName;
      state: PublicOperationState;
      sessionId: string | null;
      environmentId: string | null;
      errorCode: PublicErrorCode | null;
    }
  | {
      kind: "setup";
      at: string;
      environmentId: string;
      environmentName: string;
      phase: "ready" | "failed";
    };

export interface PublicAttentionPage {
  /** Blocking interactions first, then newest first. */
  items: PublicAttentionItem[];
  /** Items left out by `limit`. */
  more: number;
  counts: { interactions: number; runs: number; setups: number };
  /** Pass back to see only what changed since this read. */
  cursor: string;
}

// ---------------------------------------------------------------------------
// Nodes

/** One node as `node.list` reports it. Never a route, address or credential. */
export interface PublicNodeSummary {
  nodeId: string;
  name: string;
  /** The node the caller is connected to. */
  self: boolean;
  /** Registered and enabled on this command node (always true for `self`). */
  enabled: boolean;
  /** Connected now, so actions sent to it run. Always true for `self`. */
  available: boolean;
  /** `self`, or the link state (`connected`, `connecting`, `offline`, …). */
  state: string;
  /** The node's own mode as it last reported it. */
  mode: "standalone" | "command" | "leaf" | null;
  /** The node's Orkestrator version, when connected. */
  version: string | null;
  /** Public actions can be routed to it (`request.node`). */
  publicActions: boolean;
  /** Why `publicActions` is false, when it is. */
  reason?: string;
  lastConnectedAt?: string;
}

export interface PublicNodeList {
  /** This node first, then the nodes it controls in registry order. */
  items: PublicNodeSummary[];
  total: number;
  /** This node's mode. A leaf's own registry is suspended and not listed. */
  mode: "standalone" | "command" | "leaf";
  /** In leaf mode, the command nodes controlling this node. */
  controlledBy: { nodeId: string; name: string }[];
}

/** How one node answered an aggregate (`node: "all"`) read. */
export interface PublicNodeReadResult {
  nodeId: string;
  name: string;
  self: boolean;
  ok: boolean;
  /** Items that node holds in total (pages) or counted (attention). */
  total?: number;
  /** That node's next page: pass it with that node's `nodeId`. */
  nextCursor?: string;
  /** That node's attention cursor: pass it with that node's `nodeId`. */
  cursor?: string;
  error?: { code: string; message: string };
}

/** Every item of an aggregate read names the node that owns it. */
export type PublicNodeTagged<T> = T & { nodeId: string; nodeName: string };

/** Result of `project.list` or `environment.list` with `node: "all"`. */
export interface PublicAggregatePage<T> {
  items: PublicNodeTagged<T>[];
  /** Sum of every answering node's total. */
  total: number;
  nodes: PublicNodeReadResult[];
}

/** Result of `attention.list` with `node: "all"`. Cursors are per node. */
export interface PublicAggregateAttentionPage {
  items: PublicNodeTagged<PublicAttentionItem>[];
  more: number;
  counts: { interactions: number; runs: number; setups: number };
  nodes: PublicNodeReadResult[];
}

// ---------------------------------------------------------------------------
// Tickets

export interface PublicTicketSummary {
  id: string;
  projectId: string;
  title: string;
  status: string;
  order: number;
  createdAt: string;
  commentCount: number;
  imageCount: number;
  environmentId: string | null;
  pr: { url: string | null; state: string | null };
}

export interface PublicTicketDetail extends PublicTicketSummary {
  /** Absent from backends that predate ticket kinds: a feature ticket. */
  kind?: import("./ticket-sections.js").TicketKind;
  /** Every section except the acceptance criteria, as markdown. */
  description: string;
  acceptanceCriteria: string;
  /** The acceptance criteria as items with their newest Verify result. */
  criteria?: import("./ticket-sections.js").TicketCriterionSummary[];
  deliveryPolicy?: import("./ticket-sections.js").DeliveryPolicy;
  /** The latest 50. */
  comments: Array<{ id: string; text: string; createdAt: string }>;
}

// ---------------------------------------------------------------------------
// Build Pipelines

/**
 * One Build Pipeline step as the public summaries report it: the selection,
 * and the size of the user's own text. Instructions and a reviewer's focus are
 * the caller's content, so only their UTF-8 byte counts leave the backend.
 */
export interface PublicBuildStepSummary {
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean | null;
  /** UTF-8 bytes of the step's stored instructions; 0 when it has none. */
  instructionsBytes: number;
  /** A reviewer's focus by size, or null without one. */
  lens: { labelBytes: number; instructionBytes: number } | null;
}

/** `build.list` items and the head of `build.get`. */
export interface PublicBuildPipelineSummary {
  id: string;
  projectId: string;
  /** Empty until the pipeline's environment exists. */
  environmentId: string | null;
  /** The Kanban ticket (or other source's task) the pipeline builds. */
  taskId: string;
  source: "kanban" | "linear" | "github" | null;
  phase: string;
  iteration: number;
  maxIterations: number;
  agent: string;
  /** Bounded failure or cancellation reason. */
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  revision: number;
}

/** `build.get`: the summary plus what each step runs. */
export interface PublicBuildPipelineDetail extends PublicBuildPipelineSummary {
  steps: Partial<Record<import("./build-pipeline.js").BuildStepKey, PublicBuildStepSummary>>;
  /** The review panel's rows; empty for a single-reviewer review step. */
  reviewers: PublicBuildStepSummary[];
  reviewPreparation: PublicBuildStepSummary | null;
}

/** `build.launch` and `build.cancel` results: IDs and states only. */
export interface PublicBuildPipelineActionResult {
  pipelineId: string;
  projectId: string;
  environmentId: string | null;
  taskId: string;
  phase: string;
  /** `build.launch`: the ticket's active build was returned instead of a new one. */
  reused?: boolean;
}

// ---------------------------------------------------------------------------
// Graphs (item 214)

/** `graph.list` items and the head of `graph.show`: metadata and compile counts, never prompts. */
export interface PublicGraphTemplateSummary {
  /** The reference to pass back: `builtin:<id>`, `user:<id>` or `project:<path>`. */
  template: string;
  scope: "builtin" | "user" | "project";
  id: string;
  name: string;
  revision: number;
  digest: string;
  trust: "trusted" | "untrusted" | "changed";
  /** Trusted, not an engine template, and compiles with nothing pending. */
  launchable: boolean;
  /** A built-in running on its own engine (never launchable as a graph). */
  engine: string | null;
  errors: number;
  warnings: number;
  pendingAcknowledgements: number;
  /** The compile estimate, or null when the template does not compile. */
  agentSessions: { best: number; worst: number } | null;
}

/** One model binding by selection; a lens by size only. */
export interface PublicGraphBindingSummary {
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean | null;
  lens: { labelBytes: number; instructionBytes: number } | null;
}

/** `graph.show` with a project: what a launch there may bind. */
export interface PublicGraphLaunchView {
  launchable: boolean;
  blockedReason: string | null;
  roles: Array<{
    key: string;
    panel: boolean;
    maxPanel: number;
    /** The strongest enforcement floor among the role's steps. */
    floor: string | null;
    providers: Array<{
      agent: string;
      tier: string;
      available: boolean;
      unavailableReason: string | null;
    }>;
    /** What a launch that leaves the role out binds. */
    default: PublicGraphBindingSummary[];
  }>;
  /** Saved values, else the template's defaults. */
  params: Record<string, string | number | boolean | null>;
  environment: {
    default: "new-worktree" | "new-container" | "existing";
    create: "worktree" | "container" | null;
  };
}

export interface PublicGraphTemplateDetail extends PublicGraphTemplateSummary {
  description: string | null;
  roles: Array<{
    key: string;
    label: string | null;
    multiplicity: "one" | "panel";
    maxPanel: number | null;
    defaultsFrom: string[];
  }>;
  parameters: Array<{
    key: string;
    type: string;
    label: string | null;
    default: string | number | boolean | null;
    min: number | null;
    max: number | null;
    options: string[] | null;
  }>;
  inputs: Array<{
    name: string;
    type: string;
    required: boolean;
    /** A `ticket@1` input: `--ticket` fills it. */
    ticket: boolean;
  }>;
  /** The template's nodes (`nodes` is reserved for aggregate reads across command nodes). */
  steps: Array<{ id: string; kind: string; label: string | null; role: string | null }>;
  workspace: { kind: "environment" | "none"; create: "worktree" | "container" | null };
  /** With `projectId` only. */
  launch: PublicGraphLaunchView | null;
}

/** `graph.validate`: the compile result, diagnostics bounded. */
export interface PublicGraphValidation {
  /** The saved template compiled, or null for inline text. */
  template: string | null;
  ok: boolean;
  launchable: boolean;
  /** Trust alone stops a launch. */
  blockedBy: "untrusted" | "changed" | null;
  errors: number;
  warnings: number;
  infos: number;
  pendingAcknowledgements: number;
  diagnostics: Array<{
    code: string;
    severity: "error" | "warning" | "info";
    message: string;
    nodeId: string | null;
    path: string | null;
  }>;
  /** Diagnostics beyond the returned ones, counted only. */
  omittedDiagnostics: number;
  planDigest: string | null;
  cost: {
    agentSessions: { best: number; worst: number };
    activations: { best: number; worst: number };
    peakParallelism: number;
  } | null;
}

/** `graph.status`: one run by states and counts, never inputs, outputs or prompts. */
export interface PublicGraphRunSummary {
  id: string;
  projectId: string;
  /** Null while a run that creates its environment provisions it. */
  environmentId: string | null;
  template: { id: string; revision: number; name: string; scope: string | null };
  status: string;
  mock: boolean;
  requestedBy: string | null;
  ticketId: string | null;
  /** Live (not superseded) node activations by state. */
  activations: Record<string, number>;
  usage: { agentSessions: number; tokens: number };
  /** Bounded failure reason; never a payload. */
  error: string | null;
  errorCause: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  revision: number;
}

/** `graph.launch` and `graph.cancel` results: IDs and states only. */
export interface PublicGraphRunActionResult {
  runId: string;
  projectId: string;
  environmentId: string | null;
  status: string;
  template: { id: string; revision: number; name: string };
}

/** `permission.rule.list`: this node's Orkestrator permission rules (todo 0723). */
export interface PublicPermissionRuleList {
  rules: import("./permission-rules.js").NativeAgentPermissionRule[];
  total: number;
}
