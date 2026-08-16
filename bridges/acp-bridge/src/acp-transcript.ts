import {
  DIFF_CONTEXT_LINES,
  MAX_DIFF_EDIT_DISTANCE,
  MAX_HISTORY_MESSAGE_IDS,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_MESSAGES,
  MAX_MODEL_ID_BYTES,
  MAX_PARTS_PER_MESSAGE,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_DIFF_BYTES,
  MAX_TOOL_ID_BYTES,
  MAX_TOOL_INLINE_FILE_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_PATH_BYTES,
  MAX_TOOL_TITLE_BYTES,
  MAX_TRANSCRIPT_BYTES,
  TRANSCRIPT_CHECK_INTERVAL_BYTES,
  acpToolSourceStates,
  isObject,
  provider,
  saturatedText,
  trimmedToolCalls,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeTextPart,
  type BridgeToolDiff,
  type BridgeToolPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { schedulePersist } from "./acp-persist-writer.js";

/** Every `session/update` kind that appends to or mutates the transcript. */
export const TRANSCRIPT_UPDATE_KINDS = new Set([
  "user_message",
  "user_message_chunk",
  "agent_message",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "subagent_spawned",
  "subagent_finished",
]);

export function isTranscriptUpdateKind(kind: string): boolean {
  return TRANSCRIPT_UPDATE_KINDS.has(kind);
}

export function findHistoryMessage(state: SessionState, providerMessageId: string): BridgeMessage | undefined {
  const messageId = state.historyMessageIds.get(providerMessageId);
  return messageId ? state.messages.find((message) => message.id === messageId) : undefined;
}

export function rememberHistoryMessage(state: SessionState, providerMessageId: string, messageId: string): void {
  if (!state.historyMessageIds.has(providerMessageId)
    && state.historyMessageIds.size >= MAX_HISTORY_MESSAGE_IDS) {
    const oldest = state.historyMessageIds.keys().next().value;
    if (typeof oldest === "string") state.historyMessageIds.delete(oldest);
  }
  state.historyMessageIds.set(providerMessageId, messageId);
}
export function turnRequiresCompleteOutput(state: SessionState): boolean {
  return state.currentTurnOutput !== null;
}

export function failTranscriptLimit(state: SessionState): void {
  state.outputTruncated = true;
  state.status = "error";
  state.error = `${provider} output exceeded the transcript limit`;
  state.child?.notify("session/cancel", { sessionId: state.acpSessionId });
  state.revision += 1;
  schedulePersist();
}

export const TRANSCRIPT_TRIM_NOTICE =
  "[Earlier steps in this response were dropped: it reached the transcript display limit.]";

export function trimNoticePartId(message: BridgeMessage): string {
  return `${message.id}:transcript-trimmed`;
}

export function isTrimNotice(
  message: BridgeMessage,
  part: BridgeMessagePart | undefined,
): boolean {
  return part !== undefined && part.sourcePartId === trimNoticePartId(message);
}

/**
 * Drop the oldest parts of `message` until it holds at most `targetLength`,
 * leaving one notice in their place. Always drops at least one, so callers can
 * loop on it, and counts the notice against the target so trimming for room
 * cannot itself push the message back over a cap.
 *
 * The announcement matters more here than for the rest of the transcript: the
 * parts most likely to be dropped are the tool calls that did the work, and a
 * silent cut reads as a response that simply never took those steps. The notice
 * is keyed by `sourcePartId`, so repeated trims replace it rather than stack.
 */
export function trimPartsTo(message: BridgeMessage, targetLength: number): number {
  if (isTrimNotice(message, message.parts[0])) message.parts.shift();
  const keep = Math.max(0, targetLength - 1);
  const dropped = message.parts.splice(0, Math.max(1, message.parts.length - keep));
  rememberTrimmedToolCalls(message, dropped);
  message.parts.unshift({
    type: "text",
    content: TRANSCRIPT_TRIM_NOTICE,
    sourcePartId: trimNoticePartId(message),
    sourceMessageId: message.id,
  });
  return dropped.length;
}

/**
 * Record the tool calls a trim just removed, so a late update cannot rebuild
 * one as an empty part. Bounded by the number of parts a message may hold in
 * the first place, oldest evicted first: a turn can trim an unlimited number of
 * calls, and this must not become the unbounded thing that replaces them.
 */
export function rememberTrimmedToolCalls(message: BridgeMessage, dropped: BridgeMessagePart[]): void {
  const ids = trimmedToolCalls.get(message) ?? new Set<string>();
  for (const part of dropped) {
    if (part.type === "tool-invocation") ids.add(part.toolUseId);
  }
  for (const id of ids) {
    if (ids.size <= MAX_PARTS_PER_MESSAGE) break;
    ids.delete(id);
  }
  trimmedToolCalls.set(message, ids);
}

export function boundedString(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return truncateUtf8(value, maximumBytes);
}

export function boundedNullableString(value: unknown, maximumBytes: number): string | undefined {
  return value === null ? undefined : boundedString(value, maximumBytes);
}

export function boundedToolArguments(value: JsonObject): JsonObject {
  const { _toolName: _ignoredToolName, ...argumentsWithoutHint } = value;
  if (Buffer.byteLength(JSON.stringify(argumentsWithoutHint)) <= MAX_TOOL_ARGUMENT_BYTES) {
    return argumentsWithoutHint;
  }
  return { _orkestrator: "Tool input omitted because it exceeded the 512 KiB display limit" };
}

export function mapAcpToolState(status: unknown): BridgeToolPart["toolState"] | undefined {
  if (status === "completed") return "success";
  if (status === "failed") return "failure";
  if (status === "pending" || status === "in_progress") return "pending";
  return undefined;
}

export function stringifyToolPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let serialized: string;
  if (typeof value === "string") serialized = value;
  else {
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch {
      serialized = String(value);
    }
  }
  return truncateDisplayText(serialized, MAX_TOOL_OUTPUT_BYTES, "\n… tool output truncated");
}

