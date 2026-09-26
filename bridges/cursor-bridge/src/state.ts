/**
 * The transcript model this bridge serves, and the per-session state that
 * produces it.
 *
 * The shape is the provider-neutral one Orkestrator's shared renderer already
 * consumes for every agent platform. Keeping it identical is the whole point
 * of the adapter: the Cursor SDK's event vocabulary is translated here, once,
 * so nothing downstream needs to know which engine produced a transcript.
 */
import type { AgentOptions, Run, SDKAgent, SDKCustomTool } from "@cursor/sdk";
import type {
  NativeAgentAccountUsageWindow,
  NativeAgentComposerState,
  NativeAgentTurnUsage,
} from "@orkestrator/protocol/native-agent";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";

export type JsonObject = Record<string, unknown>;
export type SessionStatus = "idle" | "running" | "error";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface BridgeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: BridgeMessagePart[];
  createdAt: string;
  /** Model selected when this assistant response began. */
  modelId?: string;
  /** Exact SDK run that originated this user turn, used by destructive rewind. */
  runId?: string;
  /**
   * Typed plan-review marker used by the shared presentation slot.
   *
   * Set on assistant messages produced while the composer is in plan mode, and
   * on historic turns that already called `createPlan`. The renderer shows
   * approve/dismiss controls for the latest such message.
   */
  planReview?: boolean;
}

export interface BridgeTextPart {
  type: "text" | "thinking";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  /** Launch tool this nested text belongs to, for sub-agent output. */
  parentTaskUseId?: string;
}

/**
 * A prompt attachment as the transcript records it. The bytes go to the agent
 * but are never kept here: the renderer resolves `fileUrl` for its own
 * preview, and inlining a data URL could spend half the transcript budget on
 * one screenshot.
 */
export interface BridgeFilePart {
  type: "file";
  content: string;
  fileUrl?: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
}

