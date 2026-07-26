/**
 * Contract between the bridge's HTTP/SSE layer and the Codex engine.
 *
 * There is one implementation — `AppServerEngine`, a persistent
 * `codex app-server --stdio` child per environment. The interface remains because
 * it is the seam the reducer, registry and renderer are written against: they
 * consume `EngineEvent` and `EngineItem`, not the app-server wire protocol, so a
 * protocol change is absorbed in one adapter rather than spread through the bridge.
 *
 * Items use snake_case discriminants (`agent_message`, `command_execution`) even
 * though app-server speaks camelCase. `app-server/item-adapter.ts` converts, which
 * is what keeps `itemToParts`, the sub-agent reconciler and their tests independent
 * of the protocol.
 */
import type { ThreadItem } from "../codex-item-types.js";
import type { CodexCollabToolCallItem } from "../codex-collaboration.js";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";

export type EngineKind = "app-server";

/**
 * A monotonically increasing counter for the underlying execution process.
 *
 * With `runStreamed` a crash rejects one generator. With app-server one child
 * serves every thread in the environment, so every turn, pending request and
 * queued event records the generation it belongs to and anything from an older
 * generation is discarded after a restart.
 */
export type EngineGeneration = number;

export type EngineState =
  | "stopped"
  | "starting"
  | "ready"
  | "draining"
  | "restarting"
  | "backoff"
  | "failed";

/**
 * Not every engine can do everything. The bridge gates behaviour on these
 * rather than sniffing the engine kind, so adding an engine does not mean
 * hunting for `=== "app-server"` checks.
 */
export interface EngineCapabilities {
  /** Can rehydrate a persisted transcript via a protocol call. */
  readThread: boolean;
  /** Can enumerate threads natively (otherwise: rollout filesystem scan). */
  listThreads: boolean;
  /** Can push a title into Codex itself. */
  setThreadName: boolean;
  /** Emits collaboration/subagent items on the stream (otherwise: rollout polling). */
  nativeSubagentItems: boolean;
  /** Accepts a client-supplied message id, enabling at-most-once dispatch. */
  clientUserMessageId: boolean;
  /** Interrupt resolves asynchronously via a terminal turn event. */
  asyncInterrupt: boolean;
  /** Emits incremental deltas rather than whole-item snapshots. */
  itemDeltas: boolean;
  /** Reports a turn-level unified diff. */
  turnDiff: boolean;
}

export interface EngineInfo {
  kind: EngineKind;
  capabilities: EngineCapabilities;
  generation: EngineGeneration;
  /** Reported by the running binary, when it can tell us. */
  codexVersion?: string;
  codexHome?: string;
  platformOs?: string;
  pid?: number;
}

/** Structured error that survives the trip from engine to UI without losing its code. */
export interface EngineError {
  message: string;
  /** Protocol/domain code, e.g. `usageLimitExceeded` or `-32001`. */
  code?: string;
  /** True only when the engine explicitly said the request was not executed. */
  retryable?: boolean;
  details?: string;
}

export type EngineTurnStatus = "completed" | "interrupted" | "failed";

/**
 * Superset of the SDK item union plus the item kinds only app-server reports.
 * `itemToParts` switches on this; unknown `type` values fall through to an empty
 * part list and are counted as unknown-item metrics rather than crashing.
 */
export type EngineItem =
  | ThreadItem
  | CodexCollabToolCallItem
  | EngineSubagentActivityItem
  | EnginePlanItem;

/** app-server `subAgentActivity`: lifecycle beats for a child agent thread. */
export interface EngineSubagentActivityItem {
  id: string;
  type: "subagent_activity";
  activity: "started" | "interacted" | "interrupted";
  agent_thread_id: string;
  agent_path?: string;
}

/** app-server `plan`: free-text plan the agent is drafting, streamed via deltas. */
export interface EnginePlanItem {
  id: string;
  type: "plan";
  text: string;
}