export function toolCallContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const pieces = value.flatMap((item) => {
    if (!isObject(item) || item.type === "diff") return [];
    if (item.type === "content") {
      const text = contentText(item.content);
      return text ? [text] : [];
    }
    if (item.type === "terminal") {
      const terminalId = boundedString(item.terminalId, MAX_TOOL_ID_BYTES);
      return [terminalId ? `[Terminal ${terminalId}]` : "[Terminal]"];
    }
    return [];
  });
  if (pieces.length === 0) return undefined;
  return truncateDisplayText(pieces.join("\n"), MAX_TOOL_OUTPUT_BYTES, "\n… tool output truncated");
}

export function toolCallContentDiffs(value: unknown): BridgeToolDiff[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || item.type !== "diff") return [];
    const normalized = normalizeAcpContentDiff(item);
    return normalized ? [normalized] : [];
  });
}

export function normalizeAcpContentDiff(value: JsonObject): BridgeToolDiff | undefined {
  const filePath = boundedString(value.path, MAX_TOOL_PATH_BYTES);
  const rawBefore = typeof value.oldText === "string" ? value.oldText : undefined;
  const rawAfter = typeof value.newText === "string" ? value.newText : undefined;
  const keepInline = Buffer.byteLength(rawBefore ?? "") <= MAX_TOOL_INLINE_FILE_BYTES
    && Buffer.byteLength(rawAfter ?? "") <= MAX_TOOL_INLINE_FILE_BYTES;
  // An empty `diff` string carries no information, so it must not suppress the
  // oldText/newText rendering the way a real one does — hence the truthy check
  // rather than a `typeof` guard alone. Truncation is announced, like every
  // other bounded display field; a silent cut reads as a complete diff.
  const rawSuppliedDiff = typeof value.diff === "string" && value.diff ? value.diff : undefined;
  const suppliedDiff = rawSuppliedDiff === undefined
    ? undefined
    : truncateDisplayText(rawSuppliedDiff, MAX_TOOL_DIFF_BYTES, "\n… file diff truncated");
  // Only generated when it will actually be used: `createDisplayDiff` is
  // whole-file work, and computing it just to drop it in favour of a supplied
  // diff was the most expensive no-op on the read loop.
  const generated = suppliedDiff === undefined && keepInline && rawAfter !== undefined
    ? createDisplayDiff(filePath, rawBefore, rawAfter)
    : undefined;
  const diff = suppliedDiff ?? generated?.diff ?? (filePath
    ? `--- ${safeDiffPath(filePath)}\n+++ ${safeDiffPath(filePath)}\n@@ diff omitted: file state exceeded display limit @@`
    : undefined);
  const stats = rawSuppliedDiff !== undefined
    ? countUnifiedDiffLines(rawSuppliedDiff)
    : generated;
  if (!filePath && rawBefore === undefined && rawAfter === undefined && diff === undefined) {
    return undefined;
  }
  // The file states are only ever rendered as the fallback for a part that has
  // no diff at all: the renderer treats `diff` as authoritative the moment it
  // exists. Keeping them alongside one stored two more whole copies of the file
  // per edit — 5.3 MiB in the original incident — that nothing would ever read.
  const keepFileStates = keepInline && diff === undefined;
  return {
    ...(filePath ? { filePath } : {}),
    ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
    ...(keepFileStates && rawBefore !== undefined ? { before: rawBefore } : {}),
    ...(keepFileStates && rawAfter !== undefined ? { after: rawAfter } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

export function aggregateAcpToolDiffs(
  diffs: BridgeToolDiff[],
  fallbackPath: string | undefined,
): BridgeToolDiff | undefined {
  if (diffs.length === 0) return fallbackPath ? { filePath: fallbackPath } : undefined;
  if (diffs.length === 1) {
    const [diff] = diffs;
    return diff?.filePath || !fallbackPath ? diff : { ...diff, filePath: fallbackPath };
  }
  const rendered = diffs.flatMap((diff) => diff.diff ? [diff.diff] : []);
  const hasCompleteStats = diffs.every(
    (diff) => diff.additions !== undefined && diff.deletions !== undefined,
  );
  return {
    ...(hasCompleteStats ? {
      additions: diffs.reduce((total, diff) => total + (diff.additions ?? 0), 0),
      deletions: diffs.reduce((total, diff) => total + (diff.deletions ?? 0), 0),
    } : {}),
    ...(rendered.length > 0 ? {
      diff: truncateDisplayText(
        rendered.join("\n"),
        MAX_TOOL_DIFF_BYTES,
        "\n… additional file diffs truncated",
      ),
    } : {}),
  };
}

export function toolCallLocationPath(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value.find((location): location is JsonObject => isObject(location));
  return boundedString(first?.path, MAX_TOOL_PATH_BYTES);
}

export function toolArgumentPath(toolArgs: JsonObject | undefined): string | undefined {
  return boundedString(toolArgs?.path, MAX_TOOL_PATH_BYTES)
    ?? boundedString(toolArgs?.filePath, MAX_TOOL_PATH_BYTES)
    ?? boundedString(toolArgs?.file_path, MAX_TOOL_PATH_BYTES);
}

export interface DisplayDiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

export function createDisplayDiff(
  filePath: string | undefined,
  before: string | undefined,
  after: string,
): { diff: string; additions: number; deletions: number } {
  const lines = diffFileLines(fileLines(before ?? ""), fileLines(after));
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "add") additions += 1;
    if (line.type === "remove") deletions += 1;
  }
  const path = safeDiffPath(filePath ?? "unknown-file");
  return {
    diff: truncateDisplayText(
      [
        `--- ${before === undefined ? "/dev/null" : path}`,
        `+++ ${path}`,
        ...renderDiffHunks(lines),
      ].join("\n"),
      MAX_TOOL_DIFF_BYTES,
      "\n… file diff truncated",
    ),
    additions,
    deletions,
  };
}

/**
 * Render the changed regions as unified hunks rather than the whole file.
 *
 * Runs of unchanged lines longer than twice the context are elided, and each
 * surviving region gets a `@@` header carrying its line numbers so the reader
 * can still place it in the file. A file with no changes at all renders as a
 * single empty `@@` header, which is what it is: nothing to show.
 */
export function renderDiffHunks(lines: DisplayDiffLine[]): string[] {
  const changed = lines.reduce<number[]>((indexes, line, index) => {
    if (line.type !== "context") indexes.push(index);
    return indexes;
  }, []);
  if (changed.length === 0) return ["@@"];

  const rendered: string[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let cursor = 0;
  let nextChange = 0;

  while (nextChange < changed.length) {
    const start = Math.max(cursor, changed[nextChange]! - DIFF_CONTEXT_LINES);
    // Extend the hunk while the next change is close enough that the gap
    // between them is cheaper to print than a second header.
    let end = Math.min(lines.length - 1, changed[nextChange]! + DIFF_CONTEXT_LINES);
    while (
      nextChange + 1 < changed.length
      && changed[nextChange + 1]! - DIFF_CONTEXT_LINES <= end + 1
    ) {
      nextChange += 1;
      end = Math.min(lines.length - 1, changed[nextChange]! + DIFF_CONTEXT_LINES);
    }
    nextChange += 1;

    // Advance the line counters across everything elided before this hunk.
    for (let index = cursor; index < start; index += 1) {
      const type = lines[index]!.type;
      if (type !== "add") beforeLine += 1;
      if (type !== "remove") afterLine += 1;
    }

    let beforeCount = 0;
    let afterCount = 0;
    const body: string[] = [];
    for (let index = start; index <= end; index += 1) {
      const line = lines[index]!;
      if (line.type !== "add") beforeCount += 1;
      if (line.type !== "remove") afterCount += 1;
      body.push(
        `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}`,
      );
    }
    rendered.push(
      `@@ -${beforeLine},${beforeCount} +${afterLine},${afterCount} @@`,
      ...body,
    );
    beforeLine += beforeCount;
    afterLine += afterCount;
    cursor = end + 1;
  }
  return rendered;
}

export function fileLines(value: string): string[] {
  return value.length === 0 ? [] : value.split("\n");
}

export function diffFileLines(before: string[], after: string[]): DisplayDiffLine[] {
  // `trace` retains one frontier per edit distance, each holding O(distance)
  // entries, so this search costs O(distance²) in *memory* as well as time. The
  // work counter alone bounded only the latter: a full rewrite of a 256KiB file
  // reached ~4M retained Map entries (~340MB, ~150ms of blocked read loop)
  // before it fired, and then discarded all of it for the fallback anyway.
  // Capping the distance bounds both — 512 keeps an optimal diff for edits up to
  // 512 changed lines at ~24MB and <10ms, and anything larger renders as one
  // replaced block, which is what a rewrite that size looks like regardless.
  const maximumSteps = Math.min(before.length + after.length, MAX_DIFF_EDIT_DISTANCE);
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  let work = 0;

  for (let distance = 0; distance <= maximumSteps; distance += 1) {
    trace.push(new Map(frontier));
    const next = new Map(frontier);
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : Math.max(0, right + 1);
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
        work += 1;
      }
      next.set(diagonal, x);
      work += 1;
      if (x >= before.length && y >= after.length) {
        return backtrackFileDiff(trace, before, after);
      }
      if (work > 2_000_000) return boundedFallbackDiff(before, after);
    }
    frontier = next;
  }
  return boundedFallbackDiff(before, after);
}

