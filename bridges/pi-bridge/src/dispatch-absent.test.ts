/**
 * `GET /session/:id/dispatch` answering `absent`, through the real router.
 *
 * `absent` lets the backend re-send a recovered request under the same id, so
 * a wrong one runs a turn twice. These cases pin where it is provable (a
 * session this bridge created, a clean restart of one) and where it must stay
 * `unknown` (eviction, a record without the flag, a lossy reload, a resumed or
 * closed session), and that the prompt route still delivers an id once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const ENV_KEYS = [
  "PORT",
  "HOSTNAME",
  "PI_BRIDGE_TOKEN",
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
  "PI_SESSION_DIR",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// `config.ts` reads its environment once, at import, so everything below is
// loaded dynamically after the environment is in place (see `http.test.ts`).
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
delete process.env.PI_SESSION_DIR;

const { route } = await import("./http.js");
const { authToken: TOKEN, MAX_PROMPT_JOURNAL } = await import("./config.js");
const { markSessionClosed, newSessionState, setAgentSessionTestHooks } =
  await import("./agent-session.js");
const { buildCommandCatalogue } = await import("./commands.js");
const { setCommandPreviewReaderForTests } = await import("./command-preview.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { loadPersistedState, persistBarrier, setPersistWriteGateForTests } =
  await import("./persistence.js");
const { setPromptJournal } = await import("./prompt.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

type SessionState = ReturnType<typeof newSessionState>;

let server: Server;
let origin: string;
const directories: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch(() => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setCommandPreviewReaderForTests(async () => buildCommandCatalogue({} as never));
});

afterEach(async () => {
  // Leave nothing for the next case: a state directory left set would have
  // its barrier write this file's sessions into a removed directory.
  await persistBarrier().catch(() => undefined);
  delete process.env.PI_BRIDGE_STATE_DIR;
  delete process.env.PI_SESSION_DIR;
  setAgentSessionTestHooks(undefined);
  setPersistWriteGateForTests();
  sessions.clear();
  clientSessionKeys.clear();
});

afterAll(async () => {
  setCommandPreviewReaderForTests(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function ownedDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function post(path: string, body: unknown): Promise<Response> {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

async function dispatchOf(state: { id: string }, requestId: string): Promise<unknown> {
  const response = await call(
    `/session/${state.id}/dispatch?requestId=${encodeURIComponent(requestId)}`,
  );
  return ((await response.json()) as { dispatch: unknown }).dispatch;
}

/**
 * A Pi session that accepts every prompt at preflight. Its runs finish at once,
 * or never when `hold` is set (a turn the process dies in the middle of).
 */
function countingSession(options: { hold?: boolean } = {}) {
  const counts = { prompts: 0, followUps: 0 };
  const hold = options.hold === true;
  const session = {
    sessionId: "pi-session-absent",
    sessionFile: "/tmp/pi-session-absent.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    bindExtensions: async () => undefined,
    prompt: (_text: string, promptOptions: { preflightResult?: (disposition: string) => void }) => {
      counts.prompts += 1;
      promptOptions.preflightResult?.("started");
      return hold ? new Promise<void>(() => undefined) : Promise.resolve();
    },
    followUp: async () => {
      counts.followUps += 1;
    },
    abort: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
    pendingMessageCount: 0,
  };
  return { session: session as unknown as AgentSession, counts };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

/**
 * A prompt whose body the test sends later, so the route is held before its
 * duplicate check (see `http-cancel-startup.test.ts`).
 */
function heldPrompt(state: { id: string }): {
  response: Promise<Response>;
  finish: (body: unknown) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const response = nativeFetch(`${origin}/session/${state.id}/prompt`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: stream,
  });
  return {
    response,
    finish: (body) => {
      if (finished) return;
      finished = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller.close();
    },
  };
}

/** Poll for work a route deliberately did not wait for. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A session created through the route, as the backend creates one. */
async function createFresh(key: string): Promise<SessionState> {
  const response = await post("/session/create", { clientSessionKey: key });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  return sessions.get(sessionId)!;
}

