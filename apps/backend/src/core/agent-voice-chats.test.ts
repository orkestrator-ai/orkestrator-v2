import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_VOICE_CHAT_LIMITS } from "@orkestrator/protocol/agent-voice-chat";
import {
  AgentVoiceChatError,
  AgentVoiceChats,
  type AgentVoiceChatRecord,
} from "./agent-voice-chats.js";

/** The in-memory agent voice chats: ownership, replies, idempotence, bounds and teardown. */

const live: AgentVoiceChats[] = [];
afterEach(() => {
  for (const chats of live.splice(0)) chats.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function chats(options: ConstructorParameters<typeof AgentVoiceChats>[0] = {}) {
  let next = 0;
  const instance = new AgentVoiceChats({
    randomId: () => (next++).toString().padStart(12, "0"),
    ...options,
  });
  live.push(instance);
  return instance;
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentVoiceChatError) return error.code;
    throw error;
  }
  return undefined;
}

describe("AgentVoiceChats", () => {
  test("a message gets a reply that answers it", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "Status?" });
    expect(chat.id).toMatch(/^avc_[a-z0-9]{12}$/);
    expect(chat.title).toBe("Status?");
    const seen: string[][] = [];
    const { turn, replayed } = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "Status?",
      requestId: "r1",
      reply: async (record) => {
        seen.push(record.turns.map((entry) => entry.text));
        return "All quiet.";
      },
    });
    expect(replayed).toBe(false);
    expect(chat.state).toBe("replying");
    await store.waitForReply("voice", chat.id, 1_000, turn.id);
    expect(seen).toEqual([["Status?"]]);
    expect(store.replyTo(chat, turn.id)?.text).toBe("All quiet.");
    expect(store.view(chat)).toMatchObject({
      chatId: chat.id,
      projectId: "p1",
      state: "idle",
      turns: [
        { role: "voice", text: "Status?", requestId: "r1" },
        { role: "agent", text: "All quiet." },
      ],
    });
    expect(store.view(chat, turn.id).turns.map((entry) => entry.role)).toEqual(["agent"]);
  });

  test("chats belong to the credential that opened them", () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    expect(errorCode(() => store.get("other", chat.id))).toBe("not-found");
    expect(errorCode(() => store.end("other", chat.id))).toBe("not-found");
    expect(store.list("other")).toEqual([]);
    expect(store.list("voice").map((entry) => entry.id)).toEqual([chat.id]);
  });

  test("a retried request repeats nothing; other text under its ID conflicts", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    let runs = 0;
    const reply = async () => {
      runs += 1;
      return "Hello.";
    };
    const first = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "hi",
      requestId: "r1",
      reply,
    });
    await store.waitForReply("voice", chat.id, 1_000, first.turn.id);
    const again = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "hi",
      requestId: "r1",
      reply,
    });
    expect(again).toEqual({ turn: first.turn, replayed: true });
    expect(runs).toBe(1);
    expect(chat.turns).toHaveLength(2);
    expect(
      errorCode(() =>
        store.say({ ownerId: "voice", chatId: chat.id, text: "bye", requestId: "r1", reply }),
      ),
    ).toBe("request-conflict");
  });

  test("a failed reply is retried by repeating the request", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    const failing = async (): Promise<string> => {
      throw new Error("Claude printed the prompt: secret words");
    };
    const { turn } = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "hi",
      requestId: "r1",
      reply: failing,
    });
    await store.waitForReply("voice", chat.id, 1_000, turn.id);
    expect(chat.state).toBe("failed");
    // Content-free: the CLI's own error never reaches the caller.
    expect(chat.error).toBe("No reply could be written; try again");
    store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "hi",
      requestId: "r1",
      reply: async () => "Hello again.",
    });
    await store.waitForReply("voice", chat.id, 1_000, turn.id);
    expect(chat.state).toBe("idle");
    expect(store.replyTo(chat, turn.id)?.text).toBe("Hello again.");
    expect(chat.turns.filter((entry) => entry.role === "voice")).toHaveLength(1);
  });

  test("a new message supersedes a slow reply, which is dropped", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "one" });
    const slow = deferred<string>();
    const first = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "one",
      requestId: "r1",
      reply: () => slow.promise,
    });
    let secondSaw: string[] = [];
    const second = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "two",
      requestId: "r2",
      reply: async (record: AgentVoiceChatRecord) => {
        secondSaw = record.turns.map((entry) => entry.text);
        return "Both answered.";
      },
    });
    // The first message's wait ends with the reply that superseded it.
    await store.waitForReply("voice", chat.id, 1_000, first.turn.id);
    expect(secondSaw).toEqual(["one", "two"]);
    slow.resolve("Late answer.");
    await Bun.sleep(0);
    expect(chat.turns.map((entry) => entry.text)).toEqual(["one", "two", "Both answered."]);
    expect(store.replyTo(chat, first.turn.id)?.text).toBe("Both answered.");
    expect(store.replyTo(chat, second.turn.id)?.text).toBe("Both answered.");
  });

  test("a wait is bounded and ends when the chat ends", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    const never = deferred<string>();
    const { turn } = store.say({
      ownerId: "voice",
      chatId: chat.id,
      text: "hi",
      requestId: "r1",
      reply: () => never.promise,
    });
    const started = Date.now();
    await store.waitForReply("voice", chat.id, 20, turn.id);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(chat.state).toBe("replying");
    const waiting = store.waitForReply("voice", chat.id, 10_000, turn.id);
    store.end("voice", chat.id);
    await waiting;
    never.resolve("Too late.");
    await Bun.sleep(0);
    expect(chat.turns).toHaveLength(1);
    expect(errorCode(() => store.get("voice", chat.id))).toBe("not-found");
  });

  test("turns are bounded, notes are kept as context", () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    for (let index = 0; index < AGENT_VOICE_CHAT_LIMITS.turnsKept + 5; index += 1) {
      store.note("voice", chat.id, `note ${index}`);
    }
    expect(chat.turns).toHaveLength(AGENT_VOICE_CHAT_LIMITS.turnsKept);
    expect(chat.turns[0]?.text).toBe("note 5");
    expect(chat.turns.every((entry) => entry.role === "event")).toBe(true);
  });

  test("idle chats expire; a replying chat does not", () => {
    let now = 1_000_000;
    const store = chats({ now: () => now, idleExpiryMs: 1_000 });
    const idle = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "a" });
    const busy = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "b" });
    store.say({
      ownerId: "voice",
      chatId: busy.id,
      text: "b",
      requestId: "r1",
      reply: () => new Promise<string>(() => undefined),
    });
    now += 5_000;
    expect(errorCode(() => store.get("voice", idle.id))).toBe("not-found");
    store.sweep();
    expect(store.list("voice").map((entry) => entry.id)).toEqual([busy.id]);
  });

  test("each credential keeps a bounded number of chats", () => {
    let now = 0;
    const store = chats({ now: () => (now += 1) });
    const opened = Array.from({ length: AGENT_VOICE_CHAT_LIMITS.chatsPerOwner }, (_, index) =>
      store.open({ ownerId: "voice", projectId: "p1", firstMessage: `chat ${index}` }),
    );
    const newest = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "one more" });
    const ids = store.list("voice").map((entry) => entry.id);
    expect(ids).toHaveLength(AGENT_VOICE_CHAT_LIMITS.chatsPerOwner);
    expect(ids).toContain(newest.id);
    // The least recently used chat made room.
    expect(ids).not.toContain(opened[0]!.id);
  });

  test("opening requests bind owner, node, project and text, retaining ended tombstones", () => {
    const store = chats();
    const input = { ownerId: "voice", projectId: "p1", firstMessage: "hi", requestId: "r1" };
    const first = store.openRequest(input);
    expect(store.openRequest(input).id).toBe(first.id);
    for (const changed of [{ firstMessage: "other" }, { projectId: "p2" }, { nodeId: "remote" }]) {
      expect(errorCode(() => store.openRequest({ ...input, ...changed }))).toBe("request-conflict");
    }
    expect(store.openRequest({ ...input, ownerId: "other" }).id).not.toBe(first.id);
    store.end("voice", first.id);
    expect(errorCode(() => store.openRequest(input))).toBe("not-found");
  });

  test("supersession, end and dispose abort the owned generation", async () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    const signals: AbortSignal[] = [];
    const reply = async (_record: AgentVoiceChatRecord, signal: AbortSignal) => {
      signals.push(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return "obsolete";
    };
    store.say({ ownerId: "voice", chatId: chat.id, text: "one", requestId: "1", reply });
    store.say({ ownerId: "voice", chatId: chat.id, text: "two", requestId: "2", reply });
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    store.end("voice", chat.id);
    expect(signals[1]!.aborted).toBe(true);
    const other = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    store.say({ ownerId: "voice", chatId: other.id, text: "three", requestId: "3", reply });
    store.dispose();
    expect(signals[2]!.aborted).toBe(true);
  });

  test("dispose ends every chat and refuses new ones", () => {
    const store = chats();
    const chat = store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" });
    store.dispose();
    expect(errorCode(() => store.get("voice", chat.id))).toBe("not-found");
    expect(
      errorCode(() => store.open({ ownerId: "voice", projectId: "p1", firstMessage: "hi" })),
    ).toBe("not-found");
  });
});
