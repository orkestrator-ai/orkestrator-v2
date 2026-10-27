import { describe, expect, test } from "bun:test";
import { harness, threadPayload, waitUntil } from "./app-server-runtime-test-harness.js";

/**
 * Rewinds: our own `thread/revert`, and one made by another client, which
 * app-server reports as `thread/reverted` naming only the thread.
 */
async function twoTurns(surviving: { turns: string[]; failRead?: boolean }) {
  let started = 0;
  const h = await harness({
    "turn/start": () => ({ turn: { id: `turn-${++started}` } }),
    "thread/read": () => {
      if (surviving.failRead) throw new Error("app-server restarting");
      return {
        thread: threadPayload("thread-1", {
          turns: surviving.turns.map((id) => ({ id, items: [] })),
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
    const messages = (await h.runtime.getMessages(sessionId)) ?? [];
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