export function backtrackFileDiff(
  trace: Array<Map<number, number>>,
  before: string[],
  after: string[],
): DisplayDiffLine[] {
  let x = before.length;
  let y = after.length;
  const result: DisplayDiffLine[] = [];
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!;
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      result.push({ type: "context", content: before[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (x === previousX) {
      result.push({ type: "add", content: after[y - 1]! });
      y -= 1;
    } else {
      result.push({ type: "remove", content: before[x - 1]! });
      x -= 1;
    }
  }
  return result.reverse();
}

export function boundedFallbackDiff(before: string[], after: string[]): DisplayDiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map((content) => ({ type: "context" as const, content })),
    ...before.slice(prefix, before.length - suffix).map((content) => ({ type: "remove" as const, content })),
    ...after.slice(prefix, after.length - suffix).map((content) => ({ type: "add" as const, content })),
    ...before.slice(before.length - suffix).map((content) => ({ type: "context" as const, content })),
  ];
}

export function countUnifiedDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function safeDiffPath(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

export function truncateDisplayText(value: string, maximumBytes: number, notice: string): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const noticeBytes = Buffer.byteLength(notice);
  return truncateUtf8(value, Math.max(0, maximumBytes - noticeBytes)) + notice;
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("");
  if (!isObject(value)) return "";
  return typeof value.text === "string" ? value.text : "";
}

