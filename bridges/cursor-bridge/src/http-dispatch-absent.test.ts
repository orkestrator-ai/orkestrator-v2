/**
 * `GET /session/:id/dispatch` answering `absent`: the id has no journal record
 * and the session's journal provably holds every id it ever took.
 *
 * `absent` licenses the backend to re-send under the same id, so every case
 * that cannot prove completeness — an eviction, a reload that lost or lacked
 * the flag, an adopted agent, a claim in flight, a closing session — must stay
 * `unknown`. The router, the write queue, the journals and serialization are
 * production code; only the SDK agent is replaced.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { MAX_PROMPT_JOURNAL } from "./config.js";
import { loadPersistedState, persistBarrier } from "./persistence.js";
import { setPromptJournal } from "./prompt.js";
import { clientSessionKeys, closingTombstones, sessions, type SessionState } from "./state.js";
import { attachFake, fakeAgent } from "./testing/fake-agent.js";
import {
  defaultPolicy,
  deferred,
  holdPublication,
  startRouterHarness,
  stubAttach,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";

let harness: RouterHarness;
let warn: Mock<typeof console.warn>;

beforeEach(async () => {
  harness = await startRouterHarness();
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  try {
    await harness.close();
  } finally {
    warn.mockRestore();
  }
});

function prompt(state: SessionState, requestId: string): Promise<Response> {
  return harness.call(`/session/${state.id}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt: "synthetic prompt", requestId }),
  });
}

async function dispatch(state: SessionState, requestId: string): Promise<unknown> {
  const response = await harness.call(
    `/session/${state.id}/dispatch?requestId=${encodeURIComponent(requestId)}`,
  );
  return ((await response.json()) as { dispatch: unknown }).dispatch;
}

/** A successor process that reads only what was published. */
async function restart(): Promise<void> {
  sessions.clear();
  clientSessionKeys.clear();
  closingTombstones.clear();
  await loadPersistedState();
}

type PublishedFile = { sessions: Array<Record<string, unknown> & { id: string }> };

async function editPublished(edit: (file: PublishedFile) => void): Promise<void> {
  await persistBarrier();
  const file = JSON.parse(await readFile(harness.stateFile, "utf8")) as PublishedFile;
  edit(file);
  await writeFile(harness.stateFile, JSON.stringify(file));
}

function record(file: PublishedFile, id: string): PublishedFile["sessions"][number] {
  return file.sessions.find((entry) => entry.id === id)!;
}