export interface BridgeToolDiff {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

export interface BridgeToolPart {
  type: "tool-invocation";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  toolUseId: string;
  createdAt?: string;
  toolName?: string;
  toolArgs?: JsonObject;
  toolState?: "success" | "failure" | "pending";
  /**
   * Lifecycle of a sub-agent launched by this tool, kept separate from
   * `toolState` because Cursor completes a *background* launch tool as soon as
   * the child starts — the card stays active long after the call succeeded.
   */
  agentState?: "active" | "finished" | "failed";
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: BridgeToolDiff;
  /** Launch tool this nested call belongs to. */
  parentTaskUseId?: string;
}

/** A context compaction boundary. */
export interface BridgeCompactionPart {
  type: "compaction";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  /** Pending while the summary is still being produced. */
  toolState?: "success" | "failure" | "pending";
}

/** A short provider status line in the transcript flow. */
export interface BridgeStatusPart {
  type: "status";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  severity?: "info" | "warning" | "error";
}

/** An image the agent generated. Bytes stay behind `fileUrl`. */
export interface BridgeImagePart {
  type: "image";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  fileUrl?: string;
  filename?: string;
  imageSource?: "attachment" | "generated" | "viewed";
}

/** A live progress line for a running tool call. */
export interface BridgeProgressPart {
  type: "progress";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  toolUseId: string;
}

export type BridgeMessagePart =
  | BridgeTextPart
  | BridgeFilePart
  | BridgeToolPart
  | BridgeCompactionPart
  | BridgeStatusPart
  | BridgeImagePart
  | BridgeProgressPart;

export interface PromptJournalEntry {
  requestId: string;
  state: "prepared" | "accepted" | "completed" | "failed" | "ambiguous";
  acceptedAt: number;
  /** Set when this id answered an idle `/steer` locally. */
  local?: boolean;
  /**
   * Runtime-only, on an `ambiguous` record: this process's own `agent.send`
   * call rejected, so whether the SDK started the run is unknown. A retry of
   * the same id in this process may dispatch again — the SDK receives the same
   * idempotency key. Never persisted: after a restart the record is plain
   * ambiguous and the id is refused.
   */
  sendFailed?: true;
}

export interface SteerJournalEntry {
  requestId: string;
  inputDigest: string;
  expectedRunId: string;
  state: "prepared" | "delivered" | "absent" | "ambiguous";
  createdAt: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider-calculated total; preferred over reconstructing vendor accounting. */
  totalTokens?: number;
}

export interface PersistedUsage {
  /**
   * What the whole turn spent, cumulative across every model call the run made.
   * This is the billing figure, and for a run with several calls it is a
   * multiple of what the context window ever held.
   */
  turn: TurnUsage;
  /**
   * The final model call's own snapshot, which is what the context window
   * actually held when the turn ended. Absent when the provider reported only a
   * cumulative figure, in which case `turn` is the best available occupancy
   * estimate too.
   */
  context?: TurnUsage;
  modelId?: string;
  durationMs?: number;
  /** Cumulative billed tokens for this durable Cursor agent. */
  sessionTokens?: number;
  /**
   * Lowest cumulative total that can include every locally measured turn.
   *
   * Kept separately from `sessionTokens`: the account snapshot can lag, while
   * this floor must survive a newer turn and a bridge restart so an older
   * account report is never mistaken for the latest one. Public projections
   * use the greater of the two.
   */
  sessionTokenFloor?: number;
  /** Amount actually charged by Cursor, including discounts, in US dollars. */
  costUsd?: number;
  /** Provider-reported per-run usage, newest last and bounded to twenty. */
  turns?: NativeAgentTurnUsage[];
  /** Agent-scoped cumulative billing data exposed through the generic panel. */
  account?: NativeAgentAccountUsageWindow[];
  updatedAt: string;
}

/**
 * Bounded correlation metadata for an active background sub-agent.
 *
 * Deliberately independent of the rendered parts: transcript retention is a
 * display concern and must not decide whether background work still exists.
 */
export interface ActiveSubagentDescriptor {
  description?: string;
  subagentType?: string;
  agentId?: string;
  toolState?: BridgeToolPart["toolState"];
}

export interface SessionState {
  id: string;
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  /** Per-turn review boundary; changing it reattaches the same SDK conversation. */
  readOnly?: boolean;
  clientSessionKey?: string;
  /** The SDK's own agent id. Stable across bridge restarts; what resume takes. */
  agentId?: string;
  /**
   * Detached to adopt an MCP configuration change and not yet reattached. The
   * next attach must resume `agentId` or fail; it may never quietly start a
   * new conversation. Persisted, because a restart does not change that.
   */
  configResumePending?: boolean;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  /** Absolute index of `messages[0]`, so evictions cannot shift client windows. */
  droppedMessages: number;
  /** Parts evicted from retained messages over the lifetime of this window. */
  droppedParts: number;
  transcriptTruncated: boolean;
  revision: number;
  structured: Map<string, unknown>;
  promptJournal: Map<string, PromptJournalEntry>;
  steerJournal: Map<string, SteerJournalEntry>;
  /** Encoded bytes `steerJournal` holds. Maintained only by `steer-journal.ts`. */
  steerJournalBytes: number;
  /** Runs whose steer history was evicted; see `steer-journal.ts`. */
  steerFence?: SteerFence;
  /**
   * Runtime-only notice latches, so a saturated or fenced journal produces one
   * health notice on the transition rather than one per refused request.
   */
  steerNoticed?: { saturated?: boolean; fencedRunId?: string };
  /** The active run was re-adopted rather than started by this process. */
  activeRunRecovered?: boolean;
  /** Provider creation time of a re-adopted run, when the SDK reported one. */
  activeRunCreatedAt?: number;
  /** Live background children, maintained incrementally for `/activity`. */
  activeSubagentDescriptors: Map<string, ActiveSubagentDescriptor>;
  /** Fatal latch: once the bound trips, later frames cannot reopen work. */
  subagentLimitExceeded: boolean;
  /** Merge source for the next todo update; restored from the newest part. */
  todos: TodoItem[];
  composer: NativeAgentComposerState;
  /** The attached SDK agent, or null when this session is detached. */
  agent: SDKAgent | null;
  /** Holds the SDK's prewarmed executor alive for the attached agent. */
  workspaceWarmRelease?: () => Promise<void>;
  /** The in-flight attach, shared by every caller that wants this attached. */
  attaching?: Promise<SDKAgent>;
  /** Cancels the turn in flight. Never persisted. */
  cancelTurn?: () => Promise<void>;
  /** Current SDK run, retained only while it can accept steering. */
  activeRun?: Run;
  /** In-flight re-attach of a run that survived a bridge restart. */
  recoveringRun?: Promise<void>;
  /** MCP names only. Launch configuration can contain credentials and is never persisted. */
  mcpServerNames?: string[];
  /**
   * Tab-scoped Orkestrator MCP connection. Memory only — persistence must never
   * write the bearer token. Env is the fallback when this is absent.
   */
  agentMcp?: { url: string; token: string };
  /** Fingerprint of the MCP connection the attached SDK agent was built with. */
  attachedMcpKey?: string;
  /**
   * Closes the in-process Orkestrator MCP client a sandboxed coordinator
   * attach opened. Runtime-only — the bearer never reaches persistence.
   */
  hostedMcpClose?: () => Promise<void>;
  /**
   * In-process Orkestrator callbacks for the attached agent. Repeated on every
   * send because Cursor's run executor owns the callable map for that turn;
   * the agent-level descriptors alone are not enough after resume/recovery.
   */
  hostedMcpTools?: Record<string, SDKCustomTool>;
  /**
   * Local SDK options used to attach this agent. Per-run custom-tool callbacks
   * merge into this object so repeating them never drops cwd or sandbox policy.
   */
  agentLocalOptions?: NonNullable<AgentOptions["local"]>;
  /**
   * A turn the user cancelled before its run handle existed.
   *
   * `cancelTurn` is only assignable once `agent.send` has resolved, and that
   * call can sit open for as long as the SDK takes to start a run. A cancel
   * arriving in that window has nothing to act on, so it records the sequence
   * of the turn it meant to stop and `dispatchPrompt` honours it the moment
   * the handle exists. Without this the user is told the turn stopped while it
   * carries on writing to the workspace.
   */
  pendingCancelPromptSequence?: number;
  /**
   * A turn accepted but not yet handed to the agent. Transient and deliberately
   * not persisted: a restart answers the same question through the prompt
   * journal, which records an unfinished turn as ambiguous.
   */
  dispatching: boolean;
  /** Monotonic count of turns dispatched in this process. */
  promptSequence: number;
  /**
   * The assistant message the current turn writes into.
   *
   * Held by id rather than by reference so a transcript trim that evicts the
   * message cannot leave the translator appending to an orphan that no longer
   * appears in the transcript it is bounding.
   */
  currentAssistantMessageId?: string;
  /**
   * The text and thinking blocks still being appended to, by kind and
   * sub-agent.
   *
   * Cursor interleaves reasoning with prose, so "the last part" is not a
   * reliable way to find the block a delta continues. Held by `sourcePartId`
   * rather than by reference so a transcript trim that drops the part simply
   * fails the lookup and starts a new block.
   */
  openTextParts: Map<string, string>;
  /** Bytes appended since the transcript was last measured against its budget. */
  uncheckedTranscriptBytes: number;
  /** Accumulates the assistant text of a structured-output turn. */
  currentTurnOutput: string | null;
  usage?: PersistedUsage;
  /** Cumulative usage reported by completed model calls in the run still in flight. */
  currentRunUsage?: TurnUsage;
  /**
   * Heuristic output-token progress for the model call still in flight.
   *
   * Cursor publishes `token-delta` before its first exact `turn-ended.usage`
   * frame. Keeping the estimate separate prevents it from contaminating the
   * exact provider categories that replace it at the turn boundary.
   */
  currentTurnOutputTokenEstimate?: number;
  /** Independent accumulator for usage delivered through turn-ended deltas. */
  currentRunDeltaUsage?: TurnUsage;
  /** Independent accumulator for usage delivered through the run message stream. */
  currentRunStreamUsage?: TurnUsage;
  /** Timestamp of the latest in-flight usage update exposed to polling clients. */
  currentRunUsageUpdatedAt?: string;
  /** Model selected when the current run was dispatched. */
  currentRunModelId?: string;
  /** The most recent model call, used as the live context-occupancy snapshot. */
  currentTurnUsage?: TurnUsage;
  turnStartedAt?: number;
  /** Wall clock the session was last touched by a tab-facing route. */
  lastAccessed: number;
  /**
   * The model the SDK reported it is actually running, from the run's own
   * `system` message. Not the composer selection: Cursor substitutes.
   */
  runModelId?: string;
  /** Tool *names* the run was given. Never their descriptions or schemas. */
  runTools?: string[];
  /**
   * Qualified `mcp__<server>__<tool>` names this session has actually called.
   *
   * Held beside the transcript rather than derived from it. `boundTranscript`
   * evicts cards for display, and an MCP server must not vanish from the panel
   * because its last call scrolled out of the window — the transcript module
   * says as much itself. Names only, never arguments or results, and
   * runtime-only: a restore re-seeds this from the transcript it recovered.
   */
  observedMcpTools: Set<string>;
  /**
   * MCP evidence from before the last configuration reattach: qualified names
   * this session called under a previous MCP configuration. A saved edit may
   * have removed their server, so they keep the server listed but can no
   * longer say it is connected. Runtime-only, bounded like `observedMcpTools`.
   */
  retiredMcpTools?: Set<string>;
  /**
   * The `runTools` array the previous configuration's agent advertised. Held
   * by identity: the next run assigns a fresh array, which is when the
   * advertised inventory becomes evidence about the current configuration.
   */
  retiredRunTools?: string[];
  /**
   * What this bridge saw and did not understand, and what the SDK reported.
   *
   * `@cursor/sdk` is a fast-moving dependency whose update and tool-call unions
   * grow between releases; without this, a new variant is indistinguishable
   * from a turn that produced nothing. Runtime-only — a restart re-observes.
   */
  health: RuntimeHealthRecorder;
  /**
   * Permanent close was requested. Set synchronously, before the close awaits
   * anything, and never cleared: from here no prompt, attach, config, steer or
   * same-key create may start work on this session, and a late attach or send
   * result is disposed rather than installed. Idle detach never sets it.
   */
  closed?: boolean;
  /** The one close operation every concurrent close request shares. */
  closing?: Promise<void>;
  /**
   * Every operation this session owned has settled and its resources are
   * released. What remains is publishing the removal; until then the record
   * stays registered so a retried close cannot mistake it for already gone.
   */
  closeFenced?: boolean;
  /** Settles when the admitted prompt's pre-dispatch phase ends, either way. */
  dispatchClaim?: Promise<void>;
  /** Settles when the dispatched turn reaches its terminal state. Never rejects. */
  turnCompletion?: Promise<void>;
  /** An in-flight destructive rewind of the provider history. Never rejects. */
  rewinding?: Promise<void>;
}

/**
 * Runs whose steer history this journal no longer holds.
 *
 * `runs` names them, bounded. When a name has to be dropped to keep that
 * bound, `overflowBefore` records when: a dropped run was necessarily created
 * at or before that moment, so a run created later is provably not one of
 * them. A timestamp rather than a boolean, so one overflow does not fence
 * every future run forever.
 */
export interface SteerFence {
  runs: string[];
  overflowBefore?: number;
}

/**
 * A session whose permanent close was requested but whose removal was not yet
 * published when this record was written.
 *
 * Kept apart from `sessions` on disk so a restarted bridge — or an older one
 * that does not know this field — can never reopen it: the older bridge simply
 * does not see it, and this one answers it as closing until a close finishes.
 */
export interface ClosingTombstone {
  id: string;
  agentId?: string;
  since: number;
}

export interface PersistedSession {
  id: string;
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  readOnly?: boolean;
  clientSessionKey?: string;
  agentId?: string;
  configResumePending?: boolean;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  droppedMessages?: number;
  droppedParts?: number;
  transcriptTruncated?: boolean;
  revision: number;
  structured: Array<[string, unknown]>;
  promptJournal: PromptJournalEntry[];
  steerJournal?: SteerJournalEntry[];
  /**
   * `overflow` is the legacy boolean form, still written beside
   * `overflowBefore` so an older bridge that reads only the boolean stays
   * conservative.
   */
  steerFence?: { runs: string[]; overflowBefore?: number; overflow?: boolean };
  composer?: NativeAgentComposerState;
  usage?: PersistedUsage;
  subagentLimitExceeded?: boolean;
}

export interface PersistedState {
  version: 1;
  provider: "cursor";
  /** Closes that had not published their removal. Absent when there are none. */
  closing?: ClosingTombstone[];
  sessions: PersistedSession[];
}

export const sessions = new Map<string, SessionState>();
/** Closing records restored from disk, answered as closing until closed. */
export const closingTombstones = new Map<string, ClosingTombstone>();
export const clientSessionKeys = new Map<string, string>();
export const sessionCreations = new Map<string, Promise<SessionState>>();

/**
 * Parts and messages whose text already sits at its byte cap.
 *
 * Without this, an agent that keeps streaming into a saturated buffer would
 * make `appendBounded` re-encode and re-copy the whole 2MiB buffer for every
 * remaining chunk only to hand back exactly what it was given. Saturation is
 * recorded once and the append skipped from then on.
 *
 * Weakly held, so a trimmed part or an evicted message takes its entry with it.
 */
export const saturatedText = new WeakSet<BridgeMessage | BridgeMessagePart>();

/**
 * Live source state for a tool part, keyed off the part itself.
 *
 * Tool cards are patched in place across `partial` → `started` → `completed`,
 * and the raw SDK payload that produced them is far larger than what is
 * rendered. Keeping it out of the transcript keeps the display budget honest.
 */
export interface ToolSourceState {
  /**
   * Serialized size of the rendered part the last time it was charged against
   * `uncheckedTranscriptBytes`. Only the delta is new on a patch, so charging
   * the whole part per streaming frame would re-bill a 1MiB diff every frame.
   */
  chargedBytes?: number;
  /** Shell output accumulated from `shell-output-delta` before the result. */
  streamedOutput?: string;
}

export const toolSourceStates = new WeakMap<BridgeToolPart, ToolSourceState>();

/**
 * Work refused because the session's permanent close has begun. Answered as a
 * conflict: nothing was started, and the session will not accept it again.
 */
export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";

