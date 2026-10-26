import { createHash, randomUUID } from "node:crypto";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";
import { RecentlyRevisedRows } from "@orkestrator/protocol/node/revised-rows";
import type {
  NativeAgentContextUsage,
  NativeAgentNotice,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import {
  asRecord,
  nonEmptyString,
  serializedByteLength,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import { openCodeSessionModelRef } from "./opencode-model-catalog.js";
import {
  openCodeRevertMarker,
  sameOpenCodeRevertMarker,
  type OpenCodeRevertMarker,
} from "./opencode-revert.js";
import {
  createOpenCodeUsageLedger,
  openCodeContextUsage,
  openCodeContextUsageFromLedger,
  recordOpenCodeUsageMessages,
  type OpenCodeUsageLedger,
} from "./opencode-usage.js";

const MAX_STREAM_SESSIONS = 1_024;
export const MAX_STREAM_MESSAGES = 1_025;
const MAX_STREAM_PARTS = 2_048;
const MAX_STREAM_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/**
 * Newest cached messages whose content a gap baseline fingerprints, so a
 * re-read can tell which of them changed while the stream was down. Older ones
 * are still checked for removal, by id.
 */
const GAP_BASELINE_FINGERPRINTS = 128;

/** Marks a message the stream created before OpenCode reported its info. */
const PROVISIONAL_INFO = Symbol("opencode-provisional-info");

/**
 * Whether a cached message's info was made up by the stream rather than
 * reported by OpenCode: a part event can precede its message's
 * `message.updated`, and the placeholder then carries a backend clock (or an
 * event time) instead of the message's own creation time. A page cursor minted
 * from it could skip or repeat rows, so cursors are named only from real info.
 */
export function isProvisionalOpenCodeMessage(message: unknown): boolean {
  const info = asRecord(asRecord(message)?.info) as Record<PropertyKey, unknown> | null;
  return info?.[PROVISIONAL_INFO] === true;
}

/**
 * What the cache held when the stream was lost, for checking the re-read
 * against: message ids in order, and content fingerprints of the newest.
 */
type GapBaseline = { ids: string[]; fingerprints: Map<string, string> };

function cachedMessageId(message: unknown): string | undefined {
  const id = nonEmptyString(asRecord(asRecord(message)?.info)?.id);
  // A `session.compacted` row is the stream's own; OpenCode never returns it.
  return id && !id.startsWith("opencode-") ? id : undefined;
}

function messageFingerprint(message: unknown): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(message) ?? "")
      .digest("base64url");
  } catch {
    return "";
  }
}

function baselineOf(messages: readonly unknown[] | undefined): GapBaseline {
  const ids: string[] = [];
  const fingerprints = new Map<string, string>();
  const fingerprintFrom = Math.max(0, (messages?.length ?? 0) - GAP_BASELINE_FINGERPRINTS);
  messages?.forEach((message, index) => {
    const id = cachedMessageId(message);
    if (!id) return;
    ids.push(id);
    if (index >= fingerprintFrom) fingerprints.set(id, messageFingerprint(message));
  });
  return { ids, fingerprints };
}

/**
 * Whether a read proves history was rewritten since `baseline`: a message it
 * held is gone, or something now sits between two it held.
 *
 * Only the overlap can be checked — from the oldest baseline message the read
 * still holds, or all of it when the read began at the session's first
 * message. OpenCode removes a suffix (a revert drops everything after its
 * point), so a removal always reaches into that overlap. A read sharing
 * nothing with the baseline cannot prove continuity and counts as rewritten.
 */
function historyRewritten(
  baseline: readonly string[],
  read: readonly string[],
  fromStart: boolean,
): boolean {
  if (baseline.length === 0) return false;
  const readIds = new Set(read);
  const first = fromStart ? 0 : baseline.findIndex((id) => readIds.has(id));
  if (first < 0) return true;
  let at = read.indexOf(baseline[first]!);
  if (at < 0) return true;
  for (let index = first; index < baseline.length; index += 1) {
    if (read[at] !== baseline[index]) return true;
    at += 1;
  }
  return false;
}

