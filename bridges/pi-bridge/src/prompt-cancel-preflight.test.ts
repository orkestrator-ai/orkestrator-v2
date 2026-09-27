/**
 * Cancellation while Pi's own prompt preflight is pending (INC-05).
 *
 * `AgentSession.prompt` reports acceptance through `preflightResult`, and the
 * bridge has no run to cancel until then. Pi 0.87's `abort()` during preflight
 * cancels an auto-compaction in progress but cannot pre-empt the run:
 * `_runAgentPrompt` resets the abort request when the run starts. So a cancel
 * during preflight is applied twice over — at once (reaching any compaction)
 * and again the moment Pi accepts, because `preflightResult(true)` is called
 * synchronously just before the run is created. These cases hold preflight
 * with a deferred gate and prove that the cancel is retained, applied once per
 * phase, scoped to its own turn, and never leaves an approval waiting.
 *
 * Gates are released in `finally`; no sleeps are used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
const { claimPromptTurn, sessions } = await import("./state.js");
const { dispatchPrompt, setStartupTimeoutForTests } = await import("./prompt.js");
const { denyAllApprovals, requestToolApproval } = await import("./interactions.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

type SessionState = ReturnType<typeof newSessionState>;

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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * A Pi session whose preflight and runs this test controls.
 *
 * With `holdPreflight`, `prompt()` keeps the preflight callback for the test
 * to announce. `abort()` models the SDK: before acceptance it reaches no run
 * (only whatever `onPreflightAbort` stands for, e.g. an auto-compaction);
 * afterwards it ends the current run, after `abortGate` when one is set.
 */
function preflightSession(
  options: {
    holdPreflight?: boolean;
    abortGate?: Promise<void>;
    onPreflightAbort?: () => void;
  } = {},
) {
  const runs: Deferred<void>[] = [];
  const preflights: Array<(accepted: boolean) => void> = [];
  const counts = { prompts: 0, aborts: 0, abortsBeforeAcceptance: 0, abortsAfterAcceptance: 0 };
  let accepted = 0;
  const session = {
    sessionId: "pi-session-preflight",
    sessionFile: "/tmp/pi-session-preflight.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    prompt: (_text: string, promptOptions: { preflightResult?: (accepted: boolean) => void }) => {
      counts.prompts += 1;
      const run = deferred();
      runs.push(run);
      const announce = (ok: boolean) => {
        if (ok) accepted += 1;
        promptOptions.preflightResult?.(ok);
      };
      if (options.holdPreflight) preflights.push(announce);
      else announce(true);
      return run.promise;
    },
    abort: async () => {
      counts.aborts += 1;
      if (accepted < runs.length) {
        counts.abortsBeforeAcceptance += 1;
        options.onPreflightAbort?.();
        return;
      }
      counts.abortsAfterAcceptance += 1;
      // Like the SDK's abort signal, bound to the run live when it was called.
      const target = runs.at(-1);
      if (options.abortGate) await options.abortGate;
      target?.resolve();
    },
    clearQueue: () => ({ steering: [], followUp: [] }),
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
  };
  return {
    session: session as unknown as AgentSession,
    raw: session,
    counts,
    preflights,
    accept: (index = preflights.length - 1) => preflights[index]?.(true),
    refuse: (index = preflights.length - 1) => preflights[index]?.(false),
    finishRun: (index = runs.length - 1) => runs[index]?.resolve(),
    failRun: (error: unknown, index = runs.length - 1) => runs[index]?.reject(error),
    settleAll: () => {
      for (const run of runs) run.resolve();
    },
  };
}

function seed(session: AgentSession): SessionState {
  const state = newSessionState();
  state.session = session;
  sessions.set(state.id, state);
  setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
  return state;
}

function release(state: SessionState): void {
  denyAllApprovals(state, "test teardown");
  sessions.delete(state.id);
  setAgentSessionTestHooks(undefined);
}

async function status(state: SessionState): Promise<string> {
  return ((await (await call(`/session/${state.id}/status`)).json()) as { status: string }).status;
}

