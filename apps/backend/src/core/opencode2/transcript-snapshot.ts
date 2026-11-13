/**
 * OpenCode 2.x transcript windows, history pages and revised rows
 * (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`), build plan phase 4).
 *
 * The authoritative source is `GET /api/session/:id/message`, newest first,
 * paged by an opaque cursor. Live events are only hints over it (AGENTS.md
 * invariants 3 and 4): they move a per-session revision, so an unchanged
 * window can answer `unchanged`, and they note which rows changed, so a row
 * pushed out of the window that changes later (a background sub-agent's
 * result on an older response) still reaches readers as a revised row.
 * Whenever the stream is not live, or a gap or oversized frame was seen,
 * nothing is answered from the hints: the window is re-read.
 *
 * - **Cursors.** The server's cursor is `base64url({ id, order, direction })`
 *   and names the rows strictly before row `id` in `order`
 *   (2.2.6 `server/handlers/message.ts`). The window's `historyCursor` and
 *   `historyCursorBefore` are minted in exactly that form from the oldest row
 *   a reader holds, so they mean the same as one the server minted.
 * - **Pages are whole rows.** A row's group (one response, or a response and
 *   its error) is never split across pages.
 * - **A vanished anchor expires.** The server answers an empty page when the
 *   cursor's row no longer exists (a committed revert), which would read as
 *   "start of history"; an empty page is therefore checked against the row
 *   and answered `expired` when the row is gone.
 * - **Bounded.** At most {@link OPENCODE2_TRANSCRIPT_READ_LIMIT} rows per read,
 *   the client's 8 MB page bound, the reader's own byte target, and the
 *   bridge bounds for revised rows.
 */
