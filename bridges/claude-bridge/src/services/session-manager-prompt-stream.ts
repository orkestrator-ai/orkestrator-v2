import type {
  MessagePatchEventData,
  NormalizedMessage,
  NormalizedPart,
  SessionState,
} from "../types/index.js";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import { TaskRegistry } from "@orkestrator/protocol/task-list";
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
import { eventEmitter } from "./event-emitter.js";
import { markTranscriptChanged } from "./transcript-revision.js";
import {
  ToolTracker,
  buildMessageParts,
  type OrderedPartEntry,
} from "./session-manager-messages.js";
import { getMessageTextFromParts, isSamePublishedPart } from "./session-manager-persistence.js";

/** One finalized `assistant` record, already parsed, for {@link PromptStreamState.applyAssistantRecord}. */
export interface AssistantRecordInput {
  /** The API message id (`msg_…`) the record belongs to, when it names one. */
  apiMessageId?: string;
  /** The record's own transcript uuid. */
  uuid?: string;
  parentToolUseId?: string;
  isRoot: boolean;
  orderedParts: OrderedPartEntry[];
  contentBlockCount: number;
  modelId?: string;
  receivedAt?: string;
}

export interface PromptStreamState {
  /** The row of the newest root model response in this turn, once it has content. */
  readonly currentAssistantMessage: NormalizedMessage | null;
  /** Whether any row of this turn has produced content. */
  readonly assistantOutputSeen: boolean;
  toolTracker: ToolTracker;
  taskRegistry: TaskRegistry;
  activeTaskIds: Set<string>;
  /**
   * The transcript message holding an unsettled `retry` row.
   *
   * Turn-scoped rather than session-scoped: a retry belongs to the request that
   * failed, and a row still pending when its turn ends is settled by the turn's
   * outcome rather than carried into the next one.
   */
  pendingApiRetryMessageId?: string;
  /** Fold one finalized `assistant` record into the row it belongs to and publish it. */
  applyAssistantRecord: (record: AssistantRecordInput) => void;
  /**
   * Rebuild and publish the current row and every row of this turn holding one
   * of `toolUseIds`, after the tracker's state for those calls changed.
   * Returns the messages it published, so a caller sweeping older turns can
   * skip them.
   */
  refreshToolRows: (toolUseIds: Iterable<string>) => ReadonlySet<NormalizedMessage>;
  /** The row of this turn holding `toolUseId`, else the newest row with content. */
  rowHoldingTool: (toolUseId: string) => NormalizedMessage | null;
  /** Publish a row of this turn whose parts the caller changed in place. */
  publishRow: (message: NormalizedMessage) => void;
  flushStreamedAssistantMessage: () => void;
  applyPartialAssistantMessage: (partialMessage: any) => boolean;
  beginPostSteerScope: () => void;
  clearFlushTimer: () => void;
}

/**
 * Highest content-block index accepted from a streamed SDK event. Reject larger
 * indices rather than retaining malformed sparse state for the rest of a turn.
 */
export const MAX_STREAM_CONTENT_BLOCK_INDEX = 4_095;

/**
 * Rows of one turn that still accept output and tool updates.
 *
 * A turn kept alive by background work can answer task notifications for
 * hours, adding a row per model response. The oldest rows past this bound
 * stop being tracked: their messages stay in the transcript exactly as last
 * published, and a late subagent frame for a call they hold lands on the
 * current row instead, as every frame did before rows were split.
 */
export const MAX_TRACKED_STREAM_ROWS = 256;

/**
 * Subagent parts a row keeps for each call that started one.
 *
 * A subagent's output joins the row holding its call, and a foreground agent
 * can answer for an hour while the root opens no new row — the oversized row
 * one row per response exists to prevent, rebuilt on the parent. Its oldest
 * parts go first; the call's own card and result stay, and a reload shows
 * none of a subagent's steps anyway.
 */
export const MAX_SUBAGENT_PARTS_PER_CALL = 128;

