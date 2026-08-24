/**
 * The transcript model this bridge serves, and the per-session state that
 * produces it.
 *
 * The shape is the provider-neutral one Orkestrator's shared renderer already
 * consumes for every agent platform. Keeping it identical is the whole point
 * of the adapter: the Cursor SDK's event vocabulary is translated here, once,
 * so nothing downstream needs to know which engine produced a transcript.
 */
import type { SDKAgent } from "@cursor/sdk";
import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";

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
  clientSessionKey?: string;
  /** The SDK's own agent id. Stable across bridge restarts; what resume takes. */
  agentId?: string;
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
  /** Live background children, maintained incrementally for `/activity`. */
  activeSubagentDescriptors: Map<string, ActiveSubagentDescriptor>;
  /** Fatal latch: once the bound trips, later frames cannot reopen work. */
  subagentLimitExceeded: boolean;
  /** Merge source for the next todo update; restored from the newest part. */
  todos: TodoItem[];
  composer: NativeAgentComposerState;
  /** The attached SDK agent, or null when this session is detached. */
  agent: SDKAgent | null;
  /** The in-flight attach, shared by every caller that wants this attached. */
  attaching?: Promise<SDKAgent>;
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
  currentTurnUsage?: TurnUsage;
  turnStartedAt?: number;
  /** Wall clock the session was last touched by a tab-facing route. */
  lastAccessed: number;
}

export interface PersistedSession {
  id: string;
  clientSessionKey?: string;
  agentId?: string;
  status: SessionStatus;
  error?: string;
  messages: BridgeMessage[];
  droppedMessages?: number;
  droppedParts?: number;
  transcriptTruncated?: boolean;
  revision: number;
  structured: Array<[string, unknown]>;
  promptJournal: PromptJournalEntry[];
  composer?: NativeAgentComposerState;
  usage?: PersistedUsage;
  subagentLimitExceeded?: boolean;
}

export interface PersistedState {
  version: 1;
  provider: "cursor";
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