describe("a session this bridge created", () => {
  test("answers absent for an unseen id, dispatches it once, then deduplicates it", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const agent = attachFake(state);
    expect(await dispatch(state, "fresh-1")).toBe("absent");

    expect((await prompt(state, "fresh-1")).status).toBe(202);
    await waitFor(() => state.status !== "running");
    expect(agent.sends).toHaveLength(1);
    expect(await dispatch(state, "fresh-1")).toBe("dispatched");

    const duplicate = await prompt(state, "fresh-1");
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(agent.sends).toHaveLength(1);
    // Another unseen id on the same session is still provably absent.
    expect(await dispatch(state, "fresh-2")).toBe("absent");
  });

  test("publishes the flag only as true", async () => {
    const state = await harness.createSession();
    await persistBarrier();
    const file = (await harness.readPublished()) as PublishedFile;
    expect(record(file, state.id).promptJournalComplete).toBe(true);
  });

  test("a stateless bridge answers absent for its own fresh session", async () => {
    await harness.close();
    harness = await startRouterHarness({ stateless: true });
    const state = await harness.createSession();
    expect(await dispatch(state, "fresh-1")).toBe("absent");
  });

  test("an id the prompt route would not take verbatim is unknown", async () => {
    const state = await harness.createSession();
    attachFake(state);
    expect((await prompt(state, " padded ")).status).toBe(202);
    await waitFor(() => state.status !== "running");
    // The route trims, so " padded " was journaled as "padded".
    expect(await dispatch(state, "padded")).toBe("dispatched");
    expect(await dispatch(state, " padded ")).toBe("unknown");
    expect(await dispatch(state, "x".repeat(513))).toBe("unknown");
    expect(await dispatch(state, "")).toBe("unknown");
  });

  test("a closing session and an in-flight claim answer unknown", async () => {
    const state = await harness.createSession();
    state.closed = true;
    expect(await dispatch(state, "fresh-1")).toBe("unknown");
    state.closed = false;
    // The claim may be this very id before its prepared record exists.
    state.dispatching = true;
    expect(await dispatch(state, "fresh-1")).toBe("unknown");
    state.dispatching = false;
    expect(await dispatch(state, "fresh-1")).toBe("absent");
  });

  test("a read racing the prepared publication is unknown and a same-id resend cannot dispatch twice", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state);
    const hold = holdPublication();
    try {
      const first = prompt(state, "raced-1");
      await hold.held;
      expect(await dispatch(state, "raced-1")).toBe("unknown");
      const resend = await prompt(state, "raced-1");
      expect(resend.status).toBe(409);
      expect(agent.sends).toHaveLength(0);
      hold.release();
      expect((await first).status).toBe(202);
    } finally {
      hold.restore();
    }
    await waitFor(() => state.status !== "running");
    expect(agent.sends).toHaveLength(1);
    expect(await dispatch(state, "raced-1")).toBe("dispatched");
  });

  test("a pre-dispatch rollback keeps the journal complete", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const restore = stubAttach({
      create: async () => {
        throw new Error("cold start failed");
      },
    });
    try {
      const state = await harness.createSession();
      const failed = await prompt(state, "rolled-back");
      expect(failed.status).not.toBe(202);
      expect(state.promptJournal.has("rolled-back")).toBe(false);
      // Provably never reached the SDK, so a resend would be its first delivery.
      expect(await dispatch(state, "rolled-back")).toBe("absent");
      const agent = attachFake(state);
      expect((await prompt(state, "rolled-back")).status).toBe(202);
      await waitFor(() => state.status !== "running");
      expect(agent.sends).toHaveLength(1);
    } finally {
      restore();
      error.mockRestore();
    }
  });

  test("dispatched and lost answers are unchanged", async () => {
    const state = await harness.createSession();
    state.promptJournal.set("done", { requestId: "done", state: "completed", acceptedAt: 0 });
    state.promptJournal.set("old", { requestId: "old", state: "ambiguous", acceptedAt: 0 });
    state.promptJournal.set("retry", {
      requestId: "retry",
      state: "ambiguous",
      acceptedAt: 0,
      sendFailed: true,
    });
    state.promptJournal.set("gone", { requestId: "gone", state: "discarded", acceptedAt: 0 });
    state.promptJournal.set("held", { requestId: "held", state: "prepared", acceptedAt: 0 });
    expect(await dispatch(state, "done")).toBe("dispatched");
    expect(await dispatch(state, "old")).toBe("lost");
    // A record of any other state is never absent.
    expect(await dispatch(state, "retry")).toBe("unknown");
    expect(await dispatch(state, "gone")).toBe("unknown");
    expect(await dispatch(state, "held")).toBe("unknown");
  });
});

