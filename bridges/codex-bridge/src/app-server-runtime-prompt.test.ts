import { describe, expect, test } from "bun:test";
import { AppServerProcessExitError, AppServerTimeoutError } from "./app-server/errors.js";
import { hashCwd } from "./sessions/persistence.js";
import { MAX_LOCAL_MESSAGES, phaseToExternalStatus } from "./sessions/thread-registry.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  NO_RESPONSE,
  captureConsoleErrors,
  codexHome,
  deferredSignal,
  harness,
  threadPayload,
  waitUntil,
} from "./app-server-runtime-test-harness.js";

describe("at-most-once dispatch", () => {
  test("a duplicate request id while running attaches to the existing turn", async () => {
    const h = await harness(
      {},
      {
        now: () => Date.parse("2026-08-01T12:34:56.000Z"),
      },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(again).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        duplicate: true,
        turnId: "turn-1",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt).toBe("2026-08-01T12:34:56.000Z");
    // Exactly one turn was dispatched.
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("a duplicate request id after completion is not re-run", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const again = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(again).toMatchObject({
      ok: true,
      result: { status: "already-processed", duplicate: true },
    });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("the same prompt text under a new request id runs again", async () => {
    let turnCounter = 0;
    const h = await harness({
      "turn/start": () => {
        turnCounter += 1;
        return { turn: { id: `turn-${turnCounter}` } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "same", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    const second = await h.runtime.prompt(sessionId, {
      prompt: "same",
      requestId: "req-2",
      attachments: [],
    });

    // Deduplicating on text would swallow a legitimate retry.
    expect(second).toMatchObject({ ok: true, result: { turnId: "turn-2" } });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
  });

  test("an overload rejection leaves the session usable and does not journal a dispatch", async () => {
    const h = await harness({
      "turn/start": () => {
        const error = new Error("ingress queue full");
        (error as { rpcCode?: number }).rpcCode = -32001;
        throw error;
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    // The server said it did not accept the request, so the id is reusable.
    expect(h.runtime.getJournal().classify("req-1").action).toBe("dispatch");
    expect(h.runtime.getStatus(sessionId)!.phase).toBe("failed");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(
      h.events.filter((event) => typeof event.data?.removedMessageId === "string"),
    ).toHaveLength(2);
  });

  test("an initial prompt retries one definite overload inside the bridge", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-after-overload" } };
        },
      },
      { initialPromptRetryDelayMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-1";

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        requestId,
        turnId: "turn-after-overload",
      },
    });
    expect(h.child().requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "attach",
      record: { turnId: "turn-after-overload" },
    });
  });

  test("a second definite initial-prompt rejection becomes durably retryable", async () => {
    const h = await harness(
      {
        "turn/start": () => {
          const error = new Error("ingress queue full");
          (error as { rpcCode?: number }).rpcCode = -32001;
          throw error;
        },
      },
      { initialPromptRetryDelayMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-second-failure";

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "start once",
        requestId,
        attachments: [],
      }),
    ).toMatchObject({ ok: false, status: 503 });

    expect(h.child().requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "dispatch",
      record: { state: "retryable" },
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      phase: "failed",
      unconfirmedDispatch: { requestId, retryable: true },
    });
  });

  test("a deleted session cannot dispatch its delayed initial-prompt retry", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "must-not-run" } };
        },
      },
      { initialPromptRetryDelayMs: 30 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-deleted";
    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");

    expect(await h.runtime.deleteSession(sessionId)).toBe(true);
    expect(await pending).toMatchObject({ ok: false, status: 404 });
    expect(attempts).toBe(1);
    expect(h.runtime.getJournal().get(requestId)).toBeUndefined();
  });

  test("shutdown cancels a delayed retry and leaves a durable retry marker", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "must-not-run" } };
        },
      },
      { initialPromptRetryDelayMs: 30 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-stopping";
    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");

    await h.runtime.stop();
    expect(await pending).toMatchObject({ ok: false, status: 503 });
    expect(attempts).toBe(1);
    expect(h.runtime.getJournal().get(requestId)).toMatchObject({ state: "retryable" });
  });

  /**
   * Every exit past the `starting` phase has to settle it.
   *
   * `starting` reports `running`, so a thread left there fails
   * `assertNoActiveTurn` for every later prompt and nothing is scheduled to
   * resolve it. The two cancellation returns below are the only exits that leave
   * the delay window without dispatching, which is exactly why they are easy to
   * miss.
   */
  test("shutdown during the retry window settles the thread instead of leaving it starting", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "must-not-run" } };
        },
      },
      { initialPromptRetryDelayMs: 60 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId: "initial-prompt:env-1:tab-stopping-phase",
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");

    await h.runtime.stop();
    expect(await pending).toMatchObject({ ok: false, status: 503 });

    expect(h.runtime.getRegistry().getThread("thread-1")?.phase).toBe("failed");
    const status = h.runtime.getStatus(sessionId);
    expect(status?.status).not.toBe("running");
    expect(status).toMatchObject({ status: "error", phase: "failed" });
  });

  test("a deleted session's retry window does not wedge a thread another tab holds", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: `turn-${attempts}` } };
        },
      },
      { initialPromptRetryDelayMs: 250 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId: "initial-prompt:env-1:tab-shared",
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");

    // `releaseSession` only surrenders the thread when the *last* reference goes,
    // so a second tab inherits this context — including its unsettled phase.
    const survivor = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    expect(await h.runtime.deleteSession(sessionId)).toBe(true);
    expect(await pending).toMatchObject({ ok: false, status: 404 });
    expect(attempts).toBe(1);

    expect(h.runtime.getRegistry().getThread("thread-1")?.phase).toBe("failed");
    expect(h.runtime.getStatus(survivor!.sessionId)?.status).not.toBe("running");

    // The surviving tab must still be able to prompt: without a settled phase
    // this 409s forever with no recovery backstop armed.
    const next = await h.runtime.prompt(survivor!.sessionId, {
      prompt: "carry on",
      requestId: "req-after-shared-delete",
      attachments: [],
    });
    expect(next).toMatchObject({ ok: true, result: { turnId: "turn-2" } });
  });

  test("a concurrent retry of the same request id cannot double-dispatch", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-single" } };
        },
      },
      { initialPromptRetryDelayMs: 200 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-concurrent";
    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");

    // The journal marks the id `retryable` before the delay, so classification
    // alone would wave this second copy straight through. `dispatchInFlight` on
    // the thread is what stops it — the id is reusable, but not concurrently.
    const concurrent = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    expect(concurrent).toMatchObject({ ok: false, status: 409 });

    expect(await pending).toMatchObject({ ok: true, result: { turnId: "turn-single" } });
    // One definite rejection plus one accepted dispatch: never two accepted ones.
    expect(attempts).toBe(2);
    expect(h.child().requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
  });

  test("a failed retryable journal write during the window still fails closed", async () => {
    let attempts = 0;
    const bridgeDir = join(codexHome, "orkestrator-bridge");
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            // Break the journal after the prepared write landed, so the retryable
            // marker — which flushes without failing closed — cannot persist.
            rmSync(join(bridgeDir, `dispatch-journal-${hashCwd("/tmp/ws")}.json`), { force: true });
            mkdirSync(join(bridgeDir, `dispatch-journal-${hashCwd("/tmp/ws")}.json`));
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "must-not-run" } };
        },
        // Nothing carries the request id, so the failed retry is provably absent.
        "thread/read": () => ({ thread: threadPayload("thread-1", { turns: [] }) }),
      },
      { initialPromptRetryDelayMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId: "initial-prompt:env-1:tab-unwritable",
      attachments: [],
    });

    // The retryable marker is best-effort, but the second prepared write is not:
    // without durable evidence the id can be reused, the retry must not run.
    expect(outcome).toMatchObject({ ok: false });
    expect(attempts).toBe(1);
    expect(h.runtime.getStatus(sessionId)?.status).not.toBe("running");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(
      h.events.filter((event) => typeof event.data?.removedMessageId === "string"),
    ).toHaveLength(2);
  });

  test("the default retry delay applies when no override is configured", async () => {
    let attempts = 0;
    const h = await harness({
      "turn/start": () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("ingress queue full");
          (error as { rpcCode?: number }).rpcCode = -32001;
          throw error;
        }
        return { turn: { id: "turn-default-delay" } };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const started = Date.now();
    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId: "initial-prompt:env-1:tab-default-delay",
      attachments: [],
    });
    const elapsed = Date.now() - started;

    expect(outcome).toMatchObject({ ok: true, result: { turnId: "turn-default-delay" } });
    // A retry that fires immediately would hit the same overloaded queue. The
    // default is a full second; anything under half of it means the constant is
    // not being applied.
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(h.runtime.getStatus(sessionId)?.phase).toBe("running");
  });

  test("a delayed retry succeeds and settles the phase after the wait", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-after-wait" } };
        },
      },
      { initialPromptRetryDelayMs: 40 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-delayed-success";

    const started = Date.now();
    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(outcome).toMatchObject({ ok: true, result: { requestId, turnId: "turn-after-wait" } });
    expect(h.runtime.getRegistry().getThread("thread-1")?.phase).toBe("running");
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "attach",
      record: { turnId: "turn-after-wait" },
    });
  });

  test("a retry preserves optimistic messages when restart races the retryable journal write", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-after-restart" } };
        },
      },
      { initialPromptRetryDelayMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-restarted-delay";
    const retryableWriteStarted = deferredSignal();
    const allowRetryableWrite = deferredSignal();
    const journal = h.runtime.getJournal();
    const markRetryable = journal.markRetryable.bind(journal);
    journal.markRetryable = async (candidateRequestId) => {
      retryableWriteStarted.resolve();
      await allowRetryableWrite.promise;
      await markRetryable(candidateRequestId);
    };

    const pending = h.runtime.prompt(sessionId, {
      prompt: "start on the replacement child",
      requestId,
      attachments: [],
    });
    await retryableWriteStarted.promise;
    try {
      await h.engine.getSupervisor().restartNow("restart during retryable journal write");
    } finally {
      allowRetryableWrite.resolve();
    }

    expect(await pending).toMatchObject({
      ok: true,
      result: { requestId, turnId: "turn-after-restart" },
    });
    expect(h.children).toHaveLength(2);
    expect(
      h.children[0]!.requests.filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      h.children[1]!.requests.filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "attach",
      record: { turnId: "turn-after-restart" },
    });
    expect((await h.runtime.getMessages(sessionId))?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("never exposes an idle replacement context while a retry is still dispatching", async () => {
    let attempts = 0;
    const h = await harness(
      {
        "turn/start": () => {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-after-restart" } };
        },
      },
      { initialPromptRetryDelayMs: 80 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    // The replacement context is attached, then persisted, then dispatched. If
    // the busy flags are set after that store write rather than before it, a
    // `/review` or `/compact` arriving in the gap passes `assertNoActiveTurn`
    // and registers its own accumulator over a turn that is about to start.
    const internals = h.runtime as unknown as {
      persistSession: (session: unknown) => Promise<void>;
    };
    const realPersistSession = internals.persistSession.bind(h.runtime);
    const observedDuringRetry: Array<string | undefined> = [];
    internals.persistSession = async (session: unknown) => {
      if (attempts >= 1) observedDuringRetry.push(h.runtime.getStatus(sessionId)?.status);
      return realPersistSession(session);
    };

    const pending = h.runtime.prompt(sessionId, {
      prompt: "start on the replacement child",
      requestId: "initial-prompt:env-1:tab-busy-window",
      attachments: [],
    });
    await waitUntil(() => attempts === 1, "first initial prompt attempt did not run");
    await h.engine.getSupervisor().restartNow("restart during retry delay");
    expect(await pending).toMatchObject({ ok: true });

    expect(observedDuringRetry.length).toBeGreaterThan(0);
    expect(observedDuringRetry.every((status) => status === "running")).toBe(true);
  });

  test("a no-id replacement thread settles the stale retry and remains reusable", async () => {
    let turnAttempts = 0;
    let threadStarts = 0;
    const h = await harness(
      {
        "thread/start": () => {
          threadStarts += 1;
          if (threadStarts === 2) return { thread: {} };
          return { thread: threadPayload(`thread-${threadStarts}`) };
        },
        "turn/start": () => {
          turnAttempts += 1;
          if (turnAttempts === 1) {
            const error = new Error("ingress queue full");
            (error as { rpcCode?: number }).rpcCode = -32001;
            throw error;
          }
          return { turn: { id: "turn-after-no-id" } };
        },
      },
      { initialPromptRetryDelayMs: 80 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-no-id-replacement";

    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    await waitUntil(() => turnAttempts === 1, "first initial prompt attempt did not run");
    const staleContext = h.runtime.getRegistry().getThread("thread-1")!;
    await h.engine.getSupervisor().restartNow("restart before no-id replacement");

    expect(await pending).toMatchObject({
      ok: false,
      status: 503,
      error: "Codex did not return a thread id",
    });
    expect(staleContext.dispatchInFlight).toBe(false);
    expect(staleContext.phase).toBe("failed");
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "dispatch",
      record: { state: "retryable" },
    });

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "retry after replacement failure",
        requestId,
        attachments: [],
      }),
    ).toMatchObject({ ok: true, result: { turnId: "turn-after-no-id" } });
    expect(turnAttempts).toBe(2);
  });

  test("a thrown replacement thread start settles without dereferencing null context", async () => {
    let turnAttempts = 0;
    let threadStarts = 0;
    const h = await harness(
      {
        "thread/start": () => {
          threadStarts += 1;
          if (threadStarts === 2) throw new Error("replacement thread unavailable");
          return { thread: threadPayload(`thread-${threadStarts}`) };
        },
        "turn/start": () => {
          turnAttempts += 1;
          const error = new Error("ingress queue full");
          (error as { rpcCode?: number }).rpcCode = -32001;
          throw error;
        },
      },
      { initialPromptRetryDelayMs: 80 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const requestId = "initial-prompt:env-1:tab-thrown-replacement";

    const pending = h.runtime.prompt(sessionId, {
      prompt: "start once",
      requestId,
      attachments: [],
    });
    await waitUntil(() => turnAttempts === 1, "first initial prompt attempt did not run");
    const staleContext = h.runtime.getRegistry().getThread("thread-1")!;
    await h.engine.getSupervisor().restartNow("restart before thrown replacement");

    expect(await pending).toMatchObject({
      ok: false,
      status: 503,
      error: "thread/start failed (-32603): replacement thread unavailable",
    });
    expect(staleContext).toMatchObject({ dispatchInFlight: false, phase: "failed" });
    expect(h.runtime.getJournal().classify(requestId)).toMatchObject({
      action: "dispatch",
      record: { state: "retryable" },
    });
    expect(turnAttempts).toBe(1);
  });

  test("journal count exhaustion fails before turn/start", async () => {
    const h = await harness({}, { dispatchJournalMaxRecords: 1 });
    await h.runtime.getJournal().markPrepared({
      requestId: "existing",
      bridgeSessionId: "other-session",
      threadId: "other-thread",
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "must not dispatch",
        requestId: "new-request",
        attachments: [],
      }),
    ).toMatchObject({
      ok: false,
      status: 503,
      error: "Dispatch journal safety-record limit (1) is exhausted",
    });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(h.runtime.getJournal().classify("existing").action).toBe("reconcile");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(
      h.events.filter((event) => typeof event.data?.removedMessageId === "string"),
    ).toHaveLength(2);
  });

  test("an oversized persisted journal blocks dispatch before thread creation", async () => {
    const bridgeDir = join(codexHome, "orkestrator-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(
      join(bridgeDir, `dispatch-journal-${hashCwd("/tmp/ws")}.json`),
      "x".repeat(257),
      "utf8",
    );
    const h = await harness({}, { dispatchJournalMaxBytes: 256 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(
      await h.runtime.prompt(sessionId, {
        prompt: "must not dispatch",
        requestId: "blocked-by-oversized-journal",
        attachments: [],
      }),
    ).toMatchObject({
      ok: false,
      status: 503,
      error: "Dispatch journal exceeds its 256-byte read limit",
    });
    expect(
      h
        .child()
        .requests.some(
          (request) => request.method === "thread/start" || request.method === "turn/start",
        ),
    ).toBe(false);
  });

  test("a retryable dispatch remains visible after a bridge restart", async () => {
    const first = await harness({
      "turn/start": () => {
        const error = new Error("ingress queue full");
        (error as { rpcCode?: number }).rpcCode = -32001;
        throw error;
      },
    });
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    const requestId = "req-restored-retryable";
    expect(
      await first.runtime.prompt(sessionId, {
        prompt: "try once",
        requestId,
        attachments: [],
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(first.runtime.getStatus(sessionId)?.unconfirmedDispatch).toEqual({
      requestId,
      retryable: true,
    });
    await first.runtime.stop();

    const restored = await harness();
    expect(restored.runtime.getStatus(sessionId)?.unconfirmedDispatch).toEqual({
      requestId,
      retryable: true,
    });
    await restored.runtime.stop();
  });

  test("a failed prepared-journal write prevents turn dispatch", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const bridgeDir = join(codexHome, "orkestrator-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    mkdirSync(join(bridgeDir, `dispatch-journal-${hashCwd("/tmp/ws")}.json`));

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "must not execute",
      requestId: "req-unwritable",
      attachments: [],
    });
    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  /**
   * `recovering` after an ambiguous dispatch must be transient.
   *
   * It maps to `running`, so a thread left there rejects every later prompt with
   * a 409 and the session is bricked — the exact failure the phase exists to
   * avoid. Reconciliation, never a re-dispatch, is what resolves it.
   */
  test("an ambiguous dispatch that never ran fails, and does not brick the session", async () => {
    let hangNextTurn = false;
    let turns = 0;
    const h = await harness({
      "turn/start": () => {
        turns += 1;
        return hangNextTurn ? NO_RESPONSE : { turn: { id: `turn-${turns}` } };
      },
      // No turn carries req-1, so the write provably never landed.
      "thread/read": () => ({ thread: threadPayload("thread-1", { turns: [] }) }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Materialize the thread with a first successful turn.
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    // Dispatch a turn app-server never answers, then kill the child. The write
    // may have landed, so the outcome is genuinely unknowable.
    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    const outcome = await pending;
    await h.drain();

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    // Reconciled to a definite phase, and never silently idle while the turn
    // might still have been running.
    expect(h.runtime.getStatus(sessionId)!.phase).not.toBe("recovering");
    // Absent means it provably did not run, so the id is reusable.
    expect(h.runtime.getJournal().classify("req-1").action).toBe("dispatch");
    /*
     * Absent is as definite as an explicit rejection, so the exchange announced
     * before the write has to go with it. Leaving it behind strands a prompt
     * bubble and a blank reply for a turn `thread/read` just proved never
     * existed, and the renderer cannot clean it up itself: its own rollback
     * targets the optimistic id, which this turn's authoritative user echo
     * already retired.
     */
    const survivingMessages = (await h.runtime.getMessages(sessionId))!;
    expect(survivingMessages.map((message) => message.content)).not.toContain("second");
    expect(survivingMessages.some((message) => message.content === "first")).toBe(true);
    expect(
      h.events.filter((event) => typeof event.data?.removedMessageId === "string"),
    ).toHaveLength(2);

    hangNextTurn = false;
    const next = await h.runtime.prompt(sessionId, {
      prompt: "third",
      requestId: "req-2",
      attachments: [],
    });
    expect(next.ok).toBe(true);
  });

  test("an ambiguous dispatch that did run stays running until its terminal event", async () => {
    let hangNextTurn = false;
    let now = Date.parse("2026-08-01T12:00:00.000Z");
    const h = await harness(
      {
        "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
        // The write landed: app-server is executing this request right now.
        "thread/read": () => ({
          thread: threadPayload("thread-1", {
            turns: [
              {
                id: "turn-9",
                status: "inProgress",
                items: [{ type: "userMessage", clientId: "req-1" }],
              },
            ],
          }),
        }),
      },
      { now: () => now },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    now = Date.parse("2026-08-01T12:05:00.000Z");
    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        turnId: "turn-9",
        turnStartedAt: "2026-08-01T12:05:00.000Z",
        duplicate: true,
      },
    });
    await h.drain();

    // Reporting idle here would let the build pipeline advance on a live turn.
    expect(phaseToExternalStatus(h.runtime.getStatus(sessionId)!.phase)).toBe("running");
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt).toBe("2026-08-01T12:05:00.000Z");
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ state: "accepted" });
    /*
     * The safety half of retraction. This turn is executing, so withdrawing its
     * rows would erase a prompt the user really sent and blank the row its
     * output is about to stream into. Only a *proven* non-dispatch retracts.
     */
    expect(
      (await h.runtime.getMessages(sessionId))!.some((message) => message.content === "second"),
    ).toBe(true);
    expect(h.events.some((event) => typeof event.data?.removedMessageId === "string")).toBe(false);

    // The adopted turn is tracked, so its terminal event finalizes normally.
    const adoptedTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-9", status: "completed" },
    });
    await adoptedTurnIdle;
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
  });

  test("an attached structured turn stays pending after its start response is lost", async () => {
    let hangNextTurn = false;
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-structured",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "structured-lost-response" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-0",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "return a structured review",
      requestId: "structured-lost-response",
      attachments: [],
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    });
    // The dispatch must genuinely be in flight before the child dies. A fixed
    // delay loses that race on a loaded machine — the child exits before
    // turn/start is written, so the turn never becomes ambiguous and `pending`
    // never settles. Wait for the second turn/start (the first materialized the
    // thread), matching the other lost-response tests in this file.
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);

    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "structured-lost-response",
        turnId: "turn-structured",
        duplicate: true,
      },
    });
    await h.drain();

    expect(
      h.events.filter(
        (event) => event.type === "session.structured-output" && event.sessionId === sessionId,
      ),
    ).toEqual([]);
    expect(
      h.events.filter((event) => event.type === "session.error" && event.sessionId === sessionId),
    ).toEqual([]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      requestId: "structured-lost-response",
    });
    expect(h.runtime.getStructuredOutput(sessionId, "structured-lost-response")).toEqual({
      requestId: "structured-lost-response",
      structuredOutput: null,
    });

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-structured",
      item: {
        id: "structured-answer",
        type: "agentMessage",
        text: JSON.stringify({ summary: "Recovered successfully" }),
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-structured", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId, "structured-lost-response")).toMatchObject({
      structuredOutput: {
        ok: true,
        value: { summary: "Recovered successfully" },
      },
    });
  });

  test("events emitted while an ambiguous dispatch reconciles are not lost", async () => {
    /**
     * Regression: the placeholder accumulator installed during reconciliation
     * carries a requestId, which made every event for the *real* turn look like
     * a stale event from an older turn. They were dropped instead of parked, so
     * the transcript lost items and a `turn/completed` landing in this window
     * left the thread reporting `running` forever.
     */
    let hangNextTurn = false;
    const h = await harness({
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      "thread/read": () => {
        const thread = hangNextTurn
          ? threadPayload("thread-1", {
              turns: [
                {
                  id: "turn-live",
                  status: "inProgress",
                  items: [{ type: "userMessage", clientId: "req-1" }],
                },
              ],
            })
          : threadPayload("thread-1");
        // Answer late, so the turn's own events reach the runtime while the
        // reconcile is still open and the placeholder owns the thread.
        return new Promise((resolve) => setTimeout(() => resolve({ thread }), 25));
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);

    // The real turn reports itself while reconciliation is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-live",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "Work done during the ambiguous window",
      },
    });

    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        duplicate: true,
      },
    });
    await h.drain();

    // Adopted, and the parked event was replayed into the transcript.
    expect(phaseToExternalStatus(h.runtime.getStatus(sessionId)!.phase)).toBe("running");
    const messages = await h.runtime.getMessages(sessionId);
    expect(JSON.stringify(messages)).toContain("Work done during the ambiguous window");

    const adoptedTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-live", status: "completed" },
    });
    await adoptedTurnIdle;
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
  });

  test("a recovering thread is failed by the backstop when reconciliation cannot answer", async () => {
    let hangNextTurn = false;
    const h = await harness(
      {
        "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
        // Reconciliation is as broken as the dispatch was.
        "thread/read": () => {
          throw new Error("thread/read unavailable");
        },
      },
      { ambiguousRecoveryTimeoutMs: 20 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    const firstTurnIdle = h.waitForEvent(
      (event) => event.type === "session.idle" && event.sessionId === sessionId,
    );
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await firstTurnIdle;

    hangNextTurn = true;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });
    await h.child().waitForRequest("turn/start", 2);
    h.child().exit(1);
    expect(await pending).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        duplicate: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Unresolvable, but bounded: `recovering` can never be permanent.
    expect(h.runtime.getStatus(sessionId)!.phase).not.toBe("recovering");
    /*
     * Unresolvable is not the same as proven-absent. Nothing here ever showed
     * the write did not land, so the prompt stays on screen; only `rejected`
     * and a reconciled `absent` retract.
     */
    expect(
      (await h.runtime.getMessages(sessionId))!.some((message) => message.content === "second"),
    ).toBe(true);
    expect(h.events.some((event) => typeof event.data?.removedMessageId === "string")).toBe(false);
    hangNextTurn = false;
    expect(
      (
        await h.runtime.prompt(sessionId, {
          prompt: "third",
          requestId: "req-2",
          attachments: [],
        })
      ).ok,
    ).toBe(true);
  });

  test("config for a session with no thread yet is reported durable", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "plan" });

    // Nothing to persist until the thread materializes, so there is no pending
    // write that could be lost — reporting "not durable" would warn about a
    // problem that does not exist.
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({
      mode: "plan",
      durable: true,
    });
    expect(await h.runtime.getConfig("session-does-not-exist")).toBeNull();
  });

  test("a prompt without a request id is rejected before dispatch", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    expect(await h.runtime.prompt(sessionId, { prompt: "no id", attachments: [] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  test("an ambiguous request that did run is reconciled as already-processed", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-9",
              status: "completed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Leave req-1 stuck at `prepared`, exactly as a crash mid-write would.
    await h.runtime.getJournal().markPrepared({
      requestId: "req-1",
      bridgeSessionId: sessionId,
      threadId: "thread-1",
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });

    // thread/read proved it ran, so it must not run a second time.
    expect(outcome).toMatchObject({ ok: true, result: { status: "already-processed" } });
    expect(h.child().requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  });

  test("an ambiguous request that never ran is dispatched exactly once", async () => {
    let turns = 0;
    const h = await harness({
      "turn/start": () => {
        turns += 1;
        return { turn: { id: `turn-${turns}` } };
      },
      // No turn carries req-1, so it provably never executed.
      "thread/read": () => ({ thread: threadPayload("thread-1", { turns: [] }) }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-0", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    await h.runtime.getJournal().markPrepared({
      requestId: "req-1",
      bridgeSessionId: sessionId,
      threadId: "thread-1",
    });
    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true, result: { status: "processing", turnId: "turn-2" } });
    expect(turns).toBe(2);
  });
});

describe("slash commands", () => {
  test("/models lists descriptions and marks the configured model", async () => {
    const h = await harness({
      "model/list": () => ({
        data: [
          {
            id: "model-a",
            displayName: "Model A",
            description: "Fast general-purpose model",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: false,
          },
          {
            id: "model-b",
            displayName: "Model B",
            description: null,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      }),
    });
    const { sessionId } = h.runtime.createSession({
      mode: "build",
      model: "model-a",
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/models",
      requestId: "req-models",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[1]?.content).toContain("- model-a (current): Fast general-purpose model");
    expect(messages?.[1]?.content).toContain("- model-b");
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  test("custom prompt commands are matched case-insensitively and expanded before dispatch", async () => {
    const promptsDir = join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "review.md"),
      [
        "---",
        "description: Review a target",
        "argument_hint: <target>",
        "---",
        "Review $ARGUMENTS and report concrete findings.",
      ].join("\n"),
    );
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/ReViEw src/parser.ts",
      requestId: "req-custom-prompt",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    const turnStart = h.child().requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params.input)).toContain(
      "Review src/parser.ts and report concrete findings.",
    );
    expect(JSON.stringify(turnStart?.params.input)).not.toContain("/ReViEw");
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[0]?.content).toBe("/ReViEw src/parser.ts");
  });

  test("/help is answered locally without reaching Codex", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(0);

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/help",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.child().requests.some((r) => r.method === "turn/start")).toBe(false);
    const messageUpdates = h.events.filter(
      (event) =>
        event.type === "message.updated" &&
        (event.data?.message as { role?: unknown } | undefined)?.role,
    );
    expect(messageUpdates.map((event) => (event.data?.message as { role?: unknown }).role)).toEqual(
      ["user", "assistant"],
    );
    const assistant = messageUpdates[1];
    expect((assistant?.data?.message as { content: string } | undefined)?.content).toContain(
      "Available Codex slash commands",
    );
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.content).toBe("/help");
    expect(messages?.[1]?.content).toContain("Available Codex slash commands");
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(1);
  });

  test("an idle /steer is answered locally instead of starting a model turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/STEER check the failing test",
      requestId: "req-idle-steer",
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages?.[0]?.content).toBe("/STEER check the failing test");
    expect(messages?.[1]?.content).toContain("no active Codex turn to steer");
  });

  test("a structured /steer is rejected and never starts a model turn", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "/steer do not start another turn",
      requestId: "req-structured-steer",
      attachments: [],
      outputSchema: { type: "object" },
    });

    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: "/steer cannot be used with structured output",
    });
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(
      h.runtime.getRegistry().getSession(sessionId)?.structuredOutputRequestId,
    ).toBeUndefined();
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).toEqual([]);
  });

  test("a bare or multiline idle /steer is answered locally without leaking to Codex", async () => {
    for (const [prompt, expectedReply] of [
      ["/steer", "Usage: /steer <instructions>"],
      ["/steer   \n  ", "Usage: /steer <instructions>"],
      ["/steer\ncheck the API\nthen the UI", "no active Codex turn to steer"],
    ] as const) {
      const h = await harness();
      const { sessionId } = h.runtime.createSession({ mode: "build" });

      const outcome = await h.runtime.prompt(sessionId, {
        prompt,
        requestId: `req-${prompt.length}`,
        attachments: [],
      });

      expect(outcome).toMatchObject({ ok: true });
      expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);
      const messages = await h.runtime.getMessages(sessionId);
      expect(messages?.[0]?.content).toBe(prompt);
      expect(messages?.[1]?.content).toContain(expectedReply);
    }
  });

  /**
   * Local replies have no rollout item, so their timestamp is the only ordering
   * key they share with the model's transcript. Concatenating would show them
   * after work that actually happened later.
   */
  test("local replies are interleaved into a materialized transcript by time", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    await h.runtime.prompt(sessionId, { prompt: "/help", requestId: "req-help", attachments: [] });

    clock += 5_000;
    await h.runtime.prompt(sessionId, { prompt: "real work", requestId: "req-1", attachments: [] });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "done" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The /help exchange predates the Codex turn, so it sorts first.
    expect(messages[0]!.content).toBe("/help");
    expect(messages[2]!.content).toBe("real work");
    const timestamps = messages.map((message) => message.createdAt);
    expect([...timestamps].sort()).toEqual(timestamps);
  });

  test("the local transcript is capped rather than growing for the life of the tab", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    const rounds = MAX_LOCAL_MESSAGES; // two entries each, so comfortably over the cap
    for (let round = 0; round < rounds; round += 1) {
      await h.runtime.prompt(sessionId, {
        prompt: "/help",
        requestId: `req-help-${round}`,
        attachments: [],
      });
    }

    const session = h.runtime.getRegistry().getSession(sessionId)!;
    // Nothing else ever evicts these: they survive detaching, and there is no
    // rollout to reload them from.
    expect(session.localMessages).toHaveLength(MAX_LOCAL_MESSAGES);
    expect(session.localMessages.at(-1)!.content).toContain("Available Codex slash commands");
    expect(session.messageRevision).toBe(rounds);
  });
});

