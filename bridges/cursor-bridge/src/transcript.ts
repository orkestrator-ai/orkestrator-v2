/**
 * Keeping the rendered transcript inside its display budget.
 *
 * The bridge holds one transcript per session for the lifetime of an
 * environment and serves it whole to a renderer. Trimming is therefore a
 * presentation concern with a hard memory consequence, and it is deliberately
 * separate from whether background work still exists — dropping a tool card
 * for display must never be read as evidence that the tool stopped running.
 */
import {
  MAX_CHILD_BYTES_PER_TASK,
  MAX_CHILD_PARTS_PER_TASK,
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_TRANSCRIPT_BYTES,
} from "./config.js";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import {
  boundTranscriptInPlace,
  encodedJsonBytes,
  type TranscriptLimits,
} from "@orkestrator/protocol/node/transcript-budget";
import {
  saturatedText,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeTextPart,
  type SessionState,
} from "./state.js";

const TRUNCATION_NOTICE = "\n\n[output truncated]";
/** Maximum charged growth between exact measurements while streaming. */
export const STREAM_BOUND_INTERVAL_BYTES = Math.min(MAX_TRANSCRIPT_BYTES, 1024 * 1024);

const TRANSCRIPT_LIMITS: TranscriptLimits = {
  maxMessages: MAX_MESSAGES,
  maxPartsPerMessage: MAX_PARTS_PER_MESSAGE,
  maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
};

/**
 * Append to a byte-capped buffer, returning the value to store.
 *
 * Returns the original reference unchanged once saturated so callers can skip
 * the write entirely; `carrier` is what records saturation, so an already-full
 * part costs one WeakSet lookup per remaining chunk instead of a full re-encode.
 */
export function appendBounded(
  carrier: BridgeMessage | BridgeMessagePart,
  current: string,
  addition: string,
  limit = MAX_MESSAGE_TEXT_BYTES,
): string {
  if (!addition) return current;
  if (saturatedText.has(carrier)) return current;
  const currentBytes = Buffer.byteLength(current);
  const additionBytes = Buffer.byteLength(addition);
  if (currentBytes + additionBytes <= limit) return current + addition;

  const available = limit - currentBytes - Buffer.byteLength(TRUNCATION_NOTICE);
  saturatedText.add(carrier);
  if (available <= 0) {
    return current.endsWith(TRUNCATION_NOTICE) ? current : current + TRUNCATION_NOTICE;
  }
  return current + sliceToBytes(addition, available) + TRUNCATION_NOTICE;
}

/** Truncate a standalone string to a byte budget, marking it when it trims. */
export function boundText(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  const available = Math.max(0, limit - Buffer.byteLength(TRUNCATION_NOTICE));
  return sliceToBytes(value, available) + TRUNCATION_NOTICE;
}