export interface EngineThreadTurn {
  id: string;
  status: EngineTurnStatus | "inProgress";
  items: EngineItem[];
  /** `clientUserMessageId` echoed back on the turn's user message, when present. */
  clientId?: string | null;
  startedAt?: string;
  completedAt?: string;
  error?: EngineError;
}

export interface EngineThread {
  /**
   * Codex thread id, or null when the engine defers creating a persisted thread
   * until the first turn. Lazy creation is deliberate: an abandoned Orkestrator
   * session must not leave an empty thread in the resume dialog.
   */
  id: string | null;
  /** Opaque engine-side address for this thread. */
  handle: string;
  cwd?: string;
  model?: string;
  name?: string | null;
  preview?: string;
  source?: string;
  parentThreadId?: string | null;
  updatedAt?: string;
  createdAt?: string;
  /** Populated only by `readThread`/`resumeThread` when history was requested. */
  turns?: EngineThreadTurn[];
}

export interface EngineTurn {
  threadId: string | null;
  turnId: string;
  engineGeneration: EngineGeneration;
  /** True when the engine recognised the request id as already dispatched. */
  duplicate?: boolean;
}

export interface EngineRateLimitWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: string;
}

export interface EngineCreditSnapshot {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
}

export interface EngineUsageSnapshot {
  usedTokens: number;
  totalTokens: number;
  percentUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  lastTurnTokens?: number;
  sessionTokens?: number;
  credits?: EngineCreditSnapshot;
  rateLimits?: EngineRateLimitWindow[];
  estimated: false;
  source: "provider";
  updatedAt: string;
}

export interface EngineModelReasoningOption {
  effort: string;
  description?: string;
}

export interface EngineModel {
  id: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  /** Server-provided order is authoritative — never re-sort by name. */
  supportedReasoningEfforts: EngineModelReasoningOption[];
  defaultReasoningEffort?: string;
  serviceTiers?: string[];
  isDefault?: boolean;
}

export type EngineConversationMode = "build" | "plan";

/** Per-turn execution policy. Passed explicitly on every turn, never inherited. */
export interface EngineTurnConfig {
  mode: EngineConversationMode;
  model?: string;
  reasoningEffort?: string;
  /** `fast` service tier, or null to explicitly clear a previously set tier. */
  serviceTier?: string | null;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "untrusted";
  networkAccessEnabled?: boolean;
}

export interface StartThreadOptions {
  config: EngineTurnConfig;
}

export interface ResumeThreadOptions {
  config: EngineTurnConfig;
  /** Ask the engine to return reconstructed turn history. */
  includeTurns?: boolean;
}

export interface ReadThreadOptions {
  includeTurns?: boolean;
}