describe("cancel while Pi's preflight is held", () => {
  test("acknowledges as pending and aborts the run the moment Pi accepts", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "cancel me",
        requestId: "preflight-cancel",
      });
      await waitFor(() => pi.preflights.length === 1);
      expect(state.status).toBe("running");
      expect(state.dispatching).toBe(true);
      expect(state.cancelTurn).toBeUndefined();

      const cancelled = await post(`/session/${state.id}/cancel`);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });
      // Recorded, not stopped: the turn still reports working.
      expect(await status(state)).toBe("running");
      // Applied at once, reaching whatever preflight is doing — but not a run.
      await waitFor(() => pi.counts.abortsBeforeAcceptance === 1);
      expect(pi.counts.abortsAfterAcceptance).toBe(0);

      pi.accept();
      const response = await prompt;
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });

      await waitFor(() => state.status === "idle");
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(pi.counts.abortsBeforeAcceptance).toBe(1);
      expect(state.promptJournal.get("preflight-cancel")?.state).toBe("completed");
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.cancelTurn).toBeUndefined();
    } finally {
      pi.settleAll();
      release(state);
    }
  });

  test("a preflight rejection after a cancel settles once and leaves no stale intent", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "refused",
        requestId: "preflight-refused",
      });
      await waitFor(() => pi.preflights.length === 1);
      expect((await post(`/session/${state.id}/cancel`)).status).toBe(202);
      const revisionBefore = state.revision;

      pi.refuse();
      pi.failRun(new Error("no credential"));
      expect((await prompt).status).toBe(500);

      // One terminal transition: the rollback, not a rollback plus a run end.
      expect(state.status).toBe("error");
      expect(state.revision).toBe(revisionBefore + 1);
      expect(state.messages).toHaveLength(0);
      expect(state.promptJournal.has("preflight-refused")).toBe(false);
      // Only the preflight abort; nothing was accepted, so no run was aborted.
      expect(pi.counts.abortsAfterAcceptance).toBe(0);
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();

      // The next prompt runs normally; nothing from the refused one cancels it.
      const next = post(`/session/${state.id}/prompt`, { prompt: "runs" });
      await waitFor(() => pi.preflights.length === 2);
      pi.accept(1);
      expect((await next).status).toBe(202);
      expect(state.status).toBe("running");
      expect(pi.counts.abortsAfterAcceptance).toBe(0);
      pi.finishRun();
      await waitFor(() => state.status === "idle");
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      pi.settleAll();
      release(state);
    }
  });
});

describe("concurrent cancels for one claim", () => {
  test("repeat cancels during preflight answer identically and abort the run once", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "cancel me twice" });
      await waitFor(() => pi.preflights.length === 1);

      const [first, second] = await Promise.all([
        post(`/session/${state.id}/cancel`),
        post(`/session/${state.id}/abort`),
      ]);
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(await first.json()).toEqual({ cancelled: false, pending: true });
      expect(await second.json()).toEqual({ cancelled: false, pending: true });

      pi.accept();
      expect((await prompt).status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(pi.counts.abortsBeforeAcceptance).toBeGreaterThanOrEqual(1);
    } finally {
      pi.settleAll();
      release(state);
    }
  });

  test("repeat cancels of an accepted run share one abort", async () => {
    const abortGate = deferred();
    const pi = preflightSession({ abortGate: abortGate.promise });
    const state = seed(pi.session);
    try {
      expect((await post(`/session/${state.id}/prompt`, { prompt: "runs" })).status).toBe(202);
      const first = post(`/session/${state.id}/cancel`);
      const second = post(`/session/${state.id}/abort`);
      await waitFor(() => pi.counts.aborts >= 1);
      abortGate.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(await responses[0]!.json()).toEqual({ cancelled: true });
      expect(await responses[1]!.json()).toEqual({ cancelled: true });
      expect(pi.counts.aborts).toBe(1);
      await waitFor(() => state.status === "idle");
    } finally {
      abortGate.resolve();
      pi.settleAll();
      release(state);
    }
  });
});

