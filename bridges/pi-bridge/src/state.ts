/**
 * The transcript model this bridge serves, and the per-session state that
 * produces it.
 *
 * The shape is the provider-neutral one Orkestrator's shared renderer already
 * consumes for every agent platform. Keeping it identical is the whole point
 * of the adapter: Pi's event vocabulary is translated here, once, so nothing
 * downstream needs to know which engine produced a transcript.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  NativeAgentComposerState,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";

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

export type BridgeMessagePart = BridgeTextPart | BridgeFilePart | BridgeToolPart;

export interface PromptJournalEntry {
  requestId: string;
  state: "prepared" | "accepted" | "completed" | "failed" | "ambiguous";
  acceptedAt: number;
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
  modelId?: string;
  durationMs?: number;
  costUsd?: number;
  /** Whole-session context occupancy, which Pi reports directly. */
  contextTokens?: number;
  contextWindow?: number;
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
  id: string;
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
  /** Tool calls parked on a human decision, newest last. */
  approvals: Map<string, PendingApproval>;
  /** Merge source for the next todo update; restored from the newest part. */
  todos: TodoItem[];
  composer: NativeAgentComposerState;
  /** The attached Pi session, or null when this bridge session is detached. */
  session: AgentSession | null;
  /** Releases the SDK event subscription that feeds `translate.ts`. */
  unsubscribe?: () => void;
  /** The in-flight attach, shared by every caller that wants this attached. */
  attaching?: Promise<AgentSession>;
  /** Cancels the turn in flight. Never persisted. */
  cancelTurn?: () => Promise<void>;
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
   * The text and thinking blocks still being appended to, by kind.
   *
   * Pi interleaves reasoning with prose, so "the last part" is not a reliable
   * way to find the block a delta continues. Held by `sourcePartId` rather than
   * by reference so a transcript trim that drops the part simply fails the
   * lookup and starts a new block.
   */
  openTextParts: Map<string, string>;
  /** Bytes appended since the transcript was last measured against its budget. */
  uncheckedTranscriptBytes: number;
  /** Accumulates the assistant text of a structured-output turn. */
  currentTurnOutput: string | null;
  usage?: PersistedUsage;
  currentTurnUsage?: TurnUsage;
  turnStartedAt?: number;
  /** Steering and follow-up prompts Pi is holding for the running turn. */
  queue: { steering: string[]; followUp: string[] };
  /** Prompt templates, skills and extension commands the session offers. */
  slashCommands: NativeAgentSlashCommand[];
  /** True while Pi is compacting; the tab shows it as still working. */
  compacting: boolean;
  /** Wall clock the session was last touched by a tab-facing route. */
  lastAccessed: number;
}

export interface PersistedSession {
  id: string;
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
  composer?: NativeAgentComposerState;
  usage?: PersistedUsage;
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
  return state.status === "running" || state.compacting;
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
