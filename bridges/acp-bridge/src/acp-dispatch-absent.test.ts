/**
 * `GET /session/:id/dispatch` answering `absent`: the bridge asserts a request
 * id never reached the agent, so the backend may send it again under the same
 * id. The journal rules (eviction, the byte budget, restore) run in process
 * over the real router and restore; creation, adoption, dispatch and restart
 * run against spawned bridges and the fake agent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Must precede every bridge import below: `acp-context.ts` resolves its
// provider configuration and its state file at module scope.
import "./testing/unit-test-env.js";
import { removePrivateStateDir, restoreStateDirEnvironment } from "./testing/private-state-dir.js";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import {
  MAX_PERSISTED_PROMPT_JOURNAL_BYTES,
  MAX_PROMPT_JOURNAL,
  authToken,
  clientSessionKeys,
  provider,
  sessions,
  stateFile,
  type SessionState,
} from "./acp-context.js";
import { route } from "./acp-http.js";
import { emptySessionConfig, loadPersistedState } from "./acp-persistence.js";
import { persistedSnapshot } from "./acp-persist-writer.js";
import { setPromptJournal } from "./acp-public.js";
import {
  children,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";

// The bridge modules have read it; nothing after this file should.
restoreStateDirEnvironment();

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  removePrivateStateDir();
});

afterEach(() => {
  sessions.clear();
  clientSessionKeys.clear();
});

function isDuplicate(body: unknown): boolean {
  return typeof body === "object" && body !== null && "duplicate" in body;
}

async function dispatchIn(sessionId: string, requestId: string): Promise<unknown> {
  const response = await nativeFetch(
    `${origin}/session/${sessionId}/dispatch?requestId=${encodeURIComponent(requestId)}`,
    { headers: { authorization: `Bearer ${authToken}` } },
  );
  expect(response.status).toBe(200);
  return response.json();
}

/** Only the fields `/dispatch` and the persist writer read. */
function seeded(id: string, complete: boolean): SessionState {
  const state = {
    id,
    acpSessionId: `vendor-${id}`,
    status: "idle",
    messages: [],
    activeSubagentToolIds: new Set(),
    activeSubagentDescriptors: new Map(),
    settledCursorAgentIds: new Set(),
    subagentLimitExceeded: false,
    subagentToolIds: new Map(),
    cursorTodos: [],
    historyMessageIds: new Map(),
    child: null,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    ...(complete ? { promptJournalComplete: true } : {}),
    grokInterjectionJournal: new Map(),
    approvals: new Map(),
    interactions: new Map(),
    outputTruncated: false,
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    promptSequence: 0,
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    sessionConfig: emptySessionConfig(),
    dispatching: false,
    historyReplay: false,
    health: new RuntimeHealthRecorder(),
  } as SessionState;
  sessions.set(id, state);
  return state;
}

