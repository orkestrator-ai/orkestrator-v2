/**
 * `/dispatch` answering `absent`: the runtime half of the proof (todo 0223).
 *
 * The journal's own rules are covered in `sessions/dispatch-journal.test.ts`;
 * these drive the real runtime against a scripted app-server, with the
 * harness's private CODEX_HOME, and restart it over the same directory.
 */
import { describe, expect, jest, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashCwd } from "./sessions/persistence.js";
import {
  codexHome,
  deferredSignal,
  harness,
  threadPayload,
  waitUntil,
} from "./app-server-runtime-test-harness.js";

jest.setTimeout(30_000);

const turnStarts = (h: Awaited<ReturnType<typeof harness>>) =>
  h.children.flatMap((child) => child.requests).filter((r) => r.method === "turn/start");

async function completeTurn(h: Awaited<ReturnType<typeof harness>>, turnId = "turn-1") {
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "completed" },
  });
  await h.drain();
}

describe("absent dispatch answers", () => {
  test("a fresh session proves an unseen id absent until a prompt journals it", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build", clientSessionKey: "env:tab" });
    expect(h.runtime.promptDispatchAbsent(sessionId, "req-1")).toBe(true);

    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    expect(h.runtime.promptDispatchAbsent(sessionId, "req-1")).toBe(false);
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "accepted",
      bridgeSessionId: sessionId,
    });

    // The resend the backend makes on `absent` is deduplicated by the journal.
    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });
    expect(again).toMatchObject({ ok: true, result: { duplicate: true } });
    expect(turnStarts(h)).toHaveLength(1);
    // Other ids on the same session are still provably unsent.
    expect(h.runtime.promptDispatchAbsent(sessionId, "req-2")).toBe(true);
    // An unknown session proves nothing.
    expect(h.runtime.promptDispatchAbsent("session-nope", "req-2")).toBe(false);
  });

  test("a record of the id under another session is never absent", async () => {
    const h = await harness();
    const first = h.runtime.createSession({ mode: "build" });
    const second = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "x",
      requestId: "req-shared",
      attachments: [],
    });
    expect(h.runtime.promptDispatchAbsent(second.sessionId, "req-shared")).toBe(false);
  });

  test("a prompt still on its way to the journal keeps the id unknown", async () => {
    const threadStart = deferredSignal();
    const h = await harness({
      "thread/start": async () => {
        await threadStart.promise;
        return { thread: threadPayload("thread-1") };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const pending = h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("thread/start");
    expect(h.runtime.getJournal().get("req-1")).toBeUndefined();
    expect(h.runtime.promptDispatchAbsent(sessionId, "req-1")).toBe(false);
    threadStart.resolve();
    await pending;
    expect(h.runtime.getJournal().get("req-1")?.state).toBe("accepted");
  });

  test("a resumed session is never absent", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-adopted") }),
    });
    const resumed = await h.runtime.resumeSession({ threadId: "thread-adopted", mode: "build" });
    expect(resumed).not.toBeNull();
    expect(h.runtime.promptDispatchAbsent(resumed!.sessionId, "req-never-seen")).toBe(false);
  });

  test("a steered id is never absent, before or after a restart", async () => {
    const first = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    await first.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    expect(first.runtime.promptDispatchAbsent(sessionId, "req-steer")).toBe(true);
    expect(await first.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe(
      "accepted",
    );
    // Not journaled as a prompt, yet it reached Codex.
    expect(first.runtime.getJournal().get("req-steer")).toBeUndefined();
    expect(first.runtime.promptDispatchAbsent(sessionId, "req-steer")).toBe(false);
    await completeTurn(first);
    await first.runtime.stop();

    const second = await harness();
    expect(second.runtime.getRegistry().getSession(sessionId)).toBeDefined();
    expect(second.runtime.promptDispatchAbsent(sessionId, "req-steer")).toBe(false);
    // The marker survived the restart: an id never sent is still provable.
    expect(second.runtime.promptDispatchAbsent(sessionId, "req-never-sent")).toBe(true);
    expect(second.runtime.promptDispatchAbsent(sessionId, "req-1")).toBe(false);
    await second.runtime.stop();
  });

  test("a steer is refused unsent when its id cannot be recorded first", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    const journal = h.runtime.getJournal();
    const original = journal.noteUntracked.bind(journal);
    journal.noteUntracked = async () => {
      throw new Error("disk full");
    };
    try {
      expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe(
        "unavailable",
      );
    } finally {
      journal.noteUntracked = original;
    }
    expect(h.child().requests.some((request) => request.method === "turn/steer")).toBe(false);
  });

  test("sessions that predate an older-format journal stay unknown", async () => {
    // A journal last written by an older bridge: records, no completeness block.
    mkdirSync(join(codexHome, "orkestrator-bridge"), { recursive: true });
    writeFileSync(
      join(codexHome, "orkestrator-bridge", `dispatch-journal-${hashCwd("/tmp/ws")}.json`),
      `${JSON.stringify({
        version: 1,
        records: [
          {
            requestId: "req-old",
            bridgeSessionId: "session-old",
            threadId: "thread-old",
            turnId: "turn-old",
            state: "terminal",
            terminalStatus: "completed",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sequence: 1,
          },
        ],
      })}\n`,
    );
    const h = await harness();
    expect(h.runtime.getJournal().get("req-old")?.state).toBe("terminal");
    const { sessionId } = h.runtime.createSession({ mode: "build", clientSessionKey: "env:tab" });
    // The older bridge's removals were never recorded, so not even a session
    // created afterwards can be proved complete.
    expect(h.runtime.promptDispatchAbsent(sessionId, "req-anything")).toBe(false);
  });

  test("two prompts racing a fresh session's thread creation dispatch once", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Hold the first prompt just after it has bound the new thread, the moment
    // its dispatch lock key changes from the session to the thread.
    const held = deferredSignal();
    let holding = true;
    const runtime = h.runtime as unknown as {
      persistSession: (...args: unknown[]) => Promise<void>;
    };
    const persist = runtime.persistSession.bind(h.runtime);
    let reachedHold = false;
    runtime.persistSession = async (...args: unknown[]) => {
      if (holding) {
        holding = false;
        reachedHold = true;
        await held.promise;
      }
      return persist(...args);
    };
    const first = h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    await waitUntil(() => reachedHold, "first prompt never bound its thread");
    const second = h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.resolve();
    const outcomes = await Promise.all([first, second]);
    expect(turnStarts(h)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
  });
});
