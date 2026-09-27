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
import {
  boundTranscriptInPlace,
  encodedJsonBytes,
  type TranscriptLimits,
} from "@orkestrator/protocol/transcript-budget";
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
  // child's oldest steps is what keeps the rest of the message in the window.
  const newest = state.messages.at(-1);
  const childTrimmed = newest ? boundNestedParts(state, newest, undefined, true) : false;
  const trimmed = boundTranscriptInPlace(state, TRANSCRIPT_LIMITS);
  if (trimmed || childTrimmed) forgetEvictedOpenText(state);
  return trimmed || childTrimmed;
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
  grownParents?: ReadonlySet<string>,
): void {
  const stats = statsFor(state);
  stats.checks += 1;
  const newest = state.messages.at(-1);
  // A new nested part is the only thing that can raise a sub-agent's count,
  // so the count check runs exactly then, for exactly those sub-agents.
  if (newest && grownParents && grownParents.size > 0) {
    const started = performance.now();
    stats.childChecks += 1;
    if (boundNestedParts(state, newest, grownParents, false)) {
      stats.trims += 1;
      forgetEvictedOpenText(state);
    }
    recordCheckDuration(stats, started);
  }
  if (
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
  state.openTextParts.clear();
  state.currentAssistantMessageId = undefined;
  state.transcriptEpoch = (state.transcriptEpoch ?? 0) + 1;
  state.revision += 1;
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
 * Nested activity (`parentTaskUseId`) is flat in the parent's message, so the
 * per-message part cap bounds it only in aggregate: one child running
 * hundreds of tools would evict its launch card, its siblings and the
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
  const retained = new Set(state.messages.at(-1)?.parts.map((part) => part.sourcePartId));
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