function useSession(pi: ReturnType<typeof countingSession>): void {
  setAgentSessionTestHooks({
    hydrateComposer: async (composer) => composer,
    createAgentSession: async () => pi.session,
  });
}

/** Reload as a restarted bridge would: an empty registry, then the state file. */
async function restart(): Promise<void> {
  await persistBarrier();
  sessions.clear();
  clientSessionKeys.clear();
  await loadPersistedState();
}

async function writeStateFile(directory: string, records: unknown[]): Promise<void> {
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({ version: 1, provider: "pi", sessions: records }),
    "utf8",
  );
}

function record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "idle",
    messages: [],
    revision: 0,
    structured: [],
    promptJournal: [{ requestId: "before", state: "completed", acceptedAt: 1 }],
    ...extra,
  };
}

describe("a session this bridge created", () => {
  test("answers absent for an unseen id, then delivers it exactly once", async () => {
    const pi = countingSession();
    useSession(pi);
    const state = await createFresh("absent-fresh");

    expect(await dispatchOf(state, "first")).toBe("absent");

    const sent = await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "first" });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ accepted: true });
    expect(pi.counts.prompts).toBe(1);
    expect(await dispatchOf(state, "first")).toBe("dispatched");

    const again = await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "first" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ accepted: true, duplicate: true });
    expect(pi.counts.prompts).toBe(1);
    // Still complete: delivering an id does not cost the session its proof.
    expect(await dispatchOf(state, "second")).toBe("absent");
  });

  test("never answers absent for an id the journal holds, in any state", async () => {
    const state = await createFresh("absent-states");
    for (const entryState of ["prepared", "dropped"] as const) {
      setPromptJournal(state, { requestId: entryState, state: entryState, acceptedAt: 1 });
      expect(await dispatchOf(state, entryState)).toBe("unknown");
    }
    setPromptJournal(state, { requestId: "local", state: "completed", acceptedAt: 1, local: true });
    expect(await dispatchOf(state, "local")).toBe("dispatched");
    setPromptJournal(state, { requestId: "lost", state: "ambiguous", acceptedAt: 1 });
    expect(await dispatchOf(state, "lost")).toBe("lost");
    setPromptJournal(state, { requestId: "ran", state: "failed", acceptedAt: 1 });
    expect(await dispatchOf(state, "ran")).toBe("dispatched");
  });

  test("answers unknown for an id the prompt route would not journal as given", async () => {
    const state = await createFresh("absent-canonical");
    expect(await dispatchOf(state, " padded")).toBe("unknown");
    expect(await dispatchOf(state, "x".repeat(513))).toBe("unknown");
    expect(await dispatchOf(state, "")).toBe("unknown");
    state.steerJournal.set("steered", {
      requestId: "steered",
      inputDigest: "digest",
      expectedRunId: "run",
      state: "delivered",
      createdAt: 1,
    });
    expect(await dispatchOf(state, "steered")).toBe("unknown");
  });

  test("answers unknown once the session is closing", async () => {
    const state = await createFresh("absent-closing");
    markSessionClosed(state);
    expect(await dispatchOf(state, "late")).toBe("unknown");
  });

  test("answers unknown for good once an entry has been evicted", async () => {
    const state = await createFresh("absent-evicted");
    for (let index = 0; index < MAX_PROMPT_JOURNAL; index += 1) {
      setPromptJournal(state, { requestId: `r${index}`, state: "completed", acceptedAt: 1 });
    }
    // Full but nothing lost yet.
    expect(await dispatchOf(state, "unseen")).toBe("absent");
    setPromptJournal(state, { requestId: "overflow", state: "completed", acceptedAt: 1 });
    expect(state.promptJournal.has("r0")).toBe(false);
    // The evicted id may have run; "no record" can no longer tell it apart.
    expect(await dispatchOf(state, "r0")).toBe("unknown");
    expect(await dispatchOf(state, "unseen")).toBe("unknown");
  });

  test("a rollback before the hand-over keeps the session complete", async () => {
    const state = await createFresh("absent-rollback");
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        throw new Error("attach failed");
      },
    });
    const sent = await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "never" });
    expect(sent.status).toBe(500);
    expect(state.promptJournal.has("never")).toBe(false);
    expect(await dispatchOf(state, "never")).toBe("absent");
  });

  test("two follow-ups under one id reach Pi once", async () => {
    const pi = countingSession();
    useSession(pi);
    const state = await createFresh("absent-follow-up");
    // A live turn, so the next prompts queue behind it as follow-ups.
    await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "turn" });
    state.status = "running";

    // A file attachment makes the route do real I/O after its duplicate check,
    // which is where a second request under the same id used to slip through.
    const followUp = {
      prompt: "next",
      requestId: "queued",
      attachments: [{ type: "file", path: "package.json" }],
    };
    const [left, right] = await Promise.all([
      post(`/session/${state.id}/prompt`, followUp),
      post(`/session/${state.id}/prompt`, followUp),
    ]);
    expect(pi.counts.followUps).toBe(1);
    // One queued it; the other was refused as still preparing or answered as
    // a duplicate, depending on where the two interleaved.
    const bodies = [await left.json(), await right.json()];
    expect(bodies.filter((body) => body.queued === true)).toHaveLength(1);
    expect(await dispatchOf(state, "queued")).toBe("dispatched");
  });
});

