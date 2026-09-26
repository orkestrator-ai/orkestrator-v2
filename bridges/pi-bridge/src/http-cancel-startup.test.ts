/**
 * Cancellation during a Pi prompt's startup, through the real router (INC-05).
 *
 * A prompt owns its turn from the moment the route claims it, but it has no
 * cancel handle until Pi accepts it. These cases hold each preparation
 * boundary — cold attach, the mandatory journal write — with a deferred gate,
 * cancel inside it, and prove that the intent is retained against that exact
 * turn, that Pi is never invoked for it, and that nothing leaks into the next
 * turn. Configuration, compaction, deletion, a hanging abort and the
 * provider-owned follow-up queue are covered as the boundaries of that model.
 *
 * Gates are released in `finally`, so a failing assertion cannot hang
 * teardown on its own fixture. No sleeps: every wait is on an observable
 * condition.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
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
// loaded dynamically after the environment is in place (see `http.test.ts`).
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { route, setCancelAckTimeoutForTests, setDeleteCancelTimeoutForTests } =
  await import("./http.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { sessions } = await import("./state.js");
const { setPersistWriteGateForTests } = await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

type SessionState = ReturnType<typeof newSessionState>;

// A private server over the real router, so this file does not share the
// process-wide lifecycle in `server.ts` with any other suite.
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal).catch(() => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function post(path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function cancel(state: SessionState, action = "cancel"): Promise<Response> {
  return post(`/session/${state.id}/${action}`);
}

/** Poll for work a route deliberately did not wait for. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function seedSession(): SessionState {
  const state = newSessionState();
  sessions.set(state.id, state);
  return state;
}

/**
 * A Pi session whose runs this test controls.
 *
 * Accepts at preflight like the SDK does, and returns a run that settles only
 * when the test finishes it or the bridge aborts it. `abortGate`, when set,
 * holds the abort itself, which is how a provider abort that hangs is modelled.
 */
function controlledSession(options: { abortGate?: Promise<void> } = {}) {
  const runs: Deferred<void>[] = [];
  const counts = { prompts: 0, aborts: 0, followUps: 0 };
  const session = {
    sessionId: "pi-session-cancel",
    sessionFile: "/tmp/pi-session-cancel.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    bindExtensions: async () => undefined,
    prompt: (_text: string, promptOptions: { preflightResult?: (accepted: boolean) => void }) => {
      counts.prompts += 1;
      const run = deferred();
      runs.push(run);
      promptOptions.preflightResult?.(true);
      return run.promise;
    },
    followUp: async () => {
      counts.followUps += 1;
    },
    abort: async () => {
      counts.aborts += 1;
      // Like the SDK's abort signal, bound to the run live when it was called.
      const target = runs.at(-1);
      if (options.abortGate) await options.abortGate;
      target?.resolve();
    },
    compact: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
    pendingMessageCount: 0,
  };
  return {
    session: session as unknown as AgentSession,
    raw: session,
    counts,
    finishRun: (index = runs.length - 1) => runs[index]?.resolve(),
  };
}

function resetHooks(): void {
  setAgentSessionTestHooks(undefined);
}

/**
 * A prompt request whose body the test finishes later, so the route is held
 * between admission (headers received) and `readJson`.
 */
function heldPrompt(state: SessionState): {
  response: Promise<Response>;
  finish: (body: unknown) => void;
  abandon: () => void;
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
    abandon: () => {
      if (finished) return;
      finished = true;
      controller.close();
    },
  };
}

async function readStatus(path: string): Promise<unknown> {
  return ((await (await call(path)).json()) as { status?: unknown }).status;
}