type OpenCodeStreamSession = {
  messages?: unknown[];
  messagesCurrent: boolean;
  /**
   * Whether `messages` begins at the session's first message. Only a read
   * that came back shorter than it asked for proves that; streamed appends
   * keep whatever the seeding read established.
   */
  messagesFromStart: boolean;
  /**
   * Changes when older history was rewritten under a page cursor: a removed
   * message, or a re-read after a stream gap that proves one (see
   * `gapBaseline`). Ordinary appends and edits keep it, and so does a
   * reconnect that changed nothing, so readers keep the history they paged.
   */
  historyEpoch: number;
  /**
   * The cache as it stood when the stream was lost, until a read taken after
   * the stream is back has been checked against it. Every authoritative read
   * in between is checked too and becomes the new baseline, so a removal is
   * caught even if a read during the outage already reflects it.
   */
  gapBaseline?: GapBaseline;
  /**
   * Messages OpenCode changed in place, newest first. An OpenCode message is
   * one agent-loop step, and a late tool result lands on its own step after
   * newer steps have pushed it out of the live window; the transcript carries
   * the noted ones from before its window so readers refresh their copies.
   */
  revised?: RecentlyRevisedRows;
  /** Monotonic count of inbound session events, including events seen while dirty. */
  eventVersion: number;
  /**
   * OpenCode's pending revert (`Session.revert`), which the transcript hides;
   * see `opencode-revert.ts`. Kept apart from the messages because OpenCode
   * keeps the reverted ones until the next prompt.
   */
  revert?: OpenCodeRevertMarker;
  /**
   * Whether `revert` reflects OpenCode as of the last `session.updated`,
   * action result or session read. A stream gap can hide the update that
   * changed it, so it then waits for a read.
   */
  revertKnown: boolean;
  /**
   * Moves with every source of `revert`, so a session read that a newer
   * update overtook does not install its older marker.
   */
  revertVersion: number;
  notices: NativeAgentNotice[];
  /**
   * Notices derived from `session.status` rather than from the transcript.
   *
   * Kept apart from `notices` because an authoritative messages read clears
   * those: a `session.error` is persisted on the failed message, so the read
   * supersedes it, but a retry lives only in the status and would vanish on
   * the next transcript refresh. `retryNotice` lasts while OpenCode retries;
   * `turnFailure` is a retry OpenCode says needs the user (a usage limit) and
   * lasts until the next turn starts.
   */
  retryNotice?: NativeAgentNotice;
  turnFailure?: NativeAgentNotice;
  revision: number;
  /** Exact after snapshots/structural changes; a safe upper bound after deltas. */
  transcriptBytes?: number;
  title?: string;
  sessionModelId?: string;
  sessionReasoningId?: string;
  permission?: unknown;
  runtime?: Pick<NativeAgentRuntimeSummary, "todos" | "files">;
  turnStartedAt?: number;
  /** Whether a running observation confirmed the current turn clock. */
  turnConfirmed?: boolean;
  /**
   * Lifetime per-message usage. The live transcript is a sliding window, so
   * session totals derived from it walk backwards on a long job. This ledger
   * keeps every message that has reported tokens, including ones that later
   * fall out of the window or out of an oversized cache.
   */
  usageLedger: OpenCodeUsageLedger;
};

export type OpenCodeStreamEffect = {
  reconnect?: boolean;
  refreshInteractions?: string;
  refreshMcp?: boolean;
  /** The turn cannot progress without the user; abort it so the session is free. */
  abortTurn?: boolean;
  sessionId?: string;
  status?: "running" | "idle" | "missing";
};

/**
 * The failure message for a retry status OpenCode marked as needing the user.
 *
 * OpenCode attaches `action` to a retry only for account conditions its TUI
 * turns into a dialog (for example "Go limit reached" with a settings link);
 * an ordinary transient retry has none.
 */
export function openCodeRetryActionFailure(
  status: Record<string, unknown> | null | undefined,
): string | undefined {
  const action = asRecord(status?.action);
  if (!action) return undefined;
  const title = nonEmptyString(action.title);
  const detail = nonEmptyString(action.message) ?? nonEmptyString(status?.message);
  const link = nonEmptyString(action.link);
  const text = [title, detail].filter(Boolean).join(": ");
  if (!text) return undefined;
  return `${text}${link && !text.includes(link) ? ` ${link}` : ""}`.slice(0, 2_000);
}

/**
 * Bounded incremental state derived from OpenCode's v1 SSE stream.
 *
 * Every entry starts dirty and becomes current only after an authoritative
 * session.messages read. A reconnect marks every transcript dirty, so an SSE
 * gap can make reads more expensive but can never leave a projection silently
 * incomplete.
 */