describe("losing completeness", () => {
  test("an eviction answers unknown for good, and the flag leaves the published record", async () => {
    const state = await harness.createSession();
    for (let index = 0; index <= MAX_PROMPT_JOURNAL; index += 1) {
      setPromptJournal(state, {
        requestId: `settled-${index}`,
        state: "completed",
        acceptedAt: index,
      });
    }
    expect(state.promptJournal.has("settled-0")).toBe(false);
    // The evicted id, and any other unseen one, could have been sent.
    expect(await dispatch(state, "settled-0")).toBe("unknown");
    expect(await dispatch(state, "never-sent")).toBe("unknown");
    await persistBarrier();
    const file = (await harness.readPublished()) as PublishedFile;
    expect(record(file, state.id)).not.toHaveProperty("promptJournalComplete");
    await restart();
    expect(await dispatch(sessions.get(state.id)!, "never-sent")).toBe("unknown");
  });

  test("a reload whose record lacks the flag answers unknown", async () => {
    const state = await harness.createSession();
    // What an older bridge's writer leaves: it rewrites only fields it knows.
    await editPublished((file) => {
      delete record(file, state.id).promptJournalComplete;
    });
    await restart();
    expect(await dispatch(sessions.get(state.id)!, "never-sent")).toBe("unknown");
  });

  for (const [name, corrupt] of [
    ["a record without a request id", { state: "completed", acceptedAt: 1 }],
    ["a record that is not an object", "settled"],
    ["a duplicated request id", { requestId: "kept", state: "failed", acceptedAt: 2 }],
    ["a state this bridge never writes", { requestId: "odd", state: "prepared", acceptedAt: 1 }],
  ] as const) {
    test(`a reload that drops or rewrites a journal record (${name}) answers unknown`, async () => {
      const state = await harness.createSession();
      setPromptJournal(state, { requestId: "kept", state: "completed", acceptedAt: 1 });
      await editPublished((file) => {
        (record(file, state.id).promptJournal as unknown[]).push(corrupt);
      });
      await restart();
      const successor = sessions.get(state.id)!;
      expect(successor.promptJournalComplete).not.toBe(true);
      expect(await dispatch(successor, "never-sent")).toBe("unknown");
    });
  }

  test("a reload of a file holding the same session twice answers unknown", async () => {
    const state = await harness.createSession();
    await editPublished((file) => {
      file.sessions.push({ ...record(file, state.id), promptJournal: [] });
    });
    await restart();
    expect(await dispatch(sessions.get(state.id)!, "never-sent")).toBe("unknown");
  });

  test("a resumed agent answers unknown, before and after a restart", async () => {
    const restore = stubAttach({ resume: async () => fakeAgent() });
    try {
      const response = await harness.call("/session/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId: "vendor-agent-9", policy: defaultPolicy }),
      });
      expect(response.status).toBe(201);
      const { sessionId } = (await response.json()) as { sessionId: string };
      const adopted = sessions.get(sessionId)!;
      expect(await dispatch(adopted, "never-sent")).toBe("unknown");
      await persistBarrier();
      const file = (await harness.readPublished()) as PublishedFile;
      expect(record(file, sessionId)).not.toHaveProperty("promptJournalComplete");
      await restart();
      expect(await dispatch(sessions.get(sessionId)!, "never-sent")).toBe("unknown");
    } finally {
      restore();
    }
  });
});

describe("a clean restart", () => {
  test("keeps absent for unseen ids and answers lost or dispatched for journaled ones", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab-1" });
    const running = deferred();
    attachFake(state, { hold: running.promise });
    setPromptJournal(state, { requestId: "finished", state: "completed", acceptedAt: 1 });
    expect((await prompt(state, "in-flight")).status).toBe(202);
    await persistBarrier();

    try {
      await restart();
      const successor = sessions.get(state.id)!;
      expect(successor.promptJournalComplete).toBe(true);
      // Accepted when the process died: persisted as ambiguous, never absent.
      expect(await dispatch(successor, "in-flight")).toBe("lost");
      expect(await dispatch(successor, "finished")).toBe("dispatched");
      expect(await dispatch(successor, "after-restart")).toBe("absent");

      const agent = attachFake(successor);
      expect((await prompt(successor, "in-flight")).status).toBe(410);
      expect((await prompt(successor, "after-restart")).status).toBe(202);
      await waitFor(() => successor.status !== "running");
      expect((await prompt(successor, "after-restart")).status).toBe(202);
      expect(agent.sends).toHaveLength(1);
      expect(await dispatch(successor, "after-restart")).toBe("dispatched");
    } finally {
      running.resolve();
    }
  });
});