describe("cancel during cold attach", () => {
  test("retains the intent and never invokes Pi for the cancelled prompt", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const attachGate = deferred();
    let attaches = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        attaches += 1;
        await attachGate.promise;
        return pi.session;
      },
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "cold-cancel",
      });
      await waitFor(() => attaches === 1);
      const claim = state.promptClaim;
      expect(claim).toBeNumber();
      expect(state.dispatching).toBe(true);

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });
      expect(state.cancelRequestedClaim).toBe(claim);
      // Still owned work: the backend's stop ladder must not read this as a
      // completed stop while the claim can still reach Pi.
      expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "working",
      });
      expect(await (await call(`/session/${state.id}/status`)).json()).toMatchObject({
        status: "running",
      });

      attachGate.resolve();
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "idle",
      });

      // Settled locally: Pi never saw the prompt, and nothing is left owned.
      expect(pi.counts.prompts).toBe(0);
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("idle");
      expect(state.dispatching).toBe(false);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.promptJournal.get("cold-cancel")?.state).toBe("completed");
      expect(
        await (await call(`/session/${state.id}/dispatch?requestId=cold-cancel`)).json(),
      ).toEqual({ dispatch: "dispatched" });
      expect(state.messages.map((message) => message.role)).toEqual(["user"]);
      // The attach itself completed and is kept for the next turn.
      expect(state.session).toBe(pi.session);

      // A later turn is unaffected by the earlier cancellation.
      const next = await post(`/session/${state.id}/prompt`, {
        prompt: "runs",
        requestId: "cold-next",
      });
      expect(next.status).toBe(202);
      expect(await next.json()).toEqual({ accepted: true });
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("running");
      pi.finishRun();
      await waitFor(() => state.status === "idle");
      expect(state.promptClaim).toBeUndefined();
    } finally {
      attachGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("a startup failure after a cancel clears the pending intent", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const attachGate = deferred();
    let attaches = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        attaches += 1;
        if (attaches === 1) {
          await attachGate.promise;
          throw new Error("attach refused");
        }
        return pi.session;
      },
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "fails",
        requestId: "attach-fails",
      });
      await waitFor(() => attaches === 1);
      expect((await cancel(state)).status).toBe(202);

      attachGate.resolve();
      expect((await prompt).status).toBe(500);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("attach-fails")).toBe(false);

      // With nothing admitted, a cancel is a plain no-op again.
      const idle = await cancel(state);
      expect(idle.status).toBe(200);
      expect(await idle.json()).toEqual({ cancelled: false });

      const next = await post(`/session/${state.id}/prompt`, {
        prompt: "runs",
        requestId: "attach-next",
      });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      attachGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("an attachment failure releases the claim so the next prompt runs normally", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const failed = await post(`/session/${state.id}/prompt`, {
        prompt: "with a missing image",
        requestId: "attachment-fails",
        attachments: [{ type: "image", path: "definitely-missing-image.png" }],
      });
      expect(failed.status).toBe(400);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();

      expect(await (await cancel(state)).json()).toEqual({ cancelled: false });
      expect(state.cancelRequestedClaim).toBeUndefined();

      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("deleting the session during a cold attach never invokes Pi", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const attachGate = deferred();
    let attaches = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        attaches += 1;
        await attachGate.promise;
        return pi.session;
      },
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "deleted-during-attach",
      });
      await waitFor(() => attaches === 1);
      const deletion = call(`/session/${state.id}`, { method: "DELETE" });
      await waitFor(() => state.cancelRequestedClaim !== undefined);

      attachGate.resolve();
      expect((await deletion).status).toBe(200);
      // The late attach refuses to publish into the closed session. That is
      // the close winning, so the prompt settles as cancelled before send —
      // the same answer `/close` gives — never a 500.
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(pi.counts.prompts).toBe(0);
      expect(sessions.has(state.id)).toBe(false);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      attachGate.resolve();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("cancel during the mandatory journal write", () => {
  test("retains the intent across the write and settles the correct claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cancel-write-"));
    const writeGate = deferred();
    let writes = 0;
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    process.env.PI_BRIDGE_STATE_DIR = directory;
    setPersistWriteGateForTests(async () => {
      writes += 1;
      await writeGate.promise;
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "write-cancel",
      });
      await waitFor(() => writes >= 1);
      const claim = state.promptClaim;
      expect(claim).toBeNumber();

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });

      writeGate.resolve();
      expect((await prompt).status).toBe(202);
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.promptJournal.get("write-cancel")?.state).toBe("completed");
      expect(state.status).toBe("idle");
    } finally {
      writeGate.resolve();
      setPersistWriteGateForTests();
      delete process.env.PI_BRIDGE_STATE_DIR;
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deleting the session while the write is held settles the prompt locally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cancel-write-delete-"));
    const writeGate = deferred();
    let writes = 0;
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    process.env.PI_BRIDGE_STATE_DIR = directory;
    setPersistWriteGateForTests(async () => {
      writes += 1;
      await writeGate.promise;
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "write-delete",
      });
      await waitFor(() => writes >= 1);
      expect((await call(`/session/${state.id}`, { method: "DELETE" })).status).toBe(200);
      expect(sessions.has(state.id)).toBe(false);

      writeGate.resolve();
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      writeGate.resolve();
      setPersistWriteGateForTests();
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.delete(state.id);
      resetHooks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a write failure after a cancel releases the claim and its intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cancel-write-fail-"));
    const writeGate = deferred();
    let writes = 0;
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    process.env.PI_BRIDGE_STATE_DIR = directory;
    setPersistWriteGateForTests(async () => {
      writes += 1;
      await writeGate.promise;
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "write-fails",
      });
      await waitFor(() => writes >= 1);
      expect((await cancel(state)).status).toBe(202);

      writeGate.reject(new Error("disk refused"));
      expect((await prompt).status).toBe(500);
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.dispatching).toBe(false);
      expect(state.promptJournal.has("write-fails")).toBe(false);

      setPersistWriteGateForTests();
      const next = await post(`/session/${state.id}/prompt`, {
        prompt: "runs",
        requestId: "write-next",
      });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      writeGate.resolve();
      setPersistWriteGateForTests();
      delete process.env.PI_BRIDGE_STATE_DIR;
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("cancel aliases", () => {
  for (const action of ["cancel", "abort", "hard-abort"]) {
    test(`/${action} records a startup cancel with the same ownership and acknowledgement`, async () => {
      const state = seedSession();
      const pi = controlledSession();
      const attachGate = deferred();
      let attaches = 0;
      setAgentSessionTestHooks({
        hydrateComposer: async (composer) => composer,
        createAgentSession: async () => {
          attaches += 1;
          await attachGate.promise;
          return pi.session;
        },
      });
      try {
        const idle = await cancel(state, action);
        expect(idle.status).toBe(200);
        expect(await idle.json()).toEqual({ cancelled: false });

        const prompt = post(`/session/${state.id}/prompt`, { prompt: "never sent" });
        await waitFor(() => attaches === 1);
        const first = await cancel(state, action);
        const second = await cancel(state, action);
        expect([first.status, second.status]).toEqual([202, 202]);
        expect(await first.json()).toEqual({ cancelled: false, pending: true });
        expect(await second.json()).toEqual({ cancelled: false, pending: true });
        expect(state.cancelRequestedClaim).toBe(state.promptClaim!);

        attachGate.resolve();
        expect((await prompt).status).toBe(202);
        expect(pi.counts.prompts).toBe(0);
        expect(state.cancelRequestedClaim).toBeUndefined();
      } finally {
        attachGate.resolve();
        sessions.delete(state.id);
        resetHooks();
      }
    });
  }
});

