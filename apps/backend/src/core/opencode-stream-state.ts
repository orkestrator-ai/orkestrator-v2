import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";
import type {
  NativeAgentNotice,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import {
  asRecord,
  nonEmptyString,
  serializedByteLength,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";

const MAX_STREAM_SESSIONS = 1_024;
const MAX_STREAM_MESSAGES = 1_025;
const MAX_STREAM_PARTS = 2_048;
const MAX_STREAM_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

type OpenCodeStreamSession = {
  messages?: unknown[];
  messagesCurrent: boolean;
  /** Monotonic count of inbound session events, including events seen while dirty. */
  eventVersion: number;
  notices: NativeAgentNotice[];
  revision: number;
  /** Exact after snapshots/structural changes; a safe upper bound after deltas. */
  transcriptBytes?: number;
  title?: string;
  permission?: unknown;
  runtime?: Pick<NativeAgentRuntimeSummary, "todos" | "files">;
  turnStartedAt?: number;
  /** Whether a running observation confirmed the current turn clock. */
  turnConfirmed?: boolean;
};

export type OpenCodeStreamEffect = {
  reconnect?: boolean;
  refreshInteractions?: string;
  refreshMcp?: boolean;
  sessionId?: string;
  status?: "running" | "idle" | "missing";
};

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

  register(sessionId: string): void {
    this.session(sessionId);
  }

  private session(sessionId: string): OpenCodeStreamSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: OpenCodeStreamSession = {
      messagesCurrent: false,
      eventVersion: 0,
      notices: [],
      revision: 0,
    };
    setBoundedMapEntry(this.sessions, sessionId, created, MAX_STREAM_SESSIONS);
    return created;
  }

  replaceMessages(
    sessionId: string,
    messages: readonly unknown[],
    expectedEventVersion?: number,
  ): boolean {
    const state = this.session(sessionId);
    if (expectedEventVersion !== undefined && state.eventVersion !== expectedEventVersion) {
      return false;
    }
    state.messages = [...messages];
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

  revision(sessionId: string): number {
    return this.sessions.get(sessionId)?.revision ?? 0;
  }

  runtime(sessionId: string): Pick<NativeAgentRuntimeSummary, "todos" | "files"> {
    return this.sessions.get(sessionId)?.runtime ?? {};
  }

  title(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.title;
  }

  permission(sessionId: string): unknown {
    return this.sessions.get(sessionId)?.permission;
  }

  notices(sessionId: string): NativeAgentNotice[] {
    return [...(this.sessions.get(sessionId)?.notices ?? [])];
  }

  /** Record dispatch before a renderer has to observe the turn. */
  beginTurn(sessionId: string, startedAt: number): void {
    const state = this.session(sessionId);
    state.turnStartedAt = startedAt;
    state.turnConfirmed = false;
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

  endTurn(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    delete state.turnStartedAt;
    delete state.turnConfirmed;
  }

  markGap(): void {
    for (const state of this.sessions.values()) {
      state.messagesCurrent = false;
      this.bumpEventVersion(state);
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

    if (event.type === "session.status") {
      const status = asRecord(properties?.status)?.type;
      if (status === "busy" || status === "retry") {
        state.notices = [];
        this.ensureTurnStarted(sessionId, observedAt);
        return { sessionId, status: "running" };
      }
      if (status === "idle") {
        this.endTurn(sessionId);
        return { sessionId, status: "idle" };
      }
      return { sessionId };
    }
    if (event.type === "session.idle") {
      this.endTurn(sessionId);
      return { sessionId, status: "idle" };
    }
    if (event.type === "session.deleted") {
      this.endTurn(sessionId);
      state.messagesCurrent = false;
      return { sessionId, status: "missing" };
    }
    if (event.type === "permission.replied") {
      return { sessionId, refreshInteractions: sessionId };
    }
    if (event.type === "session.updated") {
      const info = asRecord(properties?.info);
      const title = nonEmptyString(info?.title);
      if (title) state.title = title;
      // OpenCode v1 exposes the provider ruleset on Session.permission. Keep
      // the bounded provider value at this low adapter boundary; plan 12 owns
      // translating it into the shared execution-policy contract.
      if (Array.isArray(info?.permission) && serializedByteLength(info.permission) <= 64 * 1024) {
        state.permission = info.permission;
      }
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
      const error = asRecord(properties?.error);
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

    if (!state.messagesCurrent || !state.messages) return { sessionId };
    if (event.type === "message.updated") {
      const info = asRecord(properties?.info);
      const messageId = nonEmptyString(info?.id);
      if (!messageId) return this.invalidate(state, sessionId);
      const index = this.messageIndex(state.messages, messageId);
      const previous = index >= 0 ? asRecord(state.messages[index]) : undefined;
      const next = { info, parts: Array.isArray(previous?.parts) ? previous.parts : [] };
      if (index >= 0) state.messages[index] = next;
      else state.messages.push(next);
      this.finishMessageMutation(state);
      return { sessionId };
    }
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

  private bump(state: OpenCodeStreamSession): void {
    state.revision = state.revision >= Number.MAX_SAFE_INTEGER ? 1 : state.revision + 1;
  }

  private bumpEventVersion(state: OpenCodeStreamSession): void {
    state.eventVersion = state.eventVersion >= Number.MAX_SAFE_INTEGER ? 1 : state.eventVersion + 1;
  }
}