describe("a dispatch read racing the prompt it asks about", () => {
  test("absent before the duplicate check, yet the re-send and the original run once", async () => {
    const pi = countingSession();
    useSession(pi);
    const state = await createFresh("absent-race-body");
    const original = heldPrompt(state);
    const body = { prompt: "go", requestId: "raced" };
    try {
      // The original is admitted but has not reached its duplicate check, so
      // nothing is journaled yet. Whichever of it and a re-send passes that
      // check first journals in the same synchronous step; the other is
      // refused as busy or answered as a duplicate.
      await waitFor(() => state.promptClaim !== undefined);
      expect(await dispatchOf(state, "raced")).toBe("absent");

      const resend = await post(`/session/${state.id}/prompt`, body);
      expect([202, 409]).toContain(resend.status);
      original.finish(body);
      expect((await original.response).status).toBe(202);
      const again = await post(`/session/${state.id}/prompt`, body);
      expect(await again.json()).toEqual({ accepted: true, duplicate: true });
      expect(pi.counts.prompts).toBe(1);
    } finally {
      original.finish(body);
    }
  });

  test("unknown while the journal write is held, and a re-send cannot dispatch", async () => {
    const directory = await ownedDirectory("pi-bridge-absent-race-write-");
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const pi = countingSession();
    useSession(pi);
    const state = await createFresh("absent-race-write");
    const gate = deferred();
    let held = 0;
    setPersistWriteGateForTests(async ({ barrier }) => {
      if (!barrier) return;
      held += 1;
      await gate.promise;
    });
    try {
      const original = post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "held" });
      await waitFor(() => held === 1);
      expect(pi.counts.prompts).toBe(0);
      expect(await dispatchOf(state, "held")).toBe("unknown");
      const resend = await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "held" });
      expect(resend.status).toBe(409);

      gate.resolve();
      expect((await original).status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(await dispatchOf(state, "held")).toBe("dispatched");
    } finally {
      gate.resolve();
      setPersistWriteGateForTests();
    }
  });
});