/**
 * One transcript row: a root model response, plus the output of every
 * subagent started by a call it holds.
 *
 * A turn used to be a single row. A turn the CLI keeps alive for background
 * work then grew for hours (thousands of parts, megabytes) and no longer fit
 * any transcript window, so readers could only show a trimmed copy of it and
 * lost it entirely once a newer row pushed it out of the live tail. One row per
 * model response keeps rows small, as a reload from the rollout already does.
 */
interface StreamRow {
  /** Creation order, so a flush publishes older rows first. */
  sequence: number;
  /** The row's id: the API message id that opened it. */
  key: string;
  message: NormalizedMessage | null;
  /**
   * Blocks grouped by API message id (`msg_…`) and, within a message, by
   * content-block index. This is the only identity stable across the SDK
   * events that describe one block:
   *   - every `stream_event` carries its own random `uuid`, so grouping deltas
   *     by `uuid` produces one part per delta (a "Thinking" row per token);
   *   - the SDK emits one non-streaming `assistant` message per content block,
   *     each with a fresh `uuid` but the same `message.id`, so grouping those
   *     by `uuid` appends a duplicate copy of already-streamed content.
   * Grouping by (api message id, block index) makes deltas collapse onto the
   * block they belong to and makes the final block overwrite what it streamed.
   * Each message's blocks live in a map keyed by block index. A malformed
   * large index therefore cannot create a huge sparse array whose iteration
   * stalls the bridge; the small set of received indices is sorted on flush.
   */
  blocksByApiMessage: Map<string, Map<number, OrderedPartEntry>>;
  /** Flattened view of `blocksByApiMessage`, in message order then block order. */
  orderedParts: OrderedPartEntry[];
  toolUseIds: Set<string>;
  finalizedBlockCounts: Map<string, number>;
  modelId?: string;
  /**
   * The transcript uuid of the row's latest root record. The SDK emits one
   * `assistant` record per content block; the latest root one is the inclusive
   * end of the row, which is what a fork boundary must point at. A subagent's
   * records live in its own sidechain and can never be one.
   */
  sdkUuid?: string;
  /**
   * The transcript message this row follows: whatever was last when the
   * response started. A response can start before a steer's user row and
   * produce its first content after it; it still belongs above that row.
   */
  anchor: NormalizedMessage | undefined;
  /** Parts exactly as last published, to decide what a frame must carry. */
  publishedParts: NormalizedPart[];
  published: boolean;
  publishedModelId?: string;
}

// Released turns and their successor share API message identity. The map is
// bounded like each stream's row state and weakly owned by the session.
const sessionStreamRows = new WeakMap<
  SessionState,
  { messages: NormalizedMessage[]; rows: Map<string, StreamRow> }
>();

/**
 * Where a streamed block event lands: its row, its message's blocks, and the
 * block's index there. Each stream fills one object for every block event
 * rather than allocating a new one per token.
 */
interface StreamBlockTarget {
  row: StreamRow;
  blocks: Map<number, OrderedPartEntry>;
  blockIndex: number;
  messageKey: string;
  parentTaskUseId: string | undefined;
}

export interface PromptStreamOptions {
  flushIntervalMs: number;
  maxBlockIndex: number;
  /**
   * The tracker of the CLI this turn runs on, when it is already running.
   * Every turn on one process shares it, so a report for a tool an earlier
   * turn started still finds that tool's row.
   */
  toolTracker?: ToolTracker;
  activeTaskIds?: Set<string>;
}

export function createPromptStreamState(
  session: SessionState,
  sessionId: string,
  options: PromptStreamOptions,
): PromptStreamState {
  return new PromptStream(session, sessionId, options);
}

/** The parent call a streamed frame names, when it names one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function explicitParentTaskUseId(partialMessage: any): string | undefined {
  return typeof partialMessage.parent_tool_use_id === "string" &&
    partialMessage.parent_tool_use_id.length > 0
    ? partialMessage.parent_tool_use_id
    : undefined;
}

/** Fold any buffered streamed deltas into the entry's `value`. */
function materializeEntryValue(entry: OrderedPartEntry): void {
  if (entry.pendingChunks) {
    entry.value += entry.pendingChunks.join("");
    entry.pendingChunks = undefined;
  }
}

