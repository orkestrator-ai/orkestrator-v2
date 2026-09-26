/**
 * `POST /session/:id/close`: the non-destructive tab close.
 *
 * The session stays registered — closed, refusing admission — until its
 * removal is published, so neither a failed publication nor a concurrent retry
 * can be told `missing` for a close that did not happen. Environment is
 * snapshotted and restored exactly (absence included), and every deferred a
 * test creates is released in `finally`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const ENV_KEYS = [
  "PORT",
  "HOSTNAME",
  "PI_BRIDGE_TOKEN",
  "PI_BRIDGE_LIBRARY_ONLY",
  "PI_BRIDGE_STATE_DIR",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// `config.ts` reads its environment once, at import, so everything below is
// loaded dynamically after the environment is in place.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { setDeleteCancelTimeoutForTests } = await import("./http.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState } = await import("./agent-session.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { setPersistWriteGateForTests } = await import("./persistence.js");
const { closeSessionRetaining } = await import("./session-close.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;
let directory: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  directory = await mkdtemp(join(tmpdir(), "pi-close-"));
});

afterAll(async () => {
  await shutdown();
  await rm(directory, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Point persistence at a private state directory for one test. */
async function withStateDirectory(run: (stateFile: string) => Promise<void>): Promise<void> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "pi-close-state-"));
  process.env.PI_BRIDGE_STATE_DIR = stateDirectory;
  try {
    await run(join(stateDirectory, "state.json"));
  } finally {
    setPersistWriteGateForTests();
    delete process.env.PI_BRIDGE_STATE_DIR;
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

async function persistedIds(stateFile: string): Promise<string[]> {
  if (!existsSync(stateFile)) return [];
  const payload = JSON.parse(await readFile(stateFile, "utf8")) as { sessions: { id: string }[] };
  return payload.sessions.map((session) => session.id);
}

function close(id: string): Promise<Response> {
  return nativeFetch(`${origin}/session/${encodeURIComponent(id)}/close`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function fakeAgentSession(sessionFile: string, onDispose: () => void): AgentSession {
  return {
    sessionId: "pi-close-test",
    sessionFile,
    subscribe: () => () => undefined,
    dispose: onDispose,
    abort: async () => undefined,
  } as unknown as AgentSession;
}

describe("POST /session/:id/close", () => {
  test("resume refuses a JSONL file whose existing owner is closing", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-close-resume-"));
    const previous = process.env.PI_SESSION_DIR;
    process.env.PI_SESSION_DIR = sessionDir;
    const sessionFile = join(sessionDir, "conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const state = newSessionState();
    state.sessionFile = sessionFile;
    state.status = "running";
    sessions.set(state.id, state);
    const hung = deferred();
    state.cancelTurn = () => hung.promise;
    setDeleteCancelTimeoutForTests(5);
    try {
      expect((await close(state.id)).status).toBe(503);
      const response = await nativeFetch(`${origin}/session/resume`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionFile }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ kind: "session-closing" });
    } finally {
      hung.resolve();
      setDeleteCancelTimeoutForTests();
      sessions.delete(state.id);
      if (previous === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previous;
      await rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("releases a completed session but keeps its Pi JSONL conversation", async () => {
    const sessionFile = join(directory, "conversation.jsonl");
    await writeFile(sessionFile, '{"type":"session"}\n');
    const state = newSessionState("tab-close");
    let disposed = 0;
    state.session = fakeAgentSession(sessionFile, () => {
      disposed += 1;
    });
    state.sessionFile = sessionFile;
    sessions.set(state.id, state);
    clientSessionKeys.set("tab-close", state.id);

    const response = await close(state.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, retained: true });
    expect(disposed).toBe(1);
    expect(sessions.has(state.id)).toBe(false);
    expect(clientSessionKeys.has("tab-close")).toBe(false);
    // The conversation is Pi's, not the bridge's: a later resume reopens it.
    expect(existsSync(sessionFile)).toBe(true);

    // A lost response retries into an in-band confirmation, never a 404.
    const retry = await close(state.id);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ closed: true, missing: true });
  });

  test("answers an unknown session in band", async () => {
    const response = await close("never-existed");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, missing: true });
  });

  test("denies parked approvals and cancels the running turn", async () => {
    const state = newSessionState();
    sessions.set(state.id, state);
    const decisions: string[] = [];
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "rm -rf build" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => decisions.push(decision),
    });
    state.status = "running";
    let cancelled = false;
    state.cancelTurn = async () => {
      cancelled = true;
    };

    expect((await close(state.id)).status).toBe(200);
    expect(decisions).toEqual(["deny"]);
    expect(cancelled).toBe(true);
    expect(sessions.has(state.id)).toBe(false);
  });

  test("reports pending and keeps the session when the turn cannot be proven stopped", async () => {
    const state = newSessionState("tab-hung");
    sessions.set(state.id, state);
    clientSessionKeys.set("tab-hung", state.id);
    state.status = "running";
    // Held, not never-settling: released in `finally` so nothing outlives the test.
    const hung = deferred();
    state.cancelTurn = () => hung.promise;
    setDeleteCancelTimeoutForTests(5);
    try {
      const response = await close(state.id);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        closed: false,
        pending: true,
        error: "Session close did not complete",
      });
      // Still registered, so the backend's durable intent can retry.
      expect(sessions.get(state.id)).toBe(state);
      expect(clientSessionKeys.get("tab-hung")).toBe(state.id);
      // A same-key create is refused while the close is pending, never handed
      // the closing id.
      const recreate = await nativeFetch(`${origin}/session/create`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ clientSessionKey: "tab-hung" }),
      });
      expect(recreate.status).toBe(409);
      expect(await recreate.json()).toMatchObject({ kind: "session-closing" });

      state.cancelTurn = async () => undefined;
      const retry = await close(state.id);
      expect(retry.status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      hung.resolve();
      setDeleteCancelTimeoutForTests();
      sessions.delete(state.id);
      clientSessionKeys.delete("tab-hung");
    }
  });

  test("a failed publication keeps the session registered, so a retry never reads missing", async () => {
    await withStateDirectory(async (stateFile) => {
      const state = newSessionState("tab-publish");
      sessions.set(state.id, state);
      clientSessionKeys.set("tab-publish", state.id);
      setPersistWriteGateForTests(async () => {
        throw new Error("disk refused");
      });
      try {
        const failed = await close(state.id);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual({
          closed: false,
          pending: true,
          error: "Session close did not complete",
        });
        // Never unregistered, not even briefly: nothing to re-insert.
        expect(sessions.get(state.id)).toBe(state);
        expect(clientSessionKeys.get("tab-publish")).toBe(state.id);

        setPersistWriteGateForTests();
        const retry = await close(state.id);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toEqual({ closed: true, retained: true });
        expect(sessions.has(state.id)).toBe(false);
        expect(clientSessionKeys.has("tab-publish")).toBe(false);
        expect(await persistedIds(stateFile)).not.toContain(state.id);
      } finally {
        sessions.delete(state.id);
        clientSessionKeys.delete("tab-publish");
      }
    });
  });

  test("concurrent closes share one operation and a close during publication is not missing", async () => {
    await withStateDirectory(async (stateFile) => {
      const other = newSessionState();
      const state = newSessionState();
      sessions.set(other.id, other);
      sessions.set(state.id, state);
      const writeGate = deferred();
      let writes = 0;
      setPersistWriteGateForTests(async () => {
        writes += 1;
        await writeGate.promise;
      });
      try {
        const operation = closeSessionRetaining(state, 5_000);
        await waitFor(() => writes === 1);
        // Still registered while its removal is being published, and a second
        // caller joins the same operation rather than starting another.
        expect(sessions.get(state.id)).toBe(state);
        expect(closeSessionRetaining(state, 5_000)).toBe(operation);
        // A retry over HTTP reaches the registered session, not `missing`.
        // `lastAccessed` is stamped synchronously before the close handler runs.
        state.lastAccessed = 0;
        const retried = close(state.id);
        await waitFor(() => state.lastAccessed > 0);

        writeGate.resolve();
        expect(await operation).toBe("closed");
        const response = await retried;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ closed: true, retained: true });
        // One publication, whose file already describes the removal.
        expect(writes).toBe(1);
        expect(sessions.has(state.id)).toBe(false);
        const persisted = await persistedIds(stateFile);
        expect(persisted).toContain(other.id);
        expect(persisted).not.toContain(state.id);

        // Only now, with the removal on disk, does a retry read `missing`.
        expect(await (await close(state.id)).json()).toEqual({ closed: true, missing: true });
      } finally {
        writeGate.resolve();
        sessions.delete(state.id);
        sessions.delete(other.id);
      }
    });
  });
});
