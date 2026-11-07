/**
 * The open agent voice chats of one Control MCP listener.
 *
 * A chat belongs to the credential that opened it: no other credential can
 * read, continue or end it. It lives in memory only, bounded in count, turns
 * and idle time, so a backend restart ends every voice chat (the voice agent
 * is told `not-found` and opens a new one). Nothing a person says reaches
 * storage or a log.
 *
 * One reply runs at a time per chat. A new message while a reply is running
 * supersedes it, as a person talking over a slow answer would: the late
 * reply is dropped and the new reply sees both messages. A message is
 * idempotent on its request ID, so a voice agent that retries after a dropped
 * connection hears the same reply rather than asking twice.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  AGENT_VOICE_CHAT_LIMITS,
  agentVoiceChatTitle,
  type AgentVoiceChatReplyState,
  type AgentVoiceChatTurn,
  type AgentVoiceChatView,
} from "@orkestrator/protocol/agent-voice-chat";

export type AgentVoiceChatErrorCode =
  "not-found" | "request-conflict" | "store-capacity" | "invalid-input";

export class AgentVoiceChatError extends Error {
  constructor(
    readonly code: AgentVoiceChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentVoiceChatError";
  }
}

/** Writes one reply to the chat's latest message; throws when none can be written. */
export type AgentVoiceChatReplyRun = (
  chat: AgentVoiceChatRecord,
  signal: AbortSignal,
) => Promise<string>;

export interface AgentVoiceChatRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly projectId: string;
  /** The machine the project is on, when not this one. */
  readonly nodeId?: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  turns: AgentVoiceChatTurn[];
  state: AgentVoiceChatReplyState;
  pendingTurnId?: string;
  error?: string;
}

interface ChatState {
  record: AgentVoiceChatRecord;
  /** Bumped by every reply start; a reply finishing under an older value is dropped. */
  generation: number;
  controller?: AbortController;
  waiters: Set<() => void>;
  /** requestId → the voice turn it created and its text. */
  requests: Map<string, { turnId: string; text: string }>;
}

export interface AgentVoiceChatsOptions {
  now?: () => number;
  randomId?: () => string;
  idleExpiryMs?: number;
  sweepIntervalMs?: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class AgentVoiceChats {
  private readonly chats = new Map<string, ChatState>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly idleExpiryMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private turnCounter = 0;
  /** Opening keys retain tombstones: an evicted chat must not become a second opening. */
  private readonly openings = new Map<string, { intent: string; chatId: string }>();

  constructor(private readonly options: AgentVoiceChatsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomBytes(9).toString("hex").slice(0, 12));
    this.idleExpiryMs = options.idleExpiryMs ?? AGENT_VOICE_CHAT_LIMITS.idleExpiryMs;
  }

  /** Opens a chat for `ownerId`, ending that owner's least recently used one past its limit. */
  open(input: {
    ownerId: string;
    projectId: string;
    nodeId?: string;
    title?: string;
    firstMessage: string;
  }): AgentVoiceChatRecord {
    this.assertLive();
    if (!input.firstMessage.trim())
      throw new AgentVoiceChatError("invalid-input", "Say something first");
    this.sweep();
    const owned = this.ownedBy(input.ownerId);
    if (owned.length >= AGENT_VOICE_CHAT_LIMITS.chatsPerOwner) {
      const oldest = owned
        .filter((state) => state.record.state !== "replying")
        .sort((a, b) => a.record.updatedAt - b.record.updatedAt)[0];
      if (!oldest) {
        throw new AgentVoiceChatError(
          "store-capacity",
          "Every voice chat of this client is answering; wait for one or end one",
        );
      }
      this.remove(oldest);
    }
    if (this.chats.size >= AGENT_VOICE_CHAT_LIMITS.chatsTotal) {
      throw new AgentVoiceChatError(
        "store-capacity",
        "Too many agent voice chats are open; end one first",
      );
    }
    const now = this.now();
    let id = `avc_${this.randomId()}`;
    while (this.chats.has(id)) id = `avc_${this.randomId()}`;
    const record: AgentVoiceChatRecord = {
      id,
      ownerId: input.ownerId,
      projectId: input.projectId,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      title: agentVoiceChatTitle(input.firstMessage, input.title),
      createdAt: now,
      updatedAt: now,
      turns: [],
      state: "idle",
    };
    this.chats.set(id, { record, generation: 0, waiters: new Set(), requests: new Map() });
    this.ensureSweep();
    return record;
  }

  /** The owner's chat; `not-found` for an unknown, ended or expired one, or another owner's. */
  get(ownerId: string, chatId: string): AgentVoiceChatRecord {
    return this.state(ownerId, chatId).record;
  }