export class OpenCodeStreamState {
  private readonly sessions = new Map<string, OpenCodeStreamSession>();
  /**
   * Epochs are drawn from one counter scoped to this instance, so a session
   * evicted and seen again, or a restarted backend, never reuses an epoch a
   * reader may still hold a cursor for.
   */
  private readonly epochScope = randomUUID().slice(0, 8);
  private epochCounter = 0;

  register(sessionId: string): void {
    this.session(sessionId);
  }

  private session(sessionId: string): OpenCodeStreamSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: OpenCodeStreamSession = {
      messagesCurrent: false,
      messagesFromStart: false,
      historyEpoch: this.nextHistoryEpoch(),
      eventVersion: 0,
      revertKnown: false,
      revertVersion: 0,
      notices: [],
      revision: 0,
      usageLedger: createOpenCodeUsageLedger(),
    };
    setBoundedMapEntry(this.sessions, sessionId, created, MAX_STREAM_SESSIONS);
    return created;
  }

  /**
   * Install an authoritative messages read. `requestedLimit` is the limit that
   * read asked for: a shorter answer proves the window starts at the session's
   * first message. Without it the start stays unknown, so the window is
   * treated as possibly having older history.
   */
  replaceMessages(
    sessionId: string,
    messages: readonly unknown[],
    expectedEventVersion?: number,
    requestedLimit?: number,
  ): boolean {
    const state = this.session(sessionId);
    if (expectedEventVersion !== undefined && state.eventVersion !== expectedEventVersion) {
      return false;
    }
    const fromStart = requestedLimit !== undefined && messages.length < requestedLimit;
    if (state.gapBaseline) {
      this.verifyGap(state, messages, fromStart);
      // An unguarded read can happen during the outage, so check subsequent
      // reads too. A guarded read, or the first transcript event applied to a
      // current cache below, proves stream continuity has resumed.
      state.gapBaseline = expectedEventVersion === undefined ? baselineOf(messages) : undefined;
    }
    state.messages = [...messages];
    state.messagesFromStart = fromStart;
    this.recordUsage(sessionId, state.messages);
    state.transcriptBytes = serializedByteLength(state.messages);
    if (!this.messagesWithinBounds(state)) {
      state.messagesCurrent = false;
      return false;
    }
    state.messagesCurrent = true;
    state.notices = [];
    return true;
  }

  eventVersion(sessionId: string): number {
    return this.session(sessionId).eventVersion;
  }

  currentMessages(sessionId: string): unknown[] | undefined {
    const state = this.sessions.get(sessionId);
    return state?.messagesCurrent && state.messages ? [...state.messages] : undefined;
  }

  /** Whether the current cached transcript begins at the session's first message. */
  currentMessagesFromStart(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return Boolean(state?.messagesCurrent && state.messagesFromStart);
  }

  /** The epoch older-history page cursors for this session belong to. */
  historyEpoch(sessionId: string): string {
    return `opencode:${this.epochScope}:${this.session(sessionId).historyEpoch}`;
  }

  /** The pending revert last observed, known or retained across a gap. */
  revertMarker(sessionId: string): OpenCodeRevertMarker | undefined {
    return this.sessions.get(sessionId)?.revert;
  }

  /** Whether the revert marker is current, or must be read from the session. */
  revertMarkerKnown(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.revertKnown === true;
  }

  /** Pass to `observeRevert` to discard a session read an update overtook. */
  revertVersion(sessionId: string): number {
    return this.session(sessionId).revertVersion;
  }

  /**
   * Install OpenCode's revert marker from a session read or an action result.
   *
   * A change rewrites the transcript under readers' feet, as a removal does:
   * the revision moves so a cached snapshot is not served, and the history
   * epoch moves so paged history and page cursors named under the old marker
   * expire instead of keeping rows it hid (or hiding rows it no longer
   * covers). Returns false when `expectedVersion` was overtaken.
   */
  observeRevert(
    sessionId: string,
    marker: OpenCodeRevertMarker | undefined,
    expectedVersion?: number,
  ): boolean {
    const state = this.session(sessionId);
    if (expectedVersion !== undefined && state.revertVersion !== expectedVersion) return false;
    this.setRevert(state, marker);
    return true;
  }

  /** Forget the marker's freshness, so the next transcript read asks OpenCode. */
  invalidateRevert(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.revertKnown = false;
    state.revertVersion += 1;
  }

  /** Revision-note sequence, including changes outside the cached window. */
  revisedRowsVersion(sessionId: string): number {
    return this.sessions.get(sessionId)?.revised?.version ?? 0;
  }

  revisedRowsOverflowVersion(sessionId: string): number {
    return this.sessions.get(sessionId)?.revised?.overflowVersion ?? 0;
  }

  /** Messages OpenCode changed in place recently, newest change first. */
  revisedMessageIds(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.revised?.ids() ?? [];
  }

  /**
   * The last transcript known for a session, even after an SSE gap.
   *
   * `currentMessages` is deliberately undefined once a snapshot is stale so the
   * transcript read cannot present an incomplete turn as authoritative. Usage,
   * however, is derived from the tail and is better kept at its last known
   * value than blanked: the panel losing its counters while a reconnect
   * completes is a visible regression, while an under-reported total is
   * corrected by the next authoritative read.
   */
  retainedMessages(sessionId: string): unknown[] | undefined {
    const state = this.sessions.get(sessionId);
    return state?.messages ? [...state.messages] : undefined;
  }

  /**
   * The newest transcript tail a usage read can derive from.
   *
   * Current when the cache is authoritative, otherwise the last transcript seen
   * before an SSE gap. A stale total is corrected by the next authoritative
   * read, while a dropped one blanks the panel's counters until then.
   */
  usageMessages(sessionId: string): unknown[] {
    return this.currentMessages(sessionId) ?? this.retainedMessages(sessionId) ?? [];
  }

  recordUsage(sessionId: string, messages: readonly unknown[]): void {
    recordOpenCodeUsageMessages(this.session(sessionId).usageLedger, messages);
  }

  /**
   * Lifetime session usage, including messages that have left the live window.
   *
   * `usedTokens` still comes from the newest turn so the context gauge can
   * shrink after compaction. Session/cache/cost counters are the ledger sum.
   */
  contextUsage(
    sessionId: string,
    messages: readonly unknown[] = this.usageMessages(sessionId),
  ): NativeAgentContextUsage | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return openCodeContextUsage(messages);
    this.recordUsage(sessionId, messages);
    return openCodeContextUsageFromLedger(state.usageLedger, messages);
  }

  revision(sessionId: string): number {
    return this.sessions.get(sessionId)?.revision ?? 0;
  }

  runtime(sessionId: string): Pick<NativeAgentRuntimeSummary, "todos" | "files"> {
    return this.sessions.get(sessionId)?.runtime ?? {};
  }

  title(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.title;
  }

  sessionModel(sessionId: string): { modelId?: string; reasoningId?: string } {
    const state = this.sessions.get(sessionId);
    return {
      ...(state?.sessionModelId ? { modelId: state.sessionModelId } : {}),
      ...(state?.sessionReasoningId ? { reasoningId: state.sessionReasoningId } : {}),
    };
  }

  /**
   * Seed a fresh fork's session model. A fork has no `session.updated` yet, so
   * without this the progressive state view has no model evidence and the
   * composer falls back to the catalogue. Prefers the fork's own
   * `Session.model`, then the source session's streamed model. A model the
   * stream already reported for the fork wins: it is at least as new.
   */
  seedForkedSessionModel(forkedId: string, forked: unknown, sourceId: string): void {
    const own = openCodeSessionModelRef(asRecord(forked)?.model);
    const model = own.modelId ? own : this.sessionModel(sourceId);
    if (!model.modelId) return;
    const state = this.session(forkedId);
    if (state.sessionModelId) return;
    state.sessionModelId = model.modelId;
    if (model.reasoningId) state.sessionReasoningId = model.reasoningId;
    else delete state.sessionReasoningId;
    this.bump(state);
  }

  permission(sessionId: string): unknown {
    return this.sessions.get(sessionId)?.permission;
  }

  notices(sessionId: string): NativeAgentNotice[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    // The turn failure leads: readers take the first error as the turn error.
    return [
      ...(state.turnFailure ? [state.turnFailure] : []),
      ...state.notices,
      ...(state.retryNotice ? [state.retryNotice] : []),
    ];
  }

  turnFailure(sessionId: string): NativeAgentNotice | undefined {
    return this.sessions.get(sessionId)?.turnFailure;
  }

  /** Record dispatch before a renderer has to observe the turn. */
  beginTurn(sessionId: string, startedAt: number): void {
    const state = this.session(sessionId);
    state.turnStartedAt = startedAt;
    state.turnConfirmed = false;
    delete state.retryNotice;
    delete state.turnFailure;
  }

  /** The authoritative turn clock, if one has been established. */
  turnStartedAt(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.turnStartedAt;
  }

  /** Whether a running observation has confirmed the current turn clock. */
  isTurnConfirmed(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turnConfirmed === true;
  }

  /** Mark that a running observation confirmed the turn currently in flight. */
  confirmTurn(sessionId: string): void {
    this.session(sessionId).turnConfirmed = true;
  }

  /** Supply a backend observation clock for turns that started externally. */
  ensureTurnStarted(
    sessionId: string,
    observedAt: number,
    expectedEventVersion?: number,
  ): number | undefined {
    const state = this.session(sessionId);
    if (expectedEventVersion !== undefined && state.eventVersion !== expectedEventVersion) {
      return state.turnStartedAt;
    }
    state.turnStartedAt ??= observedAt;
    state.turnConfirmed = true;
    return state.turnStartedAt;
  }

  /** Remove only the dispatch clock belonging to this rejected request. */
  rejectTurn(sessionId: string, startedAt: number): void {
    const state = this.sessions.get(sessionId);
    if (state?.turnStartedAt === startedAt) this.endTurn(sessionId);
  }

  /** Drop everything tracked for a session whose ownership was closed. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  endTurn(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    delete state.turnStartedAt;
    delete state.turnConfirmed;
    delete state.retryNotice;
  }

  /**
   * Record a transcript change that did not come from the event stream — a
   * shell badge measured after its part completed — so the next read's source
   * token differs and the projection re-normalizes. Untracked sessions have
   * no cached projection to invalidate.
   */
  touch(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) this.bump(state);
  }

  /**
   * The stream was lost: every cache is dirty until re-read. A removal inside
   * the gap never reaches this state as an event, so the cache is kept as a
   * baseline the next reads are checked against; only a read that proves a
   * rewrite moves the history epoch (`verifyGap`). Rotating on every gap made
   * each reconnect discard every reader's paged history.
   *
   * The revision moves instead: the re-read installs whatever changed inside
   * the gap without an event to bump it, and a transcript token that stayed
   * put would answer "unchanged" over it.
   */
  markGap(): void {
    for (const state of this.sessions.values()) {
      state.messagesCurrent = false;
      state.gapBaseline ??= baselineOf(state.messages);
      // The update that changed the marker may be inside the gap.
      state.revertKnown = false;
      state.revertVersion += 1;
      this.bumpEventVersion(state);
      this.bump(state);
    }
  }

  clear(): void {
    this.sessions.clear();
  }

  apply(event: OpenCodeEvent, observedAt = Date.now()): OpenCodeStreamEffect {
    if (event.type === "mcp.tools.changed") return { refreshMcp: true };
    if (event.type === "server.connected") return {};
    if (event.type === "server.instance.disposed" || event.type === "global.disposed") {
      this.markGap();
      return { reconnect: true };
    }

    const properties = asRecord(event.properties);
    const sessionId = nonEmptyString(properties?.sessionID);
    if (!sessionId) return {};
    const state = this.session(sessionId);
    this.bumpEventVersion(state);
    if (state.messagesCurrent && event.type.startsWith("message.")) {
      state.gapBaseline = undefined;
    }

    if (event.type === "session.status") {
      const statusRecord = asRecord(properties?.status);
      const status = statusRecord?.type;
      if (status === "busy") {
        state.notices = [];
        delete state.retryNotice;
        delete state.turnFailure;
        this.ensureTurnStarted(sessionId, observedAt);
        return { sessionId, status: "running" };
      }
      if (status === "retry") {
        const failure = openCodeRetryActionFailure(statusRecord);
        if (failure) {
          // OpenCode attaches an action when the retry cannot succeed without
          // the user — an exhausted usage allowance whose reset can be days
          // away. Its TUI opens a dialog; here the turn fails and is aborted,
          // rather than showing "thinking" until the allowance resets.
          delete state.retryNotice;
          state.turnFailure = { kind: "error", message: failure };
          this.endTurn(sessionId);
          this.bump(state);
          return { sessionId, status: "running", abortTurn: true };
        }
        const attempt =
          typeof statusRecord?.attempt === "number" ? statusRecord.attempt : undefined;
        const detail =
          nonEmptyString(statusRecord?.message) ?? "The model request failed and is being retried.";
        const headline =
          attempt !== undefined
            ? `OpenCode is retrying the model request (attempt ${attempt}). ${detail}`
            : `OpenCode is retrying the model request. ${detail}`;
        state.retryNotice = {
          kind: "advisory",
          severity: "warning",
          message: headline.slice(0, 2_000),
        };
        this.ensureTurnStarted(sessionId, observedAt);
        return { sessionId, status: "running" };
      }
      if (status === "idle") {
        delete state.retryNotice;
        this.endTurn(sessionId);
        return { sessionId, status: "idle" };
      }
      return { sessionId };
    }
    if (event.type === "session.idle") {
      delete state.retryNotice;
      this.endTurn(sessionId);
      return { sessionId, status: "idle" };
    }
    if (event.type === "session.deleted") {
      this.forget(sessionId);
      return { sessionId, status: "missing" };
    }
    if (event.type === "permission.replied") {
      return { sessionId, refreshInteractions: sessionId };
    }
    if (event.type === "session.updated") {
      const info = asRecord(properties?.info);
      const title = nonEmptyString(info?.title);
      if (title) state.title = title;
      if (info && "model" in info) {
        const sessionModel = openCodeSessionModelRef(info);
        if (sessionModel.modelId) state.sessionModelId = sessionModel.modelId;
        else delete state.sessionModelId;
        if (sessionModel.reasoningId) state.sessionReasoningId = sessionModel.reasoningId;
        else delete state.sessionReasoningId;
      }
      // OpenCode v1 exposes the provider ruleset on Session.permission. Keep
      // the bounded provider value at this low adapter boundary; plan 12 owns
      // translating it into the shared execution-policy contract.
      if (Array.isArray(info?.permission) && serializedByteLength(info.permission) <= 64 * 1024) {
        state.permission = info.permission;
      }
      // Every update carries the whole merged Session, and a cleared revert
      // is published without the field, so its absence clears the marker.
      if (info) this.setRevert(state, openCodeRevertMarker(info));
      this.bump(state);
      return { sessionId };
    }
    if (event.type === "todo.updated") {
      if (Array.isArray(properties?.todos)) {
        state.runtime = { ...state.runtime, todos: properties.todos.length };
        this.bump(state);
      }
      return { sessionId };
    }
    if (event.type === "session.diff") {
      if (Array.isArray(properties?.diff)) {
        state.runtime = { ...state.runtime, files: properties.diff.length };
        this.bump(state);
      }
      return { sessionId };
    }
    if (event.type === "session.error") {
      this.endTurn(sessionId);
      delete state.retryNotice;
      const error = asRecord(properties?.error);
      // The abort that follows a turn failure reports itself as an error too;
      // the failure that caused it is the one worth showing.
      if (state.turnFailure && nonEmptyString(error?.name) === "MessageAbortedError") {
        return { sessionId };
      }
      // The persisted assistant message supplies the user-stop marker. The
      // stream's generic "Aborted" text must not turn it into a failure.
      if (nonEmptyString(error?.name) === "MessageAbortedError") return { sessionId };
      const data = asRecord(error?.data);
      const message =
        nonEmptyString(data?.message) ??
        nonEmptyString(error?.message) ??
        nonEmptyString(error?.name) ??
        "OpenCode session failed";
      state.notices = [{ kind: "error", message: message.slice(0, 2_000) }];
      this.bump(state);
      return { sessionId };
    }
    if (event.type === "session.compacted") {
      if (!state.messagesCurrent || !state.messages) return { sessionId };
      const eventId = nonEmptyString(asRecord(event)?.id) ?? `compaction-${state.revision + 1}`;
      state.messages.push({
        info: {
          id: `opencode-${eventId}`,
          sessionID: sessionId,
          role: "assistant",
          time: { created: Date.now() },
        },
        parts: [{ id: eventId, messageID: `opencode-${eventId}`, type: "compaction" }],
      });
      this.finishMessageMutation(state);
      return { sessionId };
    }

    if (event.type === "message.updated") {
      const info = asRecord(properties?.info);
      const messageId = nonEmptyString(info?.id);
      if (messageId) this.noteRevised(state, messageId);
      if (!messageId) {
        return state.messagesCurrent && state.messages
          ? this.invalidate(state, sessionId)
          : { sessionId };
      }
      this.recordUsage(sessionId, [{ info, parts: [] }]);
      if (!state.messagesCurrent || !state.messages) return { sessionId };
      const index = this.messageIndex(state.messages, messageId);
      const previous = index >= 0 ? asRecord(state.messages[index]) : undefined;
      const next = { info, parts: Array.isArray(previous?.parts) ? previous.parts : [] };
      if (index >= 0) state.messages[index] = next;
      else state.messages.push(next);
      this.finishMessageMutation(state);
      return { sessionId };
    }

    // A removal rewrites history whether or not the tail cache is current.
    if (event.type === "message.removed") {
      state.historyEpoch = this.nextHistoryEpoch();
      const removedId = nonEmptyString(properties?.messageID);
      if (removedId) state.revised?.forget(removedId);
    }
    // Noted whether or not the cache is current: the transcript re-reads what
    // it does not hold, and only needs to know which rows to carry.
    if (
      event.type === "message.part.updated" ||
      event.type === "message.part.removed" ||
      event.type === "message.part.delta"
    ) {
      const changedId =
        nonEmptyString(asRecord(properties?.part)?.messageID) ??
        nonEmptyString(properties?.messageID);
      if (changedId) this.noteRevised(state, changedId);
    }
    if (!state.messagesCurrent || !state.messages) return { sessionId };
    if (event.type === "message.removed") {
      const messageId = nonEmptyString(properties?.messageID);
      if (!messageId) return this.invalidate(state, sessionId);
      state.messages = state.messages.filter(
        (candidate) => nonEmptyString(asRecord(asRecord(candidate)?.info)?.id) !== messageId,
      );
      this.finishMessageMutation(state);
      return { sessionId };
    }
    if (event.type === "message.part.updated") {
      const part = asRecord(properties?.part);
      const messageId = nonEmptyString(part?.messageID);
      const partId = nonEmptyString(part?.id);
      if (!part || !messageId || !partId) return this.invalidate(state, sessionId);
      const message = this.ensureMessage(state, sessionId, messageId, properties?.time);
      const parts = Array.isArray(message.parts) ? [...message.parts] : [];
      const partIndex = parts.findIndex(
        (candidate) => nonEmptyString(asRecord(candidate)?.id) === partId,
      );
      if (partIndex >= 0) parts[partIndex] = part;
      else parts.push(part);
      message.parts = parts;
      this.finishMessageMutation(state);
      return { sessionId };
    }
    if (event.type === "message.part.removed") {
      const messageId = nonEmptyString(properties?.messageID);
      const partId = nonEmptyString(properties?.partID);
      const index = messageId ? this.messageIndex(state.messages, messageId) : -1;
      const message = index >= 0 ? asRecord(state.messages[index]) : undefined;
      if (!message || !partId) return this.invalidate(state, sessionId);
      message.parts = Array.isArray(message.parts)
        ? message.parts.filter((candidate) => nonEmptyString(asRecord(candidate)?.id) !== partId)
        : [];
      this.finishMessageMutation(state);
      return { sessionId };
    }
    if (event.type === "message.part.delta") {
      const messageId = nonEmptyString(properties?.messageID);
      const partId = nonEmptyString(properties?.partID);
      const field = nonEmptyString(properties?.field);
      const delta = typeof properties?.delta === "string" ? properties.delta : undefined;
      const index = messageId ? this.messageIndex(state.messages, messageId) : -1;
      const message = index >= 0 ? asRecord(state.messages[index]) : undefined;
      const parts = Array.isArray(message?.parts) ? [...message.parts] : [];
      const partIndex = partId
        ? parts.findIndex((candidate) => nonEmptyString(asRecord(candidate)?.id) === partId)
        : -1;
      const part = partIndex >= 0 ? asRecord(parts[partIndex]) : undefined;
      if (!message || !part || !field || delta === undefined || typeof part[field] !== "string") {
        return this.invalidate(state, sessionId);
      }
      parts[partIndex] = { ...part, [field]: `${part[field]}${delta}` };
      message.parts = parts;
      this.finishMessageDelta(state, delta);
      return { sessionId };
    }
    return { sessionId };
  }

  private messageIndex(messages: readonly unknown[], messageId: string): number {
    return messages.findIndex(
      (candidate) => nonEmptyString(asRecord(asRecord(candidate)?.info)?.id) === messageId,
    );
  }

  private ensureMessage(
    state: OpenCodeStreamSession,
    sessionId: string,
    messageId: string,
    time: unknown,
  ): Record<string, unknown> {
    const index = this.messageIndex(state.messages ?? [], messageId);
    if (index >= 0) return asRecord(state.messages![index])!;
    const message = {
      info: {
        id: messageId,
        sessionID: sessionId,
        role: "assistant",
        time: { created: typeof time === "number" ? time : Date.now() },
        [PROVISIONAL_INFO]: true,
      },
      parts: [],
    };
    state.messages!.push(message);
    return message;
  }

  private finishMessageMutation(state: OpenCodeStreamSession): void {
    state.transcriptBytes = state.messages ? serializedByteLength(state.messages) : undefined;
    if (!this.messagesWithinBounds(state)) {
      state.messagesCurrent = false;
      return;
    }
    this.bump(state);
  }

  private finishMessageDelta(state: OpenCodeStreamSession, delta: string): void {
    if (!state.messages || state.transcriptBytes === undefined) {
      state.messagesCurrent = false;
      return;
    }
    // JSON.stringify(delta) measures exactly the bytes added inside a JSON
    // string, except split surrogate pairs where it deliberately over-counts.
    // An upper bound is safe and keeps the hot delta path independent of the
    // transcript size.
    state.transcriptBytes += Math.max(0, serializedByteLength(delta) - 2);
    if (state.transcriptBytes > MAX_STREAM_TRANSCRIPT_BYTES) {
      state.messagesCurrent = false;
      return;
    }
    this.bump(state);
  }

  private messagesWithinBounds(state: OpenCodeStreamSession): boolean {
    return Boolean(
      state.messages &&
      state.messages.length <= MAX_STREAM_MESSAGES &&
      !state.messages.some((message) => {
        const parts = asRecord(message)?.parts;
        return Array.isArray(parts) && parts.length > MAX_STREAM_PARTS;
      }) &&
      state.transcriptBytes !== undefined &&
      state.transcriptBytes <= MAX_STREAM_TRANSCRIPT_BYTES,
    );
  }

  private invalidate(state: OpenCodeStreamSession, sessionId: string): OpenCodeStreamEffect {
    state.messagesCurrent = false;
    return { sessionId };
  }

  /**
   * Check a re-read against the gap baseline: a rewrite moves the epoch, and a
   * message whose content changed while the stream was down is noted as
   * revised, since no event said so.
   */
  private verifyGap(
    state: OpenCodeStreamSession,
    messages: readonly unknown[],
    fromStart: boolean,
  ): void {
    const baseline = state.gapBaseline!;
    const ids = messages.flatMap((message) => cachedMessageId(message) ?? []);
    if (historyRewritten(baseline.ids, ids, fromStart)) {
      state.historyEpoch = this.nextHistoryEpoch();
      return;
    }
    for (const message of messages) {
      const id = cachedMessageId(message);
      const before = id === undefined ? undefined : baseline.fingerprints.get(id);
      if (before !== undefined && before !== messageFingerprint(message)) {
        this.noteRevised(state, id!);
      }
    }
  }

  private noteRevised(state: OpenCodeStreamSession, messageId: string): void {
    const messages = state.messagesCurrent ? state.messages : undefined;
    if (messages) {
      // The newest message is always inside the live window, and one the
      // cache has not seen is about to become it; only an older message can be
      // outside. Without a current cache there is no telling, so note it.
      if (cachedMessageId(messages.at(-1)) === messageId) return;
      if (this.messageIndex(messages, messageId) < 0) return;
    }
    (state.revised ??= new RecentlyRevisedRows()).note(messageId);
  }

  private setRevert(state: OpenCodeStreamSession, marker: OpenCodeRevertMarker | undefined): void {
    state.revertKnown = true;
    state.revertVersion += 1;
    if (sameOpenCodeRevertMarker(state.revert, marker)) return;
    if (marker) state.revert = marker;
    else delete state.revert;
    state.historyEpoch = this.nextHistoryEpoch();
    this.bump(state);
  }

  private nextHistoryEpoch(): number {
    this.epochCounter = this.epochCounter >= Number.MAX_SAFE_INTEGER ? 1 : this.epochCounter + 1;
    return this.epochCounter;
  }

  private bump(state: OpenCodeStreamSession): void {
    state.revision = state.revision >= Number.MAX_SAFE_INTEGER ? 1 : state.revision + 1;
  }

  private bumpEventVersion(state: OpenCodeStreamSession): void {
    state.eventVersion = state.eventVersion >= Number.MAX_SAFE_INTEGER ? 1 : state.eventVersion + 1;
  }
}
