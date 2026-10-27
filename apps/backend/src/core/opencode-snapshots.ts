import { revisedRowsReconciliationToken } from "@orkestrator/protocol/node/revised-rows";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import {
  boundedOpenCodeMessageHistory,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
} from "@orkestrator/protocol/opencode-message-id";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  asRecord,
  assertSdkResponse,
  MAX_TRACKED_INTERACTION_SESSIONS,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  serializedByteLength,
} from "./agent-provider-runtime.js";
import {
  ProviderUnavailableError,
  type ProviderSessionStateSnapshot,
  type ProviderStatus,
  type ProviderTranscriptPage,
  type ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type {
  NativeAgentContextUsage,
  NativeAgentExecutionPolicy,
  NativeAgentNotice,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { lastAssistantModelRef } from "./native-agent-composer-selection.js";
import {
  BRIDGE_REVISED_MESSAGES_MAX,
  BRIDGE_REVISED_MESSAGES_MAX_BYTES,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import { inlineFileContentLabel, inlineFileUrlDisposition } from "./native-agent-inline-files.js";
import { normalizeOpenCodeTranscriptGroups } from "./opencode-messages.js";
import { withoutRevertedOpenCodeMessages, type OpenCodeRevertMarker } from "./opencode-revert.js";
import { isProvisionalOpenCodeMessage, type OpenCodeStreamState } from "./opencode-stream-state.js";
import { openCodeContextUsage } from "./opencode-usage.js";

// One more than the sessions we can track, so a full tracking set still leaves
// room to observe that the provider returned an extra entry.
export const MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS = MAX_TRACKED_INTERACTION_SESSIONS + 1;
export const MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/**
 * Wider than any OpenCode message id plus its timestamp, and well inside the
 * backend's direct-cursor envelope.
 */
const OPEN_CODE_HISTORY_CURSOR_MAX_LENGTH = 512;

/**
 * An OpenCode `before` cursor naming the history strictly older than `message`.
 *
 * OpenCode pages `GET /session/:id/message?limit=&before=` by its own cursor,
 * base64url JSON `{ id, time }`, ordering rows by `(time_created, id)` and
 * returning only rows strictly older than the pair. It mints that cursor from
 * the oldest message of a page, and `time_created` is the message's
 * `info.time.created`, so the same cursor can be named for any message held,
 * including one served from the stream cache. A server that rejects it answers
 * 400, which surfaces as a failed page read rather than a wrong page.
 *
 * Only a message OpenCode itself reported can name one. The stream's
 * `session.compacted` row has no OpenCode id, and a placeholder a part event
 * created before its `message.updated` carries a backend or event clock rather
 * than the message's creation time, which would skip or repeat rows.
 */
export function openCodeHistoryCursor(message: unknown): string | undefined {
  if (isProvisionalOpenCodeMessage(message)) return undefined;
  const info = asRecord(asRecord(message)?.info);
  const id = nonEmptyString(info?.id);
  const created = asRecord(info?.time)?.created;
  if (
    !id?.startsWith("msg_") ||
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created < 0
  ) {
    return undefined;
  }
  return Buffer.from(JSON.stringify({ id, time: created })).toString("base64url");
}

type OpenCodeHistoryPosition = { id: string; time: number };

function openCodeHistoryPosition(cursor: string): OpenCodeHistoryPosition | undefined {
  if (cursor.length === 0 || cursor.length > OPEN_CODE_HISTORY_CURSOR_MAX_LENGTH) return undefined;
  try {
    const body = asRecord(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    const id = nonEmptyString(body?.id);
    return id?.startsWith("msg_") === true &&
      typeof body?.time === "number" &&
      Number.isSafeInteger(body.time) &&
      body.time >= 0
      ? { id, time: body.time }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `message` sorts strictly before `position` in OpenCode's `(time_created, id)` order. */
function olderThan(message: unknown, position: OpenCodeHistoryPosition): boolean {
  const info = asRecord(asRecord(message)?.info);
  const id = nonEmptyString(info?.id);
  const created = asRecord(info?.time)?.created;
  if (!id || typeof created !== "number") return false;
  return created === position.time ? id < position.id : created < position.time;
}

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
 * The index of the oldest message in the newest run of whole messages whose
 * rows fit `rows` and `targetBytes`. Always keeps the newest message, so a
 * window or page never comes back empty while history remains.
 *
 * Both consumers bound the projected rows exactly — the live view drops
 * leading rows, which would orphan the cursor, and a reader trims a page from
 * its old end, which would strand those rows behind it — so the fill stops a
 * sixteenth short of the target to absorb what projection adds beyond this
 * estimate.
 */
function newestOpenCodeGroups(
  groups: readonly Record<string, unknown>[][],
  limits: { rows: number; targetBytes: number },
): number {
  const targetBytes = limits.targetBytes - Math.floor(limits.targetBytes / 16);
  let start = groups.length;
  let rows = 0;
  // The array's brackets; each row then adds its separator.
  let bytes = 1;
  while (start > 0) {
    const group = groups[start - 1]!;
    const groupBytes = group.reduce((total, row) => total + openCodeDisplayBytes(row) + 1, 0);
    if (
      start < groups.length &&
      (rows + group.length > limits.rows || bytes + groupBytes > targetBytes)
    ) {
      break;
    }
    rows += group.length;
    bytes += groupBytes;
    start -= 1;
  }
  return start;
}

/** What one session's transcript reads need from the provider and its stream cache. */
export interface OpenCodeTranscriptSource {
  revision: () => number;
  currentMessages: () => unknown[] | undefined;
  /** Whether the current cache begins at the session's first message. */
  currentMessagesFromStart: () => boolean;
  /** The epoch this session's page cursors belong to; see `openCodeTranscriptPage`. */
  historyEpoch: () => string;
  /** One `session.messages` read; `before` is an `openCodeHistoryCursor`. */
  readMessages: (limit: number, before?: string) => Promise<readonly unknown[]>;
  /** Messages OpenCode changed in place recently, newest change first. */
  revisedMessageIds?: () => readonly string[];
  revisedRowsVersion?: () => number;
  revisedRowsOverflowVersion?: () => number;
  replaceMessages: (messages: unknown[], requestedLimit: number) => void;
  title: () => string | undefined;
  recordUnknown: (type: string) => void;
  /** Measured shell changes to overlay by `callID`; see `opencode-command-changes.ts`. */
  commandChanges?: () => Promise<ReadonlyMap<string, MeasuredWorkspaceChange>>;
  /**
   * OpenCode's pending revert, read from the session when the stream cannot
   * vouch for it. Its messages stay in OpenCode until the next prompt, so
   * every read hides them (`opencode-revert.ts`). Called before the source
   * token and epoch are taken: a marker that changes moves both.
   */
  revertMarker?: () => Promise<OpenCodeRevertMarker | undefined>;
}

export function openCodeTranscriptSource(
  stream: OpenCodeStreamState,
  sessionId: string,
  reads: Pick<
    OpenCodeTranscriptSource,
    "readMessages" | "recordUnknown" | "commandChanges" | "revertMarker"
  >,
): OpenCodeTranscriptSource {
  return {
    revision: () => stream.revision(sessionId),
    currentMessages: () => stream.currentMessages(sessionId),
    currentMessagesFromStart: () => stream.currentMessagesFromStart(sessionId),
    historyEpoch: () => stream.historyEpoch(sessionId),
    revisedMessageIds: () => stream.revisedMessageIds(sessionId),
    revisedRowsVersion: () => stream.revisedRowsVersion(sessionId),
    revisedRowsOverflowVersion: () => stream.revisedRowsOverflowVersion(sessionId),
    replaceMessages: (messages, requestedLimit) =>
      stream.replaceMessages(sessionId, messages, undefined, requestedLimit),
    title: () => stream.title(sessionId),
    ...reads,
  };
}

export type OpenCodeTranscriptSnapshotOptions = {
  limit: number;
  targetBytes: number;
  knownSourceToken?: string;
};

export type OpenCodeTranscriptPageOptions = { cursor: string; limit: number; targetBytes: number };

/** One `session.messages` read: the newest `limit`, strictly older than `before` when given. */
export async function readOpenCodeMessages(
  client: OpencodeClient,
  requestOptions: { signal: AbortSignal },
  sessionId: string,
  limit?: number,
  before?: string,
): Promise<unknown[]> {
  const response = await client.session.messages(
    {
      sessionID: sessionId,
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    },
    requestOptions,
  );
  assertSdkResponse(response, "OpenCode transcript read");
  return Array.isArray(response.data) ? response.data : [];
}

export async function openCodeTranscriptSnapshot(
  input: OpenCodeTranscriptSource,
  options: OpenCodeTranscriptSnapshotOptions,
): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }> {
  try {
    const revert = await input.revertMarker?.();
    const revision = input.revision();
    const historyEpoch = input.historyEpoch();
    const sourceToken = `opencode:${historyEpoch}:${revision}:${options.limit}:${options.targetBytes}`;
    const current = input.currentMessages();
    if (current && options.knownSourceToken === sourceToken) {
      return { unchanged: true, sourceToken };
    }
    const fromStart = current ? input.currentMessagesFromStart() : undefined;
    const rawMessages = current ?? [...(await input.readMessages(options.limit))];
    // Only a read covering the provider's whole retained history may seed the
    // stream cache. A short tail (a one-message progress probe) would
    // otherwise become the "current" transcript every display read serves.
    let snapshotEpoch = historyEpoch;
    if (!current && options.limit >= OPEN_CODE_MESSAGE_HISTORY_LIMIT) {
      const beforeReplace = input.historyEpoch();
      input.replaceMessages(rawMessages, options.limit);
      // Checked against a stream gap's baseline, this read can itself prove
      // history was rewritten; its rows belong to the epoch that proof began.
      // An epoch that moved during the read (a removal event) keeps the old
      // label, so cursors named here expire rather than outlive the removal.
      const afterReplace = input.historyEpoch();
      if (beforeReplace === historyEpoch && afterReplace !== beforeReplace) {
        snapshotEpoch = afterReplace;
      }
    }
    const commandChanges = await input.commandChanges?.();
    // Whether older history exists is a property of the read; what the
    // revert hides is its newest end, never a reason to claim completion.
    const visibleMessages = withoutRevertedOpenCodeMessages(rawMessages, revert);
    const windowMessages = visibleMessages.slice(-options.limit);
    const groups = normalizeOpenCodeTranscriptGroups(
      windowMessages,
      input.recordUnknown,
      commandChanges,
    );
    const start = newestOpenCodeGroups(groups, {
      rows: options.limit,
      targetBytes: options.targetBytes,
    });
    /*
     * Each OpenCode message is one agent-loop step, so a long turn alone can
     * outgrow the window. What precedes it stays reachable through
     * `transcriptPage`, named by the oldest kept message that can name a
     * cursor. Rows ahead of that one are both on screen and on the first
     * page; the reader deduplicates by id, while a cursor named past them
     * would leave nothing to fill.
     */
    const olderHistory =
      start > 0 ||
      visibleMessages.length > windowMessages.length ||
      !(fromStart ?? rawMessages.length < options.limit);
    // A revert reaching past the whole read leaves nothing on screen to name
    // the cursor; the read's oldest message still bounds what lies before it.
    const historyCursor = olderHistory
      ? (windowMessages.length > 0 ? windowMessages.slice(start) : rawMessages)
          .map(openCodeHistoryCursor)
          .find((cursor) => cursor !== undefined)
      : undefined;
    const revisedMessages = openCodeRevisedRows(
      visibleMessages,
      visibleMessages.length - windowMessages.length + start,
      input.revisedMessageIds?.(),
      input.recordUnknown,
      commandChanges,
    );
    const title = input.title();
    const shownIds = new Set(
      [...groups.slice(start).flat(), ...revisedMessages].map((row) => row.id),
    );
    // A revised message the revert hides is not missing from the reader.
    const hiddenIds = new Set(
      rawMessages.slice(visibleMessages.length).flatMap((message) => {
        const id = nonEmptyString(asRecord(asRecord(message)?.info)?.id);
        return id ? [id] : [];
      }),
    );
    const omittedIds =
      input.revisedMessageIds?.().filter((id) => !shownIds.has(id) && !hiddenIds.has(id)) ?? [];
    const historyReconciliationToken = revisedRowsReconciliationToken(
      input.revisedRowsOverflowVersion?.() ?? 0,
      omittedIds.length ? [input.revisedRowsVersion?.() ?? revision, ...omittedIds] : [],
    );
    return {
      messages: groups.slice(start).flat(),
      sourceToken,
      complete: !olderHistory,
      revision: input.revision(),
      freshness: "current",
      historyEpoch: snapshotEpoch,
      ...(historyCursor
        ? {
            historyCursor,
            historyCursorBefore: openCodeCursorBefore(
              windowMessages.slice(start),
              groups.slice(start),
            ),
          }
        : {}),
      ...(revisedMessages.length > 0 ? { revisedMessages } : {}),
      ...(historyReconciliationToken ? { historyReconciliationToken } : {}),
      ...(title ? { title } : {}),
    };
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode transcript is unavailable", { cause: error });
  }
}

/**
 * `historyCursorBefore` for an OpenCode window. OpenCode pages by whole
 * message, so only the first row of a message's rows can end a page: a cursor
 * named at its error row would page the message itself away. Rows are indexed
 * on first use only.
 */
function openCodeCursorBefore(
  messages: readonly unknown[],
  groups: readonly Record<string, unknown>[][],
): (messageId: string) => string | undefined {
  let firstRows: Map<string, unknown> | undefined;
  return (messageId) => {
    if (!firstRows) {
      firstRows = new Map();
      groups.forEach((group, index) => {
        const id = group[0]?.id;
        if (typeof id === "string" && !firstRows!.has(id)) firstRows!.set(id, messages[index]);
      });
    }
    const message = firstRows.get(messageId);
    return message === undefined ? undefined : openCodeHistoryCursor(message);
  };
}

/**
 * Rows of the recently revised messages held before the window, newest change
 * first, within the bridge bounds for `revisedMessages`. OpenCode changes a
 * message in place, so a late tool result lands on a step newer steps have
 * already pushed out of the window. A message this read does not hold is
 * skipped: its content is not here, and a reader pages it back whole.
 */
function openCodeRevisedRows(
  messages: readonly unknown[],
  end: number,
  ids: readonly string[] | undefined,
  recordUnknown: (type: string) => void,
  commandChanges: ReadonlyMap<string, MeasuredWorkspaceChange> | undefined,
): Record<string, unknown>[] {
  if (!ids?.length || end <= 0) return [];
  const wanted = new Set(ids);
  const found = new Map<string, unknown>();
  for (let index = 0; index < end && found.size < wanted.size; index += 1) {
    const id = nonEmptyString(asRecord(asRecord(messages[index])?.info)?.id);
    if (id && wanted.has(id)) found.set(id, messages[index]);
  }
  const ordered = ids
    .flatMap((id) => (found.has(id) ? [found.get(id)] : []))
    .slice(0, BRIDGE_REVISED_MESSAGES_MAX);
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const group of normalizeOpenCodeTranscriptGroups(ordered, recordUnknown, commandChanges)) {
    if (rows.length + group.length > BRIDGE_REVISED_MESSAGES_MAX) break;
    const size = group.reduce((total, row) => total + openCodeDisplayBytes(row), 0);
    if (bytes + size > BRIDGE_REVISED_MESSAGES_MAX_BYTES) continue;
    bytes += size;
    rows.push(...group);
  }
  return rows;
}

/**
 * History strictly older than `cursor`, newest messages first to fill the
 * page, as whole messages.
 *
 * The read asks for one message more than the page can hold, so a page that
 * reaches the session's first message says so instead of leaving an empty
 * final page to discover it. The epoch is checked on both sides of the read:
 * a removal that lands mid-read expires the cursor instead of serving a page
 * from the history it rewrote.
 *
 * Every row must be strictly older than the cursor. Mixed or repeated
 * windows expire explicitly so a fresh read can recover continuity.
 */
export async function openCodeTranscriptPage(
  input: Pick<
    OpenCodeTranscriptSource,
    "historyEpoch" | "readMessages" | "recordUnknown" | "commandChanges" | "revertMarker"
  >,
  options: OpenCodeTranscriptPageOptions,
): Promise<ProviderTranscriptPage> {
  const position = openCodeHistoryPosition(options.cursor);
  if (!position) return { status: "expired" };
  let revert: OpenCodeRevertMarker | undefined;
  try {
    revert = await input.revertMarker?.();
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode history page is unavailable", { cause: error });
  }
  const historyEpoch = input.historyEpoch();
  const count = Math.max(
    1,
    Math.min(
      Number.isSafeInteger(options.limit) ? options.limit : 1,
      OPEN_CODE_MESSAGE_HISTORY_LIMIT,
    ),
  );
  try {
    const read = boundedOpenCodeMessageHistory(
      await input.readMessages(count + 1, options.cursor),
      {
        count: count + 1,
      },
    );
    // Inclusive or ignored cursors cannot prove completion. Reject the page
    // instead of filtering rows and silently stranding older history.
    if (read.some((message) => !olderThan(message, position))) return { status: "expired" };
    if (input.historyEpoch() !== historyEpoch) return { status: "expired" };
    const more = read.length > count;
    const candidates = read.slice(-count);
    // A revert hides the page's newest end; its oldest message still names
    // the next cursor when the revert reaches past all of it.
    const visible = withoutRevertedOpenCodeMessages(candidates, revert);
    const groups = normalizeOpenCodeTranscriptGroups(
      visible,
      input.recordUnknown,
      await input.commandChanges?.(),
    );
    const start =
      visible.length === 0
        ? 0
        : newestOpenCodeGroups(groups, { rows: count, targetBytes: options.targetBytes });
    const olderHistory = start > 0 || more;
    const historyCursor = olderHistory
      ? openCodeHistoryCursor(visible.length > 0 ? visible[start] : candidates[0])
      : undefined;
    return {
      status: "page",
      messages: groups.slice(start).flat(),
      ...(historyCursor ? { historyCursor } : {}),
      complete: !olderHistory,
      truncated: false,
      historyEpoch,
    };
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode history page is unavailable", { cause: error });
  }
}

export function openCodeSessionStateSnapshot(input: {
  status: ProviderStatus;
  revision: number;
  turnStartedAt?: number;
  title?: string;
  policy?: NativeAgentExecutionPolicy;
  runtime: NativeAgentRuntimeSummary;
  notices: NativeAgentNotice[];
  /**
   * The provider's cached transcript.
   *
   * Usage is derived from it here because the progressive state read is what
   * the renderer applies on every turn boundary: usage omitted from it would
   * drop the panel's counters even though the full projection reported them.
   * Every HTTP bridge reports usage on its state read for the same reason.
   * Prefer `contextUsage` when the caller already has a lifetime ledger; the
   * live transcript is a sliding window and under-counts a long job.
   */
  messages?: readonly unknown[];
  contextUsage?: NativeAgentContextUsage;
}): ProviderSessionStateSnapshot {
  const streamedError = input.notices.find((notice) => notice.kind === "error");
  // A stream error overrides the lifecycle status. Gate the clock on the
  // effective status so a running lifecycle never republishes a clock for a
  // turn the stream already reported as failed.
  const effectiveStatus: ProviderStatus = streamedError ? "error" : input.status;
  const lastAssistant = lastAssistantModelRef(input.messages ?? []);
  const contextUsage = input.contextUsage ?? openCodeContextUsage(input.messages ?? []);
  return {
    status: effectiveStatus,
    providerRevision: input.revision,
    ...(lastAssistant.modelId ? { lastAssistantModelId: lastAssistant.modelId } : {}),
    ...(lastAssistant.reasoningId ? { lastAssistantReasoningId: lastAssistant.reasoningId } : {}),
    ...(effectiveStatus === "running" && input.turnStartedAt !== undefined
      ? { turnStartedAt: input.turnStartedAt }
      : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(Object.keys(input.runtime).length > 0 ? { runtime: input.runtime } : {}),
    ...(input.notices.length > 0 ? { notices: input.notices } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(streamedError
      ? { phase: "error", error: streamedError.message }
      : {
          phase:
            effectiveStatus === "running"
              ? "running"
              : effectiveStatus === "blocked"
                ? "blocked"
                : "idle",
        }),
  };
}

export function boundedOwnedOpenCodeCollection(
  value: unknown,
  ownedSessionIds: ReadonlySet<string>,
  operation: string,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
  const owned: unknown[] = [];
  for (const entry of value) {
    const request = asRecord(entry);
    const sessionId = nonEmptyString(request?.sessionID) ?? nonEmptyString(request?.sessionId);
    if (!sessionId || !ownedSessionIds.has(sessionId)) continue;
    const id = nonEmptyString(request?.id);
    if (
      !request ||
      !id ||
      id.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
      sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(`${operation} contains a malformed identity`);
    }
    if (owned.length >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      throw new ProviderUnavailableError(`${operation} returned too many interactions`);
    }
    owned.push(entry);
  }
  return owned;
}

export type OpenCodeSessionLifecycleState = "running" | "idle" | "unknown" | "missing";

export type OpenCodeExistenceSnapshot = ReturnType<typeof boundedOpenCodeExistenceSnapshot>;

export type OpenCodeExistenceProbe = {
  state: "exists" | "missing" | "unknown";
  error?: unknown;
};

export function boundedOpenCodeStatusSnapshot(
  value: unknown,
  requestedSessionIds: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const snapshot = asRecord(value);
  if (!snapshot) {
    throw new ProviderUnavailableError("OpenCode status read is malformed");
  }
  const entries = Object.entries(snapshot);
  if (
    entries.length > MAX_TRACKED_PROVIDER_INTERACTIONS ||
    serializedByteLength(value) > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  ) {
    throw new ProviderUnavailableError("OpenCode status read is oversized");
  }
  const validated: Record<string, Record<string, unknown>> = Object.create(null);
  for (const sessionId of requestedSessionIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, sessionId)) continue;
    const rawStatus = snapshot[sessionId];
    const status = asRecord(rawStatus);
    if (
      sessionId.length === 0 ||
      sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength ||
      !status ||
      typeof status.type !== "string"
    ) {
      throw new ProviderUnavailableError("OpenCode status read contains a malformed entry");
    }
    validated[sessionId] = status;
  }
  return validated;
}

export function boundedOpenCodeExistenceSnapshot(value: unknown): {
  sessionIds: Set<string>;
} {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError("OpenCode session list is malformed");
  }
  if (
    value.length > MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS ||
    serializedByteLength(value) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
  ) {
    throw new ProviderUnavailableError("OpenCode session list is oversized");
  }
  const sessionIds = new Set<string>();
  for (const entry of value) {
    const sessionId = nonEmptyString(asRecord(entry)?.id);
    // The list is directory-wide and may contain sessions Orkestrator has
    // never owned. A malformed foreign entry cannot prove that a valid target
    // exists or is absent, so ignore it instead of stalling every tracked
    // session in the environment.
    if (!sessionId || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength) continue;
    sessionIds.add(sessionId);
  }
  return { sessionIds };
}