/** Cut a string at a byte budget without splitting a UTF-8 code point. */
export function sliceToBytes(value: string, limit: number): string {
  if (limit <= 0) return "";
  const buffer = Buffer.from(value);
  if (buffer.length <= limit) return value;
  // `toString` on a buffer cut mid-sequence yields U+FFFD; walk back to the
  // last lead byte so the trimmed text stays valid rather than merely short.
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Bring the transcript back inside its budget.
 *
 * Runs the cheap structural bounds first (message count, parts per message)
 * and then measures each retained message exactly once — never the shrinking
 * transcript again per dropped entry. Returns true when anything was dropped,
 * so the caller can bump the revision the renderer watches.
 */
export function boundTranscript(state: SessionState): boolean {
  // Sub-agent bounds first: they are finer-grained, and shedding a chatty
  // child's oldest steps is what keeps the rest of its row in the window.
  let childTrimmed = false;
  for (const row of liveRows(state)) {
    if (boundNestedParts(state, row, undefined, true)) childTrimmed = true;
  }
  const rowsBefore = state.messages.slice();
  const partsBefore = rowsBefore.map((row) => row.parts.length);
  const trimmed = boundTranscriptInPlace(state, TRANSCRIPT_LIMITS);
  if (trimmed) noteFrontTrimmedRows(state, rowsBefore, partsBefore);
  if (trimmed || childTrimmed) forgetEvictedOpenText(state);
  return trimmed || childTrimmed;
}

/**
 * Note the retained rows a bound shed parts from. Rows go only from the front,
 * so what is left lines up with the tail of `rowsBefore`.
 */
function noteFrontTrimmedRows(
  state: SessionState,
  rowsBefore: readonly BridgeMessage[],
  partsBefore: readonly number[],
): void {
  const offset = rowsBefore.length - state.messages.length;
  state.messages.forEach((row, index) => {
    if (row.parts.length < partsBefore[index + offset]!) noteRowRevised(state, row.id);
  });
}

/**
 * Re-measure only when the write path has charged something since the last
 * pass. Called from read routes, where an unconditional bound would make every
 * poll of a large session serialize the transcript twice.
 */
export function boundTranscriptForRead(state: SessionState): void {
  if (state.uncheckedTranscriptBytes === 0) return;
  if (boundTranscript(state)) state.revision += 1;
}

/**
 * Enforce the budget from the SDK's synchronous update callback.
 *
 * A tab can stay inactive for an entire long turn, and `/activity` is
 * deliberately a no-hydration read, so read-time and turn-boundary trimming
 * alone let an unobserved session grow without limit. Structural limits are
 * checked on every update because they cost nothing; the byte measurement is
 * amortized over {@link STREAM_BOUND_INTERVAL_BYTES} of charged growth so
 * streaming never serializes the transcript per token.
 *
 * The retained transcript therefore never exceeds `MAX_TRANSCRIPT_BYTES`
 * plus `STREAM_BOUND_INTERVAL_BYTES` plus one admitted update — and a single
 * update is itself capped by the per-field text, argument, output and diff
 * limits in `config.ts`.
 *
 * Each sub-agent's nested parts are held to `MAX_CHILD_PARTS_PER_TASK` on
 * every update that adds one, and to `MAX_CHILD_BYTES_PER_TASK` at every
 * exact check, so one child's retained bytes never exceed that budget plus
 * `STREAM_BOUND_INTERVAL_BYTES` plus one admitted update. Checks, trims and
 * the slowest check are counted for the runtime-health read.
 */
export function boundTranscriptDuringStreaming(
  state: SessionState,
  grownParents?: ReadonlyMap<string, BridgeMessage>,
): void {
  const stats = statsFor(state);
  stats.checks += 1;
  const newest = state.messages.at(-1);
  // A new nested part is the only thing that can raise a sub-agent's count,
  // so the count check runs exactly then, for exactly those sub-agents, on
  // the row that holds each one's launch card.
  let grownRowsFit = true;
  if (grownParents && grownParents.size > 0) {
    const started = performance.now();
    stats.childChecks += 1;
    let trimmed = false;
    for (const [row, parents] of parentsByRow(grownParents)) {
      if (boundNestedParts(state, row, parents, false)) trimmed = true;
      if (row.parts.length > MAX_PARTS_PER_MESSAGE) grownRowsFit = false;
    }
    if (trimmed) {
      stats.trims += 1;
      forgetEvictedOpenText(state);
    }
    recordCheckDuration(stats, started);
  }
  if (
    grownRowsFit &&
    state.messages.length <= MAX_MESSAGES &&
    (newest?.parts.length ?? 0) <= MAX_PARTS_PER_MESSAGE &&
    state.uncheckedTranscriptBytes < STREAM_BOUND_INTERVAL_BYTES
  ) {
    return;
  }
  const started = performance.now();
  stats.exactChecks += 1;
  if (boundTranscript(state)) {
    stats.trims += 1;
    state.revision += 1;
  }
  recordCheckDuration(stats, started);
}

/**
 * Drop the rendered transcript from `messageId` on, after a destructive rewind.
 *
 * Everything positional about what remains goes with it: the open blocks, the
 * assistant message a turn was writing into and — through a new
 * `transcriptEpoch` — readers' absolute offsets and page cursors, which would
 * otherwise name different messages once new turns land where the old ones
 * were.
 */
export function rewindTranscriptTo(state: SessionState, messageId: string): void {
  const transcriptIndex = state.messages.findIndex((message) => message.id === messageId);
  state.messages.splice(transcriptIndex);
  beginAssistantTurn(state);
  startTranscriptEpoch(state);
  state.revision += 1;
}

/**
 * Which turn wrote each row, so "this turn's rows" survives trims.
 *
 * A turn writes one assistant row per model step (see `translate.ts`), and a
 * late tool result, a shell delta or a sub-agent's output belongs on the row
 * holding its call, which may no longer be the newest. Tagging rows with an
 * opaque per-turn token keeps those lookups to the turn that can still be
 * patched: evicted rows simply stop being found, and a rewind, a rebuilt
 * history or a new prompt starts a token no older row carries. Weakly held and
 * runtime-only; nothing is persisted, so a restored transcript has no live
 * turn until the next one starts.
 *
 * Each claimed row also gets an ordinal, its position in the turn. The turn's
 * rows are a trailing run of the transcript in claim order, and only the front
 * of the transcript is ever trimmed, so a row's ordinal and the first retained
 * row's ordinal locate it without a scan. That is what keeps the lookups below
 * constant-time on a turn of thousands of rows.
 */
interface TurnRows {
  token: object;
  /** Ordinal the next claimed row gets. */
  nextOrdinal: number;
  /** The row each sub-agent writes into, by launch call id. Reset per turn. */
  owners: Map<string, BridgeMessage>;
  /**
   * The ordinal of the newest row holding a card for each call id. Ordinals,
   * not rows, so the index never keeps an evicted row alive.
   */
  calls: Map<string, number>;
  /** False once {@link MAX_INDEXED_CALLS} forced the index to forget entries. */
  callsComplete: boolean;
  /** The last computed start of the turn's rows; see {@link turnStartIndex}. */
  start?: TurnStart;
}

interface RowTag {
  token: object;
  ordinal: number;
}

/**
 * Where the turn's rows began when last measured, with what makes that answer
 * checkable: the array, its length, and the rows at the start and the end.
 * Pushes and front trims both change one of those, so a stale answer is never
 * read; at worst it is recomputed.
 */
interface TurnStart {
  messages: BridgeMessage[];
  length: number;
  index: number;
  first: BridgeMessage | undefined;
  last: BridgeMessage | undefined;
}

const turnRows = new WeakMap<SessionState, TurnRows>();
const rowTurns = new WeakMap<BridgeMessage, RowTag>();

/** Sub-agent rows remembered per turn before the cache starts over. */
const MAX_REMEMBERED_OWNERS = 256;
/**
 * Call ids indexed per turn. Past it the index sheds entries for evicted rows
 * and, if that frees too little, forgets everything and lets lookups the index
 * cannot answer fall back to scanning the turn's rows.
 */
export const MAX_INDEXED_CALLS = 16_384;
let maxIndexedCalls = MAX_INDEXED_CALLS;

/** Lower the call-index cap so a test can reach it; `undefined` restores it. */
export function setMaxIndexedCallsForTests(limit: number | undefined): void {
  maxIndexedCalls = limit ?? MAX_INDEXED_CALLS;
}

function newTurn(): TurnRows {
  return { token: {}, nextOrdinal: 0, owners: new Map(), calls: new Map(), callsComplete: true };
}

function currentTurn(state: SessionState): TurnRows {
  let turn = turnRows.get(state);
  if (!turn) {
    turn = newTurn();
    turnRows.set(state, turn);
  }
  return turn;
}

/**
 * Start a new turn: no row written so far can be continued or patched by it.
 *
 * Every open block goes too, sub-agents' included, because the run that owned
 * them has ended — `settleBackgroundChildren` has already closed their cards.
 */
export function beginAssistantTurn(state: SessionState): void {
  turnRows.set(state, newTurn());
  state.currentAssistantMessageId = undefined;
  state.openTextParts.clear();
}

/** Record that the current turn wrote this row, which was just appended. */
export function claimTurnRow(state: SessionState, row: BridgeMessage): void {
  const turn = currentTurn(state);
  rowTurns.set(row, { token: turn.token, ordinal: turn.nextOrdinal });
  turn.nextOrdinal += 1;
  // Extend the measured start rather than walking the turn again: a claimed
  // push that follows a still-valid measurement either joins the run or, when
  // the turn had no retained rows, begins it.
  const { messages } = state;
  const cached = turn.start;
  if (cached && messages.at(-1) === row && startStillValid(cached, messages, messages.length - 1)) {
    const index = cached.index === cached.length ? messages.length - 1 : cached.index;
    turn.start = { messages, length: messages.length, index, first: messages[index], last: row };
  } else {
    turn.start = undefined;
  }
}

function startStillValid(cached: TurnStart, messages: BridgeMessage[], length: number): boolean {
  return (
    cached.messages === messages &&
    cached.length === length &&
    messages[length - 1] === cached.last &&
    (cached.index === length || messages[cached.index] === cached.first)
  );
}

/**
 * Index of the oldest retained row of the current turn, or `messages.length`
 * when it has none. The turn's rows are the trailing run carrying its token.
 * Measured once and reused until the transcript changes shape.
 */
export function turnStartIndex(state: SessionState): number {
  const turn = turnRows.get(state);
  const { messages } = state;
  if (!turn) return messages.length;
  const cached = turn.start;
  if (cached && startStillValid(cached, messages, messages.length)) return cached.index;
  let index = messages.length;
  while (index > 0 && rowTurns.get(messages[index - 1]!)?.token === turn.token) index -= 1;
  turn.start = {
    messages,
    length: messages.length,
    index,
    first: messages[index],
    last: messages.at(-1),
  };
  return index;
}

/**
 * Index of the oldest row an update may still write to: the current turn's
 * first, or — when this process never started a turn here, as with a restored
 * transcript — the newest row, which is all the bridge ever patched before
 * rows were tracked by turn.
 */
export function writableStartIndex(state: SessionState): number {
  return turnRows.has(state) ? turnStartIndex(state) : Math.max(0, state.messages.length - 1);
}

/** The retained row the current turn claimed with this ordinal, if any. */
function turnRowAt(
  state: SessionState,
  turn: TurnRows,
  ordinal: number,
): BridgeMessage | undefined {
  const start = turnStartIndex(state);
  const first = state.messages[start];
  const firstTag = first && rowTurns.get(first);
  if (!firstTag || firstTag.token !== turn.token || ordinal < firstTag.ordinal) return undefined;
  const row = state.messages[start + ordinal - firstTag.ordinal];
  return row && rowTurns.get(row)?.ordinal === ordinal ? row : undefined;
}

/** Whether a row the current turn claimed is still retained. */
function turnRowRetained(state: SessionState, turn: TurnRows, row: BridgeMessage): boolean {
  const tag = rowTurns.get(row);
  return tag?.token === turn.token && turnRowAt(state, turn, tag.ordinal) === row;
}

/** The row a sub-agent's output was last filed under, if it is still retained. */
export function rememberedOwnerRow(
  state: SessionState,
  parentTaskUseId: string,
): BridgeMessage | undefined {
  const turn = turnRows.get(state);
  const row = turn?.owners.get(parentTaskUseId);
  if (!turn || !row) return undefined;
  if (turnRowRetained(state, turn, row)) return row;
  // Not one of the turn's retained rows: the newest row of a restored
  // transcript, or one a trim evicted. Rare, so the exact search is affordable.
  return state.messages.lastIndexOf(row) >= 0 ? row : undefined;
}

export function rememberOwnerRow(
  state: SessionState,
  parentTaskUseId: string,
  row: BridgeMessage,
): void {
  const owners = currentTurn(state).owners;
  if (owners.size >= MAX_REMEMBERED_OWNERS && !owners.has(parentTaskUseId)) owners.clear();
  owners.set(parentTaskUseId, row);
}

/**
 * Record that `row` now holds a card for `callId`.
 *
 * Only rows the current turn claimed are indexed, which are exactly the rows a
 * lookup searches once the turn exists. The newest row wins, as a newest-first
 * scan would.
 */
export function indexToolCall(state: SessionState, callId: string, row: BridgeMessage): void {
  const turn = turnRows.get(state);
  const tag = rowTurns.get(row);
  if (!turn || tag?.token !== turn.token) return;
  const known = turn.calls.get(callId);
  if (known !== undefined && known >= tag.ordinal) return;
  if (known === undefined && turn.calls.size >= maxIndexedCalls) shedIndexedCalls(state, turn);
  turn.calls.set(callId, tag.ordinal);
}

/**
 * Make room in a full call index: drop calls whose row was trimmed away, and
 * forget the rest when that frees less than a quarter, so the next shed is at
 * least that many new calls away.
 */
function shedIndexedCalls(state: SessionState, turn: TurnRows): void {
  const start = turnStartIndex(state);
  const first = state.messages[start];
  const firstTag = first && rowTurns.get(first);
  const firstOrdinal = firstTag?.token === turn.token ? firstTag.ordinal : turn.nextOrdinal;
  for (const [callId, ordinal] of turn.calls) {
    if (ordinal < firstOrdinal) turn.calls.delete(callId);
  }
  if (turn.calls.size > (maxIndexedCalls * 3) / 4) {
    turn.calls.clear();
    turn.callsComplete = false;
  }
}

/**
 * The row the call index places `callId` in.
 *
 * `null` when the index proves no row the turn can still write holds that
 * call; `undefined` when it cannot say — no turn yet, an index that had to
 * forget entries — and the caller has to scan.
 */
export function indexedToolCallRow(
  state: SessionState,
  callId: string,
): BridgeMessage | null | undefined {
  const turn = turnRows.get(state);
  if (!turn) return undefined;
  const ordinal = turn.calls.get(callId);
  if (ordinal === undefined) return turn.callsComplete ? null : undefined;
  // Trimmed rows go from the front, and the indexed row is the newest holding
  // the call, so a trimmed one leaves nothing older to find.
  return turnRowAt(state, turn, ordinal) ?? null;
}

/**
 * Rows a reader may hold a stale copy of, for `revisedMessageIds`.
 *
 * A late result, a measured command change or a settle can patch a row newer
 * steps have pushed out of the live window, and readers only re-read the
 * window. Held off the state object like the bound counters, so no
 * persistence path can pick it up; a restored session starts with none.
 */
const revisedRows = new WeakMap<SessionState, RecentlyRevisedRows>();

/** Note that the row `id` changed in place. */
export function noteRowRevised(state: SessionState, id: string): void {
  // The newest row is always inside the live window; only a row that changes
  // once a newer one exists can be outside it.
  if (state.messages.at(-1)?.id === id) return;
  let rows = revisedRows.get(state);
  if (!rows) {
    rows = new RecentlyRevisedRows();
    revisedRows.set(state, rows);
  }
  rows.note(id);
}

/**
 * Record a change to one row: note it and bump the revision readers compare.
 * Every in-place row change goes through here or `noteRowRevised`.
 */
export function rowChanged(state: SessionState, row: BridgeMessage): void {
  noteRowRevised(state, row.id);
  state.revision += 1;
}

/** Lost revision notes require retained-page reconciliation. */
export function revisedRowsOverflowVersion(state: SessionState): number {
  return revisedRows.get(state)?.overflowVersion ?? 0;
}

/** Recently changed row ids, newest first; undefined when there are none. */
export function revisedRowIds(state: SessionState): string[] | undefined {
  const ids = revisedRows.get(state)?.ids();
  return ids && ids.length > 0 ? ids : undefined;
}

/**
 * Start a new transcript epoch: the history was replaced, not appended to.
 * Ids noted against the old one name nothing in the new one.
 */
export function startTranscriptEpoch(state: SessionState): void {
  revisedRows.get(state)?.clear();
  state.transcriptEpoch = (state.transcriptEpoch ?? 0) + 1;
}

/** Rows that can still be written to; see {@link writableStartIndex}. */
function liveRows(state: SessionState): BridgeMessage[] {
  return state.messages.slice(writableStartIndex(state));
}

function parentsByRow(
  grownParents: ReadonlyMap<string, BridgeMessage>,
): Map<BridgeMessage, Set<string>> {
  const rows = new Map<BridgeMessage, Set<string>>();
  for (const [parent, row] of grownParents) {
    let parents = rows.get(row);
    if (!parents) {
      parents = new Set();
      rows.set(row, parents);
    }
    parents.add(parent);
  }
  return rows;
}

/**
 * Charge appended bytes so the next bound knows the budget may have moved.
 *
 * Charges must be upper bounds on encoded growth — see
 * {@link jsonStringContentBytes} — or the streaming bound can fall behind.
 */
export function chargeTranscript(state: SessionState, bytes: number): void {
  if (bytes > 0) state.uncheckedTranscriptBytes += bytes;
}

/**
 * The notice left where a sub-agent's oldest steps were dropped.
 *
 * Worded like the ACP bridge's trim notice, and keyed by `sourcePartId` so a
 * repeated trim moves one notice rather than stacking several.
 */
export const CHILD_TRIM_NOTICE =
  "[Earlier steps of this sub-agent were dropped: it reached the transcript display limit.]";

/** Child parts a count trim leaves, notice included: headroom so the next child does not trim again. */
export const CHILD_PARTS_AFTER_TRIM = Math.floor((MAX_CHILD_PARTS_PER_TASK * 3) / 4);
/** Child bytes a byte trim leaves, for the same reason. */
export const CHILD_BYTES_AFTER_TRIM = Math.floor((MAX_CHILD_BYTES_PER_TASK * 3) / 4);

export function childTrimNoticePartId(message: BridgeMessage, parentTaskUseId: string): string {
  // Ends in a non-numeric segment so `nextPartOrdinal` never reads a
  // numeric provider call id as an ordinal this bridge issued.
  return `${message.id}:child-trimmed:${parentTaskUseId}:notice`;
}

/**
 * Keep every sub-agent's nested parts inside its own count and byte budget.
 *
 * Nested activity (`parentTaskUseId`) is flat in the row holding its launch
 * card, so the per-message part cap bounds it only in aggregate: one child
 * running hundreds of tools would evict its launch card, its siblings and the
 * parent's prose before any of its own steps. Each child is trimmed
 * oldest-first instead, settled steps before live ones, and never its newest
 * step. With `measureBytes` false only the count is checked, which costs one
 * scan of the message and no serialization.
 *
 * Display only: lifecycle lives in `activeSubagentDescriptors` and the tool
 * state of the cards that remain. Dropping a pending card changes nothing
 * about the call — a later completion re-creates the card from its own
 * payload, and nothing here ever marks a call settled.
 */
export function boundNestedParts(
  state: SessionState,
  message: BridgeMessage,
  parents: ReadonlySet<string> | undefined,
  measureBytes: boolean,
): boolean {
  const groups = new Map<string, { children: number[]; notice?: number }>();
  message.parts.forEach((part, index) => {
    const parent = nestedParent(part);
    if (!parent || (parents && !parents.has(parent))) return;
    let group = groups.get(parent);
    if (!group) {
      group = { children: [] };
      groups.set(parent, group);
    }
    if (part.sourcePartId === childTrimNoticePartId(message, parent)) group.notice = index;
    else group.children.push(index);
  });

  const evicted = new Set<number>();
  const notices: Array<{ parent: string; before: number; existing?: number }> = [];
  let openIds: Set<string> | undefined;
  for (const [parent, group] of groups) {
    const noticeSlots = group.notice === undefined ? 0 : 1;
    const overCount = group.children.length + noticeSlots > MAX_CHILD_PARTS_PER_TASK;
    let sizes: number[] | undefined;
    let bytes = 0;
    if (measureBytes) {
      sizes = group.children.map((index) => encodedJsonBytes(message.parts[index]) + 1);
      bytes = sizes.reduce((total, size) => total + size, 0);
    }
    const overBytes = measureBytes && bytes > MAX_CHILD_BYTES_PER_TASK;
    if (!overCount && !overBytes) continue;

    // One slot is the notice's; the byte target leaves room for it too.
    const noticeBytes = encodedJsonBytes(childTrimNotice(message, parent)) + 1;
    const targetCount = overCount ? CHILD_PARTS_AFTER_TRIM - 1 : group.children.length;
    const targetBytes = overBytes ? CHILD_BYTES_AFTER_TRIM - noticeBytes : Number.POSITIVE_INFINITY;
    let count = group.children.length;
    const dropped = new Set<number>();
    const over = () => count > targetCount || bytes > targetBytes;
    openIds ??= new Set(state.openTextParts.values());
    const candidates = group.children.slice(0, -1);
    for (const live of [false, true]) {
      for (let slot = 0; slot < candidates.length && over(); slot += 1) {
        const index = candidates[slot]!;
        if (dropped.has(index)) continue;
        if (!live && !settledForDisplay(message.parts[index]!, openIds)) continue;
        dropped.add(index);
        count -= 1;
        if (sizes) bytes -= sizes[slot]!;
      }
    }
    if (dropped.size === 0) continue;
    for (const index of dropped) evicted.add(index);
    const firstKept = group.children.find((index) => !dropped.has(index))!;
    notices.push({ parent, before: firstKept, existing: group.notice });
  }
  if (evicted.size === 0) return false;

  const noticeBefore = new Map(notices.map((notice) => [notice.before, notice]));
  const staleNotices = new Set(
    notices.flatMap((notice) => (notice.existing === undefined ? [] : [notice.existing])),
  );
  const next: BridgeMessagePart[] = [];
  message.parts.forEach((part, index) => {
    const notice = noticeBefore.get(index);
    if (notice) {
      const kept = notice.existing === undefined ? undefined : message.parts[notice.existing];
      const placed = kept ?? childTrimNotice(message, notice.parent);
      if (!kept) chargeTranscript(state, encodedJsonBytes(placed) + 1);
      next.push(placed);
    }
    if (evicted.has(index) || staleNotices.has(index)) return;
    next.push(part);
  });
  message.parts = next;
  noteRowRevised(state, message.id);

  const stats = statsFor(state);
  stats.childPartsDropped += evicted.size;
  state.droppedParts += evicted.size;
  state.transcriptTruncated = true;
  state.revision += 1;
  return true;
}

function nestedParent(part: BridgeMessagePart): string | undefined {
  return "parentTaskUseId" in part ? part.parentTaskUseId : undefined;
}

function childTrimNotice(message: BridgeMessage, parentTaskUseId: string): BridgeTextPart {
  return {
    type: "text",
    content: CHILD_TRIM_NOTICE,
    sourcePartId: childTrimNoticePartId(message, parentTaskUseId),
    sourceMessageId: message.id,
    parentTaskUseId,
  };
}

/**
 * Whether dropping this step from the display leaves nothing live behind it.
 *
 * A settled card, a closed text block. Not a pending call, not a sub-agent
 * still running, not the block the child is still writing into — those go
 * only when the settled ones are not enough.
 */
function settledForDisplay(part: BridgeMessagePart, openIds: ReadonlySet<string>): boolean {
  switch (part.type) {
    case "tool-invocation":
      return (
        (part.toolState === "success" || part.toolState === "failure") &&
        part.agentState !== "active"
      );
    case "text":
    case "thinking":
      return !openIds.has(part.sourcePartId);
    default:
      return true;
  }
}

/**
 * Drop open-text lookups whose part a trim removed.
 *
 * The lookup already fails safely for an evicted part; this keeps the map from
 * holding keys for parts that no longer exist, one per sub-agent that wrote.
 */
function forgetEvictedOpenText(state: SessionState): void {
  if (state.openTextParts.size === 0) return;
  // A sub-agent's open block lives on its launch card's row, not necessarily
  // the newest, so every row the turn can still write to counts.
  const retained = new Set(
    liveRows(state).flatMap((row) => row.parts.map((part) => part.sourcePartId)),
  );
  for (const [key, sourcePartId] of state.openTextParts) {
    if (!retained.has(sourcePartId)) state.openTextParts.delete(key);
  }
}

/**
 * How often the producer-side bound runs and what it costs.
 *
 * Counts and one duration, never content: these are exposed on the runtime
 * health read. Runtime-only and per session, held off the state object so no
 * persistence path can pick them up.
 */
export interface TranscriptBoundStats {
  /** Producer-side bound entry points reached: one per top-level update. */
  checks: number;
  /** Of those, how many ran the exact byte measurement. */
  exactChecks: number;
  /** Per-sub-agent count checks, run when an update added a nested part. */
  childChecks: number;
  /** Checks that removed display entries. */
  trims: number;
  /** Nested parts removed by the per-sub-agent bounds. */
  childPartsDropped: number;
  /** Slowest single exact or sub-agent check, in milliseconds (monotonic clock). */
  maxCheckMs: number;
}

const boundStats = new WeakMap<SessionState, TranscriptBoundStats>();

function statsFor(state: SessionState): TranscriptBoundStats {
  let stats = boundStats.get(state);
  if (!stats) {
    stats = {
      checks: 0,
      exactChecks: 0,
      childChecks: 0,
      trims: 0,
      childPartsDropped: 0,
      maxCheckMs: 0,
    };
    boundStats.set(state, stats);
  }
  return stats;
}

function recordCheckDuration(stats: TranscriptBoundStats, started: number): void {
  const elapsed = performance.now() - started;
  if (elapsed > stats.maxCheckMs) stats.maxCheckMs = elapsed;
}

/** A copy of this session's bound counters, with the limits they are measured against. */
export function transcriptBoundSummary(state: SessionState): TranscriptBoundStats & {
  limits: {
    streamIntervalBytes: number;
    childParts: number;
    childBytes: number;
  };
} {
  const stats = statsFor(state);
  return {
    ...stats,
    maxCheckMs: Math.round(stats.maxCheckMs * 1000) / 1000,
    limits: {
      streamIntervalBytes: STREAM_BOUND_INTERVAL_BYTES,
      childParts: MAX_CHILD_PARTS_PER_TASK,
      childBytes: MAX_CHILD_BYTES_PER_TASK,
    },
  };
}
