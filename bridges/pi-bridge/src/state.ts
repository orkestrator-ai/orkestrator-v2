import type {
  BridgeRunDiagnostics,
  CancellationReason,
} from "@orkestrator/protocol/bridge-diagnostics";
/**
 * The transcript model this bridge serves, and the per-session state that
 * produces it.
 *
 * The shape is the provider-neutral one Orkestrator's shared renderer already
 * consumes for every agent platform. Keeping it identical is the whole point
 * of the adapter: Pi's event vocabulary is translated here, once, so nothing
 * downstream needs to know which engine produced a transcript.
 */
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type {
  NativeAgentComposerState,
  NativeAgentSlashCommand,
  NativeAgentTurnUsage,
} from "@orkestrator/protocol/native-agent";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { bridgeGeneration, MAX_STEER_JOURNAL } from "./config.js";

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
}

export interface BridgeTextPart {
  type: "text" | "thinking";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
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
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: BridgeToolDiff;
}

/**
 * A context compaction boundary.
 *
 * Its own kind rather than a tool card: the previous synthetic card dropped
 * both token counts and read as something the agent chose to run, when it is a
 * boundary in the conversation itself.
 */
export interface BridgeCompactionPart {
  type: "compaction";
  /** Pi's own summary of what it compacted, or "" when it produced none. */
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  compactedTokensBefore?: number;
  tokenCountText?: string;
}

/**
 * A retry that settles.
 *
 * `toolState` is the lifecycle: `pending` from `auto_retry_start`, settled by
 * `auto_retry_end`. The previous synthetic card was published settled and
 * never updated, so a retry that ultimately failed read as one that worked.
 */