  constructor(message = "This Cursor session is closing") {
    super(message);
  }
}

/** Refuse new work on a session whose permanent close has begun. */
export function assertSessionOpen(state: SessionState): void {
  if (state.closed) throw new SessionClosedError();
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether this session still has work in flight.
 *
 * `working` has to mean a turn or a background child is *actually* running: an
 * environment reported idle while a sub-agent is still writing files is how a
 * build pipeline advances past a turn that has not finished.
 */
export function sessionIsWorking(state: SessionState): boolean {
  return state.status === "running" || state.activeSubagentDescriptors.size > 0;
}

/**
 * Every in-flight operation this session owns and a permanent close must see
 * settle: an attach, a prompt's pre-dispatch claim, a dispatched turn, a
 * recovered run and a destructive rewind. Rejections are the owner's to
 * report; here they only mean "settled".
 */
export function ownedWork(state: SessionState): Promise<unknown>[] {
  return (
    [
      state.attaching,
      state.dispatchClaim,
      state.turnCompletion,
      state.recoveringRun,
      state.rewinding,
    ] as Array<Promise<unknown> | undefined>
  ).filter((work): work is Promise<unknown> => work !== undefined);
}

/**
 * The provider's own total when it reported one, and the sum of the categories
 * it summarises otherwise.
 *
 * `reasoningTokens` is deliberately excluded: the SDK documents it as a subset
 * of `outputTokens`, so adding it would double-count. This lives here rather
 * than beside either caller because the context gauge and the billed-usage
 * staleness check both depend on the same accounting, and two copies of the
 * rule would drift.
 */
export function turnTokenTotal(usage: TurnUsage): number {
  return (
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
  );
}
