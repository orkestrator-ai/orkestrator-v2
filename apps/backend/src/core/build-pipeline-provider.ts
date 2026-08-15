import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import {
  AGENT_ACTIVITY_STATES,
  type AgentActivityState,
} from "@orkestrator/protocol/agent-activity";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  isAgentInteractionResolution,
  isAgentInteractionSnapshot,
  type AgentInteractionApplyOutcome,
  type AgentInteractionKind,
  type AgentInteractionOrigin,
  type AgentInteractionPolicy,
  type AgentInteractionQuestion,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentBackgroundTaskSummary,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentContextUsage,
  NativeAgentNotice,
  NativeAgentRateLimitWindow,
  NativeAgentResumeEntry,
  NativeAgentRuntimeSummary,
  NativeAgentForkOutcome,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  EMPTY_NATIVE_AGENT_COMPOSER_STATE,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  normalizeOpenCodeModelProviders,
  openCodeModelProvidersKey,
} from "@orkestrator/protocol/native-agent";
import {
  parseLeadingSlashCommand,
  type ParsedSlashCommand,
} from "@orkestrator/protocol/agent-slash-commands";
import {
  mimeTypeForFilename,
  promptAttachmentUrl,
  type PromptAttachment,
} from "./prompt-attachments.js";

export type ProviderStatus = "running" | "blocked" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";
export type ProviderExecutionMode = "plan" | "build";

export interface ProviderSessionRegistration {
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  /** Content-free workflow phase used by passive observations. */
  phase?: string;
  /** Stable workflow ownership and generation fence for unattended adoption. */
  workflowId?: string;
  provider?: BuildPipelineAgent;
  fence?: string | number;
}

/** Content-free lifecycle signal emitted before a provider-owned auto-response. */
export interface ProviderInteractionObservationEvent {
  sessionId: string;
  interactionId: string;
  kind: AgentInteractionKind;
  registration: ProviderSessionRegistration;
  state: "detected" | "withdrawn";
  providerState?: "running" | "error";
}

/**
 * Provider-neutral blocking-interaction capability.
 *
 * Exact provider payloads and answer mappers remain private to each adapter;
 * callers receive only the bounded coordination contract.
 */
export interface AgentInteractionProviderCapability {
  listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot>;
  resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome>;
  watchInteractions?(
    sessionId: string,
    onRevision: (revision: number) => void,
  ): () => void;
}

const PROVIDER_ACTIVITY_STATES: readonly ProviderActivityState[] = [
  ...AGENT_ACTIVITY_STATES,
  "missing",
];

const CLAUDE_BUILT_IN_SLASH_COMMANDS: readonly NativeAgentSlashCommand[] = [
  { name: "/clear", description: "Clear conversation history" },
  { name: "/compact", description: "Compact conversation to reduce tokens" },
  { name: "/context", description: "Show current context" },
  { name: "/cost", description: "Show token usage and cost" },
  { name: "/doctor", description: "Check system health" },
  { name: "/goal", description: "Set, view, or clear a completion goal" },
  { name: "/help", description: "Show available commands" },
  { name: "/init", description: "Re-initialize the session" },
  { name: "/logout", description: "Log out of Claude" },
  { name: "/memory", description: "Show memory usage" },
  { name: "/model", description: "Show or change model" },
  { name: "/permissions", description: "Manage permissions" },
  { name: "/review", description: "Review recent changes" },
  { name: "/status", description: "Show session status" },
  { name: "/vim", description: "Toggle vim mode" },
];

/**
 * OpenCode's documented built-in commands.
 *
 * `/command` only returns *configurable* commands (project, global, skills), so
 * without this merge the menu silently lost everything a TUI user knows. The
 * list lived in the renderer until consolidation; it belongs here, beside the
 * Claude list, because command discovery is provider knowledge.
 */
const OPENCODE_BUILT_IN_SLASH_COMMANDS: readonly NativeAgentSlashCommand[] = [
  { name: "/compact", description: "Compact the current session" },
  { name: "/connect", description: "Add a provider" },
  { name: "/details", description: "Toggle tool execution details" },
  { name: "/editor", description: "Open an external editor" },
  { name: "/exit", description: "Exit OpenCode" },
  { name: "/export", description: "Export current conversation" },
  { name: "/help", description: "Show help" },
  { name: "/init", description: "Create or update AGENTS.md" },
  { name: "/models", description: "List available models" },
  { name: "/new", description: "Start a new session" },
  { name: "/redo", description: "Redo the previously undone message" },
  { name: "/sessions", description: "List and switch sessions" },
  { name: "/share", description: "Share current session" },
  { name: "/themes", description: "List available themes" },
  { name: "/thinking", description: "Toggle reasoning visibility" },
  { name: "/undo", description: "Undo the last message" },
  { name: "/unshare", description: "Unshare current session" },
];

// Shared by every backend workflow/provider instance. The scope includes the
// server and workspace identity so equal session IDs on different OpenCode
// runtimes never block or influence each other.
const defaultOpenCodeMessageIds = new OpenCodeMessageIdCoordinator();

function openCodeMessageIdScope(
  connection: BridgeConnection,
  sessionId: string,
): string {
  return JSON.stringify([connection.baseUrl, connection.directory, sessionId]);
}

/**
 * OpenCode 1.18.x accepts the legacy `format: { type: "json_schema" }`
 * request, but then its own legacy transcript route cannot decode the stored
 * user message. That makes every later `session.messages()` call return 400,
 * which strands a pipeline in reconnect recovery even after the turn finished.
 *
 * Keep the transcript readable by expressing the same contract in the prompt.
 * The provider adapter parses only the correlated assistant's text back into a
 * value; the workflow layer still performs the authoritative shape validation.
 */
function openCodeStructuredPrompt(prompt: string, schema: JsonSchema): string {
  return `${prompt}\n\n## Required OpenCode output\n\nReturn only one JSON value matching this JSON Schema. Do not wrap it in Markdown or add commentary.\n\n${JSON.stringify(schema)}`;
}

// Bounds for the prose-wrapped JSON recovery scan. The scan is a last-resort
// tolerance for models that wrap the required JSON value in a sentence; the
// bounds keep pathological output from becoming unbounded work.
const OPEN_CODE_STRUCTURED_RECOVERY_CHARS = 16 * 1024;
const OPEN_CODE_STRUCTURED_RECOVERY_CANDIDATES = 16;

/**
 * Try to parse `candidate` as a JSON value. `undefined` is the sentinel for
 * "not JSON" because `JSON.parse` never produces `undefined`.
 */
function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Extract the well-formed JSON document that begins at `start` in `text`, if
 * one exists, by tracking bracket balance outside of string literals.
 */
function parseJsonDocumentAt(
  text: string,
  start: number,
): { value: unknown; end: number } | undefined {
  const open = text[start];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const value = tryParseJson(text.slice(start, i + 1));
        return value === undefined ? undefined : { value, end: i };
      }
    }
  }
  return undefined;
}

/**
 * Last-resort recovery for a model that wrapped the required JSON document in
 * prose (a lead-in sentence or a trailing summary). Successful outer documents
 * are skipped as whole spans so their nested objects and arrays cannot replace
 * them. The last well-formed outer document wins, and arbitrary prose is never
 * interpreted as JSON.
 */
function lastWellFormedJson(text: string): unknown {
  const scanned = text.slice(0, OPEN_CODE_STRUCTURED_RECOVERY_CHARS);
  let failedCandidates = 0;
  let recovered: unknown;
  for (let i = 0; i < scanned.length; i++) {
    const ch = scanned[i];
    if (ch !== "{" && ch !== "[") continue;
    const parsed = parseJsonDocumentAt(scanned, i);
    if (parsed !== undefined) {
      recovered = parsed.value;
      i = parsed.end;
      continue;
    }
    failedCandidates += 1;
    if (failedCandidates >= OPEN_CODE_STRUCTURED_RECOVERY_CANDIDATES) break;
  }
  return recovered;
}

function parseOpenCodeStructuredText(parts: unknown): unknown {
  if (!Array.isArray(parts)) throw new Error("OpenCode returned no structured text");
  const text = parts
    .flatMap((part) => {
      const candidate = asRecord(part);
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("")
    .trim();
  if (!text) throw new Error("OpenCode returned no structured text");

  // The prompt asks for a bare JSON value; accept it verbatim.
  const exact = tryParseJson(text);
  if (exact !== undefined) return exact;

  // One exact JSON fence is harmless presentation formatting. Arbitrary prose
  // is not searched for JSON here — the bounded recovery below accepts only
  // balanced JSON documents, never prose.
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1]?.trim();
  if (fenced !== undefined) {
    const fencedValue = tryParseJson(fenced);
    if (fencedValue !== undefined) return fencedValue;
  }

  // Models occasionally wrap the value in a sentence or append a summary.
  // Recover the last well-formed JSON document before giving up.
  const recovered = lastWellFormedJson(text);
  if (recovered !== undefined) return recovered;

  throw new Error("OpenCode returned malformed structured text");
}

/**
 * Validate a bridge-supplied activity token before it can reach the durable
 * projection. An unrecognized value must fail loudly: coercing it to `idle`
 * would silently retire a spinner for a turn that is still running.
 */
function isProviderActivityState(
  value: unknown,
): value is ProviderActivityState {
  return PROVIDER_ACTIVITY_STATES.includes(value as ProviderActivityState);
}

export class PromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The provider session is alive but its last turn ended in a terminal error.
 *
 * Thrown by `status()` so a pipeline stage fails with the provider's own
 * explanation instead of a bare status. It is deliberately *not* a session
 * death: the thread, its rollout and its configuration are all still there, and
 * the next prompt clears the state — which is why interactive callers that only
 * need liveness must read `detail` through `readProviderStatus()` rather than
 * letting this escape. Treating it as fatal there left a tab that hit, say,
 * "Selected model is at capacity" unable to change model and continue, because
 * every later `ensureSession` threw on the previous turn's error.
 */
export class ProviderSessionFailedError extends Error {
  readonly agent: BuildPipelineAgent;
  readonly detail: string;

  constructor(agent: BuildPipelineAgent, detail: string) {
    super(`The ${agent} session failed: ${detail}`);
    this.name = "ProviderSessionFailedError";
    this.agent = agent;
    this.detail = detail;
  }
}

/**
 * Read a provider status without a terminal turn error escaping as a throw.
 *
 * Liveness callers ("does this session still exist?", "may I dispatch?") need
 * the `error` status and its detail as data. Only `ProviderSessionFailedError`
 * is absorbed; transport faults still reject, because those genuinely leave the
 * answer unknown.
 */
export async function readProviderStatus(
  provider: Pick<BuildPipelineProvider, "status">,
  sessionId: string,
): Promise<{ status: ProviderStatus; error?: string }> {
  try {
    return { status: await provider.status(sessionId) };
  } catch (error) {
    if (error instanceof ProviderSessionFailedError) {
      return { status: "error", error: error.detail };
    }
    throw error;
  }
}

/**
 * A prompt transport failed without proving whether the provider accepted it.
 *
 * Callers retain the durable request id and reconcile provider status before
 * retrying this error. Preflight and explicit HTTP failures must use
 * ProviderUnavailableError instead so bounded reconnect handling can run.
 */
export class AmbiguousPromptDispatchError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AmbiguousPromptDispatchError";
  }
}

export interface ProviderCreateSessionOptions {
  /** Second layer of idempotency: bridges derive a stable session id from it. */
  clientSessionKey?: string;
  /**
   * Execution mode for the session. Pipeline stages default to build mode
   * because validation tools may write generated files and caches; specialized
   * callers can still request plan mode explicitly.
   */
  mode?: ProviderExecutionMode;
  /**
   * Per-session model and effort.
   *
   * Passed per call rather than baked into the connection so one provider can
   * serve every session in an environment. Caching a provider per model would
   * accumulate one instance — and for OpenCode one event stream — per variant a
   * user ever selects.
   */
  model?: string;
  effort?: string;
  /** Cursor/Grok ACP speed toggle; ignored by other providers. */
  fastMode?: boolean;
  /** Durable interaction metadata supplied by the owning workflow. */
  interaction?: ProviderSessionRegistration;
}

