import { describe, expect, test } from "bun:test";
import { harness, threadPayload, waitUntil } from "./app-server-runtime-test-harness.js";

/**
 * Rewinds: our own `thread/revert`, and one made by another client, which
 * app-server reports as `thread/reverted` naming only the thread.
 */
async function twoTurns(surviving: {
  turns: string[];
  failRead?: boolean;
  pendingRead?: Promise<void>;
}) {
  let started = 0;
  const h = await harness({
    "turn/start": () => ({ turn: { id: `turn-${++started}` } }),
    "thread/read": async () => {
      const turns = [...surviving.turns];
      await surviving.pendingRead;
      if (surviving.failRead) throw new Error("app-server restarting");
      return {
        thread: threadPayload("thread-1", {
          turns: turns.map((id) => ({ id, items: [] })),
        }),
      };
    },
    "thread/revert": () => ({}),
  });
  const { sessionId } = h.runtime.createSession({ mode: "build" });
  for (const [index, prompt] of ["first prompt", "second prompt"].entries()) {
    await h.runtime.prompt(sessionId, { prompt, requestId: `req-${index}`, attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: `turn-${index + 1}`, status: "completed" },
    });
    await h.drain();
  }
  return { h, sessionId };
}

describe("Codex rewinds", () => {
  test("discards a read predating a turn that starts and finishes while the read waits", async () => {
    const surviving: { turns: string[]; pendingRead?: Promise<void> } = { turns: ["turn-1"] };
    const { h, sessionId } = await twoTurns(surviving);
    let release!: () => void;
    surviving.pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.child().notify("thread/reverted", { threadId: "thread-1" });
    await waitUntil(
      () => h.child().requests.some((request) => request.method === "thread/read"),
      "the revert read never started",
    );
    await h.runtime.prompt(sessionId, {
      prompt: "new prompt",
      requestId: "req-new",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-3", status: "completed" },
    });
    await h.drain();
    const before = await h.runtime.getMessages(sessionId);
    const revision = h.runtime.getRegistry().getSession(sessionId)!.messageRevision;
    release();
    await h.drain();
    await Bun.sleep(10);
    expect(await h.runtime.getMessages(sessionId)).toEqual(before);
    expect(before?.some((message) => message.content === "new prompt")).toBe(true);
    expect(h.runtime.getRegistry().getSession(sessionId)!.messageRevision).toBe(revision);
  });

  test.each(["no-ids", "mixed-ids", "empty"] as const)(
    "reconciles %s transcripts through the runtime",
    async (mode) => {
      const surviving = { turns: ["turn-1", "turn-2"] };
      const { h, sessionId } = await twoTurns(surviving);
      const context = h.runtime.getRegistry().getThreadForSession(sessionId)!;
      for (const message of context.messages) {
        if (mode === "no-ids" || (mode === "mixed-ids" && message.turnId === "turn-1"))
          delete message.turnId;
      }
      surviving.turns = mode === "empty" ? [] : ["turn-1"];
      h.child().notify("thread/reverted", { threadId: "thread-1" });
      await waitUntil(
        () => !context.messages.some((message) => message.content === "second prompt"),
        "the revert was not adopted",
      );
      const messages = await h.runtime.getMessages(sessionId);
      if (mode === "empty") expect(messages).toEqual([]);
      else
        expect(
          messages?.filter((message) => message.role === "user").map((message) => message.content),
        ).toEqual(["first prompt"]);
    },
  );

  test("a context replaced while the read waits is left alone", async () => {
    const surviving: { turns: string[]; pendingRead?: Promise<void> } = { turns: ["turn-1"] };
    const { h, sessionId } = await twoTurns(surviving);
    let release!: () => void;
    surviving.pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.child().notify("thread/reverted", { threadId: "thread-1" });
    await waitUntil(
      () => h.child().requests.some((request) => request.method === "thread/read"),
      "read not started",
    );
    const context = h.runtime.getRegistry().getThreadForSession(sessionId)!;
    h.runtime.getRegistry().detachThread(context.threadId);
    const before = [...context.messages];
    const replacement = h.runtime.getRegistry().attach(sessionId, context.threadId, {
      engineHandle: context.engineHandle,
      engineGeneration: context.engineGeneration,
    });
    replacement.messages = [
      {
        id: "replacement",
        role: "user",
        content: "replacement prompt",
        parts: [],
        createdAt: new Date().toISOString(),
      },
    ];
    release();
    await h.drain();
    await Bun.sleep(10);
    expect(context.messages).toEqual(before);
    expect(replacement.messages.map((message) => message.content)).toEqual(["replacement prompt"]);
  });

  test("a rewind by another client trims the transcript this bridge serves", async () => {
    const surviving = { turns: ["turn-1", "turn-2"] };
    const { h, sessionId } = await twoTurns(surviving);
    const users = async () =>
      ((await h.runtime.getMessages(sessionId)) ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.content);
    expect(await users()).toEqual(["first prompt", "second prompt"]);

    surviving.turns = ["turn-1"];
    h.events.length = 0;
    h.child().notify("thread/reverted", { threadId: "thread-1" });
    await waitUntil(async () => (await users()).length === 1, "the revert was not adopted");

    expect(await users()).toEqual(["first prompt"]);
    expect(
      ((await h.runtime.getMessages(sessionId)) ?? []).every(
        (message) => message.turnId === undefined || message.turnId === "turn-1",
      ),
    ).toBe(true);
    expect(
      h.events.some(
        (event) => event.type === "session.reconcile-required" && event.sessionId === sessionId,
      ),
    ).toBe(true);
    // No longer an unknown or ignored method.
    expect(h.engine.getHealth().unknownNotifications).toBe(0);
  });

  test("our own rewind's echo finds nothing more to cut", async () => {
    const surviving = { turns: ["turn-1", "turn-2"] };
    const { h, sessionId } = await twoTurns(surviving);
    // The thread's own rows: these carry the turn ids set at dispatch.
    const messages = h.runtime.getRegistry().getThreadForSession(sessionId)?.messages ?? [];
    const second = messages.find(
      (message) => message.role === "user" && message.content === "second prompt",
    );
    expect(second?.turnId).toBe("turn-2");

    expect(await h.runtime.rewindMessages(sessionId, second!.id)).toBe("rewound");
    expect(
      h.child().requests.find((request) => request.method === "thread/revert")?.params,
    ).toEqual({ threadId: "thread-1", beforeTurnId: "turn-2" });
    const afterRewind = (await h.runtime.getMessages(sessionId))?.length;

    surviving.turns = ["turn-1"];
    h.child().notify("thread/reverted", { threadId: "thread-1" });
    await waitUntil(
      () => h.child().requests.some((request) => request.method === "thread/read"),
      "the echo was not reconciled",
    );
    await h.drain();
    expect((await h.runtime.getMessages(sessionId))?.length).toBe(afterRewind);
  });

  test("a failed turn read leaves the transcript as it was", async () => {
    const surviving = { turns: ["turn-1", "turn-2"], failRead: false };
    const { h, sessionId } = await twoTurns(surviving);
    const before = (await h.runtime.getMessages(sessionId))?.length;
    surviving.turns = [];
    surviving.failRead = true;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      h.child().notify("thread/reverted", { threadId: "thread-1" });
      await h.drain();
      await Bun.sleep(5);
    } finally {
      console.warn = warn;
    }
    expect((await h.runtime.getMessages(sessionId))?.length).toBe(before);
  });
});