describe("a cancel for an older turn", () => {
  test("settling after a new turn began leaves the new turn untouched", async () => {
    const abortGate = deferred();
    const pi = preflightSession({ abortGate: abortGate.promise });
    const state = seed(pi.session);
    setCancelAckTimeoutForTests(60_000);
    try {
      expect((await post(`/session/${state.id}/prompt`, { prompt: "old" })).status).toBe(202);
      const oldClaim = state.promptClaim;

      // The old turn's cancel is still in flight while its run ends on its own.
      const oldCancel = post(`/session/${state.id}/cancel`);
      await waitFor(() => pi.counts.aborts === 1);
      expect(state.cancelRequestedClaim).toBe(oldClaim!);
      pi.finishRun(0);
      await waitFor(() => state.status === "idle");
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();

      const next = await post(`/session/${state.id}/prompt`, {
        prompt: "new",
        requestId: "new-turn",
      });
      expect(next.status).toBe(202);
      const newClaim = state.promptClaim;
      expect(newClaim).not.toBe(oldClaim);

      // Now the old abort lands. It belonged to the old turn's cancel handle.
      abortGate.resolve();
      expect((await oldCancel).status).toBe(200);
      expect(state.status).toBe("running");
      expect(state.promptClaim).toBe(newClaim!);
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(pi.counts.aborts).toBe(1);

      pi.finishRun(1);
      await waitFor(() => state.status === "idle");
      expect(state.promptJournal.get("new-turn")?.state).toBe("completed");
    } finally {
      abortGate.resolve();
      setCancelAckTimeoutForTests();
      pi.settleAll();
      release(state);
    }
  });
});

describe("approvals during cancellation", () => {
  test("are denied at once while a cancel is pending or being applied, never parked", async () => {
    const abortGate = deferred();
    const pi = preflightSession({ holdPreflight: true, abortGate: abortGate.promise });
    const state = seed(pi.session);
    state.policy = { approvals: "ask" } as never;
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "cancel me" });
      await waitFor(() => pi.preflights.length === 1);
      expect((await post(`/session/${state.id}/cancel`)).status).toBe(202);

      const duringPreflight = await requestToolApproval(state, "call-1", "bash", {
        command: "make release",
      });
      expect(duringPreflight).toEqual({
        block: true,
        reason: "The turn was cancelled before this tool call was approved.",
      });
      expect(state.approvals.size).toBe(0);

      // Accepted, and the abort is being applied but has not landed yet.
      pi.accept();
      expect((await prompt).status).toBe(202);
      await waitFor(() => pi.counts.abortsAfterAcceptance === 1);
      const whileAborting = await requestToolApproval(state, "call-2", "edit", { path: "a.ts" });
      expect(whileAborting.block).toBe(true);
      expect(state.approvals.size).toBe(0);

      abortGate.resolve();
      await waitFor(() => state.status === "idle");

      // The next turn is a new claim: its approvals park normally again, and a
      // cancel answers the parked one with an explicit deny.
      pi.raw.abort = async () => {
        pi.counts.aborts += 1;
        pi.counts.abortsAfterAcceptance += 1;
        pi.finishRun();
      };
      const next = post(`/session/${state.id}/prompt`, { prompt: "next" });
      await waitFor(() => pi.preflights.length === 2);
      pi.accept(1);
      expect((await next).status).toBe(202);
      const parked = requestToolApproval(state, "call-3", "bash", { command: "ls -la" });
      await waitFor(() => state.approvals.size === 1);
      expect((await post(`/session/${state.id}/cancel`)).status).toBe(200);
      expect(await parked).toEqual({
        block: true,
        reason: "The turn was cancelled before this tool call was approved.",
      });
      expect(state.approvals.size).toBe(0);
    } finally {
      abortGate.resolve();
      pi.settleAll();
      release(state);
    }
  });
});

describe("dispatchPrompt claim ownership", () => {
  test("applies a cancel recorded for its own claim when Pi accepts", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = newSessionState();
    state.status = "running";
    const claim = claimPromptTurn(state);
    try {
      const handle = dispatchPrompt(state, pi.session, { prompt: "go", images: [] });
      await waitFor(() => pi.preflights.length === 1);
      state.cancelRequestedClaim = claim;
      pi.accept();
      const { completion } = await handle;
      await completion;
      expect(pi.counts.aborts).toBe(1);
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(state.status).toBe("idle");
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      pi.settleAll();
    }
  });

  test("ignores a cancel recorded for any other claim", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = newSessionState();
    state.status = "running";
    const claim = claimPromptTurn(state);
    try {
      const handle = dispatchPrompt(state, pi.session, { prompt: "go", images: [] });
      await waitFor(() => pi.preflights.length === 1);
      state.cancelRequestedClaim = claim - 1;
      pi.accept();
      const { completion } = await handle;
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("running");
      pi.finishRun();
      await completion;
      expect(pi.counts.aborts).toBe(0);
      expect(state.status).toBe("idle");
      // Release is by identity: the unrelated record is not this turn's to clear.
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBe(claim - 1);
    } finally {
      pi.settleAll();
    }
  });
});