export interface ListThreadsOptions {
  cwd?: string;
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface ListThreadsResult {
  threads: EngineThread[];
  nextCursor?: string | null;
  /** False when the engine could not answer and the caller should fall back. */
  supported: boolean;
}

export type EngineUserInput =
  | { type: "text"; text: string }
  | { type: "local_image"; path: string };

export interface StartTurnOptions {
  /** Engine-side thread address from `startThread`/`resumeThread`. */
  handle: string;
  input: EngineUserInput[];
  config: EngineTurnConfig;
  /**
   * Stable per-prompt id from the browser. Forwarded as `clientUserMessageId`
   * so a lost response can be reconciled instead of blindly retried.
   */
  requestId?: string;
  /** Optional JSON Schema constraining only the final assistant message. */
  outputSchema?: JsonSchema;
}

export interface EngineEventMeta {
  engineGeneration: EngineGeneration;
  /** Engine handle, so events can be routed before a thread id exists. */
  handle?: string;
}

export type EngineEvent = EngineEventMeta &
  (
    | { kind: "thread.started"; threadId: string }
    | { kind: "turn.started"; threadId: string | null; turnId: string }
    | {
        kind: "item.started" | "item.updated" | "item.completed";
        threadId: string | null;
        turnId: string;
        item: EngineItem;
      }
    | { kind: "item.text.delta"; threadId: string | null; turnId: string; itemId: string; delta: string }
    | {
        kind: "item.reasoning.delta";
        threadId: string | null;
        turnId: string;
        itemId: string;
        delta: string;
        channel: "summary" | "content";
        index: number;
      }
    | {
        kind: "item.command.outputDelta";
        threadId: string | null;
        turnId: string;
        itemId: string;
        delta: string;
      }
    | { kind: "turn.diff"; threadId: string | null; turnId: string; diff: string }
    | {
        kind: "turn.completed";
        threadId: string | null;
        turnId: string;
        status: EngineTurnStatus;
        error?: EngineError;
      }
    | {
        kind: "error";
        threadId: string | null;
        turnId?: string;
        error: EngineError;
        willRetry: boolean;
      }
    | { kind: "thread.name.updated"; threadId: string; name?: string }
    | {
        kind: "thread.usage.updated";
        threadId: string;
        turnId: string;
        usage: EngineUsageSnapshot;
      }
    | {
        kind: "account.rateLimits.updated";
        rateLimits: EngineRateLimitWindow[];
        credits?: EngineCreditSnapshot;
      }
    | { kind: "engine.state"; state: EngineState; detail?: string }
    /**
     * A replacement child is ready. Every loaded thread must be re-subscribed and
     * every in-flight turn reconciled before the thread can accept work again —
     * otherwise sessions stay stuck in `recovering` forever.
     */
    | { kind: "engine.generation"; generation: EngineGeneration; previous: EngineGeneration }
    | { kind: "unknown.protocol"; method: string }
  );

export type EngineEventListener = (event: EngineEvent) => void;

export interface CodexEngine {
  readonly kind: EngineKind;
  readonly capabilities: EngineCapabilities;

  start(): Promise<EngineInfo>;
  stop(): Promise<void>;
  info(): EngineInfo;

  listModels(): Promise<EngineModel[]>;

  startThread(options: StartThreadOptions): Promise<EngineThread>;
  resumeThread(threadId: string, options: ResumeThreadOptions): Promise<EngineThread>;
  readThread(threadId: string, options?: ReadThreadOptions): Promise<EngineThread | null>;
  listThreads(options?: ListThreadsOptions): Promise<ListThreadsResult>;

  /**
   * Dispatches a turn. Resolves once the engine has *accepted* the turn, not
   * when it finishes — completion arrives as a `turn.completed` event.
   */
  startTurn(options: StartTurnOptions): Promise<EngineTurn>;

  /**
   * Requests interruption. For engines with `asyncInterrupt` this only asks;
   * the caller must wait for a terminal `turn.completed` with status
   * `interrupted` before treating the thread as idle.
   */
  interruptTurn(handle: string, turnId: string): Promise<void>;

  setThreadName(threadId: string, name: string): Promise<boolean>;
  unsubscribeThread(handle: string): Promise<void>;

  /** Reconfigure a thread without starting a turn (e.g. plan↔build switch). */
  configureThread(handle: string, config: EngineTurnConfig): Promise<void>;

  subscribe(listener: EngineEventListener): () => void;
}

/** Thrown when the underlying execution process died with work in flight. */
export class EngineProcessExitError extends Error {
  readonly generation: EngineGeneration;
  readonly code: number | null;
  readonly signal: string | null;

  constructor(
    message: string,
    options: { generation: EngineGeneration; code?: number | null; signal?: string | null },
  ) {
    super(message);
    this.name = "EngineProcessExitError";
    this.generation = options.generation;
    this.code = options.code ?? null;
    this.signal = options.signal ?? null;
  }
}

/** Thrown for capability gaps so callers can fall back deliberately. */
export class EngineUnsupportedError extends Error {
  constructor(operation: string, kind: EngineKind) {
    super(`${operation} is not supported by the ${kind} engine`);
    this.name = "EngineUnsupportedError";
  }
}

export const APP_SERVER_CAPABILITIES: EngineCapabilities = {
  readThread: true,
  listThreads: true,
  setThreadName: true,
  nativeSubagentItems: true,
  clientUserMessageId: true,
  asyncInterrupt: true,
  itemDeltas: true,
  turnDiff: true,
};