describe("operations without a prompt claim", () => {
  test("a cancel during configuration parks nothing against the next prompt", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const modelGate = deferred();
    let resolutions = 0;
    let holdResolution = true;
    state.session = pi.session;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      // Holds the config route inside `applyComposerToSession`, while it owns
      // `dispatching` without any prompt claim.
      resolveModel: (async () => {
        resolutions += 1;
        if (holdResolution) await modelGate.promise;
        return undefined;
      }) as never,
    });
    try {
      const config = post(`/session/${state.id}/config`, { reasoningId: "high" });
      await waitFor(() => resolutions === 1);
      expect(state.dispatching).toBe(true);
      expect(state.promptClaim).toBeUndefined();

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ cancelled: false });
      expect(state.cancelRequestedClaim).toBeUndefined();

      holdResolution = false;
      modelGate.resolve();
      expect((await config).status).toBe(200);
      expect(state.dispatching).toBe(false);

      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(await next.json()).toEqual({ accepted: true });
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("running");
    } finally {
      modelGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("a cancel during compaction parks nothing against the next prompt", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const compactGate = deferred();
    let compactions = 0;
    pi.raw.compact = async () => {
      compactions += 1;
      await compactGate.promise;
    };
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const compaction = post(`/session/${state.id}/compact`);
      await waitFor(() => compactions === 1);
      expect(state.promptClaim).toBeUndefined();

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ cancelled: false });
      expect(state.cancelRequestedClaim).toBeUndefined();

      compactGate.resolve();
      expect((await compaction).status).toBe(200);

      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      compactGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("a provider abort that hangs", () => {
  test("keeps the turn working and leaves escalation reachable", async () => {
    const state = seedSession();
    const abortGate = deferred();
    const pi = controlledSession({ abortGate: abortGate.promise });
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    setCancelAckTimeoutForTests(10);
    try {
      expect((await post(`/session/${state.id}/prompt`, { prompt: "runs" })).status).toBe(202);
      expect(state.status).toBe("running");

      const graceful = await cancel(state, "abort");
      expect(graceful.status).toBe(202);
      expect(await graceful.json()).toEqual({ cancelled: false, pending: true });
      // No false idle while the stop is unproven.
      expect(await (await call(`/session/${state.id}/status`)).json()).toMatchObject({
        status: "running",
      });
      expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "working",
      });

      // The backend's escalation still gets an answer, and observes the same
      // single cancellation rather than stacking a second abort.
      const hard = await cancel(state, "hard-abort");
      expect(hard.status).toBe(202);
      expect(await hard.json()).toEqual({ cancelled: false, pending: true });
      expect(pi.counts.aborts).toBe(1);

      abortGate.resolve();
      await waitFor(() => state.status === "idle");
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      abortGate.resolve();
      setCancelAckTimeoutForTests();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

/**
 * Pi's follow-up queue is the SDK's, not the bridge's. Pinned SDK 0.87.0:
 * `followUp()` pushes onto `AgentSession._followUpMessages` and the agent's
 * queue, and `abort()` (`abortRetry`/`abortCompaction`/`agent.abort()`) never
 * clears either — only `clearQueue()` does, which the bridge calls solely for
 * undelivered steers at turn end. So cancelling the run keeps queued
 * follow-ups, and Pi reports them through its queue state events.
 *
 * Limits of this fake: it models the queue update Pi's state event carries and
 * records any `clearQueue()` call, but it cannot model Pi delivering the
 * retained follow-up when the next run starts (the agent loop drains it); that
 * integration is covered only by the SDK itself and live QA.
 */
describe("provider-owned follow-ups", () => {
  test("queue a follow-up without a new claim, and cancelling keeps the queue policy", async () => {
    const state = seedSession();
    const pi = controlledSession();
    let queueClears = 0;
    pi.raw.clearQueue = () => {
      queueClears += 1;
      return { steering: [], followUp: [] };
    };
    pi.raw.followUp = async () => {
      pi.counts.followUps += 1;
      // Pi reports its queue through state events; model the update it sends.
      state.queue.followUp = [...state.queue.followUp, "queued follow-up"];
    };
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      expect((await post(`/session/${state.id}/prompt`, { prompt: "first" })).status).toBe(202);
      const claim = state.promptClaim;
      expect(claim).toBeNumber();

      const queued = await post(`/session/${state.id}/prompt`, {
        prompt: "queued follow-up",
        requestId: "follow-up-1",
      });
      expect(queued.status).toBe(202);
      expect(await queued.json()).toEqual({ accepted: true, queued: true });
      // The follow-up rides the live run: no fake active-turn token.
      expect(state.promptClaim).toBe(claim);
      expect(pi.counts.prompts).toBe(1);

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ cancelled: true });
      expect(pi.counts.aborts).toBe(1);
      await waitFor(() => state.status === "idle");

      // Unchanged policy: cancelling the run does not clear Pi's follow-up
      // queue; Pi retains it and reports it through `/queue`.
      expect(await (await call(`/session/${state.id}/queue`)).json()).toEqual({
        items: [{ id: "queued:0", text: "queued follow-up", mode: "follow-up" }],
      });
      expect(state.promptJournal.get("follow-up-1")?.state).toBe("accepted");
      expect(queueClears).toBe(0);
      expect(state.promptClaim).toBeUndefined();
    } finally {
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("the admission window before the prompt body is read", () => {
  test("a cancel while the body is read belongs to that prompt, which never reaches Pi", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const held = heldPrompt(state);
    try {
      // Headers are in: the route has reserved the claim before `readJson`.
      await waitFor(() => state.promptClaim !== undefined);
      const claim = state.promptClaim;
      expect(state.dispatching).toBe(false);
      expect(await readStatus(`/session/${state.id}/status`)).toBe("running");

      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });
      expect(state.cancelRequestedClaim).toBe(claim!);

      held.finish({ prompt: "never sent", requestId: "admission-cancel" });
      const response = await held.response;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.promptJournal.get("admission-cancel")?.state).toBe("completed");
      expect(await readStatus(`/session/${state.id}/status`)).toBe("idle");

      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(await next.json()).toEqual({ accepted: true });
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      held.abandon();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("a validation failure releases the reservation and its cancel", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const held = heldPrompt(state);
    try {
      await waitFor(() => state.promptClaim !== undefined);
      expect((await cancel(state)).status).toBe(202);

      held.finish({ requestId: "no-prompt" });
      expect((await held.response).status).toBe(400);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(await readStatus(`/session/${state.id}/status`)).toBe("idle");

      // Nothing is parked: a cancel is a plain no-op, and a later prompt runs.
      expect(await (await cancel(state)).json()).toEqual({ cancelled: false });
      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("running");
    } finally {
      held.abandon();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("a second prompt cannot slip past a reservation still reading its body", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const held = heldPrompt(state);
    try {
      await waitFor(() => state.promptClaim !== undefined);
      const claim = state.promptClaim;
      const second = await post(`/session/${state.id}/prompt`, { prompt: "second" });
      expect(second.status).toBe(409);
      // Configuration and compaction also wait for the reserved prompt.
      expect((await post(`/session/${state.id}/compact`)).status).toBe(409);
      expect((await post(`/session/${state.id}/config`, { reasoningId: "high" })).status).toBe(409);
      expect(state.promptClaim).toBe(claim!);

      held.finish({ prompt: "first" });
      expect((await held.response).status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
    } finally {
      held.abandon();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("the command-reload wait is inside the window", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    const reload = deferred<{ outcome: "reloaded" }>();
    state.commandReload = reload.promise;
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "never sent" });
      await waitFor(() => state.promptClaim !== undefined);
      expect((await cancel(state)).status).toBe(202);

      state.commandReload = undefined;
      reload.resolve({ outcome: "reloaded" });
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
    } finally {
      state.commandReload = undefined;
      reload.resolve({ outcome: "reloaded" });
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("a busy session reserves nothing, so a cancel then targets the owner", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const compactGate = deferred();
    let compactions = 0;
    pi.raw.compact = async () => {
      compactions += 1;
      await compactGate.promise;
    };
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    try {
      const compaction = post(`/session/${state.id}/compact`);
      await waitFor(() => compactions === 1);
      const refused = await post(`/session/${state.id}/prompt`, { prompt: "while compacting" });
      expect(refused.status).toBe(409);
      expect(state.promptClaim).toBeUndefined();
      expect(await (await cancel(state)).json()).toEqual({ cancelled: false });
      expect(state.cancelRequestedClaim).toBeUndefined();

      compactGate.resolve();
      expect((await compaction).status).toBe(200);
      const next = await post(`/session/${state.id}/prompt`, { prompt: "runs" });
      expect(next.status).toBe(202);
      expect(pi.counts.prompts).toBe(1);
      expect(pi.counts.aborts).toBe(0);
    } finally {
      compactGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("cancel while MCP reconciliation is held", () => {
  test("retains the intent across the reconciliation and never invokes Pi", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    const reconcileGate = deferred();
    let reconciles = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      mcpConfigNeedsRefresh: async () => {
        reconciles += 1;
        await reconcileGate.promise;
        return false;
      },
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "mcp-cancel",
      });
      await waitFor(() => reconciles === 1);
      const cancelled = await cancel(state);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });

      reconcileGate.resolve();
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      reconcileGate.resolve();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("every status projection while a claim is held", () => {
  test("/messages and GET /session report running like /status and /activity", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const attachGate = deferred();
    let attaches = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        attaches += 1;
        await attachGate.promise;
        return pi.session;
      },
    });
    // An earlier turn's error must not contradict the running report.
    state.status = "error";
    state.error = "an earlier turn failed";
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "slow start" });
      await waitFor(() => attaches === 1);
      for (const path of ["", "/status", "/messages"]) {
        const body = (await (await call(`/session/${state.id}${path}`)).json()) as {
          status: string;
          error?: string;
        };
        expect({ path, status: body.status, error: body.error }).toEqual({
          path,
          status: "running",
          error: undefined,
        });
      }
      expect(await (await call(`/session/${state.id}/activity`)).json()).toEqual({
        activity: "working",
      });

      attachGate.resolve();
      expect((await prompt).status).toBe(202);
      pi.finishRun();
      await waitFor(() => state.status === "idle" && state.promptClaim === undefined);
      for (const path of ["", "/status", "/messages"]) {
        expect(await readStatus(`/session/${state.id}${path}`)).toBe("idle");
      }
    } finally {
      attachGate.resolve();
      pi.finishRun();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});

describe("a closing session", () => {
  test("refuses new prompts with 409 while its close is still pending", async () => {
    const state = seedSession();
    const pi = controlledSession();
    state.session = pi.session;
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    state.status = "running";
    state.cancelTurn = () => new Promise<void>(() => undefined);
    setDeleteCancelTimeoutForTests(5);
    try {
      const close = await post(`/session/${state.id}/close`);
      expect(close.status).toBe(503);
      expect(sessions.get(state.id)).toBe(state);

      state.status = "idle";
      state.cancelTurn = undefined;
      const refused = await post(`/session/${state.id}/prompt`, { prompt: "after close" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "Session is closed" });
      expect((await post(`/session/${state.id}/attach`, {})).status).toBe(409);
      expect(pi.counts.prompts).toBe(0);
      expect(state.promptClaim).toBeUndefined();

      // The retry completes the close.
      const retry = await post(`/session/${state.id}/close`);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ closed: true, retained: true });
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      setDeleteCancelTimeoutForTests();
      sessions.delete(state.id);
      resetHooks();
    }
  });

  test("/close during a cold attach settles the prompt as cancelled, like DELETE", async () => {
    const state = seedSession();
    const pi = controlledSession();
    const attachGate = deferred();
    let attaches = 0;
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => {
        attaches += 1;
        await attachGate.promise;
        return pi.session;
      },
    });
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "never sent",
        requestId: "closed-during-attach",
      });
      await waitFor(() => attaches === 1);
      const close = post(`/session/${state.id}/close`);
      await waitFor(() => state.cancelRequestedClaim !== undefined);
      // Registered, closed, and still honest about the prompt it owns.
      expect(sessions.get(state.id)).toBe(state);
      expect(await readStatus(`/session/${state.id}/status`)).toBe("running");

      attachGate.resolve();
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, cancelled: true });
      const closed = await close;
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({ closed: true, retained: true });
      expect(pi.counts.prompts).toBe(0);
      expect(sessions.has(state.id)).toBe(false);
      expect(state.promptClaim).toBeUndefined();
    } finally {
      attachGate.resolve();
      sessions.delete(state.id);
      resetHooks();
    }
  });
});