describe("cancel while preflight is compacting", () => {
  test("aborts the auto-compaction at once, then the run Pi goes on to accept", async () => {
    // Models Pi 0.87: `abort()` during preflight aborts `_checkCompaction`'s
    // compaction, `prompt()` then carries on and accepts, and the run it
    // starts has to be aborted again because `_runAgentPrompt` resets the flag.
    let compactionAborted = false;
    const pi = preflightSession({
      holdPreflight: true,
      onPreflightAbort: () => {
        compactionAborted = true;
        queueMicrotask(() => pi.accept());
      },
    });
    const state = seed(pi.session);
    try {
      const prompt = post(`/session/${state.id}/prompt`, {
        prompt: "cancel me while compacting",
        requestId: "compaction-cancel",
      });
      await waitFor(() => pi.preflights.length === 1);

      const cancelled = await post(`/session/${state.id}/cancel`);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ cancelled: false, pending: true });
      expect(compactionAborted).toBe(true);

      expect((await prompt).status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(pi.counts.abortsBeforeAcceptance).toBe(1);
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(state.promptJournal.get("compaction-cancel")?.state).toBe("completed");
      expect(state.promptClaim).toBeUndefined();
      expect(state.promptStartup).toBeUndefined();
    } finally {
      pi.settleAll();
      release(state);
    }
  });
});

describe("the startup deadline", () => {
  test("fails the turn explicitly, keeps ownership, and aborts a late acceptance", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    setStartupTimeoutForTests(20);
    try {
      const response = await post(`/session/${state.id}/prompt`, {
        prompt: "too slow to start",
        requestId: "startup-late-accept",
      });
      expect(response.status).toBe(424);
      expect(await response.json()).toEqual({
        accepted: false,
        outcome: "startup-timeout",
        error:
          "Pi did not start the turn within 1 second, so the prompt was cancelled. Send it again once the session is idle.",
        requestId: "startup-late-accept",
      });
      // Failed, but Pi may still accept: the claim is kept, status says so,
      // the preflight abort has been applied, and nothing new is admitted.
      expect(state.promptClaim).toBeNumber();
      expect(state.status).toBe("error");
      expect(await status(state)).toBe("running");
      expect(pi.counts.abortsBeforeAcceptance).toBe(1);
      expect(state.promptJournal.get("startup-late-accept")?.state).toBe("prepared");
      expect(state.dispatching).toBe(true);
      expect((await post(`/session/${state.id}/prompt`, { prompt: "next" })).status).toBe(409);
      expect((await post(`/session/${state.id}/compact`)).status).toBe(409);
      // A stop request re-applies the startup abort and stays pending.
      const stop = await post(`/session/${state.id}/hard-abort`);
      expect(stop.status).toBe(202);
      expect(await stop.json()).toEqual({ cancelled: false, pending: true });
      await waitFor(() => pi.counts.abortsBeforeAcceptance === 2);

      pi.accept();
      await waitFor(() => state.promptClaim === undefined);
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(state.dispatching).toBe(false);
      expect(state.status).toBe("error");
      expect(state.error).toContain("Pi did not start the turn");
      expect(await status(state)).toBe("error");
      // Pi did run it (briefly), so the journal says so rather than inviting a resend.
      expect(state.promptJournal.get("startup-late-accept")?.state).toBe("failed");
      expect(state.promptStartup).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
    } finally {
      setStartupTimeoutForTests();
      pi.settleAll();
      release(state);
    }
  });

  test("releases ownership when Pi refuses late, and the next prompt runs", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    setStartupTimeoutForTests(20);
    try {
      const response = await post(`/session/${state.id}/prompt`, {
        prompt: "refused late",
        requestId: "startup-late-refuse",
      });
      expect(response.status).toBe(424);
      expect(await status(state)).toBe("running");

      pi.refuse();
      pi.failRun(new Error("no credential"));
      await waitFor(() => state.promptClaim === undefined);
      expect(pi.counts.abortsAfterAcceptance).toBe(0);
      // Provably never ran: the request id is free to be sent again.
      expect(state.promptJournal.has("startup-late-refuse")).toBe(false);
      expect(await status(state)).toBe("error");

      setStartupTimeoutForTests();
      const next = post(`/session/${state.id}/prompt`, { prompt: "runs" });
      await waitFor(() => pi.preflights.length === 2);
      pi.accept(1);
      expect((await next).status).toBe(202);
      expect(state.status).toBe("running");
      pi.finishRun(1);
      await waitFor(() => state.status === "idle");
      expect(pi.counts.abortsAfterAcceptance).toBe(0);
    } finally {
      setStartupTimeoutForTests();
      pi.settleAll();
      release(state);
    }
  });
});