import {
  BRIDGE_REVISED_MESSAGES_MAX,
  BRIDGE_REVISED_MESSAGES_MAX_BYTES,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import {
  RecentlyRevisedRows,
  revisedRowsReconciliationToken,
} from "@orkestrator/protocol/node/revised-rows";
import {
  ProviderUnavailableError,
  type ProviderTranscriptPage,
  type ProviderTranscriptSnapshot,
} from "../agent-provider-contract.js";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import { inlineFileContentLabel, inlineFileUrlDisposition } from "../native-agent-inline-files.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import type { OpenCode2Event } from "./events.js";
import { normalizeOpenCode2Group, normalizeOpenCode2Groups } from "./transcript.js";
import { openCode2RevertMarker } from "./revert.js";
import type { OpenCode2Message } from "./types.js";

/** Stands in for a deferred body: the projection's 32-character detail reference. */
const DETAIL_REFERENCE = "0".repeat(32);

/**
 * A row's size once the native projection has moved its heavy bodies behind
 * detail references (`projectionPart`): tool output and error, diff bodies,
 * and the inline data URLs it defers. That is what a window or page costs on
 * screen, and measuring the inline bodies instead would let one large tool
 * result shrink a window to a single message. A replacer skips those strings
 * rather than copying them, so the measure stays cheap on every poll.
 *
 * An inline payload the projection keeps — a PDF, or an image too large for
 * the detail cache — is counted in full. Counting it as a reference let a
 * window outgrow the live view, which then dropped the head the cursor named.
 */
function openCodeDisplayBytes(row: unknown): number {
  try {
    const serialized = JSON.stringify(row, (key, value: unknown) => {
      if (key === "toolOutput" || key === "toolError") return DETAIL_REFERENCE;
      if (key === "toolDiff") {
        const diff = asRecord(value);
        return diff
          ? {
              filePath: diff.filePath,
              additions: diff.additions,
              deletions: diff.deletions,
              deferred: true,
            }
          : value;
      }
      const part = asRecord(value);
      const disposition = part ? inlineFileUrlDisposition(part) : undefined;
      if (part && disposition) {
        const { fileUrl, ...rest } = part;
        const label = inlineFileContentLabel(part);
        return {
          ...rest,
          ...(label === undefined ? {} : { content: label }),
          ...(disposition === "defer" ? { detailRef: DETAIL_REFERENCE } : {}),
          ...(disposition === "inline" ? { fileUrl } : {}),
        };
      }
      return value;
    });
    return Buffer.byteLength(serialized ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Most rows in one window or page. Each read asks for one row more, to tell a
 * complete history from a cut one, and 2.2.6 refuses a `limit` above 200.
 */
export const OPENCODE2_TRANSCRIPT_READ_LIMIT = 199;
const MAX_CURSOR_LENGTH = 512;
const MAX_TRACKED_SESSIONS = 1_024;
const MAX_TRACKED_ROW_VERSIONS = 256;
/** Events whose data names the response row they changed. */
const ROW_EVENTS = new Set([
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
]);
/** Events that rewrite history, so every cursor held so far must expire. */
const EPOCH_EVENTS = new Set(["session.revert.committed", "session.forked", "session.deleted"]);

type SessionTranscriptState = {
  revert?: string;
  revision: number;
  epoch: number;
  revised: RecentlyRevisedRows;
  /** `revised.version` when each noted row last changed. */
  rowVersions: Map<string, number>;
  /** Row groups fetched for `revisedMessages`, by row id, with the note version they reflect. */
  revisedCache: Map<string, { version: number; rows: Record<string, unknown>[] }>;
};

/**
 * Per-session hint state fed by the provider's event monitor. Revisions only
 * ever grow, and every lost-event signal moves them, so a token minted before
 * a gap can never match one minted after it.
 */
export class OpenCode2TranscriptState {
  private readonly sessions = new Map<string, SessionTranscriptState>();
  /** A new provider (server generation) starts a new epoch for every cursor. */
  private readonly generation = crypto.randomUUID().slice(0, 8);
  /**
   * One counter for every session's revision, so a session whose state was
   * evicted and rebuilt never reissues a revision a reader already holds.
   */
  private counter = 0;

  constructor(private readonly live: () => boolean) {}

  private state(sessionId: string): SessionTranscriptState {
    let state = this.sessions.get(sessionId);
    if (state) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, state);
      return state;
    }
    state = {
      revision: ++this.counter,
      // Also unique, so cursors from before an eviction expire.
      epoch: this.counter,
      revised: new RecentlyRevisedRows(),
      rowVersions: new Map(),
      revisedCache: new Map(),
    };
    this.sessions.set(sessionId, state);
    while (this.sessions.size > MAX_TRACKED_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value!);
    }
    return state;
  }

  syncRevert(sessionId: string, messageId: string | undefined): void {
    const state = this.state(sessionId);
    if (state.revert === messageId) return;
    state.revert = messageId;
    this.observe(sessionId, { type: "session.revert.committed", data: { sessionID: sessionId } });
  }

  /** One live event (durable or ephemeral) that names `sessionId`. */
  observe(sessionId: string, event: OpenCode2Event): void {
    const state = this.state(sessionId);
    state.revision = ++this.counter;
    if (EPOCH_EVENTS.has(event.type)) {
      state.epoch = ++this.counter;
      state.revised.clear();
      state.rowVersions.clear();
      state.revisedCache.clear();
      return;
    }
    if (!ROW_EVENTS.has(event.type)) return;
    const rowId = nonEmptyString(asRecord(event.data)?.assistantMessageID);
    if (!rowId) return;
    state.revised.note(rowId);
    state.rowVersions.delete(rowId);
    state.rowVersions.set(rowId, state.revised.version);
    while (state.rowVersions.size > MAX_TRACKED_ROW_VERSIONS) {
      state.rowVersions.delete(state.rowVersions.keys().next().value!);
    }
  }

  /**
   * Something may have been missed for this session, so the next read goes to
   * the server. `lostNotes` is for a stream that dropped or a frame that was
   * discarded: a revised-row note may be gone with it, so readers reconcile
   * their retained history. A `durable.seq` gap alone does not say that,
   * because 2.2.6 skips about two sequence numbers per run; it only re-reads.
   */
  invalidate(sessionId: string, lostNotes = false): void {
    const state = this.state(sessionId);
    state.revision = ++this.counter;
    if (lostNotes) state.revised.overflowVersion += 1;
  }

  invalidateAll(lostNotes = false): void {
    for (const sessionId of Array.from(this.sessions.keys())) this.invalidate(sessionId, lostNotes);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Only a live stream can vouch that nothing changed. */
  canAnswerUnchanged(): boolean {
    return this.live();
  }

  revision(sessionId: string): number {
    return this.state(sessionId).revision;
  }

  historyEpoch(sessionId: string): string {
    return `opencode2:${this.generation}:${this.state(sessionId).epoch}`;
  }

  revisedIds(sessionId: string): string[] {
    return this.state(sessionId).revised.ids();
  }

  revisedVersion(sessionId: string): number {
    return this.state(sessionId).revised.version;
  }

  revisedOverflowVersion(sessionId: string): number {
    return this.state(sessionId).revised.overflowVersion;
  }

  /** When `rowId` was last noted as changed. */
  rowVersion(sessionId: string, rowId: string): number {
    return this.state(sessionId).rowVersions.get(rowId) ?? this.revisedVersion(sessionId);
  }

  cachedRevised(sessionId: string, rowId: string, version: number) {
    const cached = this.state(sessionId).revisedCache.get(rowId);
    return cached && cached.version >= version ? cached.rows : undefined;
  }

  cacheRevised(sessionId: string, rowId: string, version: number, rows: Record<string, unknown>[]) {
    const cache = this.state(sessionId).revisedCache;
    cache.delete(rowId);
    cache.set(rowId, { version, rows });
    while (cache.size > BRIDGE_REVISED_MESSAGES_MAX * 2) cache.delete(cache.keys().next().value!);
  }
}

/** A cursor for the history strictly before row `id`, in the server's own format. */
export function openCode2HistoryCursor(id: string, epoch?: string): string | undefined {
  if (!id.startsWith("msg_")) return undefined;
  const cursor = Buffer.from(
    JSON.stringify({ id, order: "desc", direction: "next", ...(epoch ? { epoch } : {}) }),
  ).toString("base64url");
  return cursor.length <= MAX_CURSOR_LENGTH ? cursor : undefined;
}

/** The row a history cursor pages before, or undefined for a cursor this provider never mints. */
export function openCode2CursorAnchor(cursor: string): string | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) return undefined;
  try {
    const body = asRecord(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    const id = nonEmptyString(body?.id);
    return id?.startsWith("msg_") && body?.order === "desc" && body.direction === "next"
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The index of the oldest group in the newest run of whole groups that fit
 * `rows` and `targetBytes` (the 1.x rule: it always keeps the newest group,
 * and stops a sixteenth short of the target to absorb what the projection
 * adds). Groups with no rows cost nothing.
 */
function newestGroups(
  groups: readonly Record<string, unknown>[][],
  limits: { rows: number; targetBytes: number },
): number {
  const targetBytes = limits.targetBytes - Math.floor(limits.targetBytes / 16);
  let start = groups.length;
  let rows = 0;
  let bytes = 1;
  let kept = false;
  while (start > 0) {
    const group = groups[start - 1]!;
    const groupBytes = group.reduce((total, row) => total + openCodeDisplayBytes(row) + 1, 0);
    if (kept && (rows + group.length > limits.rows || bytes + groupBytes > targetBytes)) break;
    rows += group.length;
    bytes += groupBytes;
    if (group.length > 0) kept = true;
    start -= 1;
  }
  return start;
}

function rowId(message: OpenCode2Message | undefined): string | undefined {
  return nonEmptyString(asRecord(message)?.id) ?? undefined;
}

function readLimit(limit: number): number {
  return Math.max(
    1,
    Math.min(Number.isSafeInteger(limit) ? limit : 1, OPENCODE2_TRANSCRIPT_READ_LIMIT),
  );
}

export interface OpenCode2TranscriptReadOptions {
  limit: number;
  targetBytes: number;
  knownSourceToken?: string;
}

/**
 * The newest window of a session's transcript, with its paging cursor and
 * any revised rows from before it.
 */
export async function openCode2TranscriptSnapshot(
  client: OpenCode2Client,
  state: OpenCode2TranscriptState,
  sessionId: string,
  options: OpenCode2TranscriptReadOptions,
  onUnknown?: (type: string) => void,
): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
  const session = await client.getSession(sessionId).catch((error: unknown) => {
    if (error instanceof OpenCode2RequestError && error.status === 404) return undefined;
    throw error;
  });
  const revert = openCode2RevertMarker(session);
  state.syncRevert(sessionId, revert?.messageId);
  const revision = state.revision(sessionId);
  const historyEpoch = state.historyEpoch(sessionId);
  const count = readLimit(options.limit);
  const sourceToken = `opencode2:${historyEpoch}:${revision}:${count}:${options.targetBytes}`;
  if (state.canAnswerUnchanged() && options.knownSourceToken === sourceToken) {
    return { unchanged: true, sourceToken };
  }
  let page;
  try {
    // One row more than the window, so a session that fits says so.
    page = await client.listMessages(sessionId, {
      limit: count + 1,
      order: "desc",
      ...(revert ? { cursor: openCode2HistoryCursor(revert.messageId) } : {}),
    });
  } catch (error) {
    if (error instanceof OpenCode2RequestError && error.status === 404) {
      return {
        messages: [],
        complete: true,
        freshness: "current",
        historyPageable: true,
        historyEpoch,
      };
    }
    throw new ProviderUnavailableError("OpenCode 2 transcript is unavailable", { cause: error });
  }
  const more = page.messages.length > count;
  const window = page.messages.slice(0, count).reverse();
  const groups = normalizeOpenCode2Groups(window, onUnknown);
  const start = newestGroups(groups, { rows: count, targetBytes: options.targetBytes });
  const olderHistory = more || start > 0;
  const kept = window.slice(start);
  const keptGroups = groups.slice(start);
  const firstKept = rowId(kept[0]);
  const historyCursor =
    olderHistory && firstKept ? openCode2HistoryCursor(firstKept, historyEpoch) : undefined;
  const shown = new Set(window.map(rowId));
  const revised = revert
    ? { rows: [], ids: new Set<string>() }
    : await revisedRows(client, state, sessionId, window, kept, onUnknown);
  const omitted = state
    .revisedIds(sessionId)
    .filter((id) => !shown.has(id) && !revised.ids.has(id));
  const reconciliation = revisedRowsReconciliationToken(
    state.revisedOverflowVersion(sessionId),
    omitted.length > 0 ? [state.revisedVersion(sessionId), ...omitted] : [],
  );
  return {
    messages: keptGroups.flat(),
    complete: !olderHistory,
    historyPageable: true,
    freshness: "current",
    revision,
    historyEpoch,
    sourceToken,
    ...(historyCursor
      ? { historyCursor, historyCursorBefore: cursorBefore(kept, keptGroups, historyEpoch) }
      : {}),
    ...(revised.rows.length > 0 ? { revisedMessages: revised.rows } : {}),
    ...(reconciliation ? { historyReconciliationToken: reconciliation } : {}),
  };
}

/**
 * `historyCursorBefore` for a window: only the first row of a group can end a
 * page (a cursor named at a response's error row would page the response
 * away), and only a row 2.x minted can name one.
 */
function cursorBefore(
  messages: readonly OpenCode2Message[],
  groups: readonly Record<string, unknown>[][],
  epoch: string,
): (messageId: string) => string | undefined {
  let firstRows: Map<string, string> | undefined;
  return (messageId) => {
    if (!firstRows) {
      firstRows = new Map();
      groups.forEach((group, index) => {
        const id = group[0]?.id;
        const source = rowId(messages[index]);
        if (typeof id === "string" && source && !firstRows!.has(id)) firstRows!.set(id, source);
      });
    }
    const source = firstRows.get(messageId);
    return source ? openCode2HistoryCursor(source, epoch) : undefined;
  };
}

/**
 * Rows noted as changed that lie before the window (`kept`), newest change
 * first, within the bridge bounds. Rows read in this window are taken from
 * it; older ones are fetched once per change and cached.
 */
async function revisedRows(
  client: OpenCode2Client,
  state: OpenCode2TranscriptState,
  sessionId: string,
  window: readonly OpenCode2Message[],
  kept: readonly OpenCode2Message[],
  onUnknown?: (type: string) => void,
): Promise<{ rows: Record<string, unknown>[]; ids: Set<string> }> {
  const keptIds = new Set(kept.map(rowId));
  const wanted = state
    .revisedIds(sessionId)
    .filter((id) => !keptIds.has(id))
    .slice(0, BRIDGE_REVISED_MESSAGES_MAX);
  const rows: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  if (wanted.length === 0) return { rows, ids };
  const inWindow = new Map(window.map((message) => [rowId(message), message]));
  let bytes = 0;
  for (const id of wanted) {
    const version = state.rowVersion(sessionId, id);
    let group = state.cachedRevised(sessionId, id, version);
    if (!group) {
      let message = inWindow.get(id);
      if (!message) {
        try {
          message = await client.getMessage(sessionId, id);
        } catch {
          // Not readable now; reported through the reconciliation token.
          continue;
        }
      }
      group = normalizeOpenCode2Group(message, onUnknown);
      state.cacheRevised(sessionId, id, version, group);
    }
    if (rows.length + group.length > BRIDGE_REVISED_MESSAGES_MAX) break;
    const size = group.reduce((total, row) => total + openCodeDisplayBytes(row), 0);
    if (bytes + size > BRIDGE_REVISED_MESSAGES_MAX_BYTES) continue;
    bytes += size;
    rows.push(...group);
    ids.add(id);
  }
  return { rows, ids };
}

/** History strictly before `cursor`, newest whole rows first to fill the page. */
export async function openCode2TranscriptPage(
  client: OpenCode2Client,
  state: OpenCode2TranscriptState,
  sessionId: string,
  options: { cursor: string; limit: number; targetBytes: number },
  onUnknown?: (type: string) => void,
): Promise<ProviderTranscriptPage> {
  const anchor = openCode2CursorAnchor(options.cursor);
  if (!anchor) return { status: "expired" };
  const session = await client.getSession(sessionId).catch((error: unknown) => {
    if (error instanceof OpenCode2RequestError && error.status === 404) return undefined;
    throw error;
  });
  if (!session) return { status: "expired" };
  const revert = openCode2RevertMarker(session);
  state.syncRevert(sessionId, revert?.messageId);
  const historyEpoch = state.historyEpoch(sessionId);
  const cursorEpoch = asRecord(
    JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")),
  )?.epoch;
  if (
    (cursorEpoch !== undefined && cursorEpoch !== historyEpoch) ||
    (revert && cursorEpoch === undefined)
  )
    return { status: "expired" };
  const count = readLimit(options.limit);
  let page;
  try {
    page = await client.listMessages(sessionId, {
      limit: count + 1,
      cursor: openCode2HistoryCursor(anchor),
    });
  } catch (error) {
    if (error instanceof OpenCode2RequestError && (error.status === 404 || error.status === 400)) {
      return { status: "expired" };
    }
    throw new ProviderUnavailableError("OpenCode 2 history page is unavailable", { cause: error });
  }
  if (page.messages.length === 0) {
    // An empty page is the start of history only while its anchor exists.
    try {
      await client.getMessage(sessionId, anchor);
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404)
        return { status: "expired" };
      throw new ProviderUnavailableError("OpenCode 2 history page is unavailable", {
        cause: error,
      });
    }
  }
  if (page.messages.some((message) => rowId(message) === anchor)) return { status: "expired" };
  if (state.historyEpoch(sessionId) !== historyEpoch) return { status: "expired" };
  const more = page.messages.length > count;
  const read = page.messages.slice(0, count).reverse();
  const groups = normalizeOpenCode2Groups(read, onUnknown);
  const start =
    read.length === 0 ? 0 : newestGroups(groups, { rows: count, targetBytes: options.targetBytes });
  const olderHistory = more || start > 0;
  const firstKept = rowId(read[start]);
  const historyCursor =
    olderHistory && firstKept ? openCode2HistoryCursor(firstKept, historyEpoch) : undefined;
  return {
    status: "page",
    messages: groups.slice(start).flat(),
    ...(historyCursor ? { historyCursor } : {}),
    complete: !olderHistory,
    truncated: false,
    historyEpoch,
  };
}