describe("interactive approvals", () => {
  /**
   * Creates a session, materializes its thread, then has the scripted child ask
   * for approval — the only way to reach the runtime's mapping code, which needs a
   * real threadId bound to a real bridge session.
   */
  async function withPendingApproval(
    options: {
      approvalParams?: Record<string, unknown>;
      withPendingMessageDelta?: boolean;
    } = {},
  ) {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();

    if (options.withPendingMessageDelta) {
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-before-approval",
        delta: "Before approval",
      });
    }
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9001,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
        ...(options.approvalParams ?? {}),
      },
    });
    await h.drain();

    return { h, sessionId };
  }

  test("emits approval-requested to the owning session and lists it", async () => {
    const { h, sessionId } = await withPendingApproval({
      withPendingMessageDelta: true,
    });

    const requested = h.events.filter((event) => event.type === "session.approval-requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.sessionId).toBe(sessionId);
    expect((requested[0]!.data!.approval as { command?: string }).command).toBe("rm -rf build");
    expect(h.events.findLastIndex((event) => event.type === "message.patched")).toBeLessThan(
      h.events.findIndex((event) => event.type === "session.approval-requested"),
    );

    // The rehydration path: a remounting tab must be able to ask rather than
    // relying on having seen the SSE frame.
    const listed = h.runtime.listApprovals(sessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe("command");
  });

  test("a non-actionable approval cannot be approved, only denied or cancelled", async () => {
    /**
     * The renderer hides Approve for a request the bridge could not describe,
     * but that is presentation only. Anything that can reach the route — a stale
     * tab, another client — must not be able to approve an action no human was
     * ever shown.
     */
    const { h, sessionId } = await withPendingApproval({
      approvalParams: { command: undefined, cwd: undefined },
    });
    const approval = h.runtime.listApprovals(sessionId)[0]!;
    expect(approval.actionable).toBe(false);

    expect(h.runtime.respondToApproval(sessionId, approval.approvalId, "approve")).toBe(
      "not-actionable",
    );
    expect(h.runtime.respondToApproval(sessionId, approval.approvalId, "approve-for-session")).toBe(
      "not-actionable",
    );
    // Still pending: refusing to approve must not silently drop the request.
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);

    expect(h.runtime.respondToApproval(sessionId, approval.approvalId, "deny")).toBe("applied");
  });

  test("approving sends accept to app-server and clears the card", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "approve")).toBe("applied");
    await h.drain();

    // The response is a plain JSON-RPC result, so it shows up as a write rather
    // than a request; assert on the raw stdin instead.
    expect(h.child().stdin.lines.join("")).toContain('"decision":"accept"');
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);

    const resolved = h.events.filter((event) => event.type === "session.approval-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data).toMatchObject({
      approvalId,
      decision: "approve",
      resolution: "answered",
    });
  });

  test("declining sends decline", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    h.runtime.respondToApproval(sessionId, approvalId, "deny");
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
  });

  test("another session cannot answer this one's approval", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    const other = h.runtime.createSession({ mode: "build" });

    // Scoped so one tab cannot authorise a command in another environment's turn.
    expect(h.runtime.respondToApproval(other.sessionId, approvalId, "approve")).toBe(
      "wrong-session",
    );
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
    expect(h.runtime.listApprovals(other.sessionId)).toHaveLength(0);
  });

  test("answering twice reports the second as unknown", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "approve")).toBe("applied");
    await h.drain();
    // A stale card, which is normal over a five-minute window.
    expect(h.runtime.respondToApproval(sessionId, approvalId, "deny")).toBe("unknown");
  });

  test("an unknown approval id is reported, not thrown", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.respondToApproval(sessionId, "apr-nope", "approve")).toBe("unknown");
  });

  test("closing the session withdraws the approval", async () => {
    const { h, sessionId } = await withPendingApproval();
    await h.runtime.deleteSession(sessionId);
    await h.drain();

    // The child is still alive, so it must be answered — otherwise the turn waits
    // forever on a prompt whose UI has gone.
    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
  });

  test("closing one of two tabs leaves the shared approval actionable", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({ threadId: "thread-1", mode: "build" });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9002,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch allowed",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();

    const approvalId = h.runtime.listApprovals(second!.sessionId)[0]!.approvalId;
    await h.runtime.deleteSession(first.sessionId);
    await h.drain();
    expect(h.child().stdin.lines.join("")).not.toContain('"decision":"decline"');
    expect(h.runtime.respondToApproval(second!.sessionId, approvalId, "deny")).toBe("applied");
  });

  test("a tab attached after presentation can take over a pending approval", async () => {
    const { h, sessionId: firstSessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(firstSessionId)[0]!.approvalId;
    const second = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
    });

    expect(h.runtime.listApprovals(second!.sessionId)).toHaveLength(1);
    await h.runtime.deleteSession(firstSessionId);
    expect(h.runtime.respondToApproval(second!.sessionId, approvalId, "deny")).toBe("applied");
  });

  test("cancel approval interrupts the owning turn", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;

    expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
    await h.drain();

    expect(h.child().requests.some((request) => request.method === "turn/interrupt")).toBe(true);
  });

  test("an abort rejection after cancelling an approval is contained and reported", async () => {
    const { h, sessionId } = await withPendingApproval();
    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    const runtime = h.runtime as unknown as {
      abort: (targetSessionId: string) => Promise<unknown>;
    };
    runtime.abort = async () => {
      throw new Error("abort dispatch rejected");
    };

    const errors = await captureConsoleErrors(async (captured) => {
      expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
      await waitUntil(
        () => captured.length > 0,
        "approval cancellation rejection was not reported",
      );
    });

    expect(
      errors.some(
        ([message, error]) =>
          message === "[codex-bridge] Failed to cancel turn after approval response:" &&
          error instanceof Error &&
          error.message === "abort dispatch rejected",
      ),
    ).toBe(true);
  });

  test("a failed interrupt after cancelling an approval surfaces a terminal error", async () => {
    const h = await harness({
      "turn/interrupt": () => {
        throw new Error("interrupt transport failed");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9004,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "touch file",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();

    const approvalId = h.runtime.listApprovals(sessionId)[0]!.approvalId;
    expect(h.runtime.respondToApproval(sessionId, approvalId, "cancel")).toBe("applied");
    await waitUntil(
      () => h.runtime.getStatus(sessionId)?.phase === "failed",
      "failed interrupt did not settle the turn",
    );

    expect(h.runtime.listApprovals(sessionId)).toHaveLength(0);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
    });
  });

  test("v2 file-change approvals are enriched from the active item", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-file",
        type: "fileChange",
        status: "inProgress",
        changes: [{ path: "src/index.ts", kind: { type: "update", move_path: null } }],
      },
    });
    await h.drain();
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9010,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        startedAtMs: 1,
      },
    });
    await h.drain();

    expect(h.runtime.listApprovals(sessionId)[0]).toMatchObject({
      actionable: true,
      changes: [{ path: "src/index.ts", kind: "update" }],
    });
  });

  test("non-terminal errors warn every shared tab without releasing the turn", async () => {
    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const first = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(first.sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });
    const second = await h.runtime.resumeSession({
      threadId: "thread-1",
      mode: "build",
    });
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-before-warning",
      delta: "Before warning",
    });
    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: {
        message: "retry later",
        codexErrorInfo: "usageLimitExceeded",
      },
      willRetry: true,
    });
    await h.drain();

    const warnings = h.events.filter((event) => event.type === "session.warning");
    expect(warnings).toHaveLength(2);
    expect(h.events.findLastIndex((event) => event.type === "message.patched")).toBeLessThan(
      h.events.findIndex((event) => event.type === "session.warning"),
    );
    expect(warnings.map((event) => event.sessionId).sort()).toEqual(
      [first.sessionId, second!.sessionId].sort(),
    );
    for (const warning of warnings) {
      expect(warning.data).toEqual({
        error: "retry later",
        code: "usageLimitExceeded",
        willRetry: true,
      });
    }
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.runtime.getStatus(first.sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
    expect(h.runtime.getStatus(second!.sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
  });

  test("a non-retrying standalone error remains a warning while the turn is live", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });

    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: {
        message: "context window exceeded",
        codexErrorInfo: { contextWindowExceeded: {} },
      },
      willRetry: false,
    });
    await h.drain();

    expect(
      h.events.filter((event) => event.type === "session.warning" && event.sessionId === sessionId),
    ).toEqual([
      {
        type: "session.warning",
        sessionId,
        data: {
          error: "context window exceeded",
          code: "contextWindowExceeded",
          willRetry: false,
        },
      },
    ]);
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
      requestId: "req-1",
    });
  });

  test("a warning is followed by a terminal error when turn completion fails", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-1",
      attachments: [],
    });

    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: { message: "temporary provider failure", codexErrorInfo: null },
      willRetry: true,
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
    });
    expect(h.events.filter((event) => event.type === "session.error")).toEqual([]);

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: {
          message: "provider retries exhausted",
          codexErrorInfo: "streamDisconnected",
        },
      },
    });
    await h.drain();

    expect(
      h.events
        .filter(
          (event) =>
            event.sessionId === sessionId &&
            (event.type === "session.warning" || event.type === "session.error"),
        )
        .map((event) => ({ type: event.type, data: event.data })),
    ).toEqual([
      {
        type: "session.warning",
        data: {
          error: "temporary provider failure",
          code: undefined,
          willRetry: true,
        },
      },
      {
        type: "session.error",
        data: { error: "provider retries exhausted" },
      },
    ]);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: "provider retries exhausted",
    });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "failed",
    });
  });

  test("a file-change approval is described as such", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();

    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9002,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        startedAtMs: 1,
        reason: "write outside the workspace",
      },
    });
    await h.drain();

    const approval = h.runtime.listApprovals(sessionId)[0]!;
    expect(approval.kind).toBe("file-change");
    expect(approval.reason).toBe("write outside the workspace");
    // The v2 method carries no changes; the UI reads them off the item it holds.
    expect(approval.changes).toBeUndefined();
  });

  test("an approval for an unknown thread falls back to auto-decline", async () => {
    const h = await harness();

    // No bridge session is bound to this thread, so there is no card to click and
    // parking it would leave the turn waiting on nobody.
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9003,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-unbound", turnId: "turn-x", itemId: "item-x", startedAtMs: 1 },
    });
    await h.drain();

    expect(h.child().stdin.lines.join("")).toContain('"decision":"decline"');
    expect(h.events.some((event) => event.type === "session.approval-requested")).toBe(false);
  });
});