export interface ProviderSendOptions {
  requestId: string;
  /**
   * Attachments that already exist in the workspace.
   *
   * Preferred over {@link ProviderSendOptions.images}: both bridges require a
   * `path`, so only a staged attachment can actually be delivered.
   */
  attachments?: PromptAttachment[];
  /**
   * Base64 images with no workspace path yet.
   *
   * Staged by the provider's `stageImages` dependency when one is configured.
   * Without it there is nothing that can be sent, so the images are refused
   * rather than silently dropped by the bridge.
   */
  images?: TaskSnapshotImage[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  /** Claude sub-agent selected for this prompt. */
  subAgent?: string;
  /**
   * OpenCode execution agent for this prompt (`build`, `plan`, or a custom
   * agent). Takes precedence over the coarser {@link mode} mapping so a
   * continuation can rejoin a turn under the exact agent it ran with.
   */
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  /** Overrides the connection default for this prompt only. */
  model?: string;
  effort?: string;
  /**
   * Let a submission that names one of the provider's own slash commands run
   * as that command.
   *
   * Set for interactive composer dispatch only. Workflow prompts are authored
   * by Orkestrator and must reach the model exactly as written, even when they
   * happen to begin with a slash.
   */
  allowProviderCommands?: boolean;
}

/**
 * Provider-neutral interactive read used by the native-agent runtime.
 * Provider payloads are normalized before this boundary; renderer clients
 * never receive bridge coordinates, credentials, sparse patches, or SDK
 * response envelopes.
 */
export interface ProviderInteractiveSnapshot {
  status: ProviderStatus;
  messages: unknown[];
  title?: string;
  /** `null` is an authoritative unshared state; absent means unknown. */
  shareUrl?: string | null;
  composer?: NativeAgentComposerState;
  /** Provider-reported current controls, authoritative over persisted defaults. */
  controls?: NativeAgentControlUpdate;
  providerRevision?: number;
  providerGeneration?: string | number;
  phase?: NativeAgentTurnPhase;
  turnStartedAt?: number;
  contextUsage?: NativeAgentContextUsage;
  rateLimits?: NativeAgentRateLimitWindow[];
  runtime?: NativeAgentRuntimeSummary;
  notices?: NativeAgentNotice[];
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  error?: string;
}

export interface BuildPipelineProvider {
  readonly agent: BuildPipelineAgent;
  /**
   * Register a session restored from durable pipeline state. Providers that
   * monitor environment-wide event streams must ignore requests for every
   * session not registered here or created through createSession().
   */
  registerSession?(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void;
  createSession(
    phase: PipelineSessionPhase,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void>;
  status(sessionId: string): Promise<ProviderStatus>;
  /**
   * Authoritative activity including input parked at the provider. Optional so
   * narrow test providers and non-interactive integrations can fall back to
   * the coarser status contract.
   */
  activity?(sessionId: string): Promise<ProviderActivityState>;
  /**
   * Read authoritative activity for several sessions from one provider
   * snapshot. Providers whose upstream API is session-scoped may omit this and
   * let callers fall back to activity()/status() per session.
   */
  activityBatch?(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>>;
  readonly interactions?: AgentInteractionProviderCapability;
  messages(
    sessionId: string,
    options?: { limit?: number },
  ): Promise<unknown[]>;
  structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null>;
  abort(sessionId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

/**
 * Interactive, provider-neutral session surface consumed by NativeAgentService.
 * Build-pipeline callers retain the deliberately smaller interface above.
 */
export interface NativeAgentRuntimeProvider extends BuildPipelineProvider {
  /** Live, bounded model discovery for launch surfaces without a session yet. */
  modelCatalog?(): Promise<AgentModel[]>;
  /**
   * Backend-only bounded discovery for the durable OpenCode cache. Unlike
   * `modelCatalog`, this retains an unfiltered bounded source catalogue so a
   * later allowlist expansion can work before another bridge is started. It
   * must never be returned directly to a renderer.
   */
  rawModelCatalog?(): Promise<AgentModel[]>;
  interactiveSnapshot?(sessionId: string): Promise<ProviderInteractiveSnapshot>;
  updateInteractiveControls?(
    sessionId: string,
    update: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState | undefined>;
  listResumableSessions?(): Promise<NativeAgentResumeEntry[]>;
  resumeSession?(
    sessionId: string,
    controls?: NativeAgentControlUpdate,
  ): Promise<string>;
  forkSession?(
    sessionId: string,
    messageId?: string,
  ): Promise<NativeAgentForkOutcome>;
  slashCommands?(): Promise<NativeAgentSlashCommand[]>;
  /** Drop provider-side model/command caches so the next read re-discovers. */
  refreshCatalog?(): Promise<void> | void;
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<void>;
  dismissSuggestedPrompt?(sessionId: string): Promise<void>;
  performSessionAction?(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome>;
}

type BridgeConnection = {
  agent: BuildPipelineAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
  requestTimeoutMs?: number;
};

export type ProviderDependencies = {
  fetch?: typeof fetch;
  openCodeClient?: OpencodeClient;
  /** Injectable factory for testing the production OpenCode client wiring. */
  openCodeClientFactory?: typeof createOpencodeClient;
  /** Shared by production providers; injectable to isolate deterministic tests. */
  openCodeMessageIdCoordinator?: OpenCodeMessageIdCoordinator;
  monitorRetryMs?: number;
  /** Injectable clock and cache lifetime for deterministic lifecycle tests. */
  now?: () => number;
  openCodeExistenceCacheTtlMs?: number;
  /**
   * Stage base64 images into the workspace so they can be attached by path.
   *
   * Supplied by whichever service owns a command invoker; without it a
   * base64-only image cannot be delivered to any bridge.
   */
  stageImages?: (
    images: readonly TaskSnapshotImage[],
  ) => Promise<PromptAttachment[]>;
  /**
   * Legacy test-only OpenCode event responder. Disabled unless explicitly
   * requested; production workflows use the persisted common resolver.
   */
  autoAnswerRequests?: boolean;
  /**
   * Preserve observe-only evidence when this provider must answer before a
   * separate polling adapter can see the request. The callback receives no
   * prompt, command, path, answer, or other provider content.
   */
  onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;
  /**
   * Resolve the OpenCode provider allowlist for the model catalogue. Filtering
   * happens here, in the backend, so the renderer is never sent the thousands
   * of models OpenCode advertises. Omitted means the default managed pair.
   */
  resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;
};

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MONITOR_RETRY_MS = 1_000;

const DEFAULT_SESSION_REGISTRATION: ProviderSessionRegistration = Object.freeze({
  origin: "interactive-native",
  interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
});
const MAX_TRACKED_INTERACTION_SESSIONS = 1_024;
const MAX_TRACKED_PROVIDER_INTERACTIONS = 4_096;
// This page is only a bounded positive-existence cache seed. Absence from it
// never proves deletion; only a per-session 404 may manufacture `missing`.
const MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS =
  MAX_TRACKED_INTERACTION_SESSIONS + 1;
const MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS = 10_000;
const OPENCODE_EXISTENCE_PROBE_CONCURRENCY = 8;
const OPENCODE_SUBAGENT_MAX_SESSIONS = 16;
const OPENCODE_SUBAGENT_MESSAGE_LIMIT = OPEN_CODE_MESSAGE_HISTORY_LIMIT;
const OPENCODE_SUBAGENT_FETCH_CONCURRENCY = 4;
const MCP_FORM_CONTENT_QUESTION_ID = "mcp-form-content";
const MAX_RENDERED_FILE_CHANGES = 48;
const MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH = 256;
const INTERACTIVE_RUNTIME_METADATA_TTL_MS = 30_000;
const INTERACTIVE_RUNTIME_METADATA_RETRY_MS = 5_000;
const OPENCODE_COMMAND_NAME_TTL_MS = 30_000;

function setBoundedMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maximumSize: number,
): void {
  if (!map.has(key) && map.size >= maximumSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function setBoundedSetEntry<T>(set: Set<T>, value: T, maximumSize: number): void {
  if (!set.has(value) && set.size >= maximumSize) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function openCodeCatalogProviders(value: unknown): Record<string, unknown>[] {
  const catalog = asRecord(value);
  const raw = catalog?.all ?? catalog?.providers;
  if (Array.isArray(raw)) {
    return raw.flatMap((candidate) => {
      const provider = asRecord(candidate);
      return provider ? [provider] : [];
    });
  }
  const providers = asRecord(raw);
  if (!providers) return [];
  return Object.entries(providers).flatMap(([id, candidate]) => {
    const provider = asRecord(candidate);
    return provider ? [{ id, ...provider }] : [];
  });
}

function openCodeProviderModels(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((candidate) => {
      const model = asRecord(candidate);
      return model ? [model] : [];
    });
  }
  const models = asRecord(value);
  if (!models) return [];
  return Object.entries(models).flatMap(([id, candidate]) => {
    const model = asRecord(candidate);
    return model ? [{ id, ...model }] : [];
  });
}

function openCodeCatalogDefault(value: unknown): {
  modelId?: string;
  reasoningId?: string;
} {
  const catalog = asRecord(value);
  const defaults = asRecord(catalog?.default);
  if (!defaults) return {};
  const nested = asRecord(defaults.model);
  const providerId = nonEmptyString(nested?.providerID)
    ?? nonEmptyString(defaults.providerID)
    ?? nonEmptyString(defaults.provider);
  const modelId = nonEmptyString(nested?.modelID)
    ?? nonEmptyString(defaults.modelID)
    ?? (typeof defaults.model === "string" ? defaults.model : null);
  const qualified = modelId?.includes("/")
    ? modelId
    : providerId && modelId
      ? `${providerId}/${modelId}`
      : undefined;
  return {
    ...(qualified ? { modelId: qualified } : {}),
    ...(nonEmptyString(nested?.variant) ?? nonEmptyString(defaults.variant)
      ? {
          reasoningId: nonEmptyString(nested?.variant)
            ?? nonEmptyString(defaults.variant)
            ?? undefined,
        }
      : {}),
  };
}

function normalizeOpenCodeComposerCatalog(
  value: unknown,
  allowedProviders: readonly string[] = DEFAULT_OPENCODE_MODEL_PROVIDERS,
): {
  models: AgentModel[];
  selectedModelId?: string;
  selectedReasoningId?: string;
} {
  const models: AgentModel[] = [];
  // Reject the provider before either cap is applied. OpenCode advertises
  // thousands of models across every provider it knows about, so an excluded
  // provider allowed to consume the 128-provider or 512-model budget pushes the
  // selectable catalogues out of the picker entirely.
  const selectableProviders = openCodeCatalogProviders(value)
    .filter((provider) => {
      const providerId = nonEmptyString(provider.id);
      return providerId !== null
        && isSelectableOpenCodeProvider(providerId, allowedProviders);
    })
    .slice(0, 128);
  for (const provider of selectableProviders) {
    const providerId = nonEmptyString(provider.id);
    if (!providerId) continue;
    for (const model of openCodeProviderModels(provider.models).slice(0, 512)) {
      const localId = nonEmptyString(model.id);
      if (!localId) continue;
      const variants = asRecord(model.variants);
      const reasoning = variants
        ? Object.entries(variants).flatMap(([id, candidate]) => {
            const variant = asRecord(candidate);
            return variant?.disabled === true
              ? []
              : [{ id, label: id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase()) }];
          }).slice(0, 64)
        : [];
      const limit = asRecord(model.limit);
      const capabilities = asRecord(model.capabilities);
      const input = asRecord(capabilities?.input);
      const contextWindow = [
        limit?.context,
        model.contextWindow,
        model.context_window,
      ].find((candidate) => typeof candidate === "number"
        && Number.isSafeInteger(candidate)
        && candidate > 0) as number | undefined;
      models.push({
        platform: "opencode",
        id: `${providerId}/${localId}`,
        label: nonEmptyString(model.name) ?? localId,
        providerLabel: nonEmptyString(provider.name) ?? providerId,
        reasoning: [
          { id: "default", label: "Default" },
          ...reasoning,
        ],
        defaultReasoningId: "default",
        supportsSpeed: false,
        supportsMode: true,
        ...(contextWindow ? { contextWindow } : {}),
        ...(typeof input?.image === "boolean"
          ? { supportsImageInput: input.image }
          : typeof model.attachment === "boolean"
            ? { supportsImageInput: model.attachment }
            : {}),
      });
      if (models.length >= 512) break;
    }
    if (models.length >= 512) break;
  }
  const defaults = openCodeCatalogDefault(value);
  // OpenCode's own default may name a provider the user excluded. Surfacing it
  // would pre-select a model the picker cannot show, so it is dropped with the
  // rest of that provider's catalogue.
  const selectedModelId = defaults.modelId
    && isSelectableOpenCodeModelId(defaults.modelId, allowedProviders)
    ? defaults.modelId
    : undefined;
  return {
    models,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedModelId && defaults.reasoningId
      ? { selectedReasoningId: defaults.reasoningId }
      : {}),
  };
}

function normalizeProviderContextUsage(
  value: unknown,
): NativeAgentContextUsage | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const usedTokens = typeof raw.usedTokens === "number" && Number.isFinite(raw.usedTokens)
    ? Math.max(0, raw.usedTokens)
    : undefined;
  const maximumTokens = typeof raw.totalTokens === "number" && Number.isFinite(raw.totalTokens)
    ? Math.max(0, raw.totalTokens)
    : typeof raw.maximumTokens === "number" && Number.isFinite(raw.maximumTokens)
      ? Math.max(0, raw.maximumTokens)
      : undefined;
  const percentage = typeof raw.percentUsed === "number" && Number.isFinite(raw.percentUsed)
    ? Math.max(0, Math.min(100, raw.percentUsed))
    : typeof raw.percentage === "number" && Number.isFinite(raw.percentage)
      ? Math.max(0, Math.min(100, raw.percentage))
      : undefined;
  if (usedTokens === undefined) return undefined;
  const usage: NativeAgentContextUsage = {
    usedTokens,
    ...(maximumTokens === undefined ? {} : { maximumTokens }),
    ...(percentage === undefined ? {} : { percentage }),
  };
  const optionalNumbers = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "lastTurnTokens",
    "sessionTokens",
    "costUsd",
    "durationMs",
    "apiDurationMs",
    "permissionDenials",
    "linesAdded",
    "linesRemoved",
  ] as const;
  for (const key of optionalNumbers) {
    const candidate = raw[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      usage[key] = candidate;
    }
  }
  if (typeof raw.modelId === "string") usage.modelId = raw.modelId.slice(0, 256);
  if (typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))) {
    usage.updatedAt = raw.updatedAt;
  }
  if (typeof raw.estimated === "boolean") usage.estimated = raw.estimated;
  if (
    raw.source === "claude"
    || raw.source === "opencode"
    || raw.source === "codex"
    || raw.source === "heuristic"
    || raw.source === "provider"
  ) usage.source = raw.source;
  const rateLimits = normalizeProviderRateLimits(raw.rateLimits);
  if (rateLimits.length > 0) usage.rateLimits = rateLimits;
  const credits = asRecord(raw.credits);
  if (credits) {
    const normalized = {
      ...(typeof credits.hasCredits === "boolean" ? { hasCredits: credits.hasCredits } : {}),
      ...(typeof credits.unlimited === "boolean" ? { unlimited: credits.unlimited } : {}),
      ...(typeof credits.balance === "string" ? { balance: credits.balance.slice(0, 64) } : {}),
    };
    if (Object.keys(normalized).length > 0) usage.credits = normalized;
  }
  if (Array.isArray(raw.contextCategories)) {
    const categories = raw.contextCategories.slice(0, 64).flatMap((candidate) => {
      const category = asRecord(candidate);
      if (
        !category
        || typeof category.name !== "string"
        || typeof category.tokens !== "number"
        || !Number.isFinite(category.tokens)
        || category.tokens < 0
      ) return [];
      return [{
        name: category.name.slice(0, 128),
        tokens: category.tokens,
        ...(typeof category.color === "string" ? { color: category.color.slice(0, 64) } : {}),
      }];
    });
    if (categories.length > 0) usage.contextCategories = categories;
  }
  return usage;
}

function normalizeProviderRateLimits(value: unknown): NativeAgentRateLimitWindow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((candidate) => {
    const limit = asRecord(candidate);
    if (!limit || typeof limit.label !== "string" || limit.label.length === 0) return [];
    const usedPercent = typeof limit.usedPercent === "number"
      && Number.isFinite(limit.usedPercent)
      && limit.usedPercent >= 0
      && limit.usedPercent <= 100
      ? limit.usedPercent
      : undefined;
    const windowMinutes = typeof limit.windowMinutes === "number"
      && Number.isFinite(limit.windowMinutes)
      && limit.windowMinutes >= 0
      ? limit.windowMinutes
      : undefined;
    const resetsAt = typeof limit.resetsAt === "string"
      && Number.isFinite(Date.parse(limit.resetsAt))
      ? limit.resetsAt
      : undefined;
    return [{
      label: limit.label.slice(0, 128),
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }];
  });
}

/**
 * Accept a runtime summary a bridge already reports in neutral form.
 *
 * Claude's and Codex's summaries are assembled here from provider-shaped
 * responses; the ACP bridge has to normalize its own because only it can see
 * the vendor `_meta` the counts come from. Every field stays optional so a
 * bridge that knows one fact is not forced to invent the rest.
 */
function normalizeProviderRuntimeSummary(
  value: unknown,
): NativeAgentRuntimeSummary | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const summary: NativeAgentRuntimeSummary = {};
  const counts = [
    "mcpServers",
    "plugins",
    "commands",
    "skills",
    "hooks",
    "lspServers",
    "formatters",
    "todos",
    "files",
  ] as const;
  for (const key of counts) {
    const candidate = raw[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
      summary[key] = Math.min(candidate, 10_000);
    }
  }
  if (typeof raw.state === "string" && raw.state) summary.state = raw.state.slice(0, 64);
  if (typeof raw.version === "string" && raw.version) summary.version = raw.version.slice(0, 64);
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function providerInventoryCount(value: unknown): number {
  if (Array.isArray(value)) return Math.min(value.length, 10_000);
  const data = asRecord(value)?.data;
  if (Array.isArray(data)) {
    return Math.min(10_000, data.reduce((count, entry) => {
      const item = asRecord(entry);
      const nested = item?.skills ?? item?.hooks ?? item?.servers;
      return count + (Array.isArray(nested) ? nested.length : 1);
    }, 0));
  }
  return Math.min(
    10_000,
    Object.keys(asRecord(value) ?? {}).filter((key) => key !== "error").length,
  );
}

function normalizeClaudeBackgroundTasks(
  value: unknown,
): NativeAgentBackgroundTaskSummary[] | undefined {
  const tasks = asRecord(value);
  if (!tasks) return undefined;
  const allowed = new Set(["pending", "running", "completed", "failed", "killed", "paused"]);
  return Object.entries(tasks).slice(0, 256).flatMap(([id, raw]) => {
    const task = asRecord(raw);
    if (!task || !allowed.has(String(task.status))) return [];
    return [{
      id,
      status: task.status as NativeAgentBackgroundTaskSummary["status"],
      ...(typeof task.description === "string"
        ? { description: task.description.slice(0, 1_000) }
        : {}),
    }];
  });
}

function boundedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length > maximumLength) {
    throw new ProviderUnavailableError("Provider interaction snapshot is oversized");
  }
  return text;
}

function truncatedText(
  value: unknown,
  fallback: string,
  maximumLength: number = AGENT_INTERACTION_LIMITS.maxTextLength,
): string {
  const text = nonEmptyString(value) ?? fallback;
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function boundedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return boundedText(lines.join("\n"), "Interaction details");
}

function truncatedJoinedText(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  return truncatedText(lines.join("\n"), "Interaction details");
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
  }
  if (value.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion) {
    throw new ProviderUnavailableError(`Provider returned too many ${label}`);
  }
  return value.map((entry) => {
    const text = nonEmptyString(entry);
    if (!text) {
      throw new ProviderUnavailableError(`Provider returned malformed ${label}`);
    }
    return boundedText(text, label);
  });
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedOwnedOpenCodeCollection(
  value: unknown,
  ownedSessionIds: ReadonlySet<string>,
  operation: string,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
  const owned: unknown[] = [];
  for (const entry of value) {
    const request = asRecord(entry);
    const sessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    if (!sessionId || !ownedSessionIds.has(sessionId)) continue;
    const id = nonEmptyString(request?.id);
    if (
      !request
      || !id
      || id.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(`${operation} contains a malformed identity`);
    }
    if (owned.length >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      throw new ProviderUnavailableError(`${operation} returned too many interactions`);
    }
    owned.push(entry);
  }
  return owned;
}

type OpenCodeSessionLifecycleState =
  | "running"
  | "idle"
  | "unknown"
  | "missing";

type OpenCodeExistenceSnapshot = ReturnType<
  typeof boundedOpenCodeExistenceSnapshot
>;

type OpenCodeExistenceProbe = {
  state: "exists" | "missing" | "unknown";
  error?: unknown;
};

function boundedOpenCodeStatusSnapshot(
  value: unknown,
  requestedSessionIds: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const snapshot = asRecord(value);
  if (!snapshot) {
    throw new ProviderUnavailableError("OpenCode status read is malformed");
  }
  const entries = Object.entries(snapshot);
  if (
    entries.length > MAX_TRACKED_PROVIDER_INTERACTIONS
    || serializedByteLength(value) > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  ) {
    throw new ProviderUnavailableError("OpenCode status read is oversized");
  }
  const validated: Record<string, Record<string, unknown>> = Object.create(null);
  for (const sessionId of requestedSessionIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, sessionId)) continue;
    const rawStatus = snapshot[sessionId];
    const status = asRecord(rawStatus);
    if (
      sessionId.length === 0
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || !status
      || typeof status.type !== "string"
    ) {
      throw new ProviderUnavailableError(
        "OpenCode status read contains a malformed entry",
      );
    }
    validated[sessionId] = status;
  }
  return validated;
}

function boundedOpenCodeExistenceSnapshot(value: unknown): {
  sessionIds: Set<string>;
} {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError("OpenCode session list is malformed");
  }
  if (
    value.length > MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS
    || serializedByteLength(value) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
  ) {
    throw new ProviderUnavailableError("OpenCode session list is oversized");
  }
  const sessionIds = new Set<string>();
  for (const entry of value) {
    const sessionId = nonEmptyString(asRecord(entry)?.id);
    // The list is directory-wide and may contain sessions Orkestrator has
    // never owned. A malformed foreign entry cannot prove that a valid target
    // exists or is absent, so ignore it instead of stalling every tracked
    // session in the environment.
    if (
      !sessionId
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) continue;
    sessionIds.add(sessionId);
  }
  return { sessionIds };
}

function opaqueOptionId(questionIndex: number, optionIndex: number): string {
  return `q${questionIndex}:o${optionIndex}`;
}

function requestCreatedAt(expiresAt: number | undefined, now: number): number {
  return expiresAt === undefined
    ? now
    : Math.max(0, expiresAt - AGENT_INTERACTION_DEFAULT_TIMEOUT_MS);
}

class InteractionSnapshotTracker {
  private readonly registrations = new Map<string, ProviderSessionRegistration>();
  /**
   * Sessions whose registration came from a caller rather than from the
   * implicit default.
   *
   * {@link snapshot} registers an unknown session so it can be tracked at all,
   * and that placeholder says `interactive-native`. Without this distinction,
   * first-write-wins would let one early read permanently pin an unattended
   * build-pipeline session to the interactive policy — it would simply stop
   * auto-resolving, with nothing to show for it.
   */
  private readonly explicitRegistrations = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly firstSeenAt = new Map<string, number>();
  private readonly interactionSessions = new Map<string, string>();

  register(sessionId: string, interaction?: ProviderSessionRegistration): void {
    if (
      !this.registrations.has(sessionId)
      && this.registrations.size >= MAX_TRACKED_INTERACTION_SESSIONS
    ) {
      const oldest = this.registrations.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.registrations.delete(oldest);
        this.explicitRegistrations.delete(oldest);
        this.fingerprints.delete(oldest);
        this.revisions.delete(oldest);
        for (const [interactionId, ownerSessionId] of this.interactionSessions) {
          if (ownerSessionId !== oldest) continue;
          this.interactionSessions.delete(interactionId);
          this.firstSeenAt.delete(interactionId);
        }
      }
    }
    const existing = this.registrations.get(sessionId);
    if (existing === undefined) {
      this.registrations.set(sessionId, interaction ?? DEFAULT_SESSION_REGISTRATION);
      if (interaction) this.explicitRegistrations.add(sessionId);
      return;
    }
    if (!interaction) return;
    // The placeholder written by an early read is not a decision, so the first
    // real registration replaces it outright.
    if (!this.explicitRegistrations.has(sessionId)) {
      this.registrations.set(sessionId, interaction);
      this.explicitRegistrations.add(sessionId);
      return;
    }
    // Policy is fixed before the first request. Re-registering a restored or
    // cached provider may reassert the same metadata, but must never switch a
    // live session between interactive and unattended while a request exists.
    if (
      interaction.origin !== existing.origin
      || interaction.interactionPolicy.mode !== existing.interactionPolicy.mode
    ) return;
    // Same identity, so fill in metadata the first caller did not have —
    // callers differ in what they know (the activity sweep has no `phase`, the
    // reconciler does) and whichever ran first should not cost the others their
    // fields. Values already recorded are never overwritten: the fence in
    // particular identifies the generation that owns any live request.
    this.registrations.set(sessionId, {
      ...existing,
      phase: existing.phase ?? interaction.phase,
      workflowId: existing.workflowId ?? interaction.workflowId,
      provider: existing.provider ?? interaction.provider,
      fence: existing.fence ?? interaction.fence,
    });
  }

  registration(sessionId: string): ProviderSessionRegistration {
    return this.registrations.get(sessionId) ?? DEFAULT_SESSION_REGISTRATION;
  }

  firstSeen(interactionId: string, fallback = Date.now()): number {
    const existing = this.firstSeenAt.get(interactionId);
    if (existing !== undefined) return existing;
    setBoundedMapEntry(
      this.firstSeenAt,
      interactionId,
      fallback,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return fallback;
  }

  sessionFor(interactionId: string): string | undefined {
    return this.interactionSessions.get(interactionId);
  }

  snapshot(sessionId: string, requests: AgentInteractionRequest[]): AgentInteractionSnapshot {
    if (requests.length > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
      throw new ProviderUnavailableError("Provider returned too many pending interactions");
    }
    const fingerprint = JSON.stringify(requests);
    const previous = this.fingerprints.get(sessionId);
    const revision = previous === fingerprint
      ? this.revisions.get(sessionId) ?? 0
      : (this.revisions.get(sessionId) ?? 0) + 1;
    const normalized = requests.map((request) => ({ ...request, revision }));
    const snapshot: AgentInteractionSnapshot = {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      revision,
      requests: normalized,
    };
    // Validation must precede every tracker mutation. Otherwise a rejected
    // snapshot can still retain its fingerprint and poison revision/identity
    // state for later authoritative reads.
    if (!isAgentInteractionSnapshot(snapshot)) {
      throw new ProviderUnavailableError("Provider returned a malformed interaction snapshot");
    }
    if (!this.registrations.has(sessionId)) this.register(sessionId);
    this.fingerprints.set(sessionId, fingerprint);
    this.revisions.set(sessionId, revision);
    const currentIds = new Set(normalized.map((request) => request.id));
    for (const [interactionId, ownerSessionId] of this.interactionSessions) {
      if (ownerSessionId !== sessionId || currentIds.has(interactionId)) continue;
      this.interactionSessions.delete(interactionId);
      this.firstSeenAt.delete(interactionId);
    }
    for (const request of normalized) {
      setBoundedMapEntry(
        this.interactionSessions,
        request.id,
        sessionId,
        MAX_TRACKED_PROVIDER_INTERACTIONS,
      );
    }
    return snapshot;
  }
}

function outcome(
  result: AgentInteractionApplyOutcome["result"],
  sessionId: string,
  interactionId: string,
  revision: number,
): AgentInteractionApplyOutcome {
  return { result, sessionId, interactionId, revision };
}

async function boundedJson(
  response: Response,
  operation: string,
  budget = { remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes },
): Promise<unknown> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailableError(`${operation} is oversized`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
}

function authHeaders(connection: BridgeConnection): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connection.agent === "claude") {
    headers.set("X-Orkestrator-Claude-Token", connection.authToken);
  } else if (connection.agent === "codex") {
    headers.set("X-Orkestrator-Codex-Token", connection.authToken);
  } else if (connection.agent === "cursor" || connection.agent === "grok") {
    headers.set("Authorization", `Bearer ${connection.authToken}`);
  }
  return headers;
}