describe("the journal rules behind absent", () => {
  test("absent needs a complete journal, an open session and an id the prompt route keeps", async () => {
    const state = seeded("complete", true);
    setPromptJournal(state, { requestId: "done", state: "completed", acceptedAt: 1 });
    setPromptJournal(state, { requestId: "running", state: "accepted", acceptedAt: 2 });
    setPromptJournal(state, { requestId: "preparing", state: "prepared", acceptedAt: 3 });
    setPromptJournal(state, { requestId: "retired", state: "ambiguous", acceptedAt: 4 });

    expect(await dispatchIn("complete", "never-sent")).toEqual({ dispatch: "absent" });
    // Existing answers are unchanged.
    expect(await dispatchIn("complete", "done")).toEqual({
      dispatch: "dispatched",
      turn: { state: "completed" },
    });
    expect(await dispatchIn("complete", "running")).toEqual({ dispatch: "dispatched" });
    expect(await dispatchIn("complete", "preparing")).toEqual({ dispatch: "unknown" });
    expect(await dispatchIn("complete", "retired")).toEqual({ dispatch: "lost" });
    // The prompt route trims and caps ids, so "no entry" for these says
    // nothing about the id it would actually journal.
    expect(await dispatchIn("complete", " done")).toEqual({ dispatch: "unknown" });
    expect(await dispatchIn("complete", "x".repeat(513))).toEqual({ dispatch: "unknown" });
    expect(await dispatchIn("complete", "")).toEqual({ dispatch: "unknown" });

    state.closing = "fenced";
    expect(await dispatchIn("complete", "never-sent")).toEqual({ dispatch: "unknown" });

    seeded("incomplete", false);
    expect(await dispatchIn("incomplete", "never-sent")).toEqual({ dispatch: "unknown" });
  });

  test("an eviction from memory ends absent for good", async () => {
    const state = seeded("evicting", true);
    for (let index = 0; index < MAX_PROMPT_JOURNAL; index += 1) {
      setPromptJournal(state, { requestId: `request-${index}`, state: "completed", acceptedAt: 1 });
    }
    // Full, but nothing has left it yet.
    expect(state.promptJournalComplete).toBe(true);
    expect(await dispatchIn("evicting", "never-sent")).toEqual({ dispatch: "absent" });

    setPromptJournal(state, { requestId: "one-too-many", state: "prepared", acceptedAt: 2 });
    expect(state.promptJournal.has("request-0")).toBe(false);
    expect(await dispatchIn("evicting", "request-0")).toEqual({ dispatch: "unknown" });
    expect(await dispatchIn("evicting", "never-sent")).toEqual({ dispatch: "unknown" });
  });

  test("an entry the byte budget leaves off disk ends absent, in that very write", async () => {
    // Long ids, the most the prompt route accepts, so the global budget is
    // spent across a few full sessions. The newest session is kept first.
    const entryBytes = Buffer.byteLength(
      JSON.stringify({ requestId: "x".repeat(500), state: "completed", acceptedAt: 1 }),
    );
    const sessionCount = Math.ceil(MAX_PERSISTED_PROMPT_JOURNAL_BYTES / (entryBytes * 512)) + 1;
    const states = Array.from({ length: sessionCount }, (_, index) => {
      const state = seeded(`budget-${index}`, true);
      for (let entry = 0; entry < 512; entry += 1) {
        setPromptJournal(state, {
          requestId: `${index}-${entry}-`.padEnd(500, "x"),
          state: "completed",
          acceptedAt: 1,
        });
      }
      return state;
    });

    const snapshot = persistedSnapshot();
    const oldest = states[0]!;
    const newest = states.at(-1)!;
    expect(oldest.promptJournalComplete).toBe(false);
    expect(newest.promptJournalComplete).toBe(true);
    const record = (id: string) => snapshot.sessions.find((session) => session.id === id)!;
    expect(record(oldest.id).promptJournal.length).toBeLessThan(512);
    expect(record(oldest.id).promptJournalComplete).toBeUndefined();
    expect(record(newest.id).promptJournal).toHaveLength(512);
    expect(record(newest.id).promptJournalComplete).toBe(true);

    expect(await dispatchIn(oldest.id, "never-sent")).toEqual({ dispatch: "unknown" });
    expect(await dispatchIn(newest.id, "never-sent")).toEqual({ dispatch: "absent" });
  });

  test("a reload restores the flag only from a record whose journal loaded whole", async () => {
    const record = (id: string, extra: Record<string, unknown>) => ({
      id,
      acpSessionId: `vendor-${id}`,
      status: "idle",
      messages: [],
      revision: 0,
      structured: [],
      promptJournal: [
        { requestId: "done", state: "completed", acceptedAt: 1 },
        { requestId: "in-flight", state: "accepted", acceptedAt: 2 },
      ],
      ...extra,
    });
    const tooMany = Array.from({ length: MAX_PROMPT_JOURNAL + 1 }, (_, index) => ({
      requestId: `request-${index}`,
      state: "completed",
      acceptedAt: 1,
    }));
    await fs.writeFile(
      stateFile!,
      JSON.stringify({
        version: 3,
        provider,
        sessions: [
          record("clean", { promptJournalComplete: true }),
          // Written by an older bridge, or by a session that was never complete.
          record("no-flag", {}),
          record("dropped-entry", {
            promptJournalComplete: true,
            promptJournal: [
              { requestId: "done", state: "completed", acceptedAt: 1 },
              { requestId: "garbled", state: "running", acceptedAt: 2 },
            ],
          }),
          record("over-count", { promptJournalComplete: true, promptJournal: tooMany }),
          record("not-an-array", { promptJournalComplete: true, promptJournal: {} }),
          record("twice", { promptJournalComplete: true }),
          record("twice", { promptJournalComplete: true }),
          record("not-literally-true", { promptJournalComplete: "true" }),
        ],
      }),
    );
    await loadPersistedState();

    expect(await dispatchIn("clean", "never-sent")).toEqual({ dispatch: "absent" });
    // Journaled before the restart without an outcome: retired, never absent.
    expect(await dispatchIn("clean", "in-flight")).toEqual({ dispatch: "lost" });
    expect(await dispatchIn("clean", "done")).toEqual({
      dispatch: "dispatched",
      turn: { state: "completed" },
    });
    for (const id of [
      "no-flag",
      "dropped-entry",
      "over-count",
      "not-an-array",
      "twice",
      "not-literally-true",
    ]) {
      expect({ id, answer: await dispatchIn(id, "never-sent") }).toEqual({
        id,
        answer: { dispatch: "unknown" },
      });
    }
    expect(await dispatchIn("no-flag", "in-flight")).toEqual({ dispatch: "lost" });
  });
});