class PromptStream implements PromptStreamState {
  // Tool tracker persists across all messages in this turn, and across every
  // turn written into the same CLI.
  readonly toolTracker: ToolTracker;
  // The task list, unlike the tool tracker, persists across turns — Claude's
  // tasks survive from one prompt to the next, so the registry hangs off the
  // session and is created once.
  readonly taskRegistry: TaskRegistry;
  // Track active (pending) Task tool IDs for parent tracking
  // This allows us to associate child tools with their parent Task
  readonly activeTaskIds: Set<string>;
  pendingApiRetryMessageId?: string;

  private readonly flushIntervalMs: number;
  private readonly maxBlockIndex: number;
  private streamEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Rows in creation order, the API messages each one holds, and the calls
  // each one holds — a subagent's output renders inside the row holding the
  // call that started it, however many rows later it arrives.
  private readonly rows: StreamRow[] = [];
  private readonly sharedRows: Map<string, StreamRow>;
  private readonly rowByApiMessage = new Map<string, StreamRow>();
  private readonly rowByToolUseId = new Map<string, StreamRow>();
  private currentRow: StreamRow | null = null;
  private rowSequence = 0;
  // Streaming deltas do not consistently repeat their parent relationship.
  // Remember it from whichever frame supplies it so subagent thinking/text
  // does not briefly render as parent-agent output before the final block
  // replaces the stream.
  private readonly parentTaskByApiMessage = new Map<string, string>();
  // API message id of the stream currently being received (set by `message_start`).
  private currentStreamApiMessageId: string | null = null;
  // Fallback keys for messages that carry neither an API message id nor a uuid.
  private syntheticMessageKeyCounter = 0;
  // Rows holding streamed deltas not yet published.
  private readonly dirtyRows = new Set<StreamRow>();
  // The tracked row each published message belongs to.
  private readonly rowOfMessage = new Map<NormalizedMessage, StreamRow>();
  // Whether any row of this turn has produced content, whichever row is current.
  private outputSeen = false;
  private blockTarget: StreamBlockTarget | null = null;
  private readonly flushOnTimer = () => {
    this.streamEventFlushTimer = null;
    this.flushStreamedAssistantMessage();
  };

  constructor(
    private readonly session: SessionState,
    private readonly sessionId: string,
    options: PromptStreamOptions,
  ) {
    this.flushIntervalMs = options.flushIntervalMs;
    this.maxBlockIndex = options.maxBlockIndex;
    this.toolTracker = options.toolTracker ?? new ToolTracker();
    this.taskRegistry = session.taskRegistry ??= new TaskRegistry();
    this.activeTaskIds = options.activeTaskIds ?? new Set<string>();
    let sharedState = sessionStreamRows.get(session);
    if (!sharedState || sharedState.messages !== session.messages) {
      sharedState = { messages: session.messages, rows: new Map() };
      sessionStreamRows.set(session, sharedState);
    }
    this.sharedRows = sharedState.rows;
  }

  get currentAssistantMessage(): NormalizedMessage | null {
    return this.currentRow?.message ?? null;
  }

  get assistantOutputSeen(): boolean {
    return this.outputSeen;
  }

  /** Stop tracking a row: its message stays in the transcript as published. */
  private forgetRow(row: StreamRow): void {
    if (this.dirtyRows.delete(row)) this.materializeRow(row, true);
    // Every API message routed to a row has a block map on it.
    for (const apiMessageId of row.blocksByApiMessage.keys()) {
      if (this.rowByApiMessage.get(apiMessageId) !== row) continue;
      this.rowByApiMessage.delete(apiMessageId);
      this.parentTaskByApiMessage.delete(apiMessageId);
    }
    for (const toolUseId of row.toolUseIds) {
      if (this.rowByToolUseId.get(toolUseId) === row) this.rowByToolUseId.delete(toolUseId);
    }
    if (row.message) this.rowOfMessage.delete(row.message);
  }