describe("a rejected provider abort", () => {
  test("is reported pending, never cancelled, and the escalation retries it", async () => {
    const pi = preflightSession();
    const state = seed(pi.session);
    let attempts = 0;
    pi.raw.abort = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("abort refused");
      pi.finishRun();
    };
    try {
      expect((await post(`/session/${state.id}/prompt`, { prompt: "runs" })).status).toBe(202);

      const graceful = await post(`/session/${state.id}/abort`);
      expect(graceful.status).toBe(202);
      expect(await graceful.json()).toEqual({ cancelled: false, pending: true });
      expect(await status(state)).toBe("running");

      const hard = await post(`/session/${state.id}/hard-abort`);
      expect(hard.status).toBe(200);
      expect(await hard.json()).toEqual({ cancelled: true });
      expect(attempts).toBe(2);
      await waitFor(() => state.status === "idle");
      expect(state.promptClaim).toBeUndefined();
    } finally {
      pi.settleAll();
      release(state);
    }
  });
});

describe("the turn timeout", () => {
  test("aborts the run and clears the claim and any cancel record", async () => {
    const pi = preflightSession();
    const state = newSessionState();
    state.status = "running";
    const claim = claimPromptTurn(state);
    state.cancelRequestedClaim = undefined;
    try {
      const { completion } = await dispatchPrompt(
        state,
        pi.session,
        { prompt: "never finishes", images: [], requestId: "timed-out" },
        10,
      );
      // A cancel recorded mid-run, whose abort the timeout then shares.
      state.cancelRequestedClaim = claim;
      await completion;
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
      expect(state.status).toBe("error");
      expect(state.error).toBe("The Pi turn exceeded its time budget");
      expect(state.promptClaim).toBeUndefined();
      expect(state.cancelRequestedClaim).toBeUndefined();
      expect(state.cancelTurn).toBeUndefined();
      expect(state.promptJournal.get("timed-out")?.state).toBe("failed");
    } finally {
      pi.settleAll();
    }
  });
});

describe("close and DELETE while preflight is held", () => {
  test("close answers pending until the late run is aborted, then a retry confirms", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    setDeleteCancelTimeoutForTests(20);
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "closing" });
      await waitFor(() => pi.preflights.length === 1);

      const pending = await post(`/session/${state.id}/close`);
      expect(pending.status).toBe(503);
      expect(await pending.json()).toEqual({
        closed: false,
        pending: true,
        error: "Session close did not complete",
      });
      expect(pi.counts.abortsBeforeAcceptance).toBe(1);
      expect(sessions.get(state.id)).toBe(state);
      expect((await post(`/session/${state.id}/prompt`, { prompt: "more" })).status).toBe(409);

      pi.accept();
      expect((await prompt).status).toBe(202);
      await waitFor(() => state.promptClaim === undefined);
      expect(pi.counts.abortsAfterAcceptance).toBe(1);

      const retry = await post(`/session/${state.id}/close`);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ closed: true, retained: true });
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      setDeleteCancelTimeoutForTests();
      pi.settleAll();
      release(state);
    }
  });

  test("DELETE aborts preflight at once and the accepted run on acceptance", async () => {
    const pi = preflightSession({ holdPreflight: true });
    const state = seed(pi.session);
    try {
      const prompt = post(`/session/${state.id}/prompt`, { prompt: "deleted" });
      await waitFor(() => pi.preflights.length === 1);

      const deleted = await call(`/session/${state.id}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(pi.counts.abortsBeforeAcceptance).toBe(1);
      expect(sessions.has(state.id)).toBe(false);

      pi.accept();
      expect((await prompt).status).toBe(202);
      await waitFor(() => state.promptClaim === undefined);
      expect(pi.counts.abortsAfterAcceptance).toBe(1);
    } finally {
      pi.settleAll();
      release(state);
    }
  });
});