describe("absent over a spawned bridge", () => {
  test("a fresh session answers absent, then dispatches the id exactly once", async () => {
    const stateDirectory = await temporaryDirectory();
    const counterFile = resolve(stateDirectory, "prompts.log");
    const bridge = await spawnBridge({
      stateDirectory,
      env: { FAKE_ACP_COUNTER_FILE: counterFile },
    });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    const dispatchStatus = (requestId: string) =>
      nativeFetch(
        `${bridge.base}/session/${created.id}/dispatch?requestId=${encodeURIComponent(requestId)}`,
        { headers: bridge.headers },
      ).then((response) => response.json());
    const send = () =>
      nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ prompt: "DIRECT:once", requestId: "resend-me" }),
      });

    expect(await dispatchStatus("resend-me")).toEqual({ dispatch: "absent" });
    // A read answers from memory and leaves nothing behind.
    expect(await dispatchStatus("resend-me")).toEqual({ dispatch: "absent" });

    // Both sends race the same id: one dispatches, and the other is refused
    // while it prepares or deduplicated once it is accepted.
    const answers = await Promise.all(
      [send(), send()].map(async (pending) => {
        const response = await pending;
        return { status: response.status, body: (await response.json()) as unknown };
      }),
    );
    expect(
      answers.filter((answer) => answer.status === 202 && !isDuplicate(answer.body)),
    ).toHaveLength(1);
    expect(
      answers.filter((answer) => answer.status === 409 || isDuplicate(answer.body)),
    ).toHaveLength(1);
    expect(await dispatchStatus("resend-me")).toMatchObject({ dispatch: "dispatched" });
    await waitFor(
      () => dispatchStatus("resend-me") as Promise<Record<string, unknown>>,
      (value) => "turn" in value,
    );
    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
  });

  test("absent survives a clean restart; an id journaled before it is lost", async () => {
    const directory = await temporaryDirectory();
    const stateDirectory = await temporaryDirectory();
    const counterFile = resolve(directory, "prompts.log");
    const env = {
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_HOLD_TURN_FILE: resolve(directory, "release-turn"),
    };
    const first = await spawnBridge({ stateDirectory, env });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    expect(
      (
        await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
          method: "POST",
          headers: first.headers,
          body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_RUNNING", requestId: "in-flight" }),
        })
      ).status,
    ).toBe(202);
    await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then(
          (response) => response.json(),
        ) as Promise<{ status: string }>,
      (session) => session.status === "running",
    );
    // SIGKILL: no handler may settle the turn on the way down.
    const exited = new Promise<void>((resolvePromise) =>
      first.child.once("exit", () => resolvePromise()),
    );
    first.child.kill("SIGKILL");
    await exited;
    children.delete(first.child);
    const saved = JSON.parse(await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"));
    expect(
      saved.sessions.find((session: { id: string }) => session.id === created.id),
    ).toMatchObject({ promptJournalComplete: true });

    // No hold this time: the re-send below must be able to finish.
    const second = await spawnBridge({
      stateDirectory,
      env: { FAKE_ACP_COUNTER_FILE: counterFile },
    });
    const dispatchStatus = (requestId: string) =>
      nativeFetch(`${second.base}/session/${created.id}/dispatch?requestId=${requestId}`, {
        headers: second.headers,
      }).then((response) => response.json());
    expect(await dispatchStatus("in-flight")).toEqual({ dispatch: "lost" });
    expect(await dispatchStatus("never-sent")).toEqual({ dispatch: "absent" });

    // The re-send the backend makes on `absent` runs once.
    const resend = () =>
      nativeFetch(`${second.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: second.headers,
        body: JSON.stringify({ prompt: "DIRECT:after restart", requestId: "never-sent" }),
      });
    expect((await resend()).status).toBe(202);
    await waitFor(
      () => dispatchStatus("never-sent") as Promise<Record<string, unknown>>,
      (value) => "turn" in value,
    );
    expect(await (await resend()).json()).toEqual({ accepted: true, duplicate: true });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
    await stopChild(second.child);
  });

  test("a session adopted with session/load is never complete, even after a restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const env = { ACP_PROVIDER: "grok", FAKE_ACP_REPLAY_HISTORY: "1" };
    const bridge = await spawnBridge({ stateDirectory, env });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    const listed = (await nativeFetch(`${bridge.base}/session/list`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as { sessions: Array<{ id: string }> };
    const external = listed.sessions.find((session) => session.id !== created.id);
    expect(external).toBeDefined();
    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumed.status).toBe(201);
    const { sessionId } = (await resumed.json()) as { sessionId: string };
    const dispatchStatus = (base: string, headers: Record<string, string>, id: string) =>
      nativeFetch(`${base}/session/${id}/dispatch?requestId=never-sent`, { headers }).then(
        (response) => response.json(),
      );

    expect(await dispatchStatus(bridge.base, bridge.headers, sessionId)).toEqual({
      dispatch: "unknown",
    });
    // The session this bridge created stays complete beside it.
    expect(await dispatchStatus(bridge.base, bridge.headers, created.id)).toEqual({
      dispatch: "absent",
    });

    await stopChild(bridge.child);
    const restarted = await spawnBridge({ stateDirectory, env });
    expect(await dispatchStatus(restarted.base, restarted.headers, sessionId)).toEqual({
      dispatch: "unknown",
    });
    expect(await dispatchStatus(restarted.base, restarted.headers, created.id)).toEqual({
      dispatch: "absent",
    });
    await stopChild(restarted.child);
  });
});