  private createRow(key: string, modelId?: string): StreamRow {
    const { rows, sharedRows, session } = this;
    const shared = sharedRows.get(key);
    if (shared && (!shared.message || session.messages.includes(shared.message))) {
      rows.push(shared);
      if (shared.message) this.rowOfMessage.set(shared.message, shared);
      while (rows.length > MAX_TRACKED_STREAM_ROWS) this.forgetRow(rows.shift()!);
      for (const id of shared.toolUseIds) this.rowByToolUseId.set(id, shared);
      return shared;
    }
    const row: StreamRow = {
      sequence: (this.rowSequence += 1),
      key,
      message: null,
      blocksByApiMessage: new Map(),
      orderedParts: [],
      toolUseIds: new Set(),
      finalizedBlockCounts: new Map(),
      ...(modelId ? { modelId } : {}),
      anchor: session.messages.at(-1),
      publishedParts: [],
      published: false,
    };
    sharedRows.set(key, row);
    while (sharedRows.size > MAX_TRACKED_STREAM_ROWS) {
      const oldest = sharedRows.keys().next().value;
      if (oldest === undefined) break;
      sharedRows.delete(oldest);
    }
    rows.push(row);
    while (rows.length > MAX_TRACKED_STREAM_ROWS) {
      const oldest = rows.shift()!;
      this.forgetRow(oldest);
    }
    return row;
  }

  /**
   * The row an API message's blocks belong to, opening one if needed.
   *
   * Each root model response opens its own row. Everything else — a
   * subagent's response, or a record that names no API message — joins the
   * row holding its parent call, else the current row, as a whole turn did
   * before rows were split.
   */
  private rowForApiMessage(
    messageKey: string,
    opensRow: boolean,
    parentToolUseId: string | undefined,
    modelId?: string,
  ): StreamRow {
    const known = this.rowByApiMessage.get(messageKey);
    if (known) return known;
    let row: StreamRow | undefined;
    if (!opensRow) {
      row =
        (parentToolUseId ? this.rowByToolUseId.get(parentToolUseId) : undefined) ??
        this.currentRow ??
        undefined;
    }
    if (!row) {
      // Publish what the previous response streamed first, so its row
      // precedes this one in the transcript.
      this.flushStreamedAssistantMessage();
      row = this.createRow(messageKey, modelId);
      this.currentRow = row;
    }
    this.rowByApiMessage.set(messageKey, row);
    return row;
  }

  private getBlocks(row: StreamRow, messageKey: string): Map<number, OrderedPartEntry> {
    let blocks = row.blocksByApiMessage.get(messageKey);
    if (!blocks) {
      blocks = new Map();
      row.blocksByApiMessage.set(messageKey, blocks);
    }
    return blocks;
  }

  private rebuildOrderedParts(row: StreamRow): void {
    const located: Array<{
      entry: OrderedPartEntry;
      blocks: Map<number, OrderedPartEntry>;
      index: number;
      subagent: boolean;
    }> = [];
    // Map iteration is insertion-ordered, which is API message arrival order;
    // block indices may arrive out of order, so sort only the received keys.
    for (const [messageKey, blocks] of row.blocksByApiMessage) {
      const blockIndices = Array.from(blocks.keys()).sort((a, b) => a - b);
      for (const blockIndex of blockIndices) {
        const entry = blocks.get(blockIndex);
        if (!entry) continue;
        materializeEntryValue(entry);
        located.push({ entry, blocks, index: blockIndex, subagent: messageKey !== row.key });
      }
    }
    // Shed each subagent's oldest parts past its bound, from the blocks too, so
    // a long subagent costs the row a fixed amount rather than its whole run.
    // Only a subagent's own responses are shed: the response that opened the
    // row can carry a parent tag on a call it made beside the subagent's, and
    // that call is the root's, not the subagent's.
    const keptPerCall = new Map<string, number>();
    const shed = new Set<OrderedPartEntry>();
    for (let index = located.length - 1; index >= 0; index -= 1) {
      const { entry, blocks, index: blockIndex, subagent } = located[index]!;
      const parent = entry.parentTaskUseId;
      if (!parent || !subagent) continue;
      const kept = (keptPerCall.get(parent) ?? 0) + 1;
      keptPerCall.set(parent, kept);
      if (kept <= MAX_SUBAGENT_PARTS_PER_CALL) continue;
      shed.add(entry);
      blocks.delete(blockIndex);
      if (entry.type === "tool-ref") {
        row.toolUseIds.delete(entry.value);
        if (this.rowByToolUseId.get(entry.value) === row) this.rowByToolUseId.delete(entry.value);
      }
    }
    row.orderedParts =
      shed.size === 0
        ? located.map(({ entry }) => entry)
        : located.filter(({ entry }) => !shed.has(entry)).map(({ entry }) => entry);
  }