describe("steering", () => {
  test("reports not-found without a session or a thread", async () => {
    const h = await harness();
    expect(await h.runtime.steerSession("session-nope", "more", "turn-1", "req-steer")).toBe(
      "not-found",
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe(
      "not-found",
    );
  });

  test("reports idle when no turn is running", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe("idle");
  });

  test("steers the active turn, pinning the turn id the user was looking at", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    expect(
      await h.runtime.steerSession(sessionId, "also check the tests", "turn-1", "req-steer"),
    ).toBe("accepted");
    expect(
      h.child().requests.find((request) => request.method === "turn/steer")?.params,
    ).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "also check the tests" }],
      clientUserMessageId: "req-steer",
    });

    const messages = await h.runtime.getMessages(sessionId);
    expect(
      messages
        ?.filter((message) => message.role === "user")
        .map((message) => ({
          content: message.content,
          turnId: message.turnId,
        })),
    ).toEqual([
      { content: "go", turnId: "turn-1" },
      { content: "also check the tests", turnId: "turn-1" },
    ]);
    expect(
      h.events.some(
        (event) =>
          event.type === "message.updated" &&
          (event.data?.message as { content?: unknown } | undefined)?.content ===
            "also check the tests",
      ),
    ).toBe(true);
  });

  test("places a steer between the assistant activity before and after it", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "before", type: "agentMessage", text: "Initial finding" },
    });
    await h.drain();

    expect(
      await h.runtime.steerSession(
        sessionId,
        "also inspect the tests",
        "turn-1",
        "req-steer-order",
      ),
    ).toBe("accepted");

    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "after-tool",
        type: "commandExecution",
        command: "bun test",
        status: "inProgress",
        aggregatedOutput: null,
      },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "after-text", type: "agentMessage", text: "Tests are green" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "investigate"],
      ["assistant", "Initial finding"],
      ["user", "also inspect the tests"],
      ["assistant", "Tests are green"],
    ]);
    expect(messages[1]?.parts).toEqual([{ type: "text", content: "Initial finding" }]);
    expect(messages[3]?.parts.map((part) => part.type)).toEqual(["tool-invocation", "text"]);
  });

  /**
   * `turn/steer` + `thread/read` answering the way app-server does around a
   * live steer.
   *
   * The read is stateful on purpose: a steer's client id only appears in the
   * turn once app-server has accepted it. A handler that returned it up front
   * would satisfy the pre-dispatch idempotency read instead, which reports the
   * steer as already applied by an earlier runtime and never appends it.
   *
   * `items` receives the client ids accepted so far and returns the persisted
   * item list in wire order.
   */
  function steerScript(
    items: (accepted: readonly string[]) => Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Record<string, (params: Record<string, unknown>) => unknown> {
    const accepted: string[] = [];
    return {
      "turn/steer": (params) => {
        const clientId = params.clientUserMessageId;
        if (typeof clientId === "string") accepted.push(clientId);
        return { turnId: "turn-1" };
      },
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              itemsView: "full",
              items: items(accepted),
              ...extra,
            },
          ],
        }),
      }),
    };
  }

  test("keeps updating an item that started in the assistant row before a steer", async () => {
    const h = await harness(
      steerScript((accepted) => [
        { type: "userMessage", clientId: "req-original" },
        // app-server ordered the running command before the steering message, so
        // the pre-steer row owns it and must keep receiving its completion.
        { id: "long-command", type: "commandExecution" },
        ...accepted.map((clientId) => ({ type: "userMessage", clientId })),
      ]),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "long-command",
        type: "commandExecution",
        command: "bun test",
        status: "inProgress",
        aggregatedOutput: null,
      },
    });
    await h.drain();

    expect(
      await h.runtime.steerSession(
        sessionId,
        "also inspect the tests",
        "turn-1",
        "req-steer-running-item",
      ),
    ).toBe("accepted");

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "long-command",
        type: "commandExecution",
        command: "bun test",
        status: "completed",
        aggregatedOutput: "all green",
      },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1]?.parts[0]).toMatchObject({
      type: "tool-invocation",
      toolState: "success",
      toolOutput: "all green",
    });
    expect(messages[3]?.parts).toEqual([]);
  });

  test("splits the turn at the item app-server ordered after the steer", async () => {
    const h = await harness(
      steerScript((accepted) => [
        { type: "userMessage", clientId: "req-original" },
        { id: "above", type: "agentMessage" },
        ...accepted.flatMap((clientId) => [
          { type: "userMessage", clientId },
          { id: "below", type: "agentMessage" },
        ]),
      ]),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    // Both items are already live when the steer is appended, so only the
    // authoritative ordering can say which row each one belongs to.
    for (const [id, text] of [
      ["above", "before the steer"],
      ["below", "after the steer"],
    ]) {
      h.child().notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id, type: "agentMessage", text },
      });
    }
    await h.drain();

    expect(await h.runtime.steerSession(sessionId, "narrow it down", "turn-1", "req-split")).toBe(
      "accepted",
    );
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "investigate"],
      ["assistant", "before the steer"],
      ["user", "narrow it down"],
      ["assistant", "after the steer"],
    ]);
  });

  test("keeps a streaming item above the steer when app-server has not persisted it", async () => {
    // The regression: `thread/read` only projects persisted items, so an item
    // still streaming is absent from the prefix. Treating that absence as proof
    // it came after emptied the pre-steer row and pushed the whole in-flight
    // response below the user's own steering message.
    const h = await harness(
      steerScript((accepted) => [
        { type: "userMessage", clientId: "req-original" },
        ...accepted.map((clientId) => ({ type: "userMessage", clientId })),
      ]),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "streaming",
      delta: "half a thought",
    });
    await h.drain();

    expect(
      await h.runtime.steerSession(sessionId, "actually, stop", "turn-1", "req-steer-streaming"),
    ).toBe("accepted");
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "investigate"],
      ["assistant", "half a thought"],
      ["user", "actually, stop"],
      ["assistant", ""],
    ]);
  });

  test("tolerates a partial itemsView that elides the items before the steer", async () => {
    // A `summary` view drops the prefix but cannot invent a suffix, so the
    // items it does name after the steer are still trustworthy.
    const h = await harness(
      steerScript(
        (accepted) =>
          accepted.flatMap((clientId) => [
            { type: "userMessage", clientId },
            { id: "below", type: "agentMessage" },
          ]),
        { itemsView: "summary" },
      ),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    for (const [id, text] of [
      ["above", "elided by the summary"],
      ["below", "named"],
    ]) {
      h.child().notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id, type: "agentMessage", text },
      });
    }
    await h.drain();

    expect(
      await h.runtime.steerSession(sessionId, "narrow it down", "turn-1", "req-truncated"),
    ).toBe("accepted");
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "investigate"],
      ["assistant", "elided by the summary"],
      ["user", "narrow it down"],
      ["assistant", "named"],
    ]);
  });

  test("falls back to the live boundary when the ordering read fails", async () => {
    const h = await harness({
      "turn/steer": () => ({ turnId: "turn-1" }),
      "thread/read": (() => {
        let calls = 0;
        return () => {
          calls += 1;
          // The pre-dispatch idempotency read must succeed; only the ordering
          // read that follows the accepted steer fails.
          if (calls === 1) return { thread: threadPayload("thread-1", { turns: [] }) };
          throw new Error("thread/read unavailable");
        };
      })(),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "above", type: "agentMessage", text: "before the steer" },
    });
    await h.drain();

    expect(await h.runtime.steerSession(sessionId, "carry on", "turn-1", "req-read-fails")).toBe(
      "accepted",
    );
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "investigate"],
      ["assistant", "before the steer"],
      ["user", "carry on"],
      ["assistant", ""],
    ]);
  });

  test("keeps three assistant rows straight across two steers in one turn", async () => {
    const laterItems = ["second", "third"];
    const h = await harness(
      steerScript((accepted) => [
        { type: "userMessage", clientId: "req-original" },
        { id: "first", type: "agentMessage" },
        ...accepted.flatMap((clientId, index) => [
          { type: "userMessage", clientId },
          { id: laterItems[index]!, type: "agentMessage" },
        ]),
      ]),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    const complete = async (id: string, text: string) => {
      h.child().notify("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id, type: "agentMessage", text },
      });
      await h.drain();
    };

    await complete("first", "one");
    expect(await h.runtime.steerSession(sessionId, "again", "turn-1", "req-steer-1")).toBe(
      "accepted",
    );
    await complete("second", "two");
    expect(await h.runtime.steerSession(sessionId, "once more", "turn-1", "req-steer-2")).toBe(
      "accepted",
    );
    await complete("third", "three");

    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "investigate"],
      ["assistant", "one"],
      ["user", "again"],
      ["assistant", "two"],
      ["user", "once more"],
      ["assistant", "three"],
    ]);

    // A reroute reported for the turn owns every row it produced, not just the
    // one still streaming.
    h.child().notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-start",
      toModel: "gpt-rerouted",
    });
    await h.drain();

    expect(
      (await h.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "assistant")
        .map((message) => message.modelId),
    ).toEqual(["gpt-rerouted", "gpt-rerouted", "gpt-rerouted"]);
  });

  test("re-renders a frozen row when one of its own items completes late", async () => {
    // The frozen row is skipped while nothing in it moves, so the skip must be
    // keyed on "changed since the last render", not "can still change".
    const h = await harness(
      steerScript((accepted) => [
        { type: "userMessage", clientId: "req-original" },
        { id: "slow", type: "agentMessage" },
        ...accepted.map((clientId) => ({ type: "userMessage", clientId })),
      ]),
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "investigate",
      requestId: "req-original",
      attachments: [],
    });
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "slow",
      delta: "partial",
    });
    await h.drain();
    expect(await h.runtime.steerSession(sessionId, "keep going", "turn-1", "req-steer-late")).toBe(
      "accepted",
    );
    await h.drain();

    // Everything in the frozen row has settled; a further publish must be a
    // no-op for it rather than a re-render.
    const settled = (await h.runtime.getMessages(sessionId))![1]!.revision;
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "live",
      delta: "new row",
    });
    await h.drain();
    expect((await h.runtime.getMessages(sessionId))![1]!.revision).toBe(settled);

    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "slow", type: "agentMessage", text: "partial and then complete" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]?.content).toBe("partial and then complete");
    expect(messages[1]?.revision).toBeGreaterThan(settled!);
    expect(messages[3]?.content).toBe("new row");
  });

  test("rejects a stale renderer turn before calling app-server", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-stale",
      attachments: [],
    });

    expect(await h.runtime.steerSession(sessionId, "more", "turn-old", "req-steer")).toBe(
      "mismatch",
    );
    expect(h.child().requests.some((request) => request.method === "turn/steer")).toBe(false);
  });

  test("an explicit app-server expected-turn rejection is a definite mismatch", async () => {
    const h = await harness({
      "turn/steer": () => {
        throw new Error("expectedTurnId does not match");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-explicit",
      attachments: [],
    });

    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe("mismatch");
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
  });

  test("ambiguous steering failures never claim the text was unsent", async () => {
    const h = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-steer-ambiguous",
      attachments: [],
    });

    for (const error of [
      new AppServerTimeoutError("turn/steer", 100),
      new AppServerProcessExitError("child exited", {
        generation: h.engine.info().generation,
        method: "turn/steer",
      }),
      new Error("transport is closed"),
    ]) {
      h.engine.steerTurn = async () => {
        throw error;
      };
      expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe(
        "unknown",
      );
    }

    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
    expect(
      (await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  test("an ambiguous steer retry reconciles its client id instead of dispatching twice", async () => {
    let steerCalls = 0;
    let steerAttempted = false;
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [
                { type: "userMessage", clientId: "req-original" },
                ...(steerAttempted
                  ? [
                      { type: "userMessage", clientId: "req-steer-retry" },
                      { id: "after-steer", type: "agentMessage", text: "after steer" },
                    ]
                  : []),
              ],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-original",
      attachments: [],
    });
    h.engine.steerTurn = async () => {
      steerCalls += 1;
      steerAttempted = true;
      throw new AppServerTimeoutError("turn/steer", 100);
    };

    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry")).toBe(
      "unknown",
    );
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "after-steer", type: "agentMessage", text: "after steer" },
    });
    await h.drain();
    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry")).toBe(
      "accepted",
    );
    expect(steerCalls).toBe(1);
    expect(
      (await h.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["go", "more"]);
    expect(
      (await h.runtime.getMessages(sessionId))?.map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "go"],
      ["assistant", ""],
      ["user", "more"],
      ["assistant", "after steer"],
    ]);

    // A third delivery of the same logical request is served from the bounded
    // accepted cache and cannot append or dispatch it again.
    expect(await h.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-retry")).toBe(
      "accepted",
    );
    expect(steerCalls).toBe(1);
    expect(
      (await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });

  test("a fresh runtime reconciles a retained steer request id before dispatch", async () => {
    const first = await harness();
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    await first.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-original",
      attachments: [],
    });
    first.engine.steerTurn = async () => {
      throw new AppServerTimeoutError("turn/steer", 100);
    };
    expect(await first.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-restart")).toBe(
      "unknown",
    );

    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-1.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/tmp/ws" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "go" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "more" }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
      "utf8",
    );
    await first.runtime.stop();

    const second = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [
                { type: "userMessage", clientId: "req-original" },
                { type: "userMessage", clientId: "req-steer-restart" },
              ],
            },
          ],
        }),
      }),
    });
    second.child().requests.length = 0;

    expect(
      await second.runtime.steerSession(sessionId, "more", "turn-1", "req-steer-restart"),
    ).toBe("accepted");
    expect(second.child().requests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(
      (await second.runtime.getMessages(sessionId))
        ?.filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["go", "more"]);
  });

  /**
   * `cancelling` reports `running`, so a steer arriving in the interrupt window
   * is offered to app-server rather than refused as idle: only the child knows
   * whether the turn is still accepting input. It must never be reported as
   * accepted on a guess — a turn that has already been interrupted rejects, and
   * that is a mismatch.
   */
  test("a steer during cancelling is decided by the engine, never assumed", async () => {
    const accepting = await harness({ "turn/steer": () => ({ turnId: "turn-1" }) });
    const { sessionId } = accepting.runtime.createSession({ mode: "build" });
    await accepting.runtime.prompt(sessionId, {
      prompt: "go",
      requestId: "req-cancelling-1",
      attachments: [],
    });
    await accepting.runtime.abort(sessionId);
    expect(accepting.runtime.getStatus(sessionId)).toMatchObject({ phase: "cancelling" });

    expect(await accepting.runtime.steerSession(sessionId, "more", "turn-1", "req-steer")).toBe(
      "accepted",
    );
    // The steer is pinned to the turn the user was looking at, interrupt or not.
    expect(
      accepting.child().requests.find((request) => request.method === "turn/steer")?.params,
    ).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });

    const rejecting = await harness({
      "turn/steer": () => {
        throw new Error("turn is no longer accepting input");
      },
    });
    const { sessionId: rejectedId } = rejecting.runtime.createSession({ mode: "build" });
    await rejecting.runtime.prompt(rejectedId, {
      prompt: "go",
      requestId: "req-cancelling-2",
      attachments: [],
    });
    await rejecting.runtime.abort(rejectedId);

    expect(await rejecting.runtime.steerSession(rejectedId, "more", "turn-1", "req-steer")).toBe(
      "mismatch",
    );
    // Still cancelling: a refused steer neither completes nor resurrects the turn.
    expect(rejecting.runtime.getStatus(rejectedId)).toMatchObject({
      status: "running",
      phase: "cancelling",
    });
  });
});