/**
 * `appendBounded`, memoised on the object that owns `current`.
 *
 * Once a target is saturated the answer can only ever be `current` unchanged,
 * so returning it directly keeps a stream that overruns its cap O(1) per chunk
 * instead of re-encoding and re-copying the capped buffer on the read loop for
 * the rest of the turn.
 *
 * Truncation can leave a saturated buffer a few bytes short of the cap, where
 * the two UTF-8 backoffs landed. Dropping a chunk that would fit in those bytes
 * is deliberate: it would be appended *after* the marker, and a response that
 * reads `…[output truncated by Orkestrator]y` looks corrupted rather than cut.
 *
 * `target` is absent when the caller is about to create the part that will own
 * the result; it records the saturation itself in that case.
 */
export function appendSaturating(
  target: BridgeMessage | BridgeMessagePart | undefined,
  current: string,
  addition: string,
  maximumBytes: number,
): { value: string; truncated: boolean } {
  if (target && saturatedText.has(target)) return { value: current, truncated: true };
  const next = appendBounded(current, addition, maximumBytes);
  if (next.truncated && target) saturatedText.add(target);
  return next;
}

export function appendBounded(current: string, addition: string, maximumBytes: number): {
  value: string;
  truncated: boolean;
} {
  const currentBytes = Buffer.byteLength(current);
  const remaining = Math.max(0, maximumBytes - currentBytes);
  if (Buffer.byteLength(addition) <= remaining) return { value: current + addition, truncated: false };
  const marker = "\n[output truncated by Orkestrator]";
  const markerBytes = Buffer.byteLength(marker);
  // Truncation is no longer fatal for an interactive turn, so the marker is
  // part of the correctness contract rather than optional decoration. A prior
  // stream chunk can leave fewer free bytes than the marker needs; reserve its
  // space from the already-buffered prefix in that case instead of silently
  // dropping this chunk and presenting the shortened response as complete.
  const contentLimit = Math.max(0, maximumBytes - markerBytes);
  const prefix = truncateUtf8(current, contentLimit);
  const usable = Math.max(0, contentLimit - Buffer.byteLength(prefix));
  return {
    value: prefix + truncateUtf8(addition, usable) + truncateUtf8(marker, maximumBytes),
    truncated: true,
  };
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  // Back up over continuation bytes so decoding cannot replace a partial code
  // point with U+FFFD (three bytes) and accidentally exceed the byte cap.
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

export function boundTranscript(state: SessionState): boolean {
  state.uncheckedTranscriptBytes = 0;
  let truncatedCurrentMessage = false;
  while (state.messages.length > MAX_MESSAGES) {
    state.messages.shift();
    state.droppedMessages += 1;
    state.transcriptTruncated = true;
  }
  let bytes = Buffer.byteLength(JSON.stringify(state.messages));
  while (bytes > MAX_TRANSCRIPT_BYTES && state.messages.length > 1) {
    state.messages.shift();
    state.droppedMessages += 1;
    state.transcriptTruncated = true;
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
  const onlyMessage = state.messages[0];
  while (bytes > MAX_TRANSCRIPT_BYTES && onlyMessage && onlyMessage.parts.length > 1) {
    // Strictly shorter every pass, so the loop still terminates once only the
    // notice is left.
    state.droppedParts += trimPartsTo(onlyMessage, onlyMessage.parts.length - 1);
    state.transcriptTruncated = true;
    truncatedCurrentMessage = true;
    bytes = Buffer.byteLength(JSON.stringify(state.messages));
  }
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    // One part alone is over the whole-transcript budget, so nothing left to
    // drop can bring it back under and the bound is genuinely unenforceable.
    // Every part is individually capped well below 16 MiB, so this is a backstop
    // against a future cap being raised, not a state the agents can reach.
    state.outputTruncated = true;
    state.status = "error";
    state.error = `${provider} output exceeded the transcript limit`;
    truncatedCurrentMessage = true;
    state.transcriptTruncated = true;
  }
  // Transcript retention is presentation-only. Active child lifecycle stays
  // in the separately bounded registry until a terminal event or process death.
  return truncatedCurrentMessage;
}