  /**
   * Publish a row's current parts.
   *
   * Parts are never mutated in place: `ToolTracker` replaces a tool's object
   * when its result lands, and text/thinking parts are rebuilt from scratch
   * each time, so snapshotting the published array is enough to diff against.
   */
  private emitRow(row: StreamRow): void {
    const { session, sessionId } = this;
    const message = row.message;
    if (!message) return;
    const parts = message.parts;

    // A subscriber cannot patch a message it has never seen, so the first
    // frame for each message is always the whole thing. Model metadata is
    // message-level, not part-level: if the authoritative SDK response
    // resolves after streamed parts were published, send one full frame so
    // live subscribers learn the same model REST hydration will return.
    if (!row.published || row.publishedModelId !== message.modelId) {
      row.published = true;
      row.publishedParts = parts.slice();
      row.publishedModelId = message.modelId;
      // Stamped on the message itself, before it is serialized, so both this
      // frame and any REST read of the transcript agree on the revision.
      message.revision = (message.revision ?? 0) + 1;
      // The stamp is serialized with the message, so it is transcript content.
      markTranscriptChanged(session);
      eventEmitter.emit({ type: "message.updated", sessionId, data: { message } });
      return;
    }

    const changedParts: { index: number; part: NormalizedPart }[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part && !isSamePublishedPart(row.publishedParts[index], part)) {
        changedParts.push({ index, part });
      }
    }

    // Nothing moved and nothing was dropped: a frame here would only cost
    // the client a re-render of identical content. The revision must not
    // advance either — no frame was published, so nobody fell behind.
    if (changedParts.length === 0 && parts.length === row.publishedParts.length) {
      return;
    }