async function bridgeFetch(
  connection: BridgeConnection,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const timeoutMs = Math.max(
    1,
    connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchImpl(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      `${connection.agent} bridge is unavailable`,
      { cause: error },
    );
  }
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok) {
    if (isTransientHttpStatus(response.status)) {
      throw new ProviderUnavailableError(
        `${operation} is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
}

async function assertOkWithErrorDetail(
  response: Response,
  operation: string,
): Promise<void> {
  if (response.ok) return;
  const payload = await boundedJson(response, operation).catch(() => null);
  const rawDetail = nonEmptyString(asRecord(payload)?.error);
  const detail = rawDetail
    ? rawDetail.replace(/[\r\n\t]+/g, " ").slice(0, 500)
    : "";
  const message = `${operation} ${isTransientHttpStatus(response.status)
    ? "is temporarily unavailable"
    : "failed"} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`;
  if (isTransientHttpStatus(response.status)) {
    throw new ProviderUnavailableError(message);
  }
  throw new Error(message);
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

/**
 * Produce the attachment list a bridge will accept.
 *
 * Base64-only images have no `path`, which every bridge validator requires, so
 * they must be staged first. Refusing them outright when no stager is wired is
 * deliberate: the alternative is a prompt that references an image the agent was
 * never given.
 */
async function resolvePromptAttachments(
  options: ProviderSendOptions,
  stageImages: ProviderDependencies["stageImages"],
): Promise<PromptAttachment[] | undefined> {
  const attachments = options.attachments ? [...options.attachments] : [];
  const images = options.images ?? [];
  if (images.length > 0) {
    if (!stageImages) {
      throw new PromptRejectedError(
        "Prompt images require workspace staging before they can be attached",
      );
    }
    attachments.push(...await stageImages(images));
  }
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Drop the staged `dataUrl` before an attachment reaches an ACP bridge.
 *
 * That bridge reads every attachment's bytes from the workspace itself and
 * ignores `dataUrl`, but it caps a request body at 2MiB. Forwarding the data URL
 * spends that whole budget on a copy the bridge discards, so a screenshot much
 * over 1.5MB would come back as HTTP 413 — a terminal rejection of a prompt the
 * bridge is perfectly able to read from disk. The Claude and Codex bridges do
 * consume `dataUrl`, so this is deliberately scoped to the ACP agents.
 */
function bridgePromptAttachments(
  agent: HttpBridgeProvider["agent"],
  attachments: PromptAttachment[] | undefined,
): PromptAttachment[] | undefined {
  if (!attachments || (agent !== "cursor" && agent !== "grok")) return attachments;
  return attachments.map((attachment) => ({
    type: attachment.type,
    path: attachment.path,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  }));
}

class HttpBridgeProvider implements BuildPipelineProvider {
  readonly agent: "claude" | "codex" | "cursor" | "grok";
  private readonly stageImages?: ProviderDependencies["stageImages"];
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();
  readonly interactions?: AgentInteractionProviderCapability;
  /**
   * The Codex mode each session was last known to be in.
   *
   * Codex binds its mode to the session rather than the prompt, so re-asserting
   * the mode a session was just created with costs a config round trip and
   * changes nothing. A session this provider did not create — one restored
   * through {@link registerSession} after a restart — is absent here, and those
   * do have to be reconciled against the bridge.
   */
  private readonly codexModes = new Map<string, ProviderExecutionMode>();
  private readonly interactiveMetadata = new Map<string, {
    expiresAt: number;
    executionProfiles?: NativeAgentComposerState["executionProfiles"];
    runtime?: NativeAgentRuntimeSummary;
  }>();
  /** Runtime inventory is optional UI metadata and must not delay transcripts. */
  private readonly codexRuntimeMetadataRefreshes = new Map<string, Promise<void>>();
  private codexRuntimeMetadataGeneration = 0;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    stageImages?: ProviderDependencies["stageImages"],
  ) {
    this.agent = connection.agent as "claude" | "codex" | "cursor" | "grok";
    this.stageImages = stageImages;
    this.interactions = {
      listPendingInteractions: (sessionId) => this.listPendingInteractions(sessionId),
      resolveInteraction: (sessionId, interactionId, resolution) =>
        this.resolveInteraction(sessionId, interactionId, resolution),
    };
  }

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
    this.interactionTracker.register(sessionId, interaction);
  }

  async createSession(
    _phase: PipelineSessionPhase,
    label: string,
    options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    const clientSessionKey = options.clientSessionKey;
    const mode = options.mode ?? "build";
    const response = await bridgeFetch(
      this.connection,
      "/session/create",
      {
        method: "POST",
        body: JSON.stringify(this.agent === "codex"
          ? {
              title: label,
              model: options.model ?? this.connection.model,
              modelReasoningEffort: options.effort ?? this.connection.effort,
              mode,
              clientSessionKey,
            }
          : this.agent === "cursor" || this.agent === "grok"
            ? {
                title: label,
                clientSessionKey,
                model: options.model ?? this.connection.model,
                reasoningEffort: options.effort ?? this.connection.effort,
                mode,
                ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
              }
            : { title: label, clientSessionKey }),
      },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} session creation`);
    const body = await response.json() as { sessionId?: unknown };
    if (typeof body.sessionId !== "string") {
      throw new Error(`${this.agent} returned a malformed session`);
    }
    this.registerSession(body.sessionId, options.interaction);
    if (this.agent === "codex") this.codexModes.set(body.sessionId, mode);
    return body.sessionId;
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    if (
      this.agent === "codex"
      && options.mode
      && this.codexModes.get(sessionId) !== options.mode
    ) {
      await this.ensureCodexMode(sessionId, options.mode);
      this.codexModes.set(sessionId, options.mode);
    }
    const attachments = bridgePromptAttachments(
      this.agent,
      await resolvePromptAttachments(options, this.stageImages),
    );
    let response: Response;
    try {
      response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt,
            requestId: options.requestId,
            attachments,
            outputSchema: options.schema,
            ...(this.agent === "claude"
              ? {
                  model: options.model ?? this.connection.model,
                  effort: options.effort ?? this.connection.effort,
                  fastMode: options.fastMode,
                  agent: options.subAgent,
                  includeLocalSettings: options.includeLocalSettings,
                  promptSuggestions: options.promptSuggestions,
                  permissionMode:
                    options.mode === "plan" ? "plan" : "bypassPermissions",
                }
              : this.agent === "cursor" || this.agent === "grok"
                ? {
                    fastMode: options.fastMode,
                    model: options.model ?? this.connection.model,
                    reasoningEffort: options.effort ?? this.connection.effort,
                    mode: options.mode,
                  }
                : { fastMode: options.fastMode }),
          }),
        },
        this.fetchImpl,
      );
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        throw new AmbiguousPromptDispatchError(
          `${this.agent} prompt dispatch outcome is unknown`,
          { cause: error },
        );
      }
      throw error;
    }
    // A session can briefly disappear while a bridge reconciles a restarted
    // provider, and an idle status read can race with another client starting a
    // turn. Both are retryable dispatch races, not validation rejections that
    // should park the user's prompt indefinitely.
    if (
      response.status === 404
      || response.status === 409
      || isTransientHttpStatus(response.status)
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} prompt dispatch is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      // Bridges answer terminal rejections with an actionable message (e.g. an
      // ACP prompt whose outcome is unknown after a restart). Surface it so the
      // pipeline failure tells the user what to do instead of a bare status.
      const detail = await response.json().catch(() => null) as { error?: unknown } | null;
      const detailMessage = detail !== null && typeof detail.error === "string"
        ? `: ${detail.error}`
        : "";
      throw new PromptRejectedError(
        `${this.agent} rejected the prompt (HTTP ${response.status})${detailMessage}`,
      );
    }
  }

  /**
   * Codex stores execution mode on the session rather than accepting it on the
   * prompt route. Reused workflow threads can move between plan and build
   * turns, so reconcile the idle thread before dispatching when needed.
   */
  private async ensureCodexMode(
    sessionId: string,
    mode: ProviderExecutionMode,
  ): Promise<void> {
    const path = `/session/${encodeURIComponent(sessionId)}/config`;
    const currentResponse = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (
      currentResponse.status === 404
      || currentResponse.status === 409
      || isTransientHttpStatus(currentResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode reconciliation is temporarily unavailable (HTTP ${currentResponse.status})`,
      );
    }
    assertOk(currentResponse, "Codex config read");
    const current = await currentResponse.json() as {
      model?: unknown;
      modelReasoningEffort?: unknown;
      mode?: unknown;
      fastMode?: unknown;
      durable?: unknown;
    };
    if (
      (current.mode !== "plan" && current.mode !== "build")
      || (current.model !== undefined && typeof current.model !== "string")
      || (
        current.modelReasoningEffort !== undefined
        && typeof current.modelReasoningEffort !== "string"
      )
      || typeof current.fastMode !== "boolean"
      || typeof current.durable !== "boolean"
    ) {
      throw new Error("Codex returned a malformed session config");
    }
    if (current.mode === mode && current.durable) return;

    const updateResponse = await bridgeFetch(
      this.connection,
      path,
      {
        method: "POST",
        body: JSON.stringify({
          model: current.model,
          modelReasoningEffort: current.modelReasoningEffort,
          mode,
          fastMode: current.fastMode,
        }),
      },
      this.fetchImpl,
    );
    if (
      updateResponse.status === 404
      || updateResponse.status === 409
      || isTransientHttpStatus(updateResponse.status)
    ) {
      throw new ProviderUnavailableError(
        `Codex mode update is temporarily unavailable (HTTP ${updateResponse.status})`,
      );
    }
    assertOk(updateResponse, "Codex config update");
    const update = await updateResponse.json() as { durable?: unknown };
    if (update.durable !== true) {
      throw new ProviderUnavailableError(
        "Codex mode update was not durably persisted",
      );
    }
  }

  /**
   * Read the session's lifecycle state.
   *
   * The failed-turn contract is split, so read it before branching on the
   * result: a terminal turn error is delivered as a `ProviderSessionFailedError`
   * **throw** when the bridge supplied a detail, and returned as `"error"` only
   * when it did not. A caller that branches on `status === "error"` therefore
   * reaches that branch exactly when the provider declined to explain itself —
   * which is backwards. Any such caller must read through `readProviderStatus`,
   * which turns the throw back into `{ status: "error", error }` so the branch
   * fires either way and the detail is available to it.
   */
  async status(sessionId: string): Promise<ProviderStatus> {
    const path = this.agent === "claude"
      ? `/session/${encodeURIComponent(sessionId)}`
      : `/session/${encodeURIComponent(sessionId)}/status`;
    const response = await bridgeFetch(
      this.connection,
      path,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return "missing";
    assertOk(response, `${this.agent} status read`);
    const body = await response.json() as { status?: unknown; error?: unknown };
    if (body.status === "error" && typeof body.error === "string") {
      const detail = body.error.trim().slice(0, 4_000);
      if (detail) {
        throw new ProviderSessionFailedError(this.agent, detail);
      }
    }
    return body.status === "running" || body.status === "idle" || body.status === "error"
      ? body.status
      : "error";
  }

  /**
   * Read activity from the bridge's dedicated observation route.
   *
   * This deliberately does not reuse `status()` plus the pending-input routes.
   * Those are the routes a *tab* reads, so each one is a liveness touch: the
   * codex bridge refreshes `lastAccessed` (blocking idle thread detaching) and
   * the claude bridge additionally hydrates the persisted transcript. This
   * method is polled every couple of seconds for every session in every
   * environment, so it must have no side effect at all — `/activity` exists
   * only to answer it.
   *
   * The route reports an unknown session in-band as `missing` and never 404s.
   * A 404 here therefore means the route itself is absent — an older bridge —
   * and must surface as a failure rather than as "this session is gone", which
   * the caller would act on by deleting the user's session mapping.
   */
  async activity(sessionId: string): Promise<ProviderActivityState> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/activity`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} activity read`);
    const body = await response.json() as { activity?: unknown };
    if (!isProviderActivityState(body.activity)) {
      throw new ProviderUnavailableError(
        `${this.agent} returned a malformed activity snapshot`,
      );
    }
    return body.activity;
  }

  private normalizedId(
    sessionId: string,
    providerRequestId: string,
    category: string,
  ): string {
    if (
      sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || providerRequestId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    const id = `${this.agent}:${category}:${encodeURIComponent(sessionId)}:${providerRequestId}`;
    if (id.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError(
        `${this.agent} returned an oversized interaction identity`,
      );
    }
    return id;
  }

  private interactionRequest(
    sessionId: string,
    providerRequestId: string,
    category: string,
    input: Omit<
      AgentInteractionRequest,
      "version" | "id" | "provider" | "origin" | "sessionId" | "state" | "revision"
    >,
  ): AgentInteractionRequest {
    const id = this.normalizedId(sessionId, providerRequestId, category);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: this.agent,
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      ...input,
    };
  }

  private mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const questions = request?.questions;
    const expiresAt = request?.expiresAt;
    if (
      !request
      || !providerRequestId
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
      || (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed question request");
    }
    const mapped: AgentInteractionQuestion[] = questions.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const options = question?.options;
      const prompt = nonEmptyString(question?.question);
      if (
        !question
        || !prompt
        || !Array.isArray(options)
        || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Claude returned a malformed question request");
      }
      return {
        id: `q${questionIndex}`,
        prompt: boundedText(prompt, prompt),
        description: question.header === undefined
          ? undefined
          : truncatedText(question.header, "Question"),
        required: true,
        multiple: question.multiSelect === true,
        secret: false,
        allowFreeText: true,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          const rawProviderValue = option && "value" in option
            ? nonEmptyString(option.value)
            : label;
          if (!option || !label || !rawProviderValue) {
            throw new ProviderUnavailableError(
              "Claude returned a malformed question option",
            );
          }
          const providerValue = boundedText(
            rawProviderValue,
            rawProviderValue,
            AGENT_INTERACTION_LIMITS.maxProviderValueLength,
          );
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue,
            description: option?.description === undefined
              ? undefined
              : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
    const id = this.normalizedId(sessionId, providerRequestId, "question");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? expiresAt as number
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "question", {
      kind: "question",
      presentation: { title: "Claude needs input", questions: mapped },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
  }

  private mapClaudeApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const expiresAt = request?.expiresAt;
    if (
      !providerRequestId
      || (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))
    ) {
      throw new ProviderUnavailableError("Claude returned a malformed plan approval");
    }
    const id = this.normalizedId(sessionId, providerRequestId, "plan");
    const createdAt = Number.isSafeInteger(expiresAt)
      ? requestCreatedAt(expiresAt as number, Date.now())
      : this.interactionTracker.firstSeen(id);
    const expiry = Number.isSafeInteger(expiresAt)
      ? expiresAt as number
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "plan", {
      kind: "plan-approval",
      presentation: {
        title: "Approve Claude's plan",
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt: expiry,
    });
  }

  private mapCodexApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.approvalId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    if (
      !request
      || !providerRequestId
      || !Number.isSafeInteger(requestedAt)
      || !Number.isSafeInteger(expiresAt)
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed approval request");
    }
    const providerKind = request?.kind;
    const kind = providerKind === "command"
      ? "command-approval"
      : providerKind === "file-change"
        ? "file-approval"
        : providerKind === "permissions"
          ? "permission"
          : null;
    if (!kind) throw new ProviderUnavailableError("Codex returned an unknown approval kind");
    const command = nonEmptyString(request.command);
    const cwd = nonEmptyString(request.cwd);
    const reason = nonEmptyString(request.reason);
    const grantRoot = nonEmptyString(request.grantRoot);
    const networkHost = nonEmptyString(request.networkHost);
    const rawChanges = Array.isArray(request.changes) ? request.changes : [];
    const changes = rawChanges
      .slice(0, MAX_RENDERED_FILE_CHANGES)
      .map((rawChange) => {
          const change = asRecord(rawChange);
          const path = nonEmptyString(change?.path);
          if (!change || !path) {
            throw new ProviderUnavailableError(
              "Codex returned a malformed file change",
            );
          }
          const changeKind = nonEmptyString(change.kind) ?? "update";
          return truncatedText(
            `${changeKind}: ${path}`,
            "File change",
            MAX_RENDERED_FILE_CHANGE_TEXT_LENGTH,
          );
        });
    const hiddenChangeCount = rawChanges.length - changes.length;
    const permissions = asRecord(request.permissions);
    const requestedPermissions = permissions
      ? [
          permissions.network === true ? "network" : null,
          permissions.fileSystem === true ? "file system" : null,
        ].filter((entry): entry is string => entry !== null)
      : [];
    const inferredActionable = kind === "command-approval"
      ? command !== null
      : kind === "file-approval"
        ? rawChanges.length > 0
        : requestedPermissions.length > 0;
    const actionable = inferredActionable && request.actionable !== false;
    const body = truncatedJoinedText([
      ...(reason ? [`Reason: ${boundedText(reason, "Reason")}`] : []),
      ...(command ? [`Command: ${boundedText(command, "Command")}`] : []),
      ...(cwd ? [`Working directory: ${boundedText(cwd, "Working directory")}`] : []),
      ...changes.map((change) => `Change: ${change}`),
      ...(hiddenChangeCount > 0
        ? [`… and ${hiddenChangeCount} more files`]
        : []),
      ...(requestedPermissions.length > 0
        ? [`Permissions: ${requestedPermissions.join(", ")}`]
        : []),
      ...(grantRoot ? [`Grant root: ${boundedText(grantRoot, "Grant root")}`] : []),
      ...(networkHost ? [`Network host: ${boundedText(networkHost, "Network host")}`] : []),
      ...(!actionable ? ["Approval is missing actionable operation details."] : []),
    ]);
    const mapped = this.interactionRequest(sessionId, providerRequestId, "approval", {
      kind,
      presentation: {
        title: kind === "command-approval"
          ? "Approve command"
          : kind === "file-approval" ? "Approve file changes" : "Approve permissions",
        body: body === undefined ? undefined : boundedText(body, "Approval requested"),
        questions: [],
        confirmLabel: "Approve",
        declineLabel: "Deny",
        confirmDisabled: !actionable,
        ...(request.supportsApproveForSession === true
          ? { approveForSessionLabel: "Approve for session" }
          : {}),
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
    const identity = this.providerInteractionIds.get(mapped.id);
    if (identity) identity.actionable = actionable;
    return mapped;
  }

  private mapAcpApproval(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    // Older ACP bridges exposed the same approval envelope as Codex. Keep the
    // read boundary compatible while normalizing both generations to the
    // shared interaction contract.
    if (nonEmptyString(request?.approvalId)) {
      return this.mapCodexApproval(sessionId, raw);
    }
    const providerRequestId = nonEmptyString(request?.id);
    const title = nonEmptyString(request?.title);
    const options = request?.options;
    if (
      !request
      || !providerRequestId
      || !title
      || !Array.isArray(options)
      || options.length === 0
      || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
    ) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed approval`);
    }
    const id = this.normalizedId(sessionId, providerRequestId, "approval");
    const createdAt = Number.isSafeInteger(request.requestedAt)
      ? request.requestedAt as number
      : this.interactionTracker.firstSeen(id);
    const expiresAt = Number.isSafeInteger(request.expiresAt)
      ? request.expiresAt as number
      : createdAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
    return this.interactionRequest(sessionId, providerRequestId, "approval", {
      kind: "permission",
      presentation: {
        title: boundedText(title, "Approval requested"),
        questions: [{
          id: "decision",
          prompt: "Choose how the agent should proceed",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: false,
          options: options.map((entry, optionIndex) => {
            const option = asRecord(entry);
            const optionId = nonEmptyString(option?.optionId);
            const label = nonEmptyString(option?.name);
            if (!option || !optionId || !label) {
              throw new ProviderUnavailableError(
                `${this.agent} returned a malformed approval option`,
              );
            }
            return {
              id: opaqueOptionId(0, optionIndex),
              label: boundedText(label, label),
              providerValue: boundedText(
                optionId,
                optionId,
                AGENT_INTERACTION_LIMITS.maxProviderValueLength,
              ),
            };
          }),
        }],
        confirmLabel: "Continue",
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    });
  }

  private mapCodexInteraction(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.interactionId);
    const requestedAt = request?.requestedAt;
    const expiresAt = request?.expiresAt;
    const kind = request?.kind;
    if (
      !request
      || !providerRequestId
      || !Number.isSafeInteger(requestedAt)
      || !Number.isSafeInteger(expiresAt)
      || (kind !== "question" && kind !== "mcp-form" && kind !== "mcp-url")
    ) {
      throw new ProviderUnavailableError("Codex returned a malformed interaction request");
    }
    const questions: AgentInteractionQuestion[] = kind === "question"
      ? this.mapCodexQuestions(request.questions)
      : kind === "mcp-form"
        ? [this.mapCodexMcpForm(request.schema)]
        : [];
    const url = kind === "mcp-url" ? nonEmptyString(request.url) : null;
    if (kind === "mcp-url" && !url) {
      throw new ProviderUnavailableError("Codex returned a malformed URL elicitation");
    }
    return this.interactionRequest(sessionId, providerRequestId, "interaction", {
      kind,
      presentation: {
        title: kind === "question"
          ? "Codex needs input"
          : kind === "mcp-form" ? "MCP server needs input" : "MCP authorization",
        body: request.message === undefined
          ? undefined
          : truncatedText(request.message, "MCP request"),
        questions,
        url: url === null ? undefined : boundedText(url, "MCP URL"),
        confirmLabel: "Continue",
        declineLabel: "Decline",
      },
      createdAt: requestedAt as number,
      updatedAt: requestedAt as number,
      expiresAt: expiresAt as number,
    });
  }

  private mapCodexMcpForm(schemaValue: unknown): AgentInteractionQuestion {
    const schema = asRecord(schemaValue) ?? {};
    const serializedSchema = JSON.stringify(schema);
    if (
      !serializedSchema
      || new TextEncoder().encode(serializedSchema).byteLength
        > AGENT_INTERACTION_LIMITS.maxTextLength
    ) {
      throw new ProviderUnavailableError("Codex returned an oversized MCP form schema");
    }
    return {
      id: MCP_FORM_CONTENT_QUESTION_ID,
      prompt: "Enter a JSON object matching the MCP form schema",
      description: serializedSchema,
      required: true,
      multiple: false,
      secret: false,
      allowFreeText: true,
      options: [],
    };
  }

  private mapCodexQuestions(value: unknown): AgentInteractionQuestion[] {
    if (
      !Array.isArray(value)
      || value.length === 0
      || value.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("Codex returned malformed questions");
    }
    return value.map((entry, questionIndex) => {
      const question = asRecord(entry);
      const providerQuestionId = nonEmptyString(question?.id);
      const prompt = nonEmptyString(question?.question);
      const options = question?.options ?? [];
      if (
        !providerQuestionId
        || !prompt
        || providerQuestionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
        || !Array.isArray(options)
        || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
      ) {
        throw new ProviderUnavailableError("Codex returned malformed questions");
      }
      return {
        id: providerQuestionId,
        prompt: boundedText(prompt, prompt),
        description: question?.header === undefined
          ? undefined
          : truncatedText(question.header, "Question"),
        required: true,
        // request_user_input serializes every answer as an array, but each
        // Codex option list is mutually exclusive. Wire shape is not choice
        // semantics; normalize that distinction before the shared UI.
        multiple: false,
        secret: question?.isSecret === true,
        allowFreeText: question?.isOther === true || options.length === 0,
        options: options.map((entry, optionIndex) => {
          const option = asRecord(entry);
          const label = nonEmptyString(option?.label);
          if (!option || !label) {
            throw new ProviderUnavailableError(
              "Codex returned a malformed question option",
            );
          }
          return {
            id: opaqueOptionId(questionIndex, optionIndex),
            label: boundedText(label, label),
            providerValue: boundedText(
              label,
              label,
              AGENT_INTERACTION_LIMITS.maxProviderValueLength,
            ),
            description: option?.description === undefined
              ? undefined
              : truncatedText(option.description, "Option"),
          };
        }),
      };
    });
  }

  private async listPendingInteractions(
    sessionId: string,
  ): Promise<AgentInteractionSnapshot> {
    const paths = this.agent === "claude"
      ? ["questions", "plan-approvals"] as const
      : ["approvals", "interactions"] as const;
    const responses = await Promise.all(paths.map((path) => bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/${path}`,
      {},
      this.fetchImpl,
    )));
    if (responses.every((response) => response.status === 404)) {
      return this.interactionTracker.snapshot(sessionId, []);
    }
    for (const response of responses) assertOk(response, `${this.agent} interaction snapshot`);
    const snapshotBudget = {
      remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes,
    };
    const payloads = await Promise.all(responses.map((response) =>
      boundedJson(response, `${this.agent} interaction snapshot`, snapshotBudget)
    ));
    const first = asRecord(payloads[0]);
    const second = asRecord(payloads[1]);
    const firstRequests = first?.[this.agent === "claude" ? "questions" : "approvals"];
    const secondRequests = second?.[this.agent === "claude" ? "approvals" : "interactions"];
    if (!Array.isArray(firstRequests) || !Array.isArray(secondRequests)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed interaction snapshot`);
    }
    const requests: AgentInteractionRequest[] = [];
    let droppedRequests = 0;
    const mapRequest = (
      raw: unknown,
      mapper: (request: unknown) => AgentInteractionRequest,
    ): void => {
      if (requests.length >= AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        droppedRequests += 1;
        return;
      }
      try {
        requests.push(mapper(raw));
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        droppedRequests += 1;
      }
    };
    if (this.agent === "claude") {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapClaudeQuestion(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapClaudeApproval(sessionId, raw));
      }
    } else if (this.agent === "cursor" || this.agent === "grok") {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapAcpApproval(sessionId, raw));
      }
      // ACP currently has no second interaction family. Keep reading the
      // endpoint so a future bridge can add one without losing requests, but
      // reject non-empty unknown payloads instead of pretending they vanished.
      if (secondRequests.length > 0) droppedRequests += secondRequests.length;
    } else {
      for (const request of firstRequests) {
        mapRequest(request, (raw) => this.mapCodexApproval(sessionId, raw));
      }
      for (const request of secondRequests) {
        mapRequest(request, (raw) => this.mapCodexInteraction(sessionId, raw));
      }
    }
    if (droppedRequests > 0) {
      console.warn(
        `[build-pipeline] Dropped ${droppedRequests} unmappable ${this.agent} interaction request(s)`,
      );
      if (requests.length === 0) {
        throw new ProviderUnavailableError(
          `${this.agent} returned no mappable interaction requests`,
        );
      }
    }
    const snapshot = this.interactionTracker.snapshot(sessionId, requests);
    const currentIds = new Set(snapshot.requests.map((request) => request.id));
    for (const [interactionId, identity] of this.providerInteractionIds) {
      if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
        this.providerInteractionIds.delete(interactionId);
      }
    }
    return snapshot;
  }

  private async resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const knownSession = this.interactionTracker.sessionFor(interactionId);
    if (knownSession !== undefined && knownSession !== sessionId) {
      return outcome("rejected", sessionId, interactionId, 0);
    }
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) return outcome("stale", sessionId, interactionId, snapshot.revision);
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    if (this.resolvingInteractions.has(interactionId)) {
      return outcome("already-resolved", sessionId, interactionId, snapshot.revision);
    }
    const identity = this.providerInteractionIds.get(interactionId);
    if (!identity) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (
      (resolution.action === "answer" || resolution.action === "approve-for-session")
      && identity.actionable === false
    ) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    this.resolvingInteractions.add(interactionId);
    try {
      let target: { path: string; method: "POST" | "DELETE"; body?: string };
      try {
        target = await this.httpResolutionTarget(
          sessionId,
          identity.providerRequestId,
          request,
          resolution,
        );
      } catch {
        return outcome("rejected", sessionId, interactionId, snapshot.revision);
      }
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          target.path,
          { method: target.method, body: target.body },
          this.fetchImpl,
        );
      } catch (error) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      if (response.status === 409 || response.status === 404) {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => snapshot);
        return outcome("stale", sessionId, interactionId, reconciled.revision);
      }
      if (!response.ok) {
        return outcome(
          isTransientHttpStatus(response.status) ? "provider-unavailable" : "rejected",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) {
        return outcome(
          "provider-unavailable",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      return outcome(
        reconciled.requests.some((item) => item.id === interactionId)
          ? "provider-unavailable"
          : "applied",
        sessionId,
        interactionId,
        reconciled.revision,
      );
    } finally {
      this.resolvingInteractions.delete(interactionId);
    }
  }

  private async httpResolutionTarget(
    sessionId: string,
    providerRequestId: string,
    request: AgentInteractionRequest,
    resolution: AgentInteractionResolution,
  ): Promise<{ path: string; method: "POST" | "DELETE"; body?: string }> {
    const base = `/session/${encodeURIComponent(sessionId)}`;
    if (this.agent === "claude") {
      if (request.kind === "question") {
        if (resolution.action !== "answer") {
          return {
            path: `${base}/questions/${encodeURIComponent(providerRequestId)}`,
            method: "DELETE",
          };
        }
        const byQuestion = new Map(
          resolution.answer?.answers.map((answer) => [answer.questionId, answer]),
        );
        const answers = request.presentation.questions.map((question) => {
          const answer = byQuestion.get(question.id)!;
          const options = new Map(question.options.map((option) => [option.id, option.providerValue]));
          return [
            ...(answer.optionIds ?? []).map((id) => options.get(id)!),
            ...(answer.freeText === undefined ? [] : [answer.freeText]),
          ];
        });
        return {
          path: `${base}/questions/${encodeURIComponent(providerRequestId)}/answer`,
          method: "POST",
          body: JSON.stringify({ answers }),
        };
      }
      return {
        path: `${base}/plan-approvals/${encodeURIComponent(providerRequestId)}/respond`,
        method: "POST",
        body: JSON.stringify({
          approved: resolution.action === "answer",
          ...(resolution.feedback ? { feedback: resolution.feedback } : {}),
        }),
      };
    }

    if (this.agent === "cursor" || this.agent === "grok") {
      if (request.kind !== "permission") {
        throw new ProviderUnavailableError("ACP returned an unsupported interaction kind");
      }
      if (request.presentation.questions.length === 0) {
        return {
          path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
          method: "POST",
          body: JSON.stringify({
            decision: resolution.action === "answer" ? "approve" : "deny",
          }),
        };
      }
      const answer = resolution.action === "answer"
        ? resolution.answer?.answers.find((candidate) =>
            candidate.questionId === request.presentation.questions[0]?.id
          )
        : undefined;
      const selectedId = answer?.optionIds?.[0];
      const providerValue = selectedId === undefined
        ? undefined
        : request.presentation.questions[0]?.options.find(
            (option) => option.id === selectedId,
          )?.providerValue;
      if (resolution.action === "answer" && !providerValue) {
        throw new ProviderUnavailableError("ACP approval option is missing");
      }
      return {
        path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
        method: "POST",
        body: JSON.stringify(providerValue ? { optionId: providerValue } : {}),
      };
    }

    if (
      request.kind === "command-approval"
      || request.kind === "file-approval"
      || request.kind === "permission"
    ) {
      return {
        path: `${base}/approvals/${encodeURIComponent(providerRequestId)}`,
        method: "POST",
        body: JSON.stringify({
          decision: resolution.action === "answer"
            ? "approve"
            : resolution.action === "approve-for-session"
              ? "approve-for-session"
            : resolution.action === "cancel" ? "cancel" : "deny",
        }),
      };
    }
    const answerBody: Record<string, unknown> = {
      action: resolution.action === "answer"
        ? "accept"
        : resolution.action === "cancel" ? "cancel" : "decline",
    };
    if (resolution.action === "answer" && request.kind === "mcp-form") {
      const rawContent = resolution.answer!.answers.find(
        (answer) => answer.questionId === MCP_FORM_CONTENT_QUESTION_ID,
      )?.freeText;
      let content: unknown;
      try {
        content = rawContent === undefined ? null : JSON.parse(rawContent);
      } catch {
        throw new ProviderUnavailableError("MCP form content must be valid JSON");
      }
      if (!asRecord(content)) {
        throw new ProviderUnavailableError("MCP form content must be a JSON object");
      }
      answerBody.content = content;
    } else if (resolution.action === "answer" && request.kind === "question") {
      answerBody.answers = Object.fromEntries(
        request.presentation.questions.map((question) => {
          const answer = resolution.answer!.answers.find(
            (candidate) => candidate.questionId === question.id,
          )!;
          const options = new Map(question.options.map((option) => [option.id, option.providerValue]));
          return [question.id, [
            ...(answer.optionIds ?? []).map((id) => options.get(id)!),
            ...(answer.freeText === undefined ? [] : [answer.freeText]),
          ]];
        }),
      );
    }
    return {
      path: `${base}/interactions/${encodeURIComponent(providerRequestId)}`,
      method: "POST",
      body: JSON.stringify(answerBody),
    };
  }

  async messages(sessionId: string): Promise<unknown[]> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/messages`,
      {},
      this.fetchImpl,
    );
    if (response.status === 404) return [];
    assertOk(response, `${this.agent} transcript read`);
    const body = await response.json() as { messages?: unknown };
    return Array.isArray(body.messages) ? body.messages : [];
  }

  private codexRuntimeSummary(payload: unknown): NativeAgentRuntimeSummary | undefined {
    const health = asRecord(payload);
    if (!health) return undefined;
    const engine = asRecord(health.engine);
    const groupedNotices = new Map<string, number>();
    if (Array.isArray(health.notices)) {
      for (const candidate of health.notices.slice(-128)) {
        const message = asRecord(candidate)?.message;
        if (typeof message !== "string" || message.length === 0) continue;
        const bounded = message.slice(0, 1_000);
        groupedNotices.set(bounded, (groupedNotices.get(bounded) ?? 0) + 1);
      }
    }
    return {
      mcpServers: providerInventoryCount(health.mcp),
      skills: providerInventoryCount(health.skills),
      hooks: providerInventoryCount(health.hooks),
      ...(typeof engine?.state === "string" ? { state: engine.state.slice(0, 64) } : {}),
      ...(typeof engine?.codexVersion === "string"
        ? { version: engine.codexVersion.slice(0, 64) }
        : {}),
      ...(groupedNotices.size > 0
        ? {
            notices: [...groupedNotices.entries()].slice(-5).map(([message, count]) => ({
              message,
              ...(count > 1 ? { count } : {}),
            })),
          }
        : {}),
    };
  }

  private refreshCodexRuntimeMetadata(sessionId: string): Promise<void> {
    const pending = this.codexRuntimeMetadataRefreshes.get(sessionId);
    if (pending) return pending;
    const retained = this.interactiveMetadata.get(sessionId);
    const generation = this.codexRuntimeMetadataGeneration;
    const operation = (async () => {
      try {
        const response = await bridgeFetch(
          this.connection,
          `/session/${encodeURIComponent(sessionId)}/runtime-health`,
          {},
          this.fetchImpl,
        );
        assertOk(response, "Codex runtime health read");
        const runtime = this.codexRuntimeSummary(await boundedJson(
          response,
          "Codex runtime health read",
          { remaining: 512 * 1024 },
        ));
        if (!runtime) {
          throw new ProviderUnavailableError(
            "Codex runtime health read returned malformed metadata",
          );
        }
        if (generation !== this.codexRuntimeMetadataGeneration) return;
        setBoundedMapEntry(this.interactiveMetadata, sessionId, {
          expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
          runtime,
        }, MAX_TRACKED_INTERACTION_SESSIONS);
      } catch {
        // Keep known inventory usable and avoid retrying a failed optional
        // endpoint on every 500ms projection poll.
        if (
          generation === this.codexRuntimeMetadataGeneration
          && retained
          && this.interactiveMetadata.get(sessionId) === retained
        ) {
          retained.expiresAt = Date.now() + INTERACTIVE_RUNTIME_METADATA_RETRY_MS;
        }
      }
    })();
    this.codexRuntimeMetadataRefreshes.set(sessionId, operation);
    return operation.finally(() => {
      if (this.codexRuntimeMetadataRefreshes.get(sessionId) === operation) {
        this.codexRuntimeMetadataRefreshes.delete(sessionId);
      }
    });
  }

  async interactiveSnapshot(
    sessionId: string,
  ): Promise<ProviderInteractiveSnapshot> {
    if (this.agent === "cursor" || this.agent === "grok") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}`,
        {},
        this.fetchImpl,
      );
      if (response.status === 404) return { status: "missing", messages: [] };
      assertOk(response, `${this.agent} interactive snapshot`);
      const payload = asRecord(await boundedJson(
        response,
        `${this.agent} interactive snapshot`,
        { remaining: 8 * 1024 * 1024 },
      ));
      const status = payload?.status;
      const messages = payload?.messages;
      const composer = asRecord(payload?.composer);
      const providerRevision = payload?.revision;
      const providerError = payload?.error;
      if (
        (status !== "idle" && status !== "running" && status !== "error")
        || !Array.isArray(messages)
        || !Number.isSafeInteger(providerRevision)
        || !composer
        || !Array.isArray(composer.models)
        || !Array.isArray(composer.modes)
      ) {
        throw new ProviderUnavailableError(
          `${this.agent} returned a malformed interactive snapshot`,
        );
      }
      const contextUsage = normalizeProviderContextUsage(payload?.contextUsage);
      const runtime = normalizeProviderRuntimeSummary(payload?.runtime);
      return {
        status,
        messages,
        ...(typeof payload?.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        composer: composer as unknown as NativeAgentComposerState,
        providerRevision: providerRevision as number,
        ...(contextUsage ? { contextUsage } : {}),
        ...(runtime ? { runtime } : {}),
        ...(typeof providerError === "string" ? { error: providerError } : {}),
      };
    }

    const sessionPath = this.agent === "codex"
      ? `/session/${encodeURIComponent(sessionId)}/status`
      : `/session/${encodeURIComponent(sessionId)}`;
    const cachedMetadata = this.interactiveMetadata.get(sessionId);
    const refreshMetadata = !cachedMetadata || cachedMetadata.expiresAt <= Date.now();
    if (this.agent === "codex" && cachedMetadata && refreshMetadata) {
      // `/runtime-health` fans out to several app-server inventory RPCs. The
      // previous inventory remains useful while that optional refresh runs;
      // message/status/config reads below are the foreground critical path.
      void this.refreshCodexRuntimeMetadata(sessionId);
    }
    const [sessionResponse, messages, configResponse, initResponse, runtimeResponse] = await Promise.all([
      bridgeFetch(this.connection, sessionPath, {}, this.fetchImpl),
      this.messages(sessionId),
      this.agent === "codex"
        ? bridgeFetch(
            this.connection,
            `/session/${encodeURIComponent(sessionId)}/config`,
            {},
            this.fetchImpl,
          )
        : Promise.resolve(undefined),
      this.agent === "claude" && refreshMetadata
        ? bridgeFetch(
            this.connection,
            `/session/${encodeURIComponent(sessionId)}/init`,
            {},
            this.fetchImpl,
          )
        : Promise.resolve(undefined),
      this.agent === "codex" && refreshMetadata && !cachedMetadata
        ? bridgeFetch(
            this.connection,
            `/session/${encodeURIComponent(sessionId)}/runtime-health`,
            {},
            this.fetchImpl,
          )
        : Promise.resolve(undefined),
    ]);
    if (sessionResponse.status === 404) return { status: "missing", messages: [] };
    assertOk(sessionResponse, `${this.agent} interactive session read`);
    const payload = asRecord(await boundedJson(
      sessionResponse,
      `${this.agent} interactive session read`,
      { remaining: 512 * 1024 },
    ));
    const status = payload?.status;
    if (!payload || (status !== "idle" && status !== "running" && status !== "error")) {
      throw new ProviderUnavailableError(
        `${this.agent} returned a malformed interactive session`,
      );
    }
    if (this.agent === "codex") {
      if (!configResponse) {
        throw new ProviderUnavailableError("Codex interactive config response is missing");
      }
      assertOk(configResponse, "Codex interactive config read");
      const config = asRecord(await boundedJson(
        configResponse,
        "Codex interactive config read",
        { remaining: 128 * 1024 },
      ));
      const rawPhase = payload?.phase;
      let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
      if (runtimeResponse?.ok) {
        runtime = this.codexRuntimeSummary(await boundedJson(
          runtimeResponse,
          "Codex runtime health read",
          { remaining: 512 * 1024 },
        ));
      }
      if (refreshMetadata && !cachedMetadata) {
        setBoundedMapEntry(this.interactiveMetadata, sessionId, {
          expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
          ...(runtime ? { runtime } : {}),
        }, MAX_TRACKED_INTERACTION_SESSIONS);
      }
      const phase: NativeAgentTurnPhase | undefined = rawPhase === "cancelling"
        ? "cancelling"
        : rawPhase === "recovering" || rawPhase === "starting"
          ? "recovering"
          : rawPhase === "failed"
            ? "error"
            : rawPhase === "running"
              ? "running"
              : rawPhase === "idle"
                ? "idle"
                : undefined;
      return {
        status,
        messages,
        ...(typeof payload.title === "string" && payload.title.trim()
          ? { title: payload.title.trim() }
          : {}),
        controls: {
          ...(typeof config?.model === "string" ? { modelId: config.model } : {}),
          ...(typeof config?.modelReasoningEffort === "string"
            ? { reasoningId: config.modelReasoningEffort }
            : {}),
          ...(config?.mode === "build" || config?.mode === "plan"
            ? { mode: config.mode }
            : {}),
          ...(typeof config?.fastMode === "boolean"
            ? { fastMode: config.fastMode }
            : {}),
        },
        ...(phase ? { phase } : {}),
        ...(typeof payload.turnStartedAt === "string"
          && Number.isFinite(Date.parse(payload.turnStartedAt))
          ? { turnStartedAt: Date.parse(payload.turnStartedAt) }
          : {}),
        ...(Number.isSafeInteger(payload.messageRevision)
          ? { providerRevision: payload.messageRevision as number }
          : {}),
        ...(Number.isSafeInteger(payload.engineGeneration)
          ? { providerGeneration: payload.engineGeneration as number }
          : {}),
        ...(normalizeProviderContextUsage(payload.contextUsage)
          ? { contextUsage: normalizeProviderContextUsage(payload.contextUsage) }
          : {}),
        ...(runtime ? { runtime } : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      };
    }
    let executionProfiles: NativeAgentComposerState["executionProfiles"] =
      cachedMetadata?.executionProfiles;
    let runtime: NativeAgentRuntimeSummary | undefined = cachedMetadata?.runtime;
    if (initResponse?.ok) {
      const initPayload = asRecord(await boundedJson(
        initResponse,
        "Claude init read",
        { remaining: 256 * 1024 },
      ));
      const initData = asRecord(initPayload?.initData);
      runtime = {
        mcpServers: Array.isArray(initData?.mcpServers) ? initData.mcpServers.length : 0,
        plugins: Array.isArray(initData?.plugins) ? initData.plugins.length : 0,
        commands: Array.isArray(initData?.slashCommands) ? initData.slashCommands.length : 0,
      };
      if (Array.isArray(initData?.agents)) {
        executionProfiles = initData.agents.slice(0, 128).flatMap((candidate) => {
          const agent = asRecord(candidate);
          const name = nonEmptyString(agent?.name);
          if (!name) return [];
          return [{
            id: name,
            label: name,
            ...(typeof agent?.description === "string" ? { description: agent.description } : {}),
            ...(typeof agent?.model === "string" ? { modelId: agent.model } : {}),
          }];
        });
      }
    }
    if (refreshMetadata) {
      setBoundedMapEntry(this.interactiveMetadata, sessionId, {
        expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
        ...(executionProfiles ? { executionProfiles } : {}),
        ...(runtime ? { runtime } : {}),
      }, MAX_TRACKED_INTERACTION_SESSIONS);
    }
    return {
      status,
      messages,
      ...(typeof payload.title === "string" && payload.title.trim()
        ? { title: payload.title.trim() }
        : {}),
      composer: {
        ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
        ...(executionProfiles?.length ? { executionProfiles } : {}),
      },
      ...(typeof payload.planMode === "boolean"
        ? { controls: { mode: payload.planMode ? "plan" : "build" } }
        : {}),
      ...(typeof payload.turnStartedAt === "number" && Number.isFinite(payload.turnStartedAt)
        ? { turnStartedAt: payload.turnStartedAt }
        : {}),
      ...(normalizeProviderContextUsage(payload.contextUsage)
        ? { contextUsage: normalizeProviderContextUsage(payload.contextUsage) }
        : {}),
      ...(normalizeProviderRateLimits(payload.rateLimits).length > 0
        ? { rateLimits: normalizeProviderRateLimits(payload.rateLimits) }
        : {}),
      ...(runtime ? { runtime } : {}),
      ...(normalizeClaudeBackgroundTasks(payload.backgroundTasks)
        ? { backgroundTasks: normalizeClaudeBackgroundTasks(payload.backgroundTasks) }
        : {}),
      ...(typeof payload.promptSuggestion === "string"
        ? { suggestedPrompt: payload.promptSuggestion.slice(0, 4_000) }
        : {}),
      ...(typeof payload.completionBlockedByBackgroundTasks === "boolean"
        ? { completionBlockedByBackgroundTasks: payload.completionBlockedByBackgroundTasks }
        : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    };
  }

  async updateInteractiveControls(
    sessionId: string,
    update: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState | undefined> {
    if (this.agent === "claude") {
      if (update.mode === undefined) return undefined;
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/preferences`,
        {
          method: "PUT",
          body: JSON.stringify({ planMode: update.mode === "plan" }),
        },
        this.fetchImpl,
      );
      assertOk(response, "Claude session preference update");
      return undefined;
    }
    if (this.agent === "codex") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}/config`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(update.modelId ? { model: update.modelId } : {}),
            ...(update.reasoningId ? { modelReasoningEffort: update.reasoningId } : {}),
            ...(update.mode ? { mode: update.mode } : {}),
            ...(update.fastMode === undefined ? {} : { fastMode: update.fastMode }),
          }),
        },
        this.fetchImpl,
      );
      assertOk(response, "Codex session config update");
      return undefined;
    }
    if (this.agent !== "cursor" && this.agent !== "grok") return undefined;
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/config`,
      { method: "POST", body: JSON.stringify(update) },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} config update`);
    const composer = asRecord(await boundedJson(
      response,
      `${this.agent} config update`,
    ));
    if (!composer || !Array.isArray(composer.models) || !Array.isArray(composer.modes)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed composer`);
    }
    return composer as unknown as NativeAgentComposerState;
  }

  refreshCatalog(): void {
    // Execution profiles and runtime inventory are discovered alongside models,
    // so an explicit refresh has to drop them too or the picker re-renders the
    // same stale list it was asked to replace.
    this.codexRuntimeMetadataGeneration += 1;
    this.interactiveMetadata.clear();
  }

  async listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
    if (this.agent === "cursor" || this.agent === "grok") return [];
    const response = await bridgeFetch(
      this.connection,
      "/session/list",
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} resumable session list`);
    const payload = asRecord(await boundedJson(
      response,
      `${this.agent} resumable session list`,
      { remaining: 2 * 1024 * 1024 },
    ));
    if (!payload || !Array.isArray(payload.sessions)) {
      throw new ProviderUnavailableError(`${this.agent} returned a malformed session list`);
    }
    return payload.sessions.slice(0, 512).flatMap((candidate) => {
      const session = asRecord(candidate);
      const id = nonEmptyString(session?.id);
      if (!id) return [];
      const createdAt = nonEmptyString(session?.createdAt);
      const updatedAt = nonEmptyString(session?.updatedAt)
        ?? nonEmptyString(session?.lastActivity);
      const status = session?.status === "running"
        || session?.status === "error"
        || session?.status === "idle"
        ? session.status
        : undefined;
      const messageCount = Number.isSafeInteger(session?.messageCount)
        ? session!.messageCount as number
        : undefined;
      return [{
        sessionId: id,
        ...(typeof session?.title === "string" ? { title: session.title } : {}),
        ...(createdAt && Number.isFinite(Date.parse(createdAt)) ? { createdAt } : {}),
        ...(updatedAt && Number.isFinite(Date.parse(updatedAt)) ? { updatedAt } : {}),
        ...(status ? { status } : {}),
        ...(messageCount === undefined
          ? {}
          : { detail: `${messageCount} message${messageCount === 1 ? "" : "s"}` }),
      }];
    });
  }

  async slashCommands(): Promise<NativeAgentSlashCommand[]> {
    if (this.agent === "cursor" || this.agent === "grok") return [];
    const response = await bridgeFetch(
      this.connection,
      this.agent === "codex" ? "/global/slash-commands" : "/plugins/commands",
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} slash command list`);
    const payload = asRecord(await boundedJson(
      response,
      `${this.agent} slash command list`,
      { remaining: 512 * 1024 },
    ));
    const commands = new Map<string, NativeAgentSlashCommand>(
      this.agent === "claude"
        ? CLAUDE_BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command])
        : [],
    );
    if (!payload || !Array.isArray(payload.commands)) return [...commands.values()];
    for (const candidate of payload.commands.slice(0, 512)) {
      const command = typeof candidate === "string" ? { name: candidate } : asRecord(candidate);
      const rawName = nonEmptyString(command?.name);
      if (!rawName) continue;
      const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
      commands.set(name, {
        name: name.slice(0, 256),
        ...(typeof command?.description === "string"
          ? { description: command.description.slice(0, 1_000) }
          : {}),
        ...(typeof command?.argumentHint === "string"
          ? { argumentHint: command.argumentHint.slice(0, 512) }
          : {}),
      });
    }
    return [...commands.values()].slice(0, 512);
  }

  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    if (this.agent !== "claude") {
      throw new PromptRejectedError(`${this.agent} does not support background tasks`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, "Claude background task stop");
  }

  async dismissSuggestedPrompt(sessionId: string): Promise<void> {
    if (this.agent !== "claude") {
      throw new PromptRejectedError(`${this.agent} does not support prompt suggestions`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/prompt-suggestion`,
      { method: "DELETE" },
      this.fetchImpl,
    );
    if (response.status !== 404) {
      await assertOkWithErrorDetail(response, "Claude prompt suggestion dismissal");
    }
  }

  async resumeSession(
    sessionId: string,
    controls?: NativeAgentControlUpdate,
  ): Promise<string> {
    if (this.agent === "cursor" || this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session resume`);
    }
    if (this.agent === "claude") {
      const response = await bridgeFetch(
        this.connection,
        `/session/${encodeURIComponent(sessionId)}`,
        {},
        this.fetchImpl,
      );
      assertOk(response, "Claude session resume");
      return sessionId;
    }
    const response = await bridgeFetch(
      this.connection,
      "/session/resume",
      {
        method: "POST",
        body: JSON.stringify({
          threadId: sessionId,
          ...(controls?.modelId ? { model: controls.modelId } : {}),
          ...(controls?.reasoningId
            ? { modelReasoningEffort: controls.reasoningId }
            : {}),
          ...(controls?.mode ? { mode: controls.mode } : {}),
          ...(controls?.fastMode === undefined
            ? {} : { fastMode: controls.fastMode }),
        }),
      },
      this.fetchImpl,
    );
    assertOk(response, "Codex session resume");
    const payload = asRecord(await boundedJson(response, "Codex session resume"));
    const resumedId = nonEmptyString(payload?.sessionId);
    if (!resumedId) throw new ProviderUnavailableError("Codex returned a malformed resumed session");
    return resumedId;
  }

  async forkSession(
    sessionId: string,
    messageId?: string,
  ): Promise<NativeAgentForkOutcome> {
    if (this.agent === "cursor" || this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session forks`);
    }
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(this.agent === "codex"
          ? { lastMessageId: messageId }
          : { upToMessageId: messageId }),
      },
      this.fetchImpl,
    );
    await assertOkWithErrorDetail(response, `${this.agent} session fork`);
    const payload = asRecord(await boundedJson(response, `${this.agent} session fork`));
    const forkedId = nonEmptyString(payload?.sessionId);
    if (!forkedId) throw new ProviderUnavailableError(`${this.agent} returned a malformed fork`);
    return {
      sessionId: forkedId,
      ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
    };
  }

  async performSessionAction(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (this.agent === "cursor" || this.agent === "grok") {
      throw new PromptRejectedError(`${this.agent} does not support session actions`);
    }
    const base = `/session/${encodeURIComponent(sessionId)}`;
    if (action.kind === "compact") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/compact`,
        { method: "POST" },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, `${this.agent} session compaction`);
      return { outcome: "applied" };
    }
    if (this.agent === "claude" && action.kind === "rewind-files") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/rewind`,
        {
          method: "POST",
          body: JSON.stringify({ messageId: action.messageId, dryRun: action.dryRun === true }),
        },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Claude file rewind");
      return {
        outcome: "applied",
        preview: await boundedJson(response, "Claude file rewind", { remaining: 512 * 1024 }),
      };
    }
    if (this.agent === "codex" && action.kind === "review") {
      const response = await bridgeFetch(
        this.connection,
        `${base}/review`,
        { method: "POST", body: JSON.stringify({ type: "uncommittedChanges" }) },
        this.fetchImpl,
      );
      await assertOkWithErrorDetail(response, "Codex native review");
      return { outcome: "applied" };
    }
    if (this.agent === "codex" && action.kind === "steer") {
      const statusResponse = await bridgeFetch(this.connection, `${base}/status`, {}, this.fetchImpl);
      if (statusResponse.status === 404) throw new PromptRejectedError("Codex session was not found");
      await assertOkWithErrorDetail(statusResponse, "Codex steer status read");
      const status = asRecord(await boundedJson(statusResponse, "Codex steer status read"));
      if (status?.status !== "running") return { outcome: "idle" };
      const turnId = nonEmptyString(status.turnId);
      if (!turnId) return { outcome: "unknown", requestId: action.requestId };
      let response: Response;
      try {
        response = await bridgeFetch(
          this.connection,
          `${base}/steer`,
          {
            method: "POST",
            body: JSON.stringify({
              input: action.text,
              requestId: action.requestId,
              expectedTurnId: turnId,
            }),
          },
          this.fetchImpl,
        );
      } catch {
        return { outcome: "unknown", requestId: action.requestId };
      }
      const payload = asRecord(await boundedJson(response, "Codex steer response").catch(() => ({})));
      if (payload?.outcome === "unknown") return { outcome: "unknown", requestId: action.requestId };
      if (response.status === 409) return { outcome: "mismatch" };
      await assertOkWithErrorDetail(response, "Codex steer");
      return { outcome: "applied" };
    }
    throw new PromptRejectedError(`${this.agent} does not support ${action.kind}`);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/structured-output?requestId=${encodeURIComponent(requestId)}`,
      {},
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} structured-output read`);
    const body = await response.json() as { structuredOutput?: unknown };
    return (body.structuredOutput ?? null) as StructuredOutputResult<T> | null;
  }

  async abort(sessionId: string): Promise<void> {
    const response = await bridgeFetch(
      this.connection,
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
      this.fetchImpl,
    );
    assertOk(response, `${this.agent} abort`);
  }
}

function stringifyOpenCodeToolValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 200_000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 200_000);
  } catch {
    return "[unserializable tool value]";
  }
}

function openCodeRecordString(
  value: unknown,
  ...keys: string[]
): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = nonEmptyString(record[key]);
    if (candidate) return candidate.trim();
  }
  return undefined;
}

function openCodeTaskEnvelope(output: string | undefined): {
  sessionId?: string;
  state?: "running" | "completed" | "error";
} {
  if (!output) return {};
  const match = output.match(
    /<task\s+id=["']([^"']+)["'](?:\s+state=["'](running|completed|error)["'])?/i,
  );
  return match
    ? {
        sessionId: match[1],
        state: match[2]?.toLowerCase() as "running" | "completed" | "error" | undefined,
      }
    : {};
}

function collectNormalizedOpenCodeSubagentIds(
  messages: readonly Record<string, unknown>[],
): string[] {
  const ids = new Set<string>();
  const visit = (parts: unknown, depth: number) => {
    if (!Array.isArray(parts) || depth > 8) return;
    for (const candidate of parts) {
      const part = asRecord(candidate);
      if (!part) continue;
      const id = nonEmptyString(part.subagentId);
      if (part.type === "subagent" && id) ids.add(id);
      visit(part.subagentActions, depth + 1);
    }
  };
  for (const message of messages) visit(message.parts, 0);
  return [...ids];
}

function collectRawOpenCodeSubagentIds(messages: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const candidate of messages) {
    const envelope = asRecord(candidate);
    if (!Array.isArray(envelope?.parts)) continue;
    for (const rawPart of envelope.parts) {
      const part = asRecord(rawPart);
      const state = asRecord(part?.state);
      const toolName = nonEmptyString(part?.tool)?.toLowerCase();
      if (toolName !== "task" && toolName !== "agent") continue;
      const metadata = asRecord(state?.metadata) ?? asRecord(part?.metadata);
      const id = openCodeRecordString(metadata, "sessionId", "sessionID", "jobId")
        ?? openCodeTaskEnvelope(stringifyOpenCodeToolValue(state?.output)).sessionId;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function hydrateNormalizedOpenCodeSubagents(
  messages: readonly Record<string, unknown>[],
  childMessages: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): Record<string, unknown>[] {
  const countTools = (parts: readonly Record<string, unknown>[]): number =>
    parts.reduce((count, part) =>
      count
      + (part.type === "tool-invocation" ? 1 : 0)
      + (Array.isArray(part.subagentActions)
        ? countTools(part.subagentActions.flatMap((entry) => {
            const record = asRecord(entry);
            return record ? [record] : [];
          }))
        : 0), 0);
  const hydrateParts = (
    rawParts: unknown,
    ancestry: ReadonlySet<string>,
  ): Record<string, unknown>[] => {
    if (!Array.isArray(rawParts)) return [];
    return rawParts.flatMap((candidate) => {
      const part = asRecord(candidate);
      if (!part) return [];
      const id = part.type === "subagent" ? nonEmptyString(part.subagentId) : null;
      if (!id || ancestry.has(id)) return [{ ...part }];
      const transcript = childMessages.get(id);
      if (!transcript) return [{ ...part }];
      const nextAncestry = new Set(ancestry);
      nextAncestry.add(id);
      const actions = transcript.flatMap((message) =>
        message.role === "assistant"
          ? hydrateParts(message.parts, nextAncestry)
          : [],
      );
      return [{
        ...part,
        subagentActions: actions,
        subagentActionCount: countTools(actions),
      }];
    });
  };
  return messages.map((message) => ({
    ...message,
    parts: hydrateParts(message.parts, new Set()),
  }));
}

function normalizeOpenCodeInteractiveMessage(
  value: unknown,
  index: number,
): Record<string, unknown> | null {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.info);
  if (!envelope || !info) return null;
  const role = info.role === "user" || info.role === "assistant" || info.role === "system"
    ? info.role
    : "assistant";
  const messageId = nonEmptyString(info.id) ?? `opencode-message-${index}`;
  const rawCreatedAt = asRecord(info.time)?.created;
  const createdAt = typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)
    ? new Date(rawCreatedAt).toISOString()
    : typeof rawCreatedAt === "string" && Number.isFinite(Date.parse(rawCreatedAt))
      ? new Date(rawCreatedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  const parts: Record<string, unknown>[] = [];
  let content = "";
  for (const candidate of Array.isArray(envelope.parts) ? envelope.parts.slice(0, 2_048) : []) {
    const part = asRecord(candidate);
    if (!part) continue;
    const source = {
      ...(typeof part.id === "string" ? { sourcePartId: part.id } : {}),
      ...(typeof part.messageID === "string" ? { sourceMessageId: part.messageID } : {}),
    };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", content: part.text, ...source });
      content += part.text;
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      const reasoning = part.text.replace(/^\s*\*\*/, "").replace(/\*\*\s*$/, "");
      if (reasoning.trim()) parts.push({ type: "thinking", content: reasoning, ...source });
      continue;
    }
    if (part.type === "file") {
      const path = nonEmptyString(part.filename) ?? nonEmptyString(part.url) ?? "Attached file";
      parts.push({
        type: "file",
        content: path,
        ...(typeof part.url === "string" ? { fileUrl: part.url } : {}),
        ...source,
      });
      continue;
    }
    if (part.type !== "tool") continue;
    const state = asRecord(part.state);
    const toolName = nonEmptyString(part.tool) ?? "Unknown tool";
    const rawStatus = state?.status;
    const toolState = rawStatus === "completed"
      ? "success"
      : rawStatus === "error"
        ? "failure"
        : rawStatus === "pending" || rawStatus === "running"
          ? "pending"
          : undefined;
    const isSubagent = toolName.toLowerCase() === "task"
      || toolName.toLowerCase() === "agent";
    const input = asRecord(state?.input) ?? undefined;
    const toolOutput = stringifyOpenCodeToolValue(state?.output);
    const taskEnvelope = isSubagent ? openCodeTaskEnvelope(toolOutput) : {};
    const metadata = asRecord(state?.metadata) ?? asRecord(part.metadata);
    const subagentId = isSubagent
      ? openCodeRecordString(metadata, "sessionId", "sessionID", "jobId")
        ?? taskEnvelope.sessionId
      : undefined;
    const subagentName = isSubagent
      ? openCodeRecordString(input, "description")
        ?? (typeof state?.title === "string" ? state.title : toolName)
      : undefined;
    const subagentRole = isSubagent
      ? openCodeRecordString(input, "subagent_type", "agent")
      : undefined;
    const subagentPrompt = isSubagent
      ? openCodeRecordString(input, "prompt")
      : undefined;
    const normalizedToolState = taskEnvelope.state === "running"
      ? "pending"
      : taskEnvelope.state === "completed"
        ? "success"
        : taskEnvelope.state === "error" ? "failure" : toolState;
    parts.push({
      type: isSubagent ? "subagent" : "tool-invocation",
      content: typeof state?.title === "string" ? state.title : toolName,
      toolName,
      ...(input ? { toolArgs: input } : {}),
      ...(normalizedToolState ? { toolState: normalizedToolState } : {}),
      ...(typeof state?.title === "string" ? { toolTitle: state.title } : {}),
      ...(toolOutput === undefined ? {} : { toolOutput }),
      ...(state?.error === undefined
        ? {} : { toolError: stringifyOpenCodeToolValue(state.error) }),
      ...(isSubagent ? {
        ...(subagentId ? { subagentId } : {}),
        ...(subagentName ? { subagentName } : {}),
        ...(subagentRole ? { subagentRole } : {}),
        ...(subagentPrompt ? { subagentPrompt } : {}),
        subagentActions: [],
        subagentActionCount: 0,
      } : {}),
      ...source,
    });
  }
  const providerId = nonEmptyString(info.providerID);
  const modelId = nonEmptyString(info.modelID);
  return {
    id: messageId,
    role,
    content,
    parts,
    createdAt,
    ...(role === "assistant" && modelId
      ? { modelId: providerId ? `${providerId}/${modelId}` : modelId }
      : {}),
  };
}

function normalizeOpenCodeTerminalState(value: unknown): {
  kind: "error" | "stopped";
  message: string;
} | null {
  const info = asRecord(asRecord(value)?.info);
  if (!info || info.error === undefined || info.error === null) return null;
  const error = asRecord(info.error);
  const name = nonEmptyString(error?.name);
  if (name === "MessageAbortedError") {
    return { kind: "stopped", message: "Query stopped by user." };
  }
  const data = asRecord(error?.data);
  const detail = typeof info.error === "string"
    ? info.error
    : nonEmptyString(data?.message)
      ?? nonEmptyString(error?.message)
      ?? name
      ?? "OpenCode session failed";
  return {
    kind: "error",
    message: boundedText(detail, "OpenCode session failed"),
  };
}

class OpenCodeProvider implements BuildPipelineProvider {
  readonly agent = "opencode" as const;
  private readonly client: OpencodeClient;
  private readonly messageIds: OpenCodeMessageIdCoordinator;
  private readonly interactionTracker = new InteractionSnapshotTracker();
  private readonly providerInteractionIds = new Map<
    string,
    { providerRequestId: string; sessionId: string; actionable?: boolean }
  >();
  private readonly resolvingInteractions = new Set<string>();
  readonly interactions: AgentInteractionProviderCapability = {
    listPendingInteractions: (sessionId) => this.listPendingInteractions(sessionId),
    resolveInteraction: (sessionId, interactionId, resolution) =>
      this.resolveInteraction(sessionId, interactionId, resolution),
  };
  private readonly ownedSessions = new Set<string>();
  private readonly blockedSessions = new Set<string>();
  private readonly failedQuestionSessions = new Set<string>();
  private readonly monitorController = new AbortController();
  private readonly monitorRetryMs: number;
  private readonly now: () => number;
  private readonly existenceCacheTtlMs: number;
  private readonly sessionExistenceCache = new Map<string, number>();
  private readonly sessionExistenceRetryAt = new Map<string, number>();
  private readonly interactiveMetadata = new Map<string, {
    expiresAt: number;
    /** This entry embeds a filtered catalogue, so it carries the same allowlist
     * key as `catalogMetadata`. Without it a composer read served from this
     * cache would keep the pre-edit catalogue for a whole TTL. */
    providersKey: string;
    executionProfiles: NonNullable<NativeAgentComposerState["executionProfiles"]>;
    runtime: NativeAgentRuntimeSummary;
    models: AgentModel[];
    selectedModelId?: string;
    selectedReasoningId?: string;
    title?: string;
    shareUrl?: string | null;
  }>();
  private catalogMetadata: {
    expiresAt: number;
    /** The allowlist this catalogue was filtered against; a settings edit
     * changes it and must not be served a stale, differently-filtered list. */
    providersKey: string;
    catalog: ReturnType<typeof normalizeOpenCodeComposerCatalog>;
  } | null = null;
  private commandNames: { names: Set<string>; expiresAt: number } | null = null;
  private sessionListCache: {
    snapshot: OpenCodeExistenceSnapshot;
    expiresAt: number;
  } | null = null;
  private sessionListFailure: { error: unknown; expiresAt: number } | null = null;
  private sessionListRead: Promise<OpenCodeExistenceSnapshot> | null = null;
  private existenceProbeCursor = 0;
  private readonly answeringRequestIds = new Set<string>();
  private readonly requestTasks = new Set<Promise<void>>();
  private activeStreamController: AbortController | null = null;
  private reconciliation: Promise<void> | null = null;
  private monitorPromise: Promise<void>;
  private disposed = false;
  private readonly autoAnswerRequests: boolean;
  private readonly onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;
  private readonly resolveOpenCodeModelProviders?: () =>
    | readonly string[]
    | undefined
    | Promise<readonly string[] | undefined>;

  constructor(
    private readonly connection: BridgeConnection,
    dependencies: ProviderDependencies,
  ) {
    const basic = Buffer.from(`opencode:${connection.authToken}`).toString("base64");
    const createClient = dependencies.openCodeClientFactory ?? createOpencodeClient;
    this.client = dependencies.openCodeClient ?? createClient({
      baseUrl: connection.baseUrl,
      directory: connection.directory,
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Orkestrator-OpenCode-Token": connection.authToken,
      },
    });
    this.messageIds = dependencies.openCodeMessageIdCoordinator
      ?? defaultOpenCodeMessageIds;
    this.monitorRetryMs = Math.max(
      1,
      dependencies.monitorRetryMs ?? DEFAULT_MONITOR_RETRY_MS,
    );
    this.now = dependencies.now ?? Date.now;
    this.existenceCacheTtlMs = Math.max(
      1,
      dependencies.openCodeExistenceCacheTtlMs
        ?? DEFAULT_OPENCODE_EXISTENCE_CACHE_TTL_MS,
    );
    this.autoAnswerRequests = dependencies.autoAnswerRequests === true;
    this.onInteractionObservation = dependencies.onInteractionObservation;
    this.resolveOpenCodeModelProviders = dependencies.resolveOpenCodeModelProviders;
    // An interactive provider has nothing to monitor: every request belongs to a
    // tab that will answer it. Subscribing anyway would open a permanent event
    // stream per provider for no consumer.
    this.monitorPromise = this.autoAnswerRequests
      ? this.monitorRequests()
      : Promise.resolve();
  }

  registerSession(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void {
    this.ownedSessions.add(sessionId);
    this.interactionTracker.register(sessionId, interaction);
    if (!this.autoAnswerRequests) return;
    const activeReconciliation = this.reconciliation;
    const reconciliation = activeReconciliation
      ? activeReconciliation
          .catch(() => undefined)
          .then(() => this.reconcilePendingRequests())
      : this.reconcilePendingRequests();
    void reconciliation.catch(() => {
      // The reconnect loop will try again. Registration must stay synchronous
      // so restoring a pipeline does not block on an external service.
    });
  }

  private async optionalSdkCall(
    namespace: string,
    method: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    const owner = asRecord(asRecord(this.client)?.[namespace]);
    const operation = owner?.[method];
    if (typeof operation !== "function") return { data: {} };
    return (operation as (
      parameters: Record<string, unknown>,
      options: unknown,
    ) => Promise<unknown>).call(owner, parameters, this.requestOptions());
  }

  private async readComposerCatalog(
    allowedProviders: readonly string[],
  ): Promise<
    ReturnType<typeof normalizeOpenCodeComposerCatalog>
  > {
    const providersKey = openCodeModelProvidersKey(allowedProviders);
    if (
      this.catalogMetadata
      && this.catalogMetadata.expiresAt > Date.now()
      && this.catalogMetadata.providersKey === providersKey
    ) {
      return this.catalogMetadata.catalog;
    }
    const [providerResult, fallbackResult] = await Promise.allSettled([
      this.optionalSdkCall("provider", "list", {}),
      this.optionalSdkCall("config", "providers", {}),
    ]);
    const payload = (result: PromiseSettledResult<unknown>): unknown =>
      result.status === "fulfilled" ? asRecord(result.value)?.data ?? {} : {};
    const live = normalizeOpenCodeComposerCatalog(
      payload(providerResult),
      allowedProviders,
    );
    const catalog = live.models.length > 0
      ? live
      : normalizeOpenCodeComposerCatalog(
          payload(fallbackResult),
          allowedProviders,
        );
    this.catalogMetadata = {
      expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
      providersKey,
      catalog,
    };
    return catalog;
  }

  /**
   * The configured allowlist, or the managed default when config is
   * unavailable. A failed read must not widen the catalogue to every provider.
   */
  private async openCodeModelProviders(): Promise<readonly string[]> {
    if (!this.resolveOpenCodeModelProviders) {
      return DEFAULT_OPENCODE_MODEL_PROVIDERS;
    }
    try {
      return normalizeOpenCodeModelProviders(
        await this.resolveOpenCodeModelProviders(),
      );
    } catch {
      return DEFAULT_OPENCODE_MODEL_PROVIDERS;
    }
  }

  async modelCatalog(): Promise<AgentModel[]> {
    return (await this.readComposerCatalog(
      await this.openCodeModelProviders(),
    )).models;
  }

  async rawModelCatalog(): Promise<AgentModel[]> {
    // The empty allowlist has the documented provider-filter meaning of
    // unrestricted, while `normalizeOpenCodeComposerCatalog` still enforces
    // its provider/model bounds before this reaches persistent storage.
    return (await this.readComposerCatalog([])).models;
  }

  private async monitorRequests(): Promise<void> {
    while (!this.disposed) {
      try {
        await this.reconcilePendingRequests();
        const streamController = new AbortController();
        this.activeStreamController = streamController;
        const response = await this.client.event.subscribe(
          { directory: this.connection.directory },
          {
            signal: AbortSignal.any([
              this.monitorController.signal,
              streamController.signal,
            ]),
          },
        );
        if (!response || !("stream" in response)) {
          throw new Error("OpenCode returned no event stream");
        }
        for await (const raw of response.stream as AsyncIterable<unknown>) {
          if (this.disposed) return;
          this.dispatchRequest(raw);
        }
        if (this.activeStreamController === streamController) {
          this.activeStreamController = null;
        }
      } catch (error) {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[build-pipeline] OpenCode request monitor reconnecting:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      }
      try {
        await waitForRetry(this.monitorRetryMs, this.monitorController.signal);
      } catch {
        return;
      }
    }
  }

  private dispatchRequest(raw: unknown): void {
    if (this.requestTasks.size >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      // Force snapshot reconciliation instead of silently dropping an
      // authoritative request event when the bounded worker set is full.
      console.warn("[build-pipeline] OpenCode request worker limit reached");
      this.activeStreamController?.abort();
      return;
    }
    const task = this.handleRequest(raw)
      .catch((error) => {
        if (this.disposed || this.monitorController.signal.aborted) return;
        console.warn(
          "[build-pipeline] OpenCode request handling failed:",
          error instanceof Error ? error.name : "unknown error",
        );
        this.activeStreamController?.abort();
      })
      .finally(() => {
        this.requestTasks.delete(task);
      });
    this.requestTasks.add(task);
  }

  private async handleRequest(raw: unknown): Promise<void> {
    const event = raw && typeof raw === "object"
      ? raw as { type?: unknown; properties?: Record<string, unknown> }
      : {};
    const properties = event.properties ?? {};
    const requestId = typeof properties.id === "string"
      ? properties.id
      : undefined;
    const sessionId = typeof properties.sessionID === "string"
      ? properties.sessionID
      : undefined;
    if (!sessionId || !this.ownedSessions.has(sessionId)) return;
    if (requestId && requestId.length > AGENT_INTERACTION_LIMITS.maxIdLength) return;

    const observedKind: AgentInteractionKind | null = event.type === "permission.asked"
      ? "permission"
      : event.type === "question.asked"
        ? "question"
        : null;

    const observe = async (
      state: ProviderInteractionObservationEvent["state"],
      providerState?: ProviderInteractionObservationEvent["providerState"],
    ): Promise<void> => {
      if (!requestId || !observedKind) return;
      await this.onInteractionObservation?.({
        sessionId,
        interactionId: requestId,
        kind: observedKind,
        registration: this.interactionTracker.registration(sessionId),
        state,
        providerState,
      });
    };

    // An answered question releases the session. A rejected question is no
    // longer pending/user-resolvable, so it is terminal for an unattended
    // pipeline rather than a permanent `blocked` state that the supervisor
    // would park forever.
    if (event.type === "question.replied") {
      this.blockedSessions.delete(sessionId);
      this.failedQuestionSessions.delete(sessionId);
      return;
    }
    if (event.type === "question.rejected") {
      this.blockedSessions.delete(sessionId);
      setBoundedSetEntry(
        this.failedQuestionSessions,
        sessionId,
        MAX_TRACKED_INTERACTION_SESSIONS,
      );
      return;
    }
    if (!this.autoAnswerRequests) return;
    if (!requestId || this.answeringRequestIds.has(requestId)) return;

    this.answeringRequestIds.add(requestId);
    try {
      if (event.type === "permission.asked") {
        await observe("detected").catch(() => undefined);
        const response = await this.client.permission.reply({
          requestID: requestId,
          directory: this.connection.directory,
          reply: "reject",
        }, this.requestOptions());
        assertSdkResponse(response, "OpenCode permission response");
        await observe("withdrawn", "error").catch(() => undefined);
      } else if (event.type === "question.asked") {
        // The owner persists the fail-closed terminal outcome before the
        // upstream question is removed. If persistence fails, leave the
        // request pending so a restart cannot silently advance the workflow.
        this.blockedSessions.add(sessionId);
        await observe("detected");
        try {
          const response = await this.client.question.reject({
            requestID: requestId,
            directory: this.connection.directory,
          }, this.requestOptions());
          assertSdkResponse(response, "OpenCode question rejection");
          this.blockedSessions.delete(sessionId);
          setBoundedSetEntry(
            this.failedQuestionSessions,
            sessionId,
            MAX_TRACKED_INTERACTION_SESSIONS,
          );
          await observe("withdrawn", "error").catch(() => undefined);
        } catch (error) {
          // The request may still be live and user-resolvable. Keep it blocked;
          // the reconnect/reconciliation loop will retry the fail-closed reject.
          throw error;
        }
      }
    } finally {
      this.answeringRequestIds.delete(requestId);
    }
  }

  private async reconcilePendingRequests(): Promise<void> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcilePendingRequestsNow()
        .finally(() => {
          this.reconciliation = null;
        });
    }
    return this.reconciliation;
  }

  private async reconcilePendingRequestsNow(): Promise<void> {
    if (this.disposed || this.ownedSessions.size === 0) return;
    const [permissions, questions] = await Promise.all([
      this.client.permission.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
      this.client.question.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
    ]);
    assertSdkResponse(permissions, "OpenCode pending permission read");
    assertSdkResponse(questions, "OpenCode pending question read");
    const pendingPermissions = boundedOwnedOpenCodeCollection(
      permissions.data,
      this.ownedSessions,
      "OpenCode pending permission read",
    );
    const pendingQuestions = boundedOwnedOpenCodeCollection(
      questions.data,
      this.ownedSessions,
      "OpenCode pending question read",
    );
    if (
      serializedByteLength([pendingPermissions, pendingQuestions])
        > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
    ) {
      throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
    }
    for (const request of pendingPermissions) {
      await this.handleRequest({ type: "permission.asked", properties: request });
    }
    for (const request of pendingQuestions) {
      await this.handleRequest({ type: "question.asked", properties: request });
    }
  }

  async createSession(
    _phase: PipelineSessionPhase,
    label: string,
    _options: ProviderCreateSessionOptions = {},
  ): Promise<string> {
    try {
      const response = await this.client.session.create(
        { title: label },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode session creation");
      if (!response.data?.id) throw new Error("OpenCode returned an empty session");
      this.rememberExistingSession(response.data.id);
      this.registerSession(response.data.id, _options.interaction);
      return response.data.id;
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode session creation is unavailable", {
        cause: error,
      });
    }
  }

  async send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void> {
    const shapedPrompt = options.schema
      ? openCodeStructuredPrompt(prompt, options.schema)
      : prompt;
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: shapedPrompt }];
    // OpenCode accepts inline data, so its images need no staging. Attachments
    // that arrive already staged are referenced by path instead.
    for (const image of options.images ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(image.filename),
        filename: image.filename,
        url: `data:${mimeTypeForFilename(image.filename)};base64,${image.data}`,
      });
    }
    for (const attachment of options.attachments ?? []) {
      parts.push({
        type: "file",
        mime: mimeTypeForFilename(attachment.filename ?? attachment.path),
        filename: attachment.filename,
        url: promptAttachmentUrl(attachment),
      });
    }
    const modelParts = (options.model ?? this.connection.model)?.split("/");
    // A submission that names one of OpenCode's commands runs as that command
    // rather than as prompt text the model has to interpret. Only interactive
    // dispatch opts in: a workflow prompt that happens to start with a slash
    // must keep reaching the model verbatim.
    const command = options.allowProviderCommands
      ? await this.resolveProviderCommand(shapedPrompt)
      : null;
    // Validate before any provider I/O. A local failure is definitive and must
    // not be retried as though the prompt might have reached OpenCode.
    openCodeRequestMarker(options.requestId);
    const scope = openCodeMessageIdScope(this.connection, sessionId);
    await this.messageIds.runExclusive(scope, async () => {
      // The bounded newest transcript recovers an accepted ambiguous dispatch
      // after a restart. In-memory reservations cover the gap before OpenCode
      // materializes a just-accepted user message.
      let history: readonly unknown[];
      try {
        const historyResponse = await this.client.session.messages(
          { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
          this.requestOptions(),
        );
        assertSdkResponse(historyResponse, "OpenCode pre-dispatch transcript read");
        history = boundedOpenCodeMessageHistory(historyResponse.data);
      } catch (error) {
        throw new ProviderUnavailableError(
          "OpenCode pre-dispatch transcript is unavailable",
          { cause: error },
        );
      }
      const messageID = this.messageIds.resolve(
        scope,
        history,
        options.requestId,
      );
      let response;
      try {
        response = command
          ? await this.client.session.command({
            sessionID: sessionId,
            directory: this.connection.directory,
            messageID,
            command: command.name.replace(/^\//, ""),
            // `arguments` is a *required* field on the server's command request
            // body, so a bare `/init` must still send an empty string. Passing
            // `undefined` drops the key in `JSON.stringify` and the server
            // answers 400, which the caller reads as a failed dispatch.
            arguments: command.arguments ?? "",
            model: options.model ?? this.connection.model,
            agent: options.executionAgent ?? options.mode,
            variant: options.effort ?? this.connection.effort,
            // Text became the command name and its arguments; only the files
            // survive as parts.
            parts: parts.filter((part) => part.type === "file") as never,
          }, this.requestOptions())
          : await this.client.session.promptAsync({
            sessionID: sessionId,
            directory: this.connection.directory,
            messageID,
            parts: parts as never,
            model: modelParts && modelParts.length > 1
              ? { providerID: modelParts[0]!, modelID: modelParts.slice(1).join("/") }
              : undefined,
            agent: options.executionAgent ?? options.mode ?? "build",
            variant: options.effort ?? this.connection.effort,
          }, this.requestOptions());
      } catch (error) {
        // The request may have reached OpenCode before the response was lost.
        // The reservation keeps the same ID until transcript reconciliation.
        throw new AmbiguousPromptDispatchError(
          "OpenCode prompt dispatch outcome is unknown",
          { cause: error },
        );
      }
      if ("error" in response && response.error) {
        const status = response.response?.status;
        if (
          status === 404
          || status === 409
          || (status !== undefined && isTransientHttpStatus(status))
        ) {
          throw new ProviderUnavailableError(
            `OpenCode prompt dispatch is temporarily unavailable (HTTP ${status})`,
          );
        }
        throw new PromptRejectedError("OpenCode rejected the prompt");
      }
      this.messageIds.markAccepted(scope, options.requestId);
    });
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    if (this.blockedSessions.has(sessionId)) return "blocked";
    if (this.failedQuestionSessions.has(sessionId)) return "error";
    try {
      const lifecycle = (
        await this.readSessionLifecycle([sessionId], false, true)
      ).get(sessionId);
      if (!lifecycle) {
        throw new Error(`OpenCode lifecycle snapshot omitted ${sessionId}`);
      }
      if (lifecycle === "running") return "running";
      if (lifecycle === "idle" || lifecycle === "missing") return lifecycle;
      return "error";
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode status is unavailable", {
        cause: error,
      });
    }
  }

  async activity(sessionId: string): Promise<ProviderActivityState> {
    const activity = await this.activityBatch([sessionId]);
    const state = activity.get(sessionId);
    // `activityBatch` answers for every id it is given, so a gap is a broken
    // provider rather than a missing session. Defaulting to `missing` here
    // would turn that bug into a deleted session mapping.
    if (!state) {
      throw new ProviderUnavailableError(
        `OpenCode activity snapshot omitted ${sessionId}`,
      );
    }
    return state;
  }

  async activityBatch(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>> {
    try {
      const activity = new Map<string, ProviderActivityState>();
      const sessionIdsToRead = [...new Set(sessionIds)].filter((sessionId) => {
        if (!this.blockedSessions.has(sessionId)) return true;
        // A blocked session asked a question this provider will not answer, so
        // it is parked on a human. `status()` calls that `error` because a
        // pipeline must stop advancing on it; for the sidebar the honest
        // answer is `waiting`. `idle` is the one answer that is certainly
        // wrong — it retires the indicator on a turn nobody has resolved.
        activity.set(sessionId, "waiting");
        return false;
      });
      if (sessionIdsToRead.length === 0) return activity;

      const lifecycle = await this.readSessionLifecycle(sessionIdsToRead, true);

      const runningSessionIds = new Set<string>();
      for (const sessionId of sessionIdsToRead) {
        const state = lifecycle.get(sessionId);
        if (state === "missing") {
          activity.set(sessionId, "missing");
        } else if (state === "running") {
          runningSessionIds.add(sessionId);
        } else if (state) {
          activity.set(sessionId, "idle");
        } else {
          throw new ProviderUnavailableError(
            `OpenCode lifecycle snapshot omitted ${sessionId}`,
          );
        }
      }
      if (runningSessionIds.size === 0) return activity;

      const [questions, permissions] = await Promise.all([
        this.client.question.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questions, "OpenCode pending question read");
      assertSdkResponse(permissions, "OpenCode pending permission read");
      const pendingQuestions = boundedOwnedOpenCodeCollection(
        questions.data,
        runningSessionIds,
        "OpenCode pending question read",
      );
      const pendingPermissions = boundedOwnedOpenCodeCollection(
        permissions.data,
        runningSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([pendingQuestions, pendingPermissions])
          > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      const waitingSessionIds = new Set<string>();
      for (const request of [
        ...pendingQuestions,
        ...pendingPermissions,
      ]) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          continue;
        }
        const sessionId = (request as { sessionID?: unknown }).sessionID;
        if (typeof sessionId === "string" && runningSessionIds.has(sessionId)) {
          waitingSessionIds.add(sessionId);
        }
      }
      for (const sessionId of runningSessionIds) {
        activity.set(
          sessionId,
          waitingSessionIds.has(sessionId) ? "waiting" : "working",
        );
      }
      return activity;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode activity is unavailable", {
        cause: error,
      });
    }
  }

  /**
   * Combine OpenCode's incremental activity map with bounded, authoritative
   * existence reads for entries the activity map omits.
   *
   * A short-lived session-list snapshot is the cheap common path. OpenCode's
   * `start` query is a timestamp lower bound, not an offset, so a full page
   * cannot be paginated. Targets unresolved by that page are probed directly
   * with session.get instead; only a direct 404 may manufacture `missing`.
   */
  private async readSessionLifecycle(
    sessionIds: readonly string[],
    tolerateExistenceFailure = false,
    strongExistenceRead = false,
  ): Promise<Map<string, OpenCodeSessionLifecycleState>> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    for (const sessionId of uniqueSessionIds) {
      if (
        sessionId.length === 0
        || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      ) {
        throw new ProviderUnavailableError(
          "OpenCode lifecycle read contains a malformed identity",
        );
      }
    }
    const lifecycle = new Map<string, OpenCodeSessionLifecycleState>();
    if (uniqueSessionIds.length === 0) return lifecycle;

    const statusResponse = await this.client.session.status(
      { directory: this.connection.directory },
      this.requestOptions(),
    );
    assertSdkResponse(statusResponse, "OpenCode status read");
    const statusSnapshot = boundedOpenCodeStatusSnapshot(
      statusResponse.data,
      new Set(uniqueSessionIds),
    );
    const omittedSessionIds: string[] = [];
    for (const sessionId of uniqueSessionIds) {
      const status = statusSnapshot[sessionId];
      if (!status) {
        omittedSessionIds.push(sessionId);
      } else if (status.type === "busy" || status.type === "retry") {
        lifecycle.set(sessionId, "running");
      } else if (status.type === "idle") {
        lifecycle.set(sessionId, "idle");
      } else {
        lifecycle.set(sessionId, "unknown");
      }
    }
    if (omittedSessionIds.length === 0) return lifecycle;

    const existence = await this.resolveSessionExistence(
      omittedSessionIds,
      strongExistenceRead,
    );
    for (const sessionId of omittedSessionIds) {
      const probe = existence.get(sessionId);
      if (probe?.state === "exists") {
        lifecycle.set(sessionId, "idle");
      } else if (probe?.state === "missing") {
        lifecycle.set(sessionId, "missing");
      } else if (tolerateExistenceFailure) {
        // An omitted status-map entry is not running. When existence cannot be
        // confirmed, retaining the durable mapping as idle is safer than
        // dropping it or withholding already-resolved busy sessions.
        lifecycle.set(sessionId, "unknown");
      } else {
        throw new ProviderUnavailableError(
          `OpenCode session existence is unavailable for ${sessionId}`,
          { cause: probe?.error },
        );
      }
    }
    return lifecycle;
  }

  private async resolveSessionExistence(
    sessionIds: readonly string[],
    strong: boolean,
  ): Promise<Map<string, OpenCodeExistenceProbe>> {
    const result = new Map<string, OpenCodeExistenceProbe>();
    const unresolved: string[] = [];
    const now = this.now();
    for (const sessionId of sessionIds) {
      if (strong) {
        unresolved.push(sessionId);
        continue;
      }
      const cached = this.sessionExistenceCache.get(sessionId);
      if (cached !== undefined && cached > now) {
        result.set(sessionId, { state: "exists" });
      } else if ((this.sessionExistenceRetryAt.get(sessionId) ?? 0) > now) {
        result.set(sessionId, { state: "unknown" });
      } else {
        if (cached !== undefined) this.sessionExistenceCache.delete(sessionId);
        this.sessionExistenceRetryAt.delete(sessionId);
        unresolved.push(sessionId);
      }
    }
    if (unresolved.length === 0) return result;

    let directlyProbed = unresolved;
    if (!strong) {
      try {
        const snapshot = await this.readCachedSessionList();
        directlyProbed = [];
        for (const sessionId of unresolved) {
          if (snapshot.sessionIds.has(sessionId)) {
            this.rememberExistingSession(sessionId);
            result.set(sessionId, { state: "exists" });
          } else {
            directlyProbed.push(sessionId);
          }
        }
      } catch {
        // A directory-wide optimization failing says nothing about any one
        // target. Exact reads below remain authoritative and isolated.
      }
    }

    const probeCount = strong
      ? directlyProbed.length
      : Math.min(OPENCODE_EXISTENCE_PROBE_CONCURRENCY, directlyProbed.length);
    const probeStart = directlyProbed.length === 0
      ? 0
      : this.existenceProbeCursor % directlyProbed.length;
    const scheduledProbes = Array.from(
      { length: probeCount },
      (_, index) => directlyProbed[(probeStart + index) % directlyProbed.length]!,
    );
    if (!strong && directlyProbed.length > 0) {
      this.existenceProbeCursor = (probeStart + probeCount) % directlyProbed.length;
      const scheduled = new Set(scheduledProbes);
      for (const sessionId of directlyProbed) {
        if (!scheduled.has(sessionId)) result.set(sessionId, { state: "unknown" });
      }
    }

    let nextSession = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const sessionId = scheduledProbes[nextSession++];
        if (!sessionId) return;
        const probe = await this.probeSessionExistence(sessionId);
        if (!strong && probe.state === "unknown") {
          setBoundedMapEntry(
            this.sessionExistenceRetryAt,
            sessionId,
            this.now() + this.existenceCacheTtlMs,
            MAX_TRACKED_PROVIDER_INTERACTIONS,
          );
        }
        result.set(sessionId, probe);
      }
    };
    await Promise.all(Array.from(
      {
        length: Math.min(
          OPENCODE_EXISTENCE_PROBE_CONCURRENCY,
          scheduledProbes.length,
        ),
      },
      () => worker(),
    ));
    return result;
  }

  private async readCachedSessionList(): Promise<OpenCodeExistenceSnapshot> {
    const now = this.now();
    if (this.sessionListCache && this.sessionListCache.expiresAt > now) {
      return this.sessionListCache.snapshot;
    }
    if (this.sessionListFailure && this.sessionListFailure.expiresAt > now) {
      throw this.sessionListFailure.error;
    }
    if (this.sessionListRead) return this.sessionListRead;

    const read = (async () => {
      try {
        const response = await this.client.session.list(
          {
            directory: this.connection.directory,
            limit: MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS,
          },
          this.requestOptions(),
        );
        assertSdkResponse(response, "OpenCode session list");
        const snapshot = boundedOpenCodeExistenceSnapshot(response.data);
        this.sessionListCache = {
          snapshot,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        this.sessionListFailure = null;
        return snapshot;
      } catch (error) {
        this.sessionListFailure = {
          error,
          expiresAt: this.now() + this.existenceCacheTtlMs,
        };
        throw error;
      }
    })().finally(() => {
      if (this.sessionListRead === read) this.sessionListRead = null;
    });
    this.sessionListRead = read;
    return read;
  }

  private async probeSessionExistence(
    sessionId: string,
  ): Promise<OpenCodeExistenceProbe> {
    try {
      const response = await this.client.session.get(
        { sessionID: sessionId, directory: this.connection.directory },
        this.requestOptions(),
      );
      if (response.error) {
        if (response.response?.status === 404) {
          this.sessionExistenceCache.delete(sessionId);
          this.sessionExistenceRetryAt.delete(sessionId);
          this.sessionListCache?.snapshot.sessionIds.delete(sessionId);
          return { state: "missing" };
        }
        assertSdkResponse(response, "OpenCode session existence read");
      }
      const session = asRecord(response.data);
      if (
        nonEmptyString(session?.id) !== sessionId
        || (
          this.connection.directory !== undefined
          && nonEmptyString(session?.directory) !== this.connection.directory
        )
        || serializedByteLength(response.data) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
      ) {
        throw new ProviderUnavailableError(
          "OpenCode session existence read is malformed or oversized",
        );
      }
      this.rememberExistingSession(sessionId);
      return { state: "exists" };
    } catch (error) {
      return { state: "unknown", error };
    }
  }

  private rememberExistingSession(sessionId: string): void {
    setBoundedMapEntry(
      this.sessionExistenceCache,
      sessionId,
      this.now() + this.existenceCacheTtlMs,
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    this.sessionExistenceRetryAt.delete(sessionId);
  }

  private openCodeInteractionId(
    sessionId: string,
    category: "question" | "permission",
    id: string,
  ): string {
    const interactionId = `opencode:${category}:${encodeURIComponent(sessionId)}:${id}`;
    if (interactionId.length > AGENT_INTERACTION_LIMITS.maxIdLength) {
      throw new ProviderUnavailableError(
        "OpenCode returned an oversized interaction identity",
      );
    }
    return interactionId;
  }

  private mapOpenCodeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    const questions = request?.questions;
    if (
      !providerRequestId
      || rawSessionId !== sessionId
      || !Array.isArray(questions)
      || questions.length === 0
      || questions.length > AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    ) {
      throw new ProviderUnavailableError("OpenCode returned a malformed question request");
    }
    const presentationQuestions: AgentInteractionQuestion[] = questions.map(
      (entry, questionIndex) => {
        const question = asRecord(entry);
        const options = question?.options;
        const prompt = nonEmptyString(question?.question);
        if (
          !question
          || !prompt
          || !Array.isArray(options)
          || options.length > AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
        ) {
          throw new ProviderUnavailableError("OpenCode returned a malformed question request");
        }
        return {
          id: `q${questionIndex}`,
          prompt: boundedText(prompt, prompt),
          description: nonEmptyString(question.header) ?? undefined,
          required: true,
          multiple: question.multiple === true,
          secret: false,
          allowFreeText: question.custom !== false,
          options: options.map((entry, optionIndex) => {
            const option = asRecord(entry);
            const label = nonEmptyString(option?.label);
            if (!option || !label) {
              throw new ProviderUnavailableError(
                "OpenCode returned a malformed question option",
              );
            }
            return {
              id: opaqueOptionId(questionIndex, optionIndex),
              label: boundedText(label, label),
              providerValue: boundedText(
                label,
                label,
                AGENT_INTERACTION_LIMITS.maxProviderValueLength,
              ),
              description: nonEmptyString(option?.description) ?? undefined,
            };
          }),
        };
      },
    );
    const id = this.openCodeInteractionId(sessionId, "question", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable: true },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "question",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: { title: "OpenCode needs input", questions: presentationQuestions },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapOpenCodePermission(sessionId: string, raw: unknown): AgentInteractionRequest {
    const request = asRecord(raw);
    const providerRequestId = nonEmptyString(request?.id);
    const rawSessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    const permission = nonEmptyString(request?.permission)
      ?? nonEmptyString(request?.action);
    const patterns = boundedStringArray(request?.patterns, "permission patterns");
    const alwaysPatterns = request?.always === undefined
      ? []
      : boundedStringArray(request.always, "permission always patterns");
    if (!providerRequestId || rawSessionId !== sessionId || !permission) {
      throw new ProviderUnavailableError("OpenCode returned a malformed permission request");
    }
    const actionable = patterns.length > 0;
    const id = this.openCodeInteractionId(sessionId, "permission", providerRequestId);
    setBoundedMapEntry(
      this.providerInteractionIds,
      id,
      { providerRequestId, sessionId, actionable },
      MAX_TRACKED_PROVIDER_INTERACTIONS,
    );
    const createdAt = this.interactionTracker.firstSeen(id);
    return {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      id,
      provider: "opencode",
      kind: "permission",
      origin: this.interactionTracker.registration(sessionId).origin,
      sessionId,
      state: "pending",
      revision: 0,
      presentation: {
        title: "Approve OpenCode permission",
        body: boundedJoinedText([
          `Permission: ${boundedText(permission, "Permission requested")}`,
          ...patterns.map((pattern) => `Resource: ${pattern}`),
          ...(!actionable ? ["Permission is missing its resource scope."] : []),
        ]),
        questions: [],
        confirmLabel: "Approve once",
        ...(actionable && alwaysPatterns.length > 0
          ? { approveForSessionLabel: "Always allow" }
          : {}),
        declineLabel: "Deny",
      },
      createdAt,
      updatedAt: createdAt,
    };
  }

  private async listPendingInteractions(
    sessionId: string,
  ): Promise<AgentInteractionSnapshot> {
    try {
      const [questionsResponse, permissionsResponse] = await Promise.all([
        this.client.question.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
        this.client.permission.list(
          { directory: this.connection.directory },
          this.requestOptions(),
        ),
      ]);
      assertSdkResponse(questionsResponse, "OpenCode pending question read");
      assertSdkResponse(permissionsResponse, "OpenCode pending permission read");
      const ownedSessionIds = new Set([sessionId]);
      const questions = boundedOwnedOpenCodeCollection(
        questionsResponse.data,
        ownedSessionIds,
        "OpenCode pending question read",
      );
      const permissions = boundedOwnedOpenCodeCollection(
        permissionsResponse.data,
        ownedSessionIds,
        "OpenCode pending permission read",
      );
      if (
        serializedByteLength([questions, permissions])
          > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
      ) {
        throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
      }
      if (questions.length + permissions.length
        > AGENT_INTERACTION_LIMITS.maxPendingRequests) {
        throw new ProviderUnavailableError("OpenCode returned too many interactions");
      }
      const snapshot = this.interactionTracker.snapshot(sessionId, [
        ...questions.map((request) => this.mapOpenCodeQuestion(sessionId, request)),
        ...permissions.map((request) => this.mapOpenCodePermission(sessionId, request)),
      ]);
      const currentIds = new Set(snapshot.requests.map((request) => request.id));
      for (const [interactionId, identity] of this.providerInteractionIds) {
        if (identity.sessionId === sessionId && !currentIds.has(interactionId)) {
          this.providerInteractionIds.delete(interactionId);
        }
      }
      return snapshot;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("OpenCode interactions are unavailable", {
        cause: error,
      });
    }
  }

  private async resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome> {
    const knownSession = this.interactionTracker.sessionFor(interactionId);
    if (knownSession !== undefined && knownSession !== sessionId) {
      return outcome("rejected", sessionId, interactionId, 0);
    }
    const snapshot = await this.listPendingInteractions(sessionId);
    const request = snapshot.requests.find((candidate) => candidate.id === interactionId);
    if (!request) return outcome("stale", sessionId, interactionId, snapshot.revision);
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (!isAgentInteractionResolution(resolution, request)) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    if (this.resolvingInteractions.has(interactionId)) {
      return outcome("already-resolved", sessionId, interactionId, snapshot.revision);
    }
    const identity = this.providerInteractionIds.get(interactionId);
    if (!identity) {
      return outcome("stale", sessionId, interactionId, snapshot.revision);
    }
    if (
      (resolution.action === "answer" || resolution.action === "approve-for-session")
      && identity.actionable === false
    ) {
      return outcome("rejected", sessionId, interactionId, snapshot.revision);
    }
    const providerRequestId = identity.providerRequestId;
    this.resolvingInteractions.add(interactionId);
    try {
      let response: { error?: unknown };
      try {
        if (request.kind === "question") {
          if (resolution.action === "answer") {
            const byQuestion = new Map(
              resolution.answer!.answers.map((answer) => [answer.questionId, answer]),
            );
            const answers = request.presentation.questions.map((question) => {
              const answer = byQuestion.get(question.id)!;
              const optionValues = new Map(
                question.options.map((option) => [option.id, option.providerValue]),
              );
              return [
                ...(answer.optionIds ?? []).map((id) => optionValues.get(id)!),
                ...(answer.freeText === undefined ? [] : [answer.freeText]),
              ];
            });
            response = await this.client.question.reply({
              requestID: providerRequestId,
              directory: this.connection.directory,
              answers,
            }, this.requestOptions());
          } else {
            response = await this.client.question.reject({
              requestID: providerRequestId,
              directory: this.connection.directory,
            }, this.requestOptions());
          }
        } else {
          response = await this.client.permission.reply({
            requestID: providerRequestId,
            directory: this.connection.directory,
            reply: resolution.action === "approve-for-session"
              ? "always"
              : resolution.action === "answer" ? "once" : "reject",
          }, this.requestOptions());
        }
        assertSdkResponse(response, "OpenCode interaction response");
      } catch {
        const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
        if (reconciled && !reconciled.requests.some((item) => item.id === interactionId)) {
          return outcome("applied", sessionId, interactionId, reconciled.revision);
        }
        return outcome("provider-unavailable", sessionId, interactionId, snapshot.revision);
      }
      const reconciled = await this.listPendingInteractions(sessionId).catch(() => null);
      if (!reconciled) {
        return outcome(
          "provider-unavailable",
          sessionId,
          interactionId,
          snapshot.revision,
        );
      }
      return outcome(
        reconciled.requests.some((item) => item.id === interactionId)
          ? "provider-unavailable"
          : "applied",
        sessionId,
        interactionId,
        reconciled.revision,
      );
    } finally {
      this.resolvingInteractions.delete(interactionId);
    }
  }

  async messages(
    sessionId: string,
    options: { limit?: number } = {},
  ): Promise<unknown[]> {
    try {
      const limit = options.limit;
      if (
        limit !== undefined
        && (!Number.isSafeInteger(limit) || limit <= 0 || limit > OPEN_CODE_MESSAGE_HISTORY_LIMIT)
      ) {
        throw new RangeError("OpenCode transcript limit is invalid");
      }
      const response = await this.client.session.messages(
        { sessionID: sessionId, ...(limit === undefined ? {} : { limit }) },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode transcript read");
      if (limit === undefined) {
        return Array.isArray(response.data) ? response.data : [];
      }
      return [...boundedOpenCodeMessageHistory(response.data, { count: limit })];
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode transcript is unavailable", {
        cause: error,
      });
    }
  }

  async interactiveSnapshot(
    sessionId: string,
  ): Promise<ProviderInteractiveSnapshot> {
    const [status, rawMessages, metadata] = await Promise.all([
      this.status(sessionId),
      this.messages(sessionId, { limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT }),
      this.readInteractiveMetadata(sessionId),
    ]);
    const normalizedMessages = rawMessages.flatMap((message, index) => {
      const normalized = normalizeOpenCodeInteractiveMessage(message, index);
      return normalized ? [normalized] : [];
    });
    const messages = await this.hydrateSubagentTranscripts(
      normalizedMessages,
      collectRawOpenCodeSubagentIds(rawMessages),
    );
    // OpenCode persists terminal errors on the final assistant message rather
    // than in its lifecycle snapshot. Normalize that provider detail here so
    // the shared projection can render the same durable terminal row for every
    // provider, including aborts initiated outside this renderer.
    const terminal = normalizeOpenCodeTerminalState(
      [...rawMessages].reverse().find((candidate) =>
        Boolean(asRecord(asRecord(candidate)?.info))
      ),
    );
    const usageTurns = rawMessages.flatMap((message) => {
      const info = asRecord(asRecord(message)?.info);
      const tokens = asRecord(info?.tokens);
      if (!tokens) return [];
      const number = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
      const inputTokens = number(tokens.input);
      const outputTokens = number(tokens.output);
      const reasoningTokens = number(tokens.reasoning);
      const cache = asRecord(tokens.cache);
      const cacheReadTokens = number(cache?.read);
      const cacheWriteTokens = number(cache?.write);
      const reportedTotal = number(tokens.total);
      const usedTokens = reportedTotal > 0
        ? reportedTotal
        : inputTokens + outputTokens + cacheReadTokens;
      if (usedTokens <= 0) return [];
      const time = asRecord(info?.time);
      const created = number(time?.created);
      const completed = number(time?.completed);
      const providerId = nonEmptyString(info?.providerID);
      const modelId = nonEmptyString(info?.modelID);
      return [{
        usedTokens,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: number(info?.cost),
        durationMs: completed >= created ? completed - created : 0,
        ...(modelId ? { modelId: providerId ? `${providerId}/${modelId}` : modelId } : {}),
      }];
    });
    const latestTurn = usageTurns.at(-1);
    const latestUsage: NativeAgentContextUsage | undefined = latestTurn
      ? usageTurns.reduce<NativeAgentContextUsage>((usage, turn) => ({
          ...usage,
          inputTokens: (usage.inputTokens ?? 0) + turn.inputTokens,
          outputTokens: (usage.outputTokens ?? 0) + turn.outputTokens,
          reasoningTokens: (usage.reasoningTokens ?? 0) + turn.reasoningTokens,
          cacheReadTokens: (usage.cacheReadTokens ?? 0) + turn.cacheReadTokens,
          cacheWriteTokens: (usage.cacheWriteTokens ?? 0) + turn.cacheWriteTokens,
          sessionTokens: (usage.sessionTokens ?? 0)
            + turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheWriteTokens,
          costUsd: (usage.costUsd ?? 0) + turn.costUsd,
          durationMs: (usage.durationMs ?? 0) + turn.durationMs,
        }), {
          usedTokens: latestTurn.usedTokens,
          lastTurnTokens: latestTurn.usedTokens,
          ...(latestTurn.modelId ? { modelId: latestTurn.modelId } : {}),
          estimated: false,
          source: "opencode",
          updatedAt: new Date().toISOString(),
        })
      : undefined;
    return {
      status: terminal?.kind === "error" ? "error" : status,
      messages,
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.shareUrl === undefined ? {} : { shareUrl: metadata.shareUrl }),
      composer: {
        ...EMPTY_NATIVE_AGENT_COMPOSER_STATE,
        models: metadata.models,
        ...(metadata.selectedModelId
          ? { selectedModelId: metadata.selectedModelId }
          : {}),
        ...(metadata.selectedReasoningId
          ? { selectedReasoningId: metadata.selectedReasoningId }
          : {}),
        executionProfiles: metadata.executionProfiles,
      },
      ...(latestUsage ? { contextUsage: latestUsage } : {}),
      runtime: metadata.runtime,
      ...(terminal ? { notices: [terminal] } : {}),
      ...(terminal?.kind === "error"
        ? { phase: "error" as const, error: terminal.message }
        : {}),
    };
  }

  private async readInteractiveMetadata(sessionId: string): Promise<{
    executionProfiles: NonNullable<NativeAgentComposerState["executionProfiles"]>;
    runtime: NativeAgentRuntimeSummary;
    models: AgentModel[];
    selectedModelId?: string;
    selectedReasoningId?: string;
    title?: string;
    shareUrl?: string | null;
  }> {
    // Resolved before the cache is consulted: this entry carries a catalogue
    // filtered against a specific allowlist, and a settings edit must invalidate
    // it here as well as in `readComposerCatalog`.
    const allowedProviders = await this.openCodeModelProviders();
    const providersKey = openCodeModelProvidersKey(allowedProviders);
    const cached = this.interactiveMetadata.get(sessionId);
    if (
      cached
      && cached.expiresAt > Date.now()
      && cached.providersKey === providersKey
    ) {
      return cached;
    }

    const directory = this.connection.directory;
    const results = await Promise.allSettled([
      this.optionalSdkCall("app", "agents", { directory }),
      this.optionalSdkCall("app", "skills", { directory }),
      this.optionalSdkCall("mcp", "status", { directory }),
      this.optionalSdkCall("lsp", "status", { directory }),
      this.optionalSdkCall("formatter", "status", { directory }),
      this.optionalSdkCall("session", "todo", { sessionID: sessionId, directory }),
      this.optionalSdkCall("session", "diff", { sessionID: sessionId, directory }),
      this.optionalSdkCall("session", "get", { sessionID: sessionId, directory }),
      this.readComposerCatalog(allowedProviders),
    ]);
    const data = (index: number, fallback: unknown): unknown => {
      const result = results[index];
      return result?.status === "fulfilled"
        ? asRecord(result.value)?.data ?? fallback
        : fallback;
    };
    const agents = data(0, []);
    const executionProfiles = (Array.isArray(agents) ? agents : [])
      .slice(0, 128)
      .flatMap((candidate) => {
        const agent = asRecord(candidate);
        const name = nonEmptyString(agent?.name);
        if (!name || agent?.hidden === true || agent?.mode === "subagent") return [];
        const model = asRecord(agent?.model);
        const providerId = nonEmptyString(model?.providerID);
        const modelId = nonEmptyString(model?.modelID);
        return [{
          id: name,
          label: name,
          ...(typeof agent?.description === "string"
            ? { description: agent.description.slice(0, 1_000) }
            : {}),
          ...(providerId && modelId ? { modelId: `${providerId}/${modelId}` } : {}),
        }];
      });
    const runtime: NativeAgentRuntimeSummary = {
      skills: providerInventoryCount(data(1, [])),
      mcpServers: providerInventoryCount(data(2, {})),
      lspServers: providerInventoryCount(data(3, [])),
      formatters: providerInventoryCount(data(4, [])),
      todos: providerInventoryCount(data(5, [])),
      files: providerInventoryCount(data(6, [])),
    };
    const sessionResult = results[7];
    const sessionData = sessionResult?.status === "fulfilled"
      ? asRecord(asRecord(sessionResult.value)?.data)
      : undefined;
    const title = nonEmptyString(sessionData?.title);
    const shareUrl = sessionResult?.status === "fulfilled"
      ? nonEmptyString(asRecord(sessionData?.share)?.url) ?? null
      : undefined;
    const catalogResult = results[8];
    const catalog = catalogResult?.status === "fulfilled"
      ? catalogResult.value
      : { models: [] };
    const entry = {
      expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
      providersKey,
      executionProfiles,
      runtime,
      models: catalog.models,
      ...(title ? { title } : {}),
      ...(shareUrl === undefined ? {} : { shareUrl }),
      ...(catalog.selectedModelId
        ? { selectedModelId: catalog.selectedModelId }
        : {}),
      ...(catalog.selectedReasoningId
        ? { selectedReasoningId: catalog.selectedReasoningId }
        : {}),
    };
    setBoundedMapEntry(
      this.interactiveMetadata,
      sessionId,
      entry,
      MAX_TRACKED_INTERACTION_SESSIONS,
    );
    return entry;
  }

  private async hydrateSubagentTranscripts(
    rootMessages: Record<string, unknown>[],
    rootSubagentIds: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    const queued = [...new Set([
      ...rootSubagentIds,
      ...collectNormalizedOpenCodeSubagentIds(rootMessages),
    ])]
      .slice(0, OPENCODE_SUBAGENT_MAX_SESSIONS);
    if (queued.length === 0) return rootMessages;
    const seen = new Set<string>();
    const children = new Map<string, Record<string, unknown>[]>();
    while (queued.length > 0 && seen.size < OPENCODE_SUBAGENT_MAX_SESSIONS) {
      const batch: string[] = [];
      while (
        queued.length > 0
        && batch.length < OPENCODE_SUBAGENT_FETCH_CONCURRENCY
        && seen.size + batch.length < OPENCODE_SUBAGENT_MAX_SESSIONS
      ) {
        const candidate = queued.shift();
        if (candidate && !seen.has(candidate) && !batch.includes(candidate)) {
          batch.push(candidate);
        }
      }
      if (batch.length === 0) continue;
      const results = await Promise.allSettled(batch.map(async (childSessionId) => {
        const raw = await this.messages(childSessionId, {
          limit: OPENCODE_SUBAGENT_MESSAGE_LIMIT,
        });
        const messages = raw.flatMap((message, index) => {
          const normalized = normalizeOpenCodeInteractiveMessage(message, index);
          return normalized ? [normalized] : [];
        });
        return { messages, nestedIds: collectRawOpenCodeSubagentIds(raw) };
      }));
      for (let index = 0; index < batch.length; index += 1) {
        const childSessionId = batch[index]!;
        seen.add(childSessionId);
        const result = results[index];
        if (result?.status !== "fulfilled") continue;
        children.set(childSessionId, result.value.messages);
        for (const nestedId of new Set([
          ...result.value.nestedIds,
          ...collectNormalizedOpenCodeSubagentIds(result.value.messages),
        ])) {
          if (
            !seen.has(nestedId)
            && !queued.includes(nestedId)
            && seen.size + queued.length < OPENCODE_SUBAGENT_MAX_SESSIONS
          ) queued.push(nestedId);
        }
      }
    }
    return hydrateNormalizedOpenCodeSubagents(rootMessages, children);
  }

  async listResumableSessions(): Promise<NativeAgentResumeEntry[]> {
    const response = await this.client.session.list(
      {
        directory: this.connection.directory,
        limit: MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS,
      },
      this.requestOptions(),
    );
    assertSdkResponse(response, "OpenCode resumable session list");
    if (!Array.isArray(response.data)) return [];
    return response.data.slice(0, 512).flatMap((candidate) => {
      const session = asRecord(candidate);
      const id = nonEmptyString(session?.id);
      if (!id) return [];
      const time = asRecord(session?.time);
      const toIso = (value: unknown) => {
        const date = typeof value === "number" || typeof value === "string"
          ? new Date(value)
          : null;
        return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
      };
      const createdAt = toIso(time?.created);
      const updatedAt = toIso(time?.updated);
      return [{
        sessionId: id,
        ...(typeof session?.title === "string" ? { title: session.title } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      }];
    });
  }

  refreshCatalog(): void {
    this.catalogMetadata = null;
    this.commandNames = null;
    this.interactiveMetadata.clear();
  }

  /**
   * Match a submission against the commands this runtime can execute.
   *
   * Discovery is only attempted for text that actually starts with a slash, and
   * the result is cached, so an ordinary prompt never pays for a command list.
   * A discovery failure resolves to "not a command": sending the text to the
   * model is recoverable, refusing the user's prompt is not.
   */
  private async resolveProviderCommand(
    prompt: string,
  ): Promise<ParsedSlashCommand | null> {
    const parsed = parseLeadingSlashCommand(prompt);
    if (!parsed) return null;
    let names = this.commandNames && this.commandNames.expiresAt > this.now()
      ? this.commandNames.names
      : null;
    if (!names) {
      try {
        names = new Set(
          (await this.slashCommands()).map((command) => command.name.toLowerCase()),
        );
        this.commandNames = {
          names,
          expiresAt: this.now() + OPENCODE_COMMAND_NAME_TTL_MS,
        };
      } catch {
        return null;
      }
    }
    return names.has(parsed.name) ? parsed : null;
  }

  async slashCommands(): Promise<NativeAgentSlashCommand[]> {
    const responses = await Promise.allSettled([
      this.client.command.list({}, this.requestOptions()),
      this.client.command.list(
        { directory: this.connection.directory },
        this.requestOptions(),
      ),
    ]);
    const commands = new Map<string, NativeAgentSlashCommand>(
      OPENCODE_BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command]),
    );
    for (const settled of responses) {
      if (settled.status !== "fulfilled" || !Array.isArray(settled.value.data)) continue;
      for (const candidate of settled.value.data.slice(0, 512)) {
        const command = asRecord(candidate);
        const rawName = nonEmptyString(command?.name);
        if (!rawName) continue;
        const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
        commands.set(name, {
          name,
          ...(typeof command?.description === "string"
            ? { description: command.description.slice(0, 1_000) }
            : {}),
          ...(Array.isArray(command?.hints) && typeof command.hints[0] === "string"
            ? { argumentHint: command.hints[0].slice(0, 512) }
            : {}),
        });
      }
    }
    return [...commands.values()].slice(0, 512);
  }

  async resumeSession(sessionId: string): Promise<string> {
    const status = await this.status(sessionId);
    if (status === "missing") throw new PromptRejectedError("OpenCode session was not found");
    this.rememberExistingSession(sessionId);
    return sessionId;
  }

  async forkSession(
    sessionId: string,
    messageId?: string,
  ): Promise<NativeAgentForkOutcome> {
    const response = await this.client.session.fork({
      sessionID: sessionId,
      directory: this.connection.directory,
      ...(messageId ? { messageID: messageId } : {}),
    }, this.requestOptions());
    assertSdkResponse(response, "OpenCode session fork");
    const forked = asRecord(response.data);
    const forkedId = nonEmptyString(forked?.id);
    if (!forkedId) throw new ProviderUnavailableError("OpenCode returned a malformed fork");
    this.rememberExistingSession(forkedId);
    return {
      sessionId: forkedId,
      ...(typeof forked?.title === "string" ? { title: forked.title } : {}),
    };
  }

  async performSessionAction(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome> {
    try {
      if (action.kind === "compact") {
        const model = action.modelId?.trim();
        const split = model && model !== "default" ? model.indexOf("/") : -1;
        await this.client.session.summarize({
          sessionID: sessionId,
          ...(split > 0 ? {
            providerID: model!.slice(0, split),
            modelID: model!.slice(split + 1),
          } : {}),
          auto: false,
        }, { ...this.requestOptions(), throwOnError: true });
        return { outcome: "applied" };
      }
      if (action.kind === "undo") {
        await this.client.session.revert({
          sessionID: sessionId,
          ...(action.messageId ? { messageID: action.messageId } : {}),
        }, { ...this.requestOptions(), throwOnError: true });
        return { outcome: "applied" };
      }
      if (action.kind === "redo") {
        await this.client.session.unrevert(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        return { outcome: "applied" };
      }
      if (action.kind === "share") {
        const response = await this.client.session.share(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        const share = asRecord(asRecord(response.data)?.share);
        this.interactiveMetadata.delete(sessionId);
        return {
          outcome: "applied",
          ...(typeof share?.url === "string" ? { shareUrl: share.url } : {}),
        };
      }
      if (action.kind === "unshare") {
        await this.client.session.unshare(
          { sessionID: sessionId },
          { ...this.requestOptions(), throwOnError: true },
        );
        this.interactiveMetadata.delete(sessionId);
        return { outcome: "applied" };
      }
    } catch (error) {
      throw new ProviderUnavailableError(`OpenCode ${action.kind} failed`, { cause: error });
    }
    throw new PromptRejectedError(`OpenCode does not support ${action.kind}`);
  }

  async structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null> {
    openCodeRequestMarker(requestId);
    let response;
    try {
      response = await this.client.session.messages(
        { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode structured-output read");
    } catch (error) {
      throw new ProviderUnavailableError(
        "OpenCode structured output is unavailable",
        { cause: error },
      );
    }
    if (!Array.isArray(response.data)) return null;
    let entries: readonly unknown[];
    try {
      entries = boundedOpenCodeMessageHistory(response.data);
    } catch (error) {
      throw new ProviderUnavailableError(
        "OpenCode structured output history is invalid",
        { cause: error },
      );
    }
    const providerMessageId = findOpenCodeMessageId(entries, requestId);
    if (!providerMessageId) return null;
    const assistant = [...entries].reverse().find((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const candidate = (entry as { info?: unknown }).info;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        return false;
      }
      const info = candidate as { role?: unknown; parentID?: unknown };
      return info.role === "assistant" && info.parentID === providerMessageId;
    });
    if (!assistant) return null;
    const assistantRecord = assistant as {
      info: Record<string, unknown>;
      parts?: unknown;
    };
    const info = assistantRecord.info as {
      error?: unknown;
      structured?: unknown;
      time?: { completed?: unknown };
    };
    if (!info.time?.completed) return null;
    if (info.error) {
      return {
        ok: false,
        provider: "opencode",
        requestId,
        error: {
          code: "provider_error",
          message: "OpenCode did not produce a structured result",
          provider: "opencode",
          retryable: true,
        },
      };
    }
    let value: unknown;
    try {
      value = info.structured === undefined
        ? parseOpenCodeStructuredText(assistantRecord.parts)
        : info.structured;
    } catch {
      return {
        ok: false,
        provider: "opencode",
        requestId,
        error: {
          code: "malformed_output",
          message: "OpenCode did not produce a valid JSON result",
          provider: "opencode",
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      provider: "opencode",
      requestId,
      value: value as T,
    };
  }

  async abort(sessionId: string): Promise<void> {
    try {
      const response = await this.client.session.abort(
        { sessionID: sessionId },
        this.requestOptions(),
      );
      assertSdkResponse(response, "OpenCode abort");
    } catch (error) {
      throw new ProviderUnavailableError("OpenCode abort is unavailable", {
        cause: error,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.monitorController.abort();
    this.activeStreamController?.abort();
    await this.monitorPromise;
    await Promise.allSettled([...this.requestTasks]);
    this.ownedSessions.clear();
    this.blockedSessions.clear();
    this.failedQuestionSessions.clear();
    this.answeringRequestIds.clear();
    this.requestTasks.clear();
    this.sessionExistenceCache.clear();
    this.sessionExistenceRetryAt.clear();
    this.sessionListCache = null;
    this.sessionListFailure = null;
  }

  private requestOptions(): { signal: AbortSignal } {
    const timeoutMs = Math.max(
      1,
      this.connection.requestTimeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS,
    );
    return {
      signal: AbortSignal.any([
        this.monitorController.signal,
        AbortSignal.timeout(timeoutMs),
      ]),
    };
  }
}

function assertSdkResponse(
  response: { error?: unknown },
  operation: string,
): void {
  if (response.error) {
    throw new Error(`${operation} failed`);
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createBuildPipelineProvider(
  connection: BridgeConnection,
  dependencies: ProviderDependencies = {},
): NativeAgentRuntimeProvider {
  return connection.agent === "opencode"
    ? new OpenCodeProvider(connection, dependencies)
    : new HttpBridgeProvider(
        connection,
        dependencies.fetch ?? fetch,
        dependencies.stageImages,
      );
}

export type { BridgeConnection };