export interface BridgeRetryPart {
  type: "retry";
  content: string;
  sourcePartId: string;
  sourceMessageId: string;
  createdAt?: string;
  toolState?: "success" | "failure" | "pending";
  retryAttempt?: number;
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

/** An image the agent produced or read. Bytes stay behind `fileUrl`. */
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

export type BridgeMessagePart =
  | BridgeTextPart
  | BridgeFilePart
  | BridgeToolPart
  | BridgeCompactionPart
  | BridgeRetryPart
  | BridgeStatusPart
  | BridgeImagePart;

export interface PromptJournalEntry {
  requestId: string;
  state: "prepared" | "accepted" | "completed" | "failed" | "dropped" | "ambiguous";
  acceptedAt: number;
  /** Set when this id answered an idle `/steer` locally. */
  local?: boolean;
}

export interface PiCommandCatalogueState {
  /**
   * `ready` once this process has read the list from an attached session;
   * `stale` for a list restored from disk, never read, or retained across a
   * reload that has not happened yet (or failed).
   */
  status: "ready" | "stale";
  /** Advances whenever the rows or the status change. */
  revision: number;
  truncated?: boolean;
}

/**
 * One extension command in flight.
 *
 * Pi runs an extension command's handler inside `prompt()` and reports its
 * failure only through the extension error listener, and a command may finish
 * without any assistant message at all. This record is what lets the turn end
 * with an explicit outcome rather than a silent success or a stuck user row.
 */
export interface PiCommandRun {
  /** Canonical invocation name, without the leading slash. */
  invocation: string;
  /** The first failure the handler (or work it started) reported. */
  error?: string;
  /** Text of display messages the extension emitted while it ran. */
  output: string[];
  /** The user cancelled; the handler itself may still be running. */
  cancelled?: boolean;
}

export interface SteerJournalEntry {
  requestId: string;
  inputDigest: string;
  expectedRunId: string;
  state: "prepared" | "queued" | "delivered" | "dropped" | "ambiguous";
  createdAt: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface PersistedUsage {
  turn: TurnUsage;
  /** Provider-native per-turn rows, newest last and bounded to twenty. */
  turns?: NativeAgentTurnUsage[];
  /** Cumulative counters used to derive the next turn's exact deltas. */
  sessionTokens?: number;
  sessionToolCalls?: number;
  modelId?: string;
  durationMs?: number;
  costUsd?: number;
  /** Whole-session context occupancy, which Pi reports directly. */
  contextTokens?: number;
  contextWindow?: number;
  /** Pi's own percentage of the window, which accounts for compaction. */
  contextPercent?: number;
  /**
   * True when Pi could not report a real occupancy — it answers `tokens: null`
   * between a compaction and the next model response — so `contextTokens` is
   * absent and the meter is showing the per-turn sum instead.
   */
  estimated?: boolean;
  updatedAt: string;
}

/**
 * One tool call parked on a human decision.
 *
 * Held out of the transcript on purpose: an approval is a live control, and a
 * transcript trim is a display concern that must never resolve one.
 */
export interface PendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  createdAt: number;
  expiresAt: number;
  /** Answers the parked tool call exactly once. Never persisted. */
  settle: (decision: "allow" | "deny", reason?: string) => void;
}

export interface SessionState {
  diagnostics?: BridgeRunDiagnostics;
  /** Workflow-owned tool restriction, independent of Pi thinking/composer modes. */
  readOnly?: boolean;
  /**
   * Per-tab Agent MCP credentials from create/prompt/resume. Runtime-only:
   * persisting them would write the bearer into `state.json`. Attach falls
   * back to the process env when this is absent after a restart.
   */
  agentMcp?: { url: string; token: string };
  id: string;
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  clientSessionKey?: string;
  /**
   * Pi's own session file. Stable across bridge restarts; what re-attach and
   * resume both take, and the only place the model's context actually lives.
   */
  sessionFile?: string;
  /** Pi's own session id, reported by the SDK once a session exists. */
  piSessionId?: string;
  status: SessionStatus;
  error?: string;
  title?: string;
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
  /** Live FIFO used to correlate Pi's authoritative user delivery event. */
  pendingSteerDeliveries: Array<{ requestId: string; text: string; expectedRunId: string }>;
  /** Tool calls parked on a human decision, newest last. */
  approvals: Map<string, PendingApproval>;
  /** Merge source for the next todo update; restored from the newest part. */
  todos: TodoItem[];
  composer: NativeAgentComposerState;
  /** One-shot request from the config route; never persisted. */
  persistComposerDefaults?: boolean;
  /** The attached Pi session, or null when this bridge session is detached. */
  session: AgentSession | null;
  /** Production replacement runtime used for lifecycle-correct forks. Never persisted. */
  runtime?: AgentSessionRuntime;
  /** Releases the SDK event subscription that feeds `translate.ts`. */
  unsubscribe?: () => void;
  /** The in-flight attach, shared by every caller that wants this attached. */
  attaching?: Promise<AgentSession>;
  /** Cancels the turn in flight. Never persisted. */
  cancelTurn?: (reason?: CancellationReason) => Promise<void>;
  /**
   * A turn accepted but not yet handed to the agent. Transient and deliberately
   * not persisted: a restart answers the same question through the prompt
   * journal, which records an unfinished turn as ambiguous.
   */
  dispatching: boolean;
  /**
   * The admitted prompt that owns the turn, from the prompt route's
   * synchronous claim until that turn reaches a terminal state.
   *
   * `dispatching` cannot answer "is there a prompt to cancel?": configuration
   * and compaction claim it too. This token can, and every phase — attachment
   * reads, MCP reconciliation, cold attach, the durability barrier, Pi's own
   * preflight and the accepted run — refers to the same one. Process-local and
   * never persisted: a restart answers the same question from the prompt
   * journal, and a stale token must never attach to a new run.
   */
  promptClaim?: number;
  /**
   * The claim a cancel was requested for, recorded even when no cancel handle
   * existed yet. Keyed by claim, never a bare flag, and cleared by identity, so
   * a cancel for one turn can neither be lost during startup nor stop a later
   * turn.
   */
  cancelRequestedClaim?: number;
  /**
   * The abort path for a prompt Pi has been handed but has not yet accepted.
   *
   * Pi 0.87's `session.prompt()` runs a preflight (input hooks, auth, a
   * possible auto-compaction, `before_agent_start`) before it creates the run,
   * and only the run has a cancel handle. `abort()` during preflight still
   * cancels an auto-compaction in progress, so a cancel recorded then is
   * applied through this at once instead of waiting for acceptance. Keyed by
   * claim, process-local, and cleared when the prompt is accepted, refused or
   * its abandoned startup finally settles.
   */
  promptStartup?: PromptStartupHandle;
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
   * The text and thinking blocks still being appended to, by kind.
   *
   * Pi interleaves reasoning with prose, so "the last part" is not a reliable
   * way to find the block a delta continues. Held by `sourcePartId` rather than
   * by reference so a transcript trim that drops the part simply fails the
   * lookup and starts a new block.
   */
  openTextParts: Map<string, string>;
  /**
   * The arguments each in-flight tool call was started with.
   *
   * Pi's `tool_execution_end` frame carries only `toolCallId`, `toolName`,
   * `result` and `isError` — the arguments are on the start frame and nowhere
   * else. Re-rendering a settled card without them collapsed every title to
   * the bare tool name and dropped the file path off edit and write diffs, so
   * the start frame's input is held here until the call settles. Runtime-only
   * and bounded: `toPersisted` does not carry it, and a restart re-renders
   * from the transcript it already wrote.
   */
  toolInputs: Map<string, JsonObject>;
  /** Bytes appended since the transcript was last measured against its budget. */
  uncheckedTranscriptBytes: number;
  usage?: PersistedUsage;
  currentTurnUsage?: TurnUsage;
  turnStartedAt?: number;
  /** Steering and follow-up prompts Pi is holding for the running turn. */
  queue: { steering: string[]; followUp: string[] };
  /**
   * Prompt templates, skills and extension commands the session offers.
   *
   * Every row is an enhanced descriptor built by `commands.ts`, and the row
   * *is* the executor's registry: its id names the kind and canonical Pi
   * invocation, so nothing private has to be held beside it.
   */
  slashCommands: NativeAgentSlashCommand[];
  /** Freshness of {@link slashCommands}. */
  commandCatalogue: PiCommandCatalogueState;
  /**
   * A resource reload asked for while the session was busy. Pi's own terminal
   * refuses `/reload` mid-turn, so the bridge runs it once the session is idle.
   * Runtime-only: a restarted process re-reads the list on its next attach.
   */
  commandReloadPending?: boolean;
  /** The resource reload in flight. Prompts wait for it rather than racing it. */
  commandReload?: Promise<unknown>;
  /** The extension command the current turn is running, if it is one. */
  commandRun?: PiCommandRun;
  /** True while Pi is compacting; the tab shows it as still working. */
  compacting: boolean;
  /** Wall clock the session was last touched by a tab-facing route. */
  lastAccessed: number;
  /**
   * What this bridge saw and did not understand, and what Pi told it.
   *
   * Runtime-only: a restart re-observes whatever is still true, and persisting
   * it would report a dead process's drift against a live one.
   */
  health: RuntimeHealthRecorder;
}

export interface PersistedSession {
  readOnly?: boolean;
  id: string;
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  clientSessionKey?: string;
  sessionFile?: string;
  piSessionId?: string;
  status: SessionStatus;
  error?: string;
  title?: string;
  messages: BridgeMessage[];
  droppedMessages?: number;
  droppedParts?: number;
  transcriptTruncated?: boolean;
  revision: number;
  structured: Array<[string, unknown]>;
  promptJournal: PromptJournalEntry[];
  steerJournal?: SteerJournalEntry[];
  composer?: NativeAgentComposerState;
  usage?: PersistedUsage;
  /** Public descriptors only; restored as `stale` until the next attach. */
  commands?: NativeAgentSlashCommand[];
  commandsTruncated?: boolean;
}

export interface PersistedState {
  version: 1;
  provider: "pi";
  sessions: PersistedSession[];
}

export const sessions = new Map<string, SessionState>();
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

export function piRunId(state: Pick<SessionState, "promptSequence">): string {
  return `pi:${bridgeGeneration}:${state.promptSequence}`;
}

/** See {@link SessionState.promptStartup}. */
export interface PromptStartupHandle {
  claim: number;
  abort: () => Promise<void>;
  /** The abort currently in flight, so concurrent cancels share one. */
  aborting?: Promise<void>;
}

/** Process-wide so a token can never be reused by another session's turn. */
let promptClaims = 0;

/** Settles when a claim is released, for a close that must wait the turn out. */
const claimReleases = new WeakMap<
  SessionState,
  { claim: number; resolve: () => void; promise: Promise<void> }
>();

/**
 * Reserve the admitted-turn token for a prompt, synchronously, at admission.
 *
 * Stale cancellation is cleared here, at the claim, rather than after an await:
 * a cancel can only be recorded against this token once it exists, so nothing
 * aimed at this turn is erased and nothing left from an earlier one survives.
 */
export function claimPromptTurn(state: SessionState): number {
  promptClaims += 1;
  const claim = promptClaims;
  state.promptClaim = claim;
  state.cancelRequestedClaim = undefined;
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  claimReleases.set(state, { claim, resolve, promise });
  return claim;
}

/**
 * Reserve a claim at the prompt route's entry, before its body is read.
 *
 * Only when nothing else owns the session: a running turn, configuration,
 * compaction or another prompt's claim mean this request is a follow-up or
 * will be refused, and a cancel arriving meanwhile belongs to that owner. A
 * closed session admits nothing. Returns the claim, or `undefined` when the
 * route must claim (or refuse) later at its ordinary busy check.
 */
export function reservePromptAdmission(state: SessionState, closed: boolean): number | undefined {
  if (
    closed ||
    state.status === "running" ||
    state.dispatching ||
    state.compacting ||
    state.promptClaim !== undefined
  ) {
    return undefined;
  }
  return claimPromptTurn(state);
}

/** Release a claim once its turn is terminal. A newer claim is left alone. */
export function releasePromptClaim(state: SessionState, claim: number | undefined): void {
  if (claim === undefined) return;
  if (state.promptClaim === claim) state.promptClaim = undefined;
  if (state.cancelRequestedClaim === claim) state.cancelRequestedClaim = undefined;
  if (state.promptStartup?.claim === claim) state.promptStartup = undefined;
  const release = claimReleases.get(state);
  if (release?.claim === claim) {
    claimReleases.delete(state);
    release.resolve();
  }
}

/** Settles once the current prompt claim (if any) has been released. */
export function promptClaimReleased(state: SessionState): Promise<void> {
  if (state.promptClaim === undefined) return Promise.resolve();
  return claimReleases.get(state)?.promise ?? Promise.resolve();
}

/**
 * The status a reader is told.
 *
 * A claimed prompt Pi has not settled yet — still preparing, in preflight, or
 * abandoned at its startup deadline while Pi could still accept it — is
 * reported as running. `/status`, `/activity`, `/messages` and `GET /session`
 * all answer from this, so the backend's stop ladder never reads idle (or a
 * terminal error) while something can still reach Pi.
 */
export function publicTurnStatus(state: SessionState): SessionState["status"] {
  return state.promptClaim !== undefined ? "running" : state.status;
}

/** Whether cancellation was requested for exactly this claim. */
export function cancelRequestedFor(state: SessionState, claim: number | undefined): boolean {
  return claim !== undefined && state.cancelRequestedClaim === claim;
}

/** Whether the prompt that currently owns the turn has been asked to stop. */
export function turnCancellationRequested(state: SessionState): boolean {
  return cancelRequestedFor(state, state.promptClaim);
}

/** Sessions whose removal is being published; left out of the state file. */
const pendingRemoval = new WeakSet<SessionState>();

/**
 * Mark a closing session as removed for persistence only.
 *
 * Close keeps the session registered until its removal is on disk, so a retry
 * can never be told `missing` for a close that later rolls back; the state
 * file must meanwhile describe the world *after* the removal, or publishing
 * it would publish nothing.
 */
export function setPendingRemoval(state: SessionState, pending: boolean): void {
  if (pending) pendingRemoval.add(state);
  else pendingRemoval.delete(state);
}

export function isPendingRemoval(state: SessionState): boolean {
  return pendingRemoval.has(state);
}

export function setSteerJournal(state: SessionState, entry: SteerJournalEntry): void {
  state.steerJournal.delete(entry.requestId);
  state.steerJournal.set(entry.requestId, entry);
  while (state.steerJournal.size > MAX_STEER_JOURNAL) {
    const oldest = state.steerJournal.keys().next();
    if (oldest.done) break;
    state.steerJournal.delete(oldest.value);
  }
}

/**
 * Live source state for a tool part, keyed off the part itself.
 *
 * Tool cards are patched in place across start → update → end, and the raw SDK
 * payload that produced them is far larger than what is rendered. Keeping it
 * out of the transcript keeps the display budget honest.
 */
export interface ToolSourceState {
  /**
   * Serialized size of the rendered part the last time it was charged against
   * `uncheckedTranscriptBytes`. Only the delta is new on a patch, so charging
   * the whole part per streaming frame would re-bill a 1MiB diff every frame.
   */
  chargedBytes?: number;
}

export const toolSourceStates = new WeakMap<BridgeToolPart, ToolSourceState>();

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether this session still has work in flight.
 *
 * Compaction counts. It runs after a turn and rewrites the context the next
 * turn reads, so an environment reported idle in the middle of one is an
 * environment a build pipeline will advance past while its history is still
 * being rewritten underneath it.
 */
export function sessionIsWorking(state: SessionState): boolean {
  // An admitted prompt still preparing (cold attach, preflight) is work in
  // flight: reporting idle there would let a stop request read as settled
  // while Pi may still accept the turn.
  return state.status === "running" || state.compacting || state.promptClaim !== undefined;
}

/**
 * Whether this session is waiting on a person.
 *
 * Distinct from working: the backend's activity sweep reports a parked
 * approval as `blocked` so the tab can surface it, rather than as busy work
 * nobody needs to look at.
 */
export function sessionIsBlocked(state: SessionState): boolean {
  return state.approvals.size > 0;
}