describe("across a bridge restart", () => {
  test("a complete session stays complete, and an earlier id is lost, never absent", async () => {
    const directory = await ownedDirectory("pi-bridge-absent-restart-");
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const pi = countingSession({ hold: true });
    useSession(pi);
    const state = await createFresh("absent-restart");
    const sent = await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "ran" });
    expect(sent.status).toBe(202);
    // Accepted but never recorded as finished when the process died.
    expect(state.promptJournal.get("ran")?.state).toBe("accepted");
    setPromptJournal(state, { requestId: "done", state: "completed", acceptedAt: 1 });

    await restart();
    const persisted = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(persisted.sessions[0].promptJournalComplete).toBe(true);

    const restored = sessions.get(state.id)!;
    expect(restored).not.toBe(state);
    expect(await dispatchOf(restored, "ran")).toBe("lost");
    expect(await dispatchOf(restored, "done")).toBe("dispatched");
    expect(await dispatchOf(restored, "unseen")).toBe("absent");
  });

  test("a record without the flag restores as incomplete", async () => {
    const directory = await ownedDirectory("pi-bridge-absent-unflagged-");
    process.env.PI_BRIDGE_STATE_DIR = directory;
    // What an older bridge writes, including one that loaded a flagged record
    // and rewrote it.
    await writeStateFile(directory, [record("unflagged")]);
    await loadPersistedState();
    expect(await dispatchOf({ id: "unflagged" }, "unseen")).toBe("unknown");
    expect(await dispatchOf({ id: "unflagged" }, "before")).toBe("dispatched");
  });

  test("a reload that loses a journal entry restores as incomplete", async () => {
    const directory = await ownedDirectory("pi-bridge-absent-lossy-");
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const flagged = { promptJournalComplete: true };
    await writeStateFile(directory, [
      record("clean", flagged),
      record("malformed", {
        ...flagged,
        promptJournal: [{ requestId: "kept", state: "completed", acceptedAt: 1 }, { state: "x" }],
      }),
      record("blank", { ...flagged, promptJournal: [{ requestId: " ", state: "completed" }] }),
      record("collapsed", {
        ...flagged,
        promptJournal: [
          { requestId: "twice", state: "completed", acceptedAt: 1 },
          { requestId: "twice", state: "ambiguous", acceptedAt: 1 },
        ],
      }),
      record("no-journal", { ...flagged, promptJournal: undefined }),
      record("not-true", { promptJournalComplete: "true" }),
    ]);
    await loadPersistedState();

    expect(await dispatchOf({ id: "clean" }, "unseen")).toBe("absent");
    for (const id of ["malformed", "blank", "collapsed", "no-journal", "not-true"]) {
      expect(sessions.has(id)).toBe(true);
      expect(await dispatchOf({ id }, "unseen")).toBe("unknown");
    }
  });

  test("two records under one id restore as incomplete", async () => {
    const directory = await ownedDirectory("pi-bridge-absent-duplicate-");
    process.env.PI_BRIDGE_STATE_DIR = directory;
    const flagged = { promptJournalComplete: true };
    await writeStateFile(directory, [record("twin", flagged), record("twin", flagged)]);
    await loadPersistedState();
    expect(await dispatchOf({ id: "twin" }, "unseen")).toBe("unknown");
  });
});

describe("a session this bridge did not create fresh", () => {
  test("a resumed session answers unknown, before and after a restart", async () => {
    const sessionDir = await ownedDirectory("pi-bridge-absent-resume-sessions-");
    const stateDir = await ownedDirectory("pi-bridge-absent-resume-state-");
    const sessionFile = join(sessionDir, "resumable.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "resumed-absent",
        timestamp: "2026-10-27T00:00:00.000Z",
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );
    process.env.PI_SESSION_DIR = sessionDir;
    process.env.PI_BRIDGE_STATE_DIR = stateDir;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });

    const response = await post("/session/resume", { sessionId: sessionFile });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    // Pi may have been prompted in this file without this journal.
    expect(await dispatchOf({ id: sessionId }, "unseen")).toBe("unknown");

    await restart();
    expect(sessions.has(sessionId)).toBe(true);
    expect(await dispatchOf({ id: sessionId }, "unseen")).toBe("unknown");
  });

  test("a session state built any other way answers unknown", async () => {
    const state = newSessionState();
    sessions.set(state.id, state);
    expect(await dispatchOf(state, "unseen")).toBe("unknown");
  });
});