    row.publishedParts = parts.slice();
    message.revision = (message.revision ?? 0) + 1;
    markTranscriptChanged(session);
    eventEmitter.emit({
      type: "message.patched",
      sessionId,
      data: {
        messageId: message.id,
        partCount: parts.length,
        changedParts,
        createdAt: message.createdAt,
        revision: message.revision,
      } satisfies MessagePatchEventData,
    });
  }

  private newestRowMessage(): NormalizedMessage | null {
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const message = this.rows[index]!.message;
      if (message) return message;
    }
    return null;
  }

  /**
   * Place a row's new message where its response started: after its anchor,
   * and after any older row of this turn placed there since. Everything else
   * after the anchor — a steer's user row, a notice, a newer row — arrived
   * after this response started. With the anchor gone (a rewind removed it),
   * or nothing after it, the row goes last.
   */
  private insertAfterAnchor(row: StreamRow, message: NormalizedMessage): void {
    const messages = this.session.messages;
    const anchorIndex = row.anchor ? messages.lastIndexOf(row.anchor) : -1;
    if (anchorIndex < 0) {
      messages.push(message);
      return;
    }
    let index = anchorIndex + 1;
    while (index < messages.length) {
      const owner = this.rowOfMessage.get(messages[index]!);
      if (!owner || owner.sequence > row.sequence) break;
      index += 1;
    }
    messages.splice(index, 0, message);
  }

  /** Rebuild a row's parts from its blocks, creating its message on first content. */
  private materializeRow(row: StreamRow, rebuildBlocks: boolean): void {
    const { session } = this;
    if (rebuildBlocks) this.rebuildOrderedParts(row);
    const parts = buildMessageParts(row.orderedParts, this.toolTracker);
    const content = getMessageTextFromParts(parts);
    if (!row.message) {
      if (parts.length === 0 && !content) return;
      row.message = {
        id: row.key,
        role: "assistant",
        content,
        parts,
        createdAt: new Date().toISOString(),
        ...(row.modelId ? { modelId: row.modelId } : {}),
        ...(row.sdkUuid ? { sdkUuid: row.sdkUuid } : {}),
      };
      this.rowOfMessage.set(row.message, row);
      this.insertAfterAnchor(row, row.message);
      this.outputSeen = true;
    } else {
      row.message.content = content;
      row.message.parts = parts;
      if (row.modelId) row.message.modelId = row.modelId;
      if (row.sdkUuid) row.message.sdkUuid = row.sdkUuid;
    }
    if (row.message && session.messages.at(-1) !== row.message) {
      (session.revisedRows ??= new RecentlyRevisedRows()).note(row.message.id);
    }
    markTranscriptChanged(session);
    this.emitRow(row);
  }

  // Streamed-delta coalescing. Deltas land in their row's blocks immediately;
  // the expensive snapshot (ordered-part rebuild, part build, emit) happens at
  // most once per flushIntervalMs.
  flushStreamedAssistantMessage(): void {
    this.clearFlushTimer();
    if (this.dirtyRows.size === 0) return;
    const pending = [...this.dirtyRows].sort((a, b) => a.sequence - b.sequence);
    this.dirtyRows.clear();
    for (const row of pending) this.materializeRow(row, true);
  }

  private scheduleStreamedAssistantMessageFlush(row: StreamRow): void {
    this.dirtyRows.add(row);
    this.streamEventFlushTimer ??= setTimeout(this.flushOnTimer, this.flushIntervalMs);
  }

  applyAssistantRecord(record: AssistantRecordInput): void {
    // Only a root response with an API message id opens a row of its own. A
    // root record naming no API message cannot be told apart from the blocks
    // around it, so it stays on the current row as before.
    const messageKey =
      record.apiMessageId ?? record.uuid ?? `assistant-${(this.syntheticMessageKeyCounter += 1)}`;
    const opensRow = record.isRoot && record.apiMessageId !== undefined;
    const row = this.rowForApiMessage(messageKey, opensRow, record.parentToolUseId, record.modelId);

    // Group by API message id so these blocks land on top of the partial
    // events that streamed them. The SDK sends one assistant message per
    // content block, all sharing `message.id`, so the running finalized-block
    // count gives each block its stream index.
    const blocks = this.getBlocks(row, messageKey);
    const blockIndexBase = row.finalizedBlockCounts.get(messageKey) ?? 0;
    for (const part of record.orderedParts) {
      const blockIndex = blockIndexBase + (part.blockOffset ?? 0);
      const streamedPart = blocks.get(blockIndex);
      blocks.set(blockIndex, {
        ...part,
        timestamp: streamedPart?.timestamp ?? part.timestamp ?? record.receivedAt,
        messageUuid: messageKey,
      });
      if (part.type === "tool-ref") {
        row.toolUseIds.add(part.value);
        this.rowByToolUseId.set(part.value, row);
      }
    }
    row.finalizedBlockCounts.set(messageKey, blockIndexBase + record.contentBlockCount);
    if (record.isRoot && record.modelId) row.modelId = record.modelId;
    if (record.isRoot && record.uuid) row.sdkUuid = record.uuid;
    this.dirtyRows.delete(row);
    this.materializeRow(row, true);
  }

  refreshToolRows(toolUseIds: Iterable<string>): ReadonlySet<NormalizedMessage> {
    const affected = new Set<StreamRow>();
    if (this.currentRow) affected.add(this.currentRow);
    for (const toolUseId of toolUseIds) {
      const row = this.rowByToolUseId.get(toolUseId);
      if (row) affected.add(row);
    }
    const published = new Set<NormalizedMessage>();
    for (const row of [...affected].sort((a, b) => a.sequence - b.sequence)) {
      if (!row.message) continue;
      // Streamed deltas still buffered for this row are folded in now rather
      // than left to the flush that would otherwise republish it a moment later.
      const rebuildBlocks = this.dirtyRows.delete(row);
      this.materializeRow(row, rebuildBlocks);
      published.add(row.message);
    }
    return published;
  }

  rowHoldingTool(toolUseId: string): NormalizedMessage | null {
    return (
      this.rowByToolUseId.get(toolUseId)?.message ??
      this.currentRow?.message ??
      this.newestRowMessage()
    );
  }

  publishRow(message: NormalizedMessage): void {
    const row = this.rowOfMessage.get(message);
    if (row) this.emitRow(row);
  }

  /**
   * Fold one `stream_event` frame into its row. Runs once per streamed token,
   * so neither it nor the handlers below may allocate beyond the entry a
   * block needs.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyPartialAssistantMessage(partialMessage: any): boolean {
    const streamEvent = partialMessage.event;
    switch (streamEvent?.type) {
      case "message_start":
        return this.applyMessageStart(partialMessage, streamEvent);
      case "message_stop":
        return this.applyMessageStop();
      case "content_block_start": {
        const target = this.locateStreamBlock(partialMessage, streamEvent);
        return target ? this.applyContentBlockStart(target, streamEvent.content_block) : false;
      }
      case "content_block_delta": {
        const target = this.locateStreamBlock(partialMessage, streamEvent);
        return target ? this.applyContentBlockDelta(target, streamEvent.delta) : false;
      }
      default:
        // Nothing to render (`content_block_stop`, say), but the frame still
        // routes its message to a row, exactly as the block events above do.
        this.locateStreamBlock(partialMessage, streamEvent);
        return false;
    }
  }

  // `message_start` is the only stream event carrying the API message id;
  // every later event for the same message must inherit it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyMessageStart(partialMessage: any, streamEvent: any): false {
    const apiMessageId =
      typeof streamEvent.message?.id === "string" ? streamEvent.message.id : undefined;
    this.currentStreamApiMessageId = apiMessageId ?? null;
    const isRootAssistant = isRootAssistantRecord(
      partialMessage.parent_tool_use_id,
      partialMessage.isSidechain,
    );
    const modelId = isRootAssistant
      ? normalizeBackendModelId(streamEvent.message?.model)
      : undefined;
    if (apiMessageId) {
      const parentTaskUseId = explicitParentTaskUseId(partialMessage);
      if (parentTaskUseId) this.parentTaskByApiMessage.set(apiMessageId, parentTaskUseId);
      const row = this.rowForApiMessage(apiMessageId, isRootAssistant, parentTaskUseId, modelId);
      if (modelId) row.modelId = modelId;
      this.getBlocks(row, apiMessageId);
    }
    return false;
  }

  private applyMessageStop(): false {
    this.currentStreamApiMessageId = null;
    return false;
  }

  /**
   * The row and block a block event addresses: its index, the message it
   * belongs to and the parent call it runs under. Null for an index outside
   * `0..maxBlockIndex` or a frame naming no message.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private locateStreamBlock(partialMessage: any, streamEvent: any): StreamBlockTarget | null {
    const blockIndex: number | undefined =
      Number.isInteger(streamEvent?.index) &&
      streamEvent.index >= 0 &&
      streamEvent.index <= this.maxBlockIndex
        ? streamEvent.index
        : undefined;
    if (blockIndex === undefined) return null;

    // Only fall back to the event uuid when no `message_start` was seen, which
    // real SDK streams always send before any block event.
    const messageKey =
      this.currentStreamApiMessageId ??
      (typeof partialMessage.uuid === "string" ? partialMessage.uuid : undefined);
    if (!messageKey) return null;
    const explicitParent = explicitParentTaskUseId(partialMessage);
    const parentTaskUseId = explicitParent ?? this.parentTaskByApiMessage.get(messageKey);
    if (explicitParent) this.parentTaskByApiMessage.set(messageKey, explicitParent);

    // A block whose message never started (no `message_start`) joins the
    // current row rather than opening one per delta.
    const row = this.rowForApiMessage(messageKey, false, parentTaskUseId);
    const blocks = this.getBlocks(row, messageKey);
    const target = (this.blockTarget ??= { row, blocks, blockIndex, messageKey, parentTaskUseId });
    target.row = row;
    target.blocks = blocks;
    target.blockIndex = blockIndex;
    target.messageKey = messageKey;
    target.parentTaskUseId = parentTaskUseId;
    return target;
  }

  /** A text or thinking block opens; any other block type is not rendered here. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyContentBlockStart(target: StreamBlockTarget, contentBlock: any): boolean {
    let type: "text" | "thinking";
    let value: string;
    if (contentBlock?.type === "text") {
      type = "text";
      value = typeof contentBlock.text === "string" ? contentBlock.text : "";
    } else if (contentBlock?.type === "thinking") {
      type = "thinking";
      value = typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
    } else {
      return false;
    }
    const existing = target.blocks.get(target.blockIndex);
    this.storeStreamedEntry(target, {
      type,
      value,
      timestamp: existing?.timestamp ?? new Date().toISOString(),
      messageUuid: target.messageKey,
      parentTaskUseId: target.parentTaskUseId,
    });
    return true;
  }

  /** A text or thinking delta extends its block; any other delta is not rendered here. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyContentBlockDelta(target: StreamBlockTarget, delta: any): boolean {
    if (delta?.type === "text_delta") {
      const chunk = typeof delta.text === "string" ? delta.text : "";
      this.storeStreamedEntry(target, this.appendStreamedDelta(target, "text", chunk));
    } else if (delta?.type === "thinking_delta") {
      const chunk = typeof delta.thinking === "string" ? delta.thinking : "";
      this.storeStreamedEntry(target, this.appendStreamedDelta(target, "thinking", chunk));
    } else {
      return false;
    }
    return true;
  }

  /**
   * Append a streamed delta without rebuilding the block's string: chunks are
   * buffered on the entry and joined once per flush. A delta whose type
   * disagrees with the existing entry starts a fresh entry seeded with the old
   * (materialized) value, preserving the previous behavior.
   */
  private appendStreamedDelta(
    target: StreamBlockTarget,
    type: "text" | "thinking",
    chunk: string,
  ): OrderedPartEntry {
    const entry = target.blocks.get(target.blockIndex);
    if (entry?.type === type) {
      entry.parentTaskUseId ??= target.parentTaskUseId;
      (entry.pendingChunks ??= []).push(chunk);
      return entry;
    }
    if (entry) materializeEntryValue(entry);
    return {
      type,
      value: `${entry?.value ?? ""}${chunk}`,
      timestamp: entry?.timestamp ?? new Date().toISOString(),
      messageUuid: target.messageKey,
      parentTaskUseId: entry?.parentTaskUseId ?? target.parentTaskUseId,
    };
  }

  private storeStreamedEntry(target: StreamBlockTarget, entry: OrderedPartEntry): void {
    target.blocks.set(target.blockIndex, entry);
    this.scheduleStreamedAssistantMessageFlush(target.row);
  }

  // Publish what streamed so far, so the row holding it precedes the steer's
  // user row. The steer's response is a new model response, so it opens a
  // row of its own; records of a response the steer interrupted still name
  // that response's API message and stay on its row.
  beginPostSteerScope(): void {
    this.flushStreamedAssistantMessage();
  }

  clearFlushTimer(): void {
    if (this.streamEventFlushTimer) {
      clearTimeout(this.streamEventFlushTimer);
      this.streamEventFlushTimer = null;
    }
  }
}