  list(ownerId: string): AgentVoiceChatRecord[] {
    this.sweep();
    return this.ownedBy(ownerId)
      .map((state) => state.record)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Adds the voice agent's message and starts its reply. A retry of the same
   * request ID with the same text adds nothing: it returns the original turn,
   * and restarts its reply only when that reply failed. The same ID with other
   * text is `request-conflict`.
   */
  say(input: {
    ownerId: string;
    chatId: string;
    text: string;
    requestId: string;
    reply: AgentVoiceChatReplyRun;
  }): { turn: AgentVoiceChatTurn; replayed: boolean } {
    const state = this.state(input.ownerId, input.chatId);
    const record = state.record;
    const text = input.text.trim();
    if (!text) throw new AgentVoiceChatError("invalid-input", "Say something first");
    const earlier = state.requests.get(input.requestId);
    if (earlier) {
      if (earlier.text !== text) {
        throw new AgentVoiceChatError(
          "request-conflict",
          "That requestId was used for a different message",
        );
      }
      const turn = record.turns.find((candidate) => candidate.id === earlier.turnId);
      if (!turn) {
        throw new AgentVoiceChatError("not-found", "That message is no longer in the chat");
      }
      if (record.state === "failed" && record.pendingTurnId === turn.id) {
        this.startReply(state, turn.id, input.reply);
      }
      return { turn, replayed: true };
    }
    const turn = this.append(state, { role: "voice", text, requestId: input.requestId });
    state.requests.set(input.requestId, { turnId: turn.id, text });
    // Requests older than every kept turn can no longer replay anything.
    if (state.requests.size > AGENT_VOICE_CHAT_LIMITS.turnsKept) {
      const oldest = state.requests.keys().next().value;
      if (oldest !== undefined) state.requests.delete(oldest);
    }
    this.startReply(state, turn.id, input.reply);
    return { turn, replayed: false };
  }

  /** A note in the chat that is neither side's message, such as an interrupt sent. */
  note(ownerId: string, chatId: string, text: string): AgentVoiceChatTurn {
    return this.append(this.state(ownerId, chatId), { role: "event", text });
  }

  /**
   * Waits until the chat's reply to `turnId` (or, without one, any running
   * reply) has finished, at most `ms`. Resolves early when the chat ends.
   */
  async waitForReply(ownerId: string, chatId: string, ms: number, turnId?: string): Promise<void> {
    const state = this.state(ownerId, chatId);
    const settled = () =>
      !this.chats.has(state.record.id) ||
      state.record.state !== "replying" ||
      (turnId !== undefined && !this.replyPendingFor(state.record, turnId));
    if (settled() || ms <= 0) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (!settled()) return;
        if (timer) clearTimeout(timer);
        state.waiters.delete(wake);
        resolve();
      };
      timer = setTimeout(
        () => {
          state.waiters.delete(wake);
          resolve();
        },
        Math.min(ms, AGENT_VOICE_CHAT_LIMITS.waitMaxMs),
      );
      state.waiters.add(wake);
    });
  }

  /** The agent turn answering `turnId`, once it exists. */
  replyTo(record: AgentVoiceChatRecord, turnId: string): AgentVoiceChatTurn | undefined {
    const index = record.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) return undefined;
    return record.turns.slice(index + 1).find((turn) => turn.role === "agent");
  }

  end(ownerId: string, chatId: string): AgentVoiceChatRecord {
    const state = this.state(ownerId, chatId);
    this.remove(state);
    return state.record;
  }

  /** The chat as a tool returns it, optionally only the turns after `afterTurnId`. */
  view(record: AgentVoiceChatRecord, afterTurnId?: string): AgentVoiceChatView {
    const index = afterTurnId ? record.turns.findIndex((turn) => turn.id === afterTurnId) : -1;
    return {
      chatId: record.id,
      projectId: record.projectId,
      title: record.title,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      state: record.state,
      ...(record.pendingTurnId && record.state !== "idle"
        ? { pendingTurnId: record.pendingTurnId }
        : {}),
      ...(record.error ? { error: record.error } : {}),
      turns: record.turns.slice(index + 1).map((turn) => ({ ...turn })),
    };
  }

  /** Synchronous reservation, before say starts work; concurrent callers reuse the same chat. */
  openRequest(input: {
    ownerId: string;
    requestId: string;
    projectId: string;
    nodeId?: string;
    firstMessage: string;
  }): AgentVoiceChatRecord {
    this.assertLive();
    const key = JSON.stringify([input.ownerId, input.requestId]);
    const intent = createHash("sha256")
      .update(JSON.stringify([input.nodeId ?? "", input.projectId, input.firstMessage.trim()]))
      .digest("hex");
    const previous = this.openings.get(key);
    if (previous) {
      if (previous.intent !== intent)
        throw new AgentVoiceChatError(
          "request-conflict",
          "That requestId was used for a different opening",
        );
      return this.get(input.ownerId, previous.chatId);
    }
    if (this.openings.size >= 1024)
      throw new AgentVoiceChatError(
        "store-capacity",
        "Too many opening requests; restart the voice chat listener",
      );
    const chat = this.open(input);
    this.openings.set(key, { intent, chatId: chat.id });
    return chat;
  }

  /** Ends every chat and stops the expiry sweep; later calls are refused. */
  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const state of Array.from(this.chats.values())) this.remove(state);
    this.openings.clear();
  }

  /** Ends chats idle past the expiry; a chat that is replying is not idle. */
  sweep(): void {
    const cutoff = this.now() - this.idleExpiryMs;
    for (const state of Array.from(this.chats.values())) {
      if (state.record.state !== "replying" && state.record.updatedAt < cutoff) this.remove(state);
    }
    if (this.chats.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private replyPendingFor(record: AgentVoiceChatRecord, turnId: string): boolean {
    if (record.state !== "replying" || !record.pendingTurnId) return false;
    const pending = record.turns.findIndex((turn) => turn.id === record.pendingTurnId);
    const asked = record.turns.findIndex((turn) => turn.id === turnId);
    // A later message superseded this one; its reply will answer both.
    return asked >= 0 && pending >= asked;
  }

  private startReply(state: ChatState, turnId: string, run: AgentVoiceChatReplyRun): void {
    const record = state.record;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.generation += 1;
    const generation = state.generation;
    record.state = "replying";
    record.pendingTurnId = turnId;
    delete record.error;
    record.updatedAt = this.now();
    void (async () => {
      let reply: string | null = null;
      let failure: string | null = null;
      try {
        reply = (await run(record, controller.signal)).trim() || null;
        if (!reply) failure = "The reply was empty";
      } catch (error) {
        // Content-free: a CLI handed the conversation on stdin can quote it back.
        failure =
          error instanceof AgentVoiceChatError
            ? error.message
            : "No reply could be written; try again";
      }
      if (state.generation !== generation || !this.chats.has(record.id)) return;
      if (reply) {
        this.append(state, { role: "agent", text: reply });
        record.state = "idle";
        delete record.pendingTurnId;
      } else {
        record.state = "failed";
        record.error = failure ?? "No reply could be written; try again";
      }
      record.updatedAt = this.now();
      this.notify(state);
    })();
  }

  private append(
    state: ChatState,
    turn: Omit<AgentVoiceChatTurn, "id" | "at">,
  ): AgentVoiceChatTurn {
    const now = this.now();
    this.turnCounter += 1;
    const entry: AgentVoiceChatTurn = {
      id: `t${this.turnCounter.toString(36)}`,
      at: iso(now),
      ...turn,
    };
    state.record.turns.push(entry);
    if (state.record.turns.length > AGENT_VOICE_CHAT_LIMITS.turnsKept) {
      state.record.turns.splice(0, state.record.turns.length - AGENT_VOICE_CHAT_LIMITS.turnsKept);
    }
    state.record.updatedAt = now;
    return entry;
  }

  private notify(state: ChatState): void {
    for (const wake of Array.from(state.waiters)) wake();
  }

  private remove(state: ChatState): void {
    this.chats.delete(state.record.id);
    state.controller?.abort();
    // A late reply finds the chat gone and is dropped.
    state.generation += 1;
    this.notify(state);
  }

  private state(ownerId: string, chatId: string): ChatState {
    this.assertLive();
    const state = this.chats.get(chatId);
    if (!state || state.record.ownerId !== ownerId) {
      throw new AgentVoiceChatError(
        "not-found",
        "No open agent voice chat has that ID; start a new one",
      );
    }
    if (
      state.record.state !== "replying" &&
      state.record.updatedAt < this.now() - this.idleExpiryMs
    ) {
      this.remove(state);
      throw new AgentVoiceChatError("not-found", "That agent voice chat expired; start a new one");
    }
    return state;
  }

  private ownedBy(ownerId: string): ChatState[] {
    return Array.from(this.chats.values()).filter((state) => state.record.ownerId === ownerId);
  }

  private ensureSweep(): void {
    if (this.sweepTimer || this.disposed) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs ?? 60_000);
    this.sweepTimer.unref?.();
  }

  private assertLive(): void {
    if (this.disposed) throw new AgentVoiceChatError("not-found", "Agent voice chat has stopped");
  }
}

/** What a Control MCP listener gives its operator callers for agent voice chat. */
export interface AgentVoiceChatHost {
  chats: AgentVoiceChats;
  bindInterrupt(input: VoiceInterruptBindingInput): VoiceInterruptBinding | null;
  /** One spoken reply to a prompt built by `buildAgentVoiceChatPrompt`. */
  reply(input: { prompt: string; agent?: string; signal?: AbortSignal }): Promise<string>;
}

/** Content-free durable choice, published before the public mutation. */
export interface VoiceInterruptBinding {
  fingerprint: string;
  sessionId: string;
  action: "session.prompt" | "session.steer" | "session.stop";
}
export interface VoiceInterruptBindingInput {
  ownerId: string;
  requestId: string;
  fingerprint: string;
  choice?: Omit<VoiceInterruptBinding, "fingerprint">;
}
