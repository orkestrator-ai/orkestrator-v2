import { describe, expect, test } from "bun:test";
import { AppServerRuntime, DEFAULT_THREAD_IDLE_MS, MAX_RECOVERED_CONTEXT_CHARS } from "./app-server-runtime.js";
import type { EngineEvent } from "./engine/types.js";
import { getTranscriptCatalogInvalidationCountForTesting } from "./history/rollout.js";
import { DispatchJournal } from "./sessions/dispatch-journal.js";
import { BRIDGE_SESSION_REGISTRY_VERSION, BridgeSessionStore, hashCwd } from "./sessions/persistence.js";
import { phaseToExternalStatus } from "./sessions/thread-registry.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  NO_RESPONSE,
  captureConsoleErrors,
  codexHome,
  harness,
  threadPayload,
  waitUntil,
} from "./app-server-runtime-test-harness.js";
import type { Harness } from "./app-server-runtime-test-harness.js";


describe("session lifecycle", () => {
  test("concurrent start callers share initialization and wait for it to finish", async () => {
    const h = await harness({}, { deferStart: true });
    const originalStart = h.engine.start.bind(h.engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let starts = 0;
    h.engine.start = async () => {
      starts += 1;
      signalEntered();
      await gate;
      return originalStart();
    };

    const first = h.runtime.start();
    const second = h.runtime.start();
    await entered;
    expect(starts).toBe(1);

    release();
    await Promise.all([first, second]);
    await h.runtime.start();
    expect(h.children).toHaveLength(1);
    expect(h.child().requests.filter((request) => request.method === "initialize")).toHaveLength(1);
  });

  test("a failed start can be retried", async () => {
    const h = await harness({}, { deferStart: true });
    const originalStart = h.engine.start.bind(h.engine);
    let attempts = 0;
    h.engine.start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient startup failure");
      return originalStart();
    };

    await expect(h.runtime.start()).rejects.toThrow("transient startup failure");
    await h.runtime.start();

    expect(attempts).toBe(2);
    expect(h.engine.getHealth().state).toBe("ready");
  });

  test("restores durable bridge session ids lazily after a runtime restart", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-restored",
        threadId: "thread-restored",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Restored",
        titleSource: "explicit",
        lastAcceptedRequestId: "req-old",
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-restored") }),
    });

    expect(h.runtime.getStatus("session-restored")).toMatchObject({
      status: "idle",
      threadId: "thread-restored",
      title: "Restored",
    });
    expect(h.child().requests.some((request) => request.method === "thread/resume")).toBe(false);

    expect(await h.runtime.getMessages("session-restored")).toEqual([]);
    expect(h.child().requests.some((request) => request.method === "thread/resume")).toBe(true);
  });

  test("resume without a thread id is rejected rather than creating a session", async () => {
    const h = await harness();
    expect(await h.runtime.resumeSession({ threadId: "   ", mode: "build" })).toBeNull();
    expect(await h.runtime.resumeSession({ mode: "build" })).toBeNull();
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(0);
  });

  test("resuming a thread whose rollout is gone falls back to the parser", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-gone.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-gone",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Remember the parser constraint" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will preserve it." }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-gone");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });

    // The user still sees the conversation; the next prompt starts a fresh thread
    // with reconstructed context.
    const resumed = await h.runtime.resumeSession({ threadId: "thread-gone", mode: "build" });
    expect(resumed).toMatchObject({ threadId: "thread-gone" });
    expect(resumed!.messages.map((message) => message.content)).toEqual([
      "Remember the parser constraint",
      "I will preserve it.",
    ]);
    expect(h.runtime.getStatus(resumed!.sessionId)?.messageRevision).toBe(1);
    expect(h.runtime.getRegistry().getSession(resumed!.sessionId)?.threadId).toBeNull();
    expect((await h.runtime.getMessages(resumed!.sessionId))!.map((message) => message.content))
      .toEqual(["Remember the parser constraint", "I will preserve it."]);

    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "Continue now",
      requestId: "req-recovered",
      attachments: [],
    });
    const turnStart = h.child().requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(turnStart?.params.input)).toContain("Remember the parser constraint");
    expect(JSON.stringify(turnStart?.params.input)).toContain("Continue now");
  });

  test("recovered rollout context is sent once, even when its dispatch was ambiguous", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-ambiguous.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-ambiguous",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Earlier recovered turn" }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    let hangNextTurn = false;
    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-ambiguous");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
      "turn/start": () => (hangNextTurn ? NO_RESPONSE : { turn: { id: "turn-1" } }),
      // The ambiguous dispatch really did run, carrying the recovered context.
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-live",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-ambiguous" }],
            },
          ],
        }),
      }),
    });

    const invalidationsBeforeResume =
      getTranscriptCatalogInvalidationCountForTesting();
    const resumed = await h.runtime.resumeSession({
      threadId: "thread-ambiguous",
      mode: "build",
    });
    expect(getTranscriptCatalogInvalidationCountForTesting())
      .toBe(invalidationsBeforeResume + 1);
    hangNextTurn = true;
    const pending = h.runtime.prompt(resumed!.sessionId, {
      prompt: "first after recovery",
      requestId: "req-ambiguous",
      attachments: [],
    });
    // The dispatch must be genuinely in flight before the child dies — that is
    // what makes it ambiguous. Waiting for the request rather than sleeping keeps
    // this deterministic; a fixed delay loses the race on a loaded machine and
    // the turn never becomes ambiguous, so the prompt below never settles.
    await h.child().waitForRequest("turn/start");
    h.child().exit(1);
    await pending;
    await h.drain();

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-live", status: "completed" },
    });
    await h.drain();

    hangNextTurn = false;
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "second after recovery",
      requestId: "req-next",
      attachments: [],
    });

    // Across children: the ambiguous dispatch went to the child that then died.
    const starts = h.children
      .flatMap((child) => child.requests)
      .filter((request) => request.method === "turn/start");
    const carrying = starts.filter((request) =>
      JSON.stringify(request.params.input).includes("recovered_conversation"),
    );
    // Exactly one turn carries the transcript: the one that already ran.
    expect(carrying).toHaveLength(1);
    expect(JSON.stringify(starts.at(-1)?.params.input)).not.toContain("recovered_conversation");
  });

  test("recovered context keeps every assistant segment of a multi-step turn", async () => {
    // Hydration folds a whole turn into one assistant message whose `content` is
    // only the *last* agent text; the earlier segments live in `parts`. The
    // recovered transcript must read the parts, or a turn that reasoned across
    // several messages is replayed to the model as its closing line alone.
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-multi.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { id: "thread-multi", cwd: "/tmp/ws", timestamp: "2026-07-25T12:00:00.000Z" },
        },
        { type: "turn_context", payload: { turn_id: "turn-1", cwd: "/tmp/ws" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Investigate the failure" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "First I checked the logs." }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The cache key was stale." }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-multi");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });
    const resumed = await h.runtime.resumeSession({ threadId: "thread-multi", mode: "build" });
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "continue",
      requestId: "req-multi",
      attachments: [],
    });

    const start = h.child().requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params.input);
    expect(input).toContain("Investigate the failure");
    expect(input).toContain("First I checked the logs.");
    expect(input).toContain("The cache key was stale.");
  });

  test("recovered context is bounded before it is sent", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const huge = "y".repeat(MAX_RECOVERED_CONTEXT_CHARS * 2);
    writeFileSync(
      join(sessionsDir, "thread-huge.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-huge",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: huge }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const h = await harness({
      "thread/resume": () => {
        const error = new Error("thread/resume: no rollout found for thread id thread-huge");
        (error as { rpcCode?: number }).rpcCode = -32600;
        throw error;
      },
    });
    const resumed = await h.runtime.resumeSession({ threadId: "thread-huge", mode: "build" });
    await h.runtime.prompt(resumed!.sessionId, {
      prompt: "continue",
      requestId: "req-huge",
      attachments: [],
    });

    const start = h.child().requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params.input);
    expect(input).toContain("earlier recovered context omitted");
    // A runaway rollout must not be able to dominate the turn.
    expect(input.length).toBeLessThan(MAX_RECOVERED_CONTEXT_CHARS * 2);
  });

  test("restores unresolved accepted work as running before serving status", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-recovering",
        threadId: "thread-recovering",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Recovering",
        titleSource: "prompt",
        lastAcceptedRequestId: "req-live",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-live",
      bridgeSessionId: "session-recovering",
      threadId: "thread-recovering",
    });
    await journal.markAccepted("req-live", {
      threadId: "thread-recovering",
      turnId: "turn-live",
    });

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-recovering") }),
      "thread/read": () => ({
        thread: threadPayload("thread-recovering", {
          turns: [
            {
              id: "turn-live",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-live" }],
            },
          ],
        }),
      }),
    });

    expect(h.runtime.getStatus("session-recovering")).toMatchObject({
      status: "running",
      phase: "running",
      requestId: "req-live",
      turnId: "turn-live",
    });
    expect(await h.runtime.prompt("session-recovering", {
      prompt: "must wait",
      requestId: "req-new",
      attachments: [],
    })).toMatchObject({ ok: false, status: 409 });
  });

  test("a restored dispatch announces its assistant row before patching it", async () => {
    // Updates to a streaming row are sparse patches keyed by message id. A row
    // created during startup recovery is the one the client has no snapshot of,
    // so a patch it cannot apply forces a whole-transcript refetch.
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-announce",
        threadId: "thread-announce",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Announce",
        titleSource: "prompt",
        lastAcceptedRequestId: "req-restored",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-restored",
      bridgeSessionId: "session-announce",
      threadId: "thread-announce",
    });
    await journal.markAccepted("req-restored", {
      threadId: "thread-announce",
      turnId: "turn-restored",
    });

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-announce") }),
      "thread/read": () => ({
        thread: threadPayload("thread-announce", {
          turns: [{
            id: "turn-restored",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "req-restored" }],
          }],
        }),
      }),
    });
    await h.drain();

    const restored = (await h.runtime.getMessages("session-announce"))!.at(-1)!;
    expect(restored.role).toBe("assistant");
    const announced = h.events.filter((event) =>
      event.type === "message.updated"
      && (event.data?.message as { id?: string } | undefined)?.id === restored.id
    );
    expect(announced.length).toBeGreaterThan(0);

    h.child().notify("item/completed", {
      threadId: "thread-announce",
      turnId: "turn-restored",
      item: { id: "restored-item", type: "agentMessage", text: "recovered answer" },
    });
    await h.drain();

    // Every later frame for this row may be a patch, now that the client has a
    // snapshot to apply one to.
    expect((await h.runtime.getMessages("session-announce"))?.at(-1))
      .toMatchObject({ id: restored.id, content: "recovered answer" });
  });

  test("an unresolved record with no thread is spent, not replayed", async () => {
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    // `markPrepared` with no thread: the write may have had side effects, but
    // there is no address at which anything could still be executing.
    await journal.markPrepared({
      requestId: "req-orphan",
      bridgeSessionId: "session-gone",
    });

    const h = await harness();
    const recovered = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await recovered.load();

    expect(recovered.unresolved().some((record) => record.requestId === "req-orphan"))
      .toBe(false);
    expect(recovered.classify("req-orphan").action).toBe("already-done");
    expect(h.child().requests.some((request) => request.method === "turn/start"))
      .toBe(false);
  });

  test("the highest sequence per thread is recovered when timestamps tie", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-multi",
        threadId: "thread-multi",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Multi",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({
      codexHome,
      cwd: "/tmp/ws",
      now: () => Date.parse("2026-08-05T12:00:00.000Z"),
    });
    await journal.load();
    for (const requestId of ["req-old", "req-new"]) {
      await journal.markPrepared({
        requestId,
        bridgeSessionId: "session-multi",
        threadId: "thread-multi",
      });
      await journal.markAccepted(requestId, {
        threadId: "thread-multi",
        turnId: `turn-${requestId}`,
      });
    }

    await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-multi") }),
      "thread/read": () => ({
        thread: threadPayload("thread-multi", {
          turns: [
            {
              id: "turn-req-new",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-new" }],
            },
          ],
        }),
      }),
    });

    const recovered = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await recovered.load();
    expect(recovered.unresolved().map((record) => record.requestId)).not.toContain("req-old");
    expect(recovered.classify("req-old").action).toBe("already-done");
  });

  test("a thread that cannot be re-attached during recovery stays guarded and escalates", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-stuck",
        threadId: "thread-stuck",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Stuck",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-stuck",
      bridgeSessionId: "session-stuck",
      threadId: "thread-stuck",
    });
    await journal.markAccepted("req-stuck", {
      threadId: "thread-stuck",
      turnId: "turn-stuck",
    });

    let resumeFailures = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeFailures += 1;
          throw new Error("temporary transport failure");
        },
      },
      { ambiguousRecoveryTimeoutMs: 10 },
    );

    expect(resumeFailures).toBeGreaterThan(0);
    // Never idle: the turn may still be executing on the old child.
    expect(h.runtime.getStatus("session-stuck")).toMatchObject({
      status: "running",
      phase: "recovering",
    });
    // The backstop is armed, so this cannot be a permanent state.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.children.length).toBeGreaterThan(1);
  });

  test("a failed escalation restart keeps the guard and re-arms the backstop", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-norestart",
        threadId: "thread-norestart",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "No restart",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-norestart",
      bridgeSessionId: "session-norestart",
      threadId: "thread-norestart",
    });
    await journal.markAccepted("req-norestart", {
      threadId: "thread-norestart",
      turnId: "turn-norestart",
    });

    const h = await harness(
      {
        "thread/resume": () => {
          throw new Error("temporary transport failure");
        },
      },
      { ambiguousRecoveryTimeoutMs: 10, deferStart: true },
    );
    let restartAttempts = 0;
    const supervisor = h.engine.getSupervisor();
    const realRestart = supervisor.restartNow.bind(supervisor);
    supervisor.restartNow = async () => {
      restartAttempts += 1;
      throw new Error("circuit breaker open");
    };
    await h.runtime.start();

    // Escalation keeps failing, so the thread must stay guarded and keep trying
    // rather than sit in `recovering` with no timer left to move it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(restartAttempts).toBeGreaterThan(1);
    expect(h.runtime.getStatus("session-norestart")).toMatchObject({
      status: "running",
      phase: "recovering",
    });
    expect(h.events.some(
      (event) =>
        event.type === "session.error"
        && event.data?.error === "circuit breaker open",
    )).toBe(true);

    supervisor.restartNow = realRestart;
  });

  test("status reports recovering, not idle, while startup recovery is still running", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-slow",
        threadId: "thread-slow",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Slow",
        titleSource: "prompt",
      }),
    );
    const journal = new DispatchJournal({ codexHome, cwd: "/tmp/ws" });
    await journal.load();
    await journal.markPrepared({
      requestId: "req-slow",
      bridgeSessionId: "session-slow",
      threadId: "thread-slow",
    });
    await journal.markAccepted("req-slow", {
      threadId: "thread-slow",
      turnId: "turn-slow",
    });

    const h = await harness(
      // Never answers, so recovery is still in flight while we observe status.
      { "thread/resume": () => NO_RESPONSE },
      { deferStart: true },
    );
    const started = h.runtime.start();
    await waitUntil(
      () => h.children.length === 1
        && h.child().requests.some((request) => request.method === "thread/resume"),
      "startup recovery did not reach thread/resume",
    );

    // `idle` here would let the build pipeline advance on a turn that may still
    // be executing.
    expect(h.runtime.getStatus("session-slow")).toMatchObject({
      status: "running",
      phase: "recovering",
    });

    h.children.at(-1)?.exit(1);
    await started.catch(() => undefined);
  });

  test("resuming rethrows an ambiguous failure instead of forking a thread", async () => {
    const h = await harness({
      "thread/resume": () => {
        throw new Error("temporary transport failure");
      },
    });

    // Falling back here would rebuild the conversation in a *new* thread while the
    // original is merely unreachable.
    await expect(
      h.runtime.resumeSession({ threadId: "thread-1", mode: "build" }),
    ).rejects.toThrow("temporary transport failure");
  });

  test("re-attaching hydrates the transcript and adopts the Codex thread name", async () => {
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "thread-named.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            id: "thread-named",
            cwd: "/tmp/ws",
            timestamp: "2026-07-25T12:00:00.000Z",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "persisted-tool",
            arguments: JSON.stringify({ cmd: "git status --short" }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "persisted-tool",
            output: "clean",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Persisted answer" }],
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-named",
        threadId: "thread-named",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-named", { name: "Codex Name" }) }),
    });

    const messages = await h.runtime.getMessages("session-named");
    expect(messages?.map((message) => message.content)).toEqual(["Persisted answer"]);
    expect(messages?.[0]?.parts).toEqual([
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "exec_command",
        // A persisted function_call records no outcome, so none is claimed.
        toolState: undefined,
        toolOutput: "clean",
      }),
      { type: "text", content: "Persisted answer" },
    ]);
    expect(h.runtime.getStatus("session-named")?.messageRevision).toBe(1);
    // app-server's own name outranks anything reconstructed from the rollout.
    expect(h.runtime.getStatus("session-named")).toMatchObject({ title: "Codex Name" });
    expect(h.runtime.getRegistry().getSession("session-named")?.titleSource).toBe("codex");
  });

  test("re-attaching an unnamed thread leaves the title to the rollout", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-unnamed",
        threadId: "thread-unnamed",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    const h = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-unnamed") }),
    });

    expect(await h.runtime.getMessages("session-unnamed")).toEqual([]);
    const session = h.runtime.getRegistry().getSession("session-unnamed")!;
    expect(session.title).toBeUndefined();
    expect(session.titleSource).toBeUndefined();
  });

  test("create does not materialize a Codex thread", async () => {
    const h = await harness();
    const created = h.runtime.createSession({ mode: "build" });

    expect(created.sessionId).toMatch(/^session-/);
    // An abandoned session must not appear in the resume dialog.
    expect(h.child().requests.some((r) => r.method === "thread/start")).toBe(false);
    expect(h.runtime.getStatus(created.sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
      threadId: null,
    });
  });

  test("create is idempotent for one stable client tab key", async () => {
    let clock = 1_000;
    const h = await harness({}, { now: () => clock });
    const first = h.runtime.createSession({
      mode: "build",
      clientSessionKey: "env-1:tab-1",
      title: "First writer",
    });
    const createdAt = h.runtime.getRegistry().getSession(first.sessionId)!.createdAt;
    clock = 2_000;
    const duplicate = h.runtime.createSession({
      mode: "plan",
      clientSessionKey: "env-1:tab-1",
      title: "Racing writer",
    });
    const otherTab = h.runtime.createSession({
      mode: "build",
      clientSessionKey: "env-1:tab-2",
    });

    expect(duplicate.sessionId).toBe(first.sessionId);
    expect(otherTab.sessionId).not.toBe(first.sessionId);
    expect(h.runtime.getRegistry().listSessions()).toHaveLength(2);
    // The first accepted create owns configuration; a racing duplicate must
    // not mutate a logical tab before its first prompt.
    expect(h.runtime.getRegistry().getSession(first.sessionId)).toMatchObject({
      title: "First writer",
      titleSource: "explicit",
      createdAt,
      lastAccessed: 2_000,
      config: { mode: "build", sandbox: "danger-full-access" },
    });
    expect(duplicate.title).toBe("First writer");
  });

  test("client tab keys enforce type, content, and length boundaries", async () => {
    const h = await harness();
    const accepted512 = "k".repeat(512);
    const stable = h.runtime.createSession({
      mode: "build",
      clientSessionKey: accepted512,
    });
    expect(h.runtime.createSession({
      mode: "plan",
      clientSessionKey: accepted512,
    }).sessionId).toBe(stable.sessionId);
    expect(stable.sessionId).toMatch(/^session-client-[a-f0-9]{32}$/);

    const invalidKeys: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      " \t\n ",
      "k".repeat(513),
    ];
    const fallbackIds = invalidKeys.map((clientSessionKey) =>
      h.runtime.createSession({ mode: "build", clientSessionKey }).sessionId
    );
    expect(new Set(fallbackIds).size).toBe(invalidKeys.length);
    for (const id of fallbackIds) {
      expect(id).toMatch(/^session-/);
      expect(id.startsWith("session-client-")).toBe(false);
    }
  });

  test("deleting a keyed session permits a clean recreation with the same identity", async () => {
    const h = await harness();
    const first = h.runtime.createSession({
      mode: "build",
      title: "Old session",
      clientSessionKey: "env-1:tab-recreated",
    });

    expect(await h.runtime.deleteSession(first.sessionId)).toBe(true);
    expect(h.runtime.getStatus(first.sessionId)).toBeNull();
    expect(await h.runtime.deleteSession(first.sessionId)).toBe(false);

    const recreated = h.runtime.createSession({
      mode: "plan",
      title: "New session",
      clientSessionKey: "env-1:tab-recreated",
    });
    expect(recreated).toEqual({
      sessionId: first.sessionId,
      title: "New session",
    });
    expect(h.runtime.getRegistry().getSession(recreated.sessionId)).toMatchObject({
      title: "New session",
      config: { mode: "plan", sandbox: "read-only" },
    });
  });

  test("a keyed materialized session converges on its durable identity after restart", async () => {
    const key = "env-1:tab-durable";
    const first = await harness();
    const created = first.runtime.createSession({
      mode: "plan",
      title: "Durable first writer",
      clientSessionKey: key,
    });
    await first.runtime.prompt(created.sessionId, {
      prompt: "materialize",
      requestId: "req-durable-key",
      attachments: [],
    });
    first.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.drain();
    await first.runtime.stop();

    const second = await harness({
      "thread/resume": () => ({ thread: threadPayload("thread-1") }),
    });
    const duplicate = second.runtime.createSession({
      mode: "build",
      title: "Must not replace persisted state",
      clientSessionKey: key,
    });
    expect(duplicate).toEqual({
      sessionId: created.sessionId,
      title: "Durable first writer",
    });
    expect(second.runtime.getRegistry().getSession(created.sessionId)).toMatchObject({
      threadId: "thread-1",
      title: "Durable first writer",
      config: { mode: "plan", sandbox: "read-only" },
    });
    await second.runtime.stop();
  });

  test("the first prompt creates the thread and dispatches a turn", async () => {
    const turnStartedAt = Date.parse("2026-08-01T12:34:56.000Z");
    const h = await harness({}, { now: () => turnStartedAt });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const invalidationsBefore = getTranscriptCatalogInvalidationCountForTesting();

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "do the thing",
      requestId: "req-1",
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        status: "processing",
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt)
      .toBe("2026-08-01T12:34:56.000Z");
    expect(h.events).toContainEqual({
      type: "session.updated",
      sessionId,
      data: {
        status: "running",
        phase: "starting",
        turnStartedAt: "2026-08-01T12:34:56.000Z",
      },
    });
    const methods = h.child().requests.map((r) => r.method);
    expect(methods).toContain("thread/start");
    expect(methods).toContain("turn/start");
    expect(getTranscriptCatalogInvalidationCountForTesting())
      .toBe(invalidationsBefore + 1);
    // The request id must reach app-server as the at-most-once key.
    expect(
      h.child().requests.find((r) => r.method === "turn/start")!.params.clientUserMessageId,
    ).toBe("req-1");
  });

  test("drainPendingWork waits for terminal journal and render finalization", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish deterministically",
      requestId: "req-drain",
      attachments: [],
    });

    const journal = h.runtime.getJournal();
    const originalMarkTerminal = journal.markTerminal.bind(journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    journal.markTerminal = async (...args) => {
      await gate;
      await originalMarkTerminal(...args);
    };

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.engine.getSupervisor().notificationQueue.drainAll();

    let drained = false;
    const pendingDrain = h.runtime.drainPendingWork().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");

    release();
    await pendingDrain;
    expect(h.runtime.getStatus(sessionId)?.status).toBe("idle");
    expect(journal.allRecords().find((record) => record.requestId === "req-drain"))
      .toMatchObject({ state: "terminal", terminalStatus: "completed" });
  });

  test("graceful stop does not release render state before finalization settles", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish before shutdown",
      requestId: "req-stop-drain",
      attachments: [],
    });

    const journal = h.runtime.getJournal();
    const originalMarkTerminal = journal.markTerminal.bind(journal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    journal.markTerminal = async (...args) => {
      await gate;
      await originalMarkTerminal(...args);
    };
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.engine.getSupervisor().notificationQueue.drainAll();

    let stopped = false;
    const pendingStop = h.runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await pendingStop;
    expect(journal.allRecords().find((record) => record.requestId === "req-stop-drain"))
      .toMatchObject({ state: "terminal", terminalStatus: "completed" });
  });

  test("stores a schema-constrained final response and rehydrates it by request id", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-1",
      attachments: [],
      outputSchema,
    });

    expect(
      h.child().requests.find((request) => request.method === "turn/start")!.params.outputSchema,
    ).toEqual(outputSchema);
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: JSON.stringify({ summary: "Looks good" }),
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId, "structured-1")).toEqual({
      requestId: "structured-1",
      structuredOutput: {
        ok: true,
        provider: "codex",
        requestId: "structured-1",
        value: { summary: "Looks good" },
      },
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      structuredOutputRequestId: "structured-1",
      structuredOutput: { ok: true, value: { summary: "Looks good" } },
    });
    const persisted = (await new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
    }).load())[0];
    expect(persisted?.structuredOutput).toMatchObject({
      ok: true,
      requestId: "structured-1",
    });
  });

  test("recovers a schema-constrained response wrapped in thinking or commentary", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-wrapped",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: "The schema requires JSON.\n```json\n{\"summary\":\"Looks good\"}\n```",
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: true,
        value: { summary: "Looks good" },
      },
    });
  });

  test("recovers the last well-formed object when commentary contains another JSON document", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-last-document",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: 'Example {"summary":"nope"}. Answer {"summary":"Looks good"}.',
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: true,
        value: { summary: "Looks good" },
      },
    });
  });

  test("prefers schema JSON outside a tagged thinking block in the final message", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-tagged-thinking",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: '{"summary":"Looks good"}\n<thinking>{"summary":"from thought"}</thinking>',
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: true,
        value: { summary: "Looks good" },
      },
    });
  });

  test("recovers the report after a thinking trace that opened outside the text channel", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-unopened-thinking",
      attachments: [],
      outputSchema: { type: "object" },
    });
    // Only the closing tag reaches the text channel. Its schema sketches would
    // otherwise spend the recovery budget before the report at the end.
    const sketches = Array.from(
      { length: 264 },
      (_, index) => `{ incomplete schema sketch ${index}`,
    ).join(" ");
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: `The schema requires JSON.\n${sketches}\n</thinking>\n{"summary":"Looks good"}`,
      },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: true,
        value: { summary: "Looks good" },
      },
    });
  });

  test("does not treat a plaintext final message as structured success", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-plain",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", text: "Looks good" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: false,
        error: { code: "malformed_output", retryable: true },
      },
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
    });
  });

  test("maps Codex structured-output retry exhaustion to the shared failure code", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "review",
      requestId: "structured-retries",
      attachments: [],
      outputSchema: { type: "object" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: {
          message: "Structured output retries exhausted",
          codexErrorInfo: "structuredOutputRetryExhausted",
        },
      },
    });
    await h.drain();

    expect(h.runtime.getStructuredOutput(sessionId)).toMatchObject({
      structuredOutput: {
        ok: false,
        error: { code: "schema_retry_exhausted", retryable: true },
      },
    });
  });

  test("status reports running while a turn is live", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "running",
      turnId: "turn-1",
      requestId: "req-1",
    });
  });

  test("config persistence changes only after configure succeeds", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const configure = h.engine.configureThread.bind(h.engine);
    const order: string[] = [];
    h.engine.configureThread = async (handle, config) => {
      order.push("configure:start");
      await gate;
      await configure(handle, config);
      order.push("configure:done");
    };

    const pending = h.runtime.updateConfig(sessionId, { mode: "plan" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.load())[0]?.config.mode).toBe("build");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("build");

    release();
    expect(await pending).toBe("updated");
    order.push("returned");
    expect(order).toEqual(["configure:start", "configure:done", "returned"]);
    expect((await store.load())[0]?.config.mode).toBe("plan");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
    expect(await h.runtime.getConfig(sessionId)).toMatchObject({
      mode: "plan",
      fastMode: false,
      durable: true,
    });

    h.engine.configureThread = async () => {
      throw new Error("configure rejected");
    };
    // Reported, not thrown: the route answers 503 rather than leaking a 500, and
    // both memory and disk stay on the configuration the engine accepted.
    expect(await h.runtime.updateConfig(sessionId, { mode: "build" })).toBe("unavailable");
    expect((await store.load())[0]?.config.mode).toBe("plan");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
  });

  test("an unresumable session reports unavailable instead of throwing", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-503",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Force the slow path, then fail it the way an in-flight restart would.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("temporary transport failure");
    };

    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("unavailable");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("build");
  });

  test("a rejected model configuration restores the prior confirmed model", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({
      mode: "build",
      model: "gpt-accepted-request",
    });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-model-config-rollback",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const context = h.runtime.getRegistry().getThread("thread-1")!;
    context.modelId = "gpt-accepted-confirmation";
    h.engine.configureThread = async () => {
      // Model notifications can race the RPC response. A failed response means
      // this tentative confirmation must not replace the last accepted model.
      context.modelId = "gpt-rejected-confirmation";
      throw new Error("configure rejected");
    };

    expect(await h.runtime.updateConfig(sessionId, {
      mode: "build",
      model: "gpt-rejected-request",
    })).toBe("unavailable");
    expect(context.modelId).toBe("gpt-accepted-confirmation");
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.model)
      .toBe("gpt-accepted-request");
  });

  test("a running session found only after re-attaching is still refused", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-race",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const registry = h.runtime.getRegistry();
    const context = registry.getThread("thread-1")!;
    // Idle when the route looks, running by the time the handle is valid again:
    // configuring here would change the sandbox under an executing turn.
    context.unsubscribed = true;
    const resume = h.engine.resumeThread.bind(h.engine);
    h.engine.resumeThread = async (...args) => {
      const result = await resume(...args);
      registry.setPhase(context, "running");
      return result;
    };

    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("running");
    expect(registry.getSession(sessionId)?.config.mode).toBe("build");
  });

  test("a configuration change that cannot be persisted is reported, not claimed", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-config-disk",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    const recordsDir = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/tmp/ws")}`,
    );
    const legacyPath = join(
      codexHome,
      "orkestrator-bridge",
      `bridge-sessions-${hashCwd("/tmp/ws")}.json`,
    );
    const durableBeforeFailure = await store.load();
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: BRIDGE_SESSION_REGISTRY_VERSION,
        sessions: durableBeforeFailure,
      }),
      "utf8",
    );
    rmSync(recordsDir, { recursive: true, force: true });
    writeFileSync(recordsDir, "blocks the per-session registry directory", "utf8");

    // The store warns and resolves on a write failure, so "updated" here would
    // be a lie: after a restart the stale plan/build mode is re-hydrated into
    // thread/resume, silently restoring the old sandbox.
    expect(await h.runtime.updateConfig(sessionId, { mode: "plan" })).toBe("memory-only");
    expect((await store.load())[0]?.config.mode).toBe("build");
    // Memory still matches the engine, which did accept the change.
    expect(h.runtime.getRegistry().getSession(sessionId)?.config.mode).toBe("plan");
  });

  test("an attached image is published as a file part and referenced in the persisted text", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "Inspect the diagram",
      requestId: "req-1",
      attachments: [{
        type: "image",
        path: "/workspace/.orkestrator/initial-prompt/shot.png",
        filename: "diagram.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }],
    });

    // The live row renders from the inline data, so no workspace read is needed.
    const userMessage = h.events.find(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "user",
    )!.data!.message as { content: string; parts: unknown[] };
    expect(userMessage.content).toBe("Inspect the diagram");
    expect(userMessage.parts).toEqual([
      { type: "text", content: "Inspect the diagram" },
      {
        type: "file",
        content: "/workspace/.orkestrator/initial-prompt/shot.png",
        fileUrl: "data:image/png;base64,iVBORw0KGgo=",
        filename: "diagram.png",
      },
    ]);

    // Codex keeps only an opaque data URL for the image itself, so the path has
    // to travel in the text or a rehydrated transcript loses the attachment.
    const input = h.child().requests.find((request) => request.method === "turn/start")!
      .params.input as Array<Record<string, unknown>>;
    expect(input[0]!.text).toBe(
      "Inspect the diagram\n\n<attached-files source=\"orkestrator\">\n"
      + '<attachment type="image" path="/workspace/.orkestrator/initial-prompt/shot.png"'
      + ' filename="diagram.png" />\n</attached-files>',
    );
    expect(input[1]).toEqual({
      type: "localImage",
      path: "/workspace/.orkestrator/initial-prompt/shot.png",
    });
  });

  test("an attachment-only prompt still sends a text slot carrying the reference", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "",
      requestId: "req-1",
      attachments: [{ type: "image", path: "/workspace/a.png" }],
    });

    const input = h.child().requests.find((request) => request.method === "turn/start")!
      .params.input as Array<Record<string, unknown>>;
    expect(input[0]!.text).toBe(
      '<attached-files source="orkestrator">\n<attachment type="image" path="/workspace/a.png" filename="" />\n</attached-files>',
    );
    expect(input[1]).toEqual({ type: "localImage", path: "/workspace/a.png" });
  });

  test("a prompt with no attachments is sent verbatim", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });

    const input = h.child().requests.find((request) => request.method === "turn/start")!
      .params.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]!.text).toBe("hello");
  });

  test("a full turn streams deltas and finalizes the transcript", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(h.runtime.getStatus(sessionId)?.messageRevision).toBe(0);
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    const promptRevision = h.runtime.getStatus(sessionId)!.messageRevision;
    expect(promptRevision).toBe(1);
    const initialAssistantUpdates = h.events.filter(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "assistant",
    );
    const initialUserUpdates = h.events.filter(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "user",
    );
    expect(initialUserUpdates).toHaveLength(1);
    expect(initialAssistantUpdates).toHaveLength(1);
    expect(h.events.indexOf(initialUserUpdates[0]!))
      .toBeLessThan(h.events.indexOf(initialAssistantUpdates[0]!));
    expect(
      (initialAssistantUpdates[0]!.data?.message as { revision?: number }).revision,
    ).toBe(1);

    const child = h.child();
    child.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    child.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "Hi ",
    });
    child.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "there",
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toBe("hello");
    // Streaming text is visible before completion.
    expect(messages[1]!.content).toBe("Hi there");
    expect(h.events.some((event) => event.type === "message.patched")).toBe(true);
    expect(h.events.filter(
      (event) => event.type === "message.updated"
        && (event.data?.message as { role?: unknown } | undefined)?.role === "assistant",
    )).toHaveLength(1);

    const streamingRevision = h.runtime.getStatus(sessionId)!.messageRevision;
    expect(streamingRevision).toBeGreaterThan(promptRevision);
    const revisionBeforeRead = streamingRevision;
    const messageEventsBeforeRead = h.events.filter(
      (event) => event.type === "message.updated",
    ).length;
    await h.runtime.getMessages(sessionId);
    expect(h.runtime.getStatus(sessionId)!.messageRevision).toBe(revisionBeforeRead);
    expect(
      h.events.filter((event) => event.type === "message.updated").length,
    ).toBe(messageEventsBeforeRead);

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "Hi there, final." },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    // item/completed is authoritative and replaces the streamed text.
    expect(messages[1]!.content).toBe("Hi there, final.");
    expect(h.runtime.getStatus(sessionId)!.messageRevision).toBeGreaterThan(streamingRevision);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    expect(h.runtime.getStatus(sessionId)?.turnStartedAt).toBeUndefined();
    expect(h.events.some((event) => event.type === "session.idle")).toBe(true);
    expect(h.events.findLastIndex((event) => event.type === "message.patched"))
      .toBeLessThan(h.events.findLastIndex((event) => event.type === "session.idle"));
  });

  test("command output streams while the command is in progress", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "run", requestId: "req-1", attachments: [] });

    const child = h.child();
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c1",
        type: "commandExecution",
        command: "ls -la",
        status: "inProgress",
        aggregatedOutput: null,
      },
    });
    child.notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c1",
      delta: "total 8\n",
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    const toolPart = messages[1]!.parts.find((part) => part.toolName === "bash")!;
    // An in-progress command reports no aggregated output, so the deltas are
    // spliced in — otherwise the user watches an empty box.
    expect(toolPart.toolOutput).toBe("total 8\n");
    expect(toolPart.toolState).toBe("pending");
  });

  test("plan updates do not disrupt per-file raw patch fallback or structured replacement", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-raw-patch",
      attachments: [],
    });
    const child = h.child();
    child.notify("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "inProgress" },
      ],
    });
    const rawOutput = {
      type: "custom_tool_call_output",
      call_id: "patch-1",
      output: "Failed to read file to update: missing.ts",
    };
    const rawPatch = `*** Begin Patch
*** Update File: missing.ts
@@
-old
+new
*** Add File: second.ts
+second
*** End Patch`;

    // Output-before-call cannot invent an item. Repeated call/output delivery
    // must still converge on one fallback rather than duplicating transcript UI.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-1",
        name: "apply_patch",
        input: rawPatch,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-1",
        name: "apply_patch",
        input: rawPatch,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: rawOutput,
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(3);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "todo_list",
      toolState: "success",
    });
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolState: "failure",
      toolError: "Failed to read file to update: missing.ts",
      toolDiff: { filePath: expect.stringContaining("missing.ts") },
    });
    expect(messages[1]!.parts[2]).toMatchObject({
      toolName: "apply_patch",
      toolState: "failure",
      toolDiff: { filePath: expect.stringContaining("second.ts") },
    });

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "fixed.ts", kind: { type: "add" } },
          { path: "second-fixed.ts", kind: { type: "add" } },
        ],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(3);
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolState: "success",
      toolTitle: "add: fixed.ts",
      toolOutput: "add: fixed.ts",
    });
    expect(messages[1]!.parts[1]!.toolError).toBeUndefined();
    expect(messages[1]!.parts[2]).toMatchObject({
      toolTitle: "add: second-fixed.ts",
      toolOutput: "add: second-fixed.ts",
    });
  });

  test("a successful raw patch stays hidden until structured fileChange arrives", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-successful-raw-patch",
      attachments: [],
    });
    const child = h.child();
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-success",
        name: "apply_patch",
        input: `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch`,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "patch-success",
        output: "Done!",
      },
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toEqual([]);

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-success",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", kind: { type: "update" } }],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "update: src/example.ts",
      toolState: "success",
    });

    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-without-structured-item",
        name: "apply_patch",
        input: `*** Begin Patch
*** Add File: src/fallback.ts
+fallback
*** End Patch`,
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "patch-without-structured-item",
        output: "Done!",
      },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(2);
    expect(messages[1]!.parts[1]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "add: src/fallback.ts",
      toolState: "success",
      toolDiff: { filePath: expect.stringContaining("src/fallback.ts") },
    });
  });

  test("the streamed patch preview survives the raw call that follows it", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-preview-before-raw",
      attachments: [],
    });
    const child = h.child();

    // app-server streams the in-progress patch while the model writes it.
    child.notify("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "patch-preview",
      changes: [{ path: "src/example.ts", kind: { type: "update" } }],
    });
    await h.drain();

    let messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({ toolName: "apply_patch" });

    // The raw `custom_tool_call` uses the same call id and lands afterwards. It
    // is only a recovery candidate, so it must not blank the preview already on
    // screen — the gap lasts until the patch applies, or until an approval is
    // answered, which is unbounded.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "patch-preview",
        name: "apply_patch",
        input: `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch`,
        status: "completed",
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolTitle: "update: src/example.ts",
    });

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-preview",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "src/example.ts", kind: { type: "update" } }],
      },
    });
    await h.drain();

    messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[1]!.parts[0]).toMatchObject({
      toolName: "apply_patch",
      toolState: "success",
      toolTitle: "update: src/example.ts",
    });
  });

  test("a raw patch call from a stale turn is dropped rather than applied", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "patch the file",
      requestId: "req-stale-raw-patch",
      attachments: [],
    });
    const child = h.child();

    // A turn that has already moved on must not have a previous turn's patch
    // spliced into it; `accepts` is the only thing standing between them.
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-0",
      item: {
        type: "custom_tool_call",
        call_id: "stale-patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: stale.ts\n+stale\n*** End Patch",
        status: "completed",
      },
    });
    child.notify("rawResponseItem/completed", {
      threadId: "thread-1",
      turnId: "turn-0",
      item: {
        type: "custom_tool_call_output",
        call_id: "stale-patch",
        output: "Failed to read file to update: stale.ts",
      },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.parts).toEqual([]);
  });

  test("a coalesced publish rejection is contained and reported", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "stream",
      requestId: "req-publish-rejection",
      attachments: [],
    });
    const runtime = h.runtime as unknown as {
      publishAssistantMessage: (threadId: string) => Promise<void>;
    };
    runtime.publishAssistantMessage = async () => {
      throw new Error("render rejected");
    };

    const errors = await captureConsoleErrors(async () => {
      h.child().notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "partial",
      });
      await h.drain();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Failed to publish message update:"
        && error instanceof Error
        && error.message === "render rejected",
    )).toBe(true);
  });

  test("a terminal finalization rejection is contained and removed from pending work", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "finish",
      requestId: "req-finalize-rejection",
      attachments: [],
    });
    const runtime = h.runtime as unknown as {
      finalizeTurn: () => Promise<void>;
      pendingFinalizations: Set<Promise<void>>;
    };
    runtime.finalizeTurn = async () => {
      throw new Error("journal unavailable");
    };

    const errors = await captureConsoleErrors(async () => {
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Failed to finalize turn turn-1:"
        && error === "journal unavailable",
    )).toBe(true);
    expect(runtime.pendingFinalizations.size).toBe(0);
  });

  test("tool-heavy snapshots change runtime cadence and terminal events still flush immediately", async () => {
    const h = await harness({}, { adaptiveCoalesce: true });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "produce output",
      requestId: "req-large-output",
      attachments: [],
    });

    const output = "x".repeat(300 * 1024);
    h.child().notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c-large",
        type: "commandExecution",
        command: "generate",
        status: "inProgress",
        aggregatedOutput: output,
      },
    });
    await h.drain();

    const runtimeState = h.runtime as unknown as {
      threadState: Map<string, {
        lastPublishedSnapshotChars: number;
        coalescer: { intervalMs: () => number };
      }>;
    };
    const state = runtimeState.threadState.get("thread-1")!;
    expect(state.lastPublishedSnapshotChars).toBeGreaterThanOrEqual(256 * 1024);
    expect(state.coalescer.intervalMs()).toBe(250);

    // This update is now parked behind the slower cadence.
    h.child().notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "c-large",
      delta: "tail",
    });
    // A terminal event must cancel that timer and publish the authoritative
    // final snapshot without waiting for the adaptive interval.
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "c-large",
        type: "commandExecution",
        command: "generate",
        status: "completed",
        aggregatedOutput: output,
      },
    });
    await h.drain();
    const completedToolPatchCount = h.events.length;
    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-after-large-tool",
      delta: "Done",
    });
    await h.drain();
    const laterPatches = h.events
      .slice(completedToolPatchCount)
      .filter((event) => event.type === "message.patched");
    expect(laterPatches).not.toHaveLength(0);
    for (const patch of laterPatches) {
      expect(
        (patch.data as {
          changedParts?: Array<{ index: number }>;
        }).changedParts?.some(({ index }) => index === 0),
      ).toBe(false);
    }

    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ phase: "idle" });
    expect((await h.runtime.getMessages(sessionId))?.[1]?.parts[0]?.toolState).toBe("success");
  });

  test("plan mode marks the assistant message as a plan review", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "plan" });
    await h.runtime.prompt(sessionId, { prompt: "plan it", requestId: "req-1", attachments: [] });

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.planReview).toBe(true);
    expect(h.child().requests.find((r) => r.method === "thread/start")!.params.sandbox).toBe(
      "read-only",
    );
  });
});



describe("interrupt lifecycle", () => {
  test("abort reports cancelling, not idle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const outcome = await h.runtime.abort(sessionId);

    // turn/interrupt is asynchronous; idle here would allow an overlapping turn.
    expect(outcome).toEqual({ status: "cancelling", phase: "cancelling" });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      phase: "cancelling",
    });
    expect(h.child().requests.some((r) => r.method === "turn/interrupt")).toBe(true);
  });

  test("a new prompt is rejected while cancelling", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    await h.runtime.abort(sessionId);

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "next",
      requestId: "req-2",
      attachments: [],
    });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
  });

  test("the terminal interrupted event settles the session and keeps partial output", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "partial work",
    });
    await h.drain();
    await h.runtime.abort(sessionId);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle", phase: "idle" });
    const messages = (await h.runtime.getMessages(sessionId))!;
    // The user keeps what the agent had already produced.
    expect(messages[1]!.content).toBe("partial work");
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "interrupted",
    });
  });

  test("aborting an idle session is harmless", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    expect(await h.runtime.abort(sessionId)).toMatchObject({ phase: "idle" });
  });

  test("a failed abort escalation settles the turn and surfaces the error", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });
    h.engine.waitForTurnTerminal = async () => {
      throw new Error("replacement failed");
    };

    await h.runtime.abort(sessionId);
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
    });
    expect(h.events.some(
      (event) =>
        event.type === "session.error"
        && event.sessionId === sessionId
        && event.data?.error === "replacement failed",
    )).toBe(true);
  });
});



describe("crash recovery", () => {
  test("an unexpected generation recovery rejection is contained and reported", async () => {
    const h = await harness();
    const runtime = h.runtime as unknown as {
      recoverAfterGenerationChange: (generation: number) => Promise<void>;
    };
    runtime.recoverAfterGenerationChange = async () => {
      throw new Error("recovery invariant failed");
    };
    const engine = h.engine as unknown as { emit: (event: EngineEvent) => void };

    const errors = await captureConsoleErrors(async () => {
      engine.emit({
        kind: "engine.generation",
        generation: 2,
        previous: 1,
        engineGeneration: 2,
      });
      await h.runtime.drainPendingWork();
    });

    expect(errors.some(
      ([message, error]) =>
        message === "[codex-bridge] Generation recovery failed:"
        && error instanceof Error
        && error.message === "recovery invariant failed",
    )).toBe(true);
  });

  test("generation recovery durably clears an unmaterialized thread binding", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const context = h.runtime.getRegistry().attach(sessionId, "thread-ghost", {
      engineHandle: "thread-ghost",
      engineGeneration: h.engine.info().generation,
    });
    expect(context.materialized).toBe(false);

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: sessionId,
        threadId: "thread-ghost",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    await h.engine.getSupervisor().restartNow("test generation replacement");
    await h.drain();

    expect(h.runtime.getRegistry().getSession(sessionId)?.threadId).toBeNull();
    expect(await store.load()).toEqual([]);
  });

  test("a failed rebind is resumed before a later prompt uses the replacement child", async () => {
    let resumeAttempts = 0;
    const h = await harness({
      "thread/resume": () => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) {
          const error = new Error("temporary resume failure");
          (error as { rpcCode?: number }).rpcCode = -32603;
          throw error;
        }
        return { thread: threadPayload("thread-1") };
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-before-crash",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: expect.stringContaining("temporary resume failure"),
    });

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "retry after rebind",
      requestId: "req-after-crash",
      attachments: [],
    });
    expect(outcome.ok).toBe(true);
    expect(resumeAttempts).toBe(2);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods.lastIndexOf("thread/resume")).toBeLessThan(
      methods.indexOf("turn/start"),
    );
  });

  test("a prompt waits for generation recovery before dispatching on the refreshed handle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "first",
      requestId: "req-1",
      attachments: [],
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = h.engine.resumeThread.bind(h.engine);
    const order: string[] = [];
    h.engine.resumeThread = async (...args) => {
      order.push("recovery:start");
      await gate;
      const result = await resume(...args);
      order.push("recovery:done");
      return result;
    };

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["recovery:start"]);

    let settled = false;
    const pending = h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-2",
      attachments: [],
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(h.child().requests.some((request) => request.method === "turn/start")).toBe(false);

    release();
    expect((await pending).ok).toBe(true);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
    expect(order).toEqual(["recovery:start", "recovery:done"]);
  });

  test("an active turn becomes recovering, not idle or error", async () => {
    const h = await harness({}, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).toBe("recovering");
    // A crash must not masquerade as a completed turn.
    expect(status.status).toBe("running");
    expect(status.turnStartedAt).toBe("2026-08-01T12:34:56.000Z");
  });

  /**
   * `recovering` must be a transient state, not a terminal one.
   *
   * The plan's contract is "active sessions become recovering and *eventually
   * terminal*". If nothing resolves it, the overlapping-turn guard rejects every
   * subsequent prompt with a 409 and the session is bricked until the tab is
   * closed — worse for the user than a visible failure.
   */
  test("a recovering session resolves once the replacement child is ready", async () => {
    const h = await harness({
      // The turn had already finished on the dead child.
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    const revisionBeforeRecovery = h.runtime.getStatus(sessionId)!.messageRevision;

    h.child().exit(1);
    await h.drain();
    // Bring the replacement child up, as the next request would.
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    const status = h.runtime.getStatus(sessionId)!;
    expect(status.phase).not.toBe("recovering");
    expect(status.status).toBe("idle");
    // Recovery changed only execution state in this fixture. Sparse transcript
    // publishing must not invent a message revision when no part changed.
    expect(status.messageRevision).toBe(revisionBeforeRecovery);

    // And the session must accept work again.
    const next = await h.runtime.prompt(sessionId, {
      prompt: "after recovery",
      requestId: "req-2",
      attachments: [],
    });
    expect(next.ok).toBe(true);
  });

  test("a turn still running on the replacement child stays running", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    }, {
      now: () => Date.parse("2026-08-01T12:34:56.000Z"),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.drain();
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    // Still executing, so it must not be reported idle or accept a new prompt.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "running",
      turnStartedAt: "2026-08-01T12:34:56.000Z",
    });
  });

  test("a turn that failed on the dead child is finalized as failed", async () => {
    const h = await harness({
      "thread/read": () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "failed",
              items: [{ type: "userMessage", clientId: "req-1" }],
            },
          ],
        }),
      }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    // The real status, not a generic "restarted" failure.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "error", phase: "failed" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "failed",
    });
  });

  test("a generation reconciliation read failure terminates recovery as failed", async () => {
    const h = await harness({
      "thread/read": () => {
        throw new Error("replacement read failed");
      },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "x",
      requestId: "req-1",
      attachments: [],
    });

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: expect.stringContaining("replacement read failed"),
    });
  });

  /**
   * Two restarts in quick succession are ordinary (a crash during a controlled
   * restart). Both recovery passes walk the same registry and rebind the same
   * contexts, so interleaving them would let the second overwrite handles the
   * first is still installing.
   */
  test("overlapping generation changes recover one pass at a time", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const order: string[] = [];
    let pass = 0;
    const resume = h.engine.resumeThread.bind(h.engine);
    h.engine.resumeThread = async (...args) => {
      const id = (pass += 1);
      order.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await resume(...args);
      order.push(`end:${id}`);
      return result;
    };

    // Emitted directly: the point is two generation events landing back to back,
    // which a scripted child cannot produce deterministically.
    const engine = h.engine as unknown as { emit: (event: EngineEvent) => void };
    engine.emit({ kind: "engine.generation", generation: 2, previous: 1, engineGeneration: 2 });
    engine.emit({ kind: "engine.generation", generation: 3, previous: 2, engineGeneration: 3 });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("a thread no session can reach is released, not just forgotten", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const runtime = h.runtime as unknown as { threadState: Map<string, unknown> };
    expect(runtime.threadState.has("thread-1")).toBe(true);
    // Orphaned: no bridge session can ever address this thread again.
    h.runtime.getRegistry().getThread("thread-1")!.bridgeSessionIds.clear();

    h.child().exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    expect(h.runtime.getRegistry().getThread("thread-1")).toBeUndefined();
    // The render state holds the diff baselines and the coalescer holds a timer;
    // dropping the map entry alone leaks both.
    expect(runtime.threadState.has("thread-1")).toBe(false);
  });

  test("events from the dead generation are ignored", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const dead = h.child();
    dead.exit(1);
    await h.engine.getSupervisor().ensureReady();
    await h.drain();

    dead.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "i1",
      delta: "ghost text",
    });
    await h.drain();

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages[1]!.content).not.toContain("ghost text");
  });
});



describe("idle detach and transparent re-attach", () => {
  /**
   * Detaching is the whole storage story: it frees the bridge's transcript, its
   * render state (the biggest consumer, since diffs hold whole file contents) and
   * app-server's own thread state. It is only safe because the rollout on disk is
   * the authoritative transcript.
   */
  test("an idle materialized thread is detached and unsubscribed", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 1 });

    expect(h.child().requests.some((r) => r.method === "thread/unsubscribe")).toBe(true);
    expect(h.runtime.getRegistry().listThreads()).toHaveLength(0);
    expect(h.runtime.getStorageStats()).toMatchObject({ threads: 0, detachedThreads: 1 });
  });

  test("a thread with a live turn is never detached, however idle it looks", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    clock += 60_000;
    // The turn is still executing; freeing its state would lose the in-flight work.
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 0 });
    expect(h.runtime.getRegistry().listThreads()).toHaveLength(1);
  });

  test("a detached session rehydrates accepted steering text from the rollout", async () => {
    let clock = 1_000_000;
    const h = await harness(
      { "turn/steer": () => ({ turnId: "turn-1" }) },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    expect(
      await h.runtime.steerSession(
        sessionId,
        "also inspect the bridge",
        "turn-1",
        "req-steer",
      ),
    ).toBe("accepted");
    expect((await h.runtime.getMessages(sessionId))?.filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["hello", "also inspect the bridge"]);
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

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
        {
          type: "turn_context",
          payload: { turn_id: "turn-1", cwd: "/tmp/ws" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "update_plan",
            call_id: "call-plan",
            arguments: JSON.stringify({
              plan: [{ step: "Patch both files", status: "in_progress" }],
            }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-plan",
            output: "Plan updated",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "also inspect the bridge" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call-patch",
            status: "completed",
            input: `*** Begin Patch
*** Update File: src/a.ts
@@
-a
+A
*** Add File: src/b.ts
+B
*** End Patch`,
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-patch",
            output: "Done!",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    // Same session id the UI still holds — this must just work.
    const messages = await h.runtime.getMessages(sessionId);
    expect(messages).not.toBeNull();
    expect(messages!.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", ""],
      ["user", "also inspect the bridge"],
      ["assistant", "done"],
    ]);
    expect(messages!.filter((message) => message.role === "user").map((message) => ({
      content: message.content,
      turnId: message.turnId,
    }))).toEqual([
      { content: "hello", turnId: "turn-1" },
      { content: "also inspect the bridge", turnId: "turn-1" },
    ]);
    const patchParts = messages!
      .flatMap((message) => message.parts)
      .filter((part) => part.toolName === "apply_patch");
    expect(patchParts).toHaveLength(2);
    expect(patchParts.map((part) => part.toolDiff?.filePath)).toEqual([
      "/tmp/ws/src/a.ts",
      "/tmp/ws/src/b.ts",
    ]);
    expect(h.child().requests.some((r) => r.method === "thread/resume")).toBe(true);
    expect(h.runtime.getStorageStats()).toMatchObject({ reattachedThreads: 1 });
  });

  test("a prompt on a detached session resumes rather than forking a new thread", async () => {
    let clock = 1_000_000;
    let turns = 0;
    const h = await harness(
      {
        "turn/start": () => {
          turns += 1;
          return { turn: { id: `turn-${turns}` } };
        },
      },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    const outcome = await h.runtime.prompt(sessionId, {
      prompt: "second",
      requestId: "req-2",
      attachments: [],
    });

    expect(outcome.ok).toBe(true);
    const methods = h.child().requests.map((r) => r.method);
    // Forking would orphan the conversation the user was looking at.
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect((outcome as { result: { threadId: string } }).result.threadId).toBe("thread-1");
  });

  /**
   * An unmaterialized thread has no rollout, so `thread/resume` fails with "no
   * rollout found" — verified against codex 0.147.0. Keeping its id would strand
   * the session against a dead thread forever.
   */
  test("detaching a thread that never ran a turn clears its id so the next prompt starts fresh", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    // Materialize a thread binding without completing a turn: resume the session
    // onto a thread, then let it go idle before any prompt.
    const context = h.runtime.getRegistry().attach(sessionId, "thread-ghost", {
      engineHandle: "thread-ghost",
    });
    expect(context.materialized).toBe(false);
    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
    });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: sessionId,
        threadId: "thread-ghost",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
      }),
    );

    clock += 60_000;
    await h.runtime.sweepIdle();

    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
    expect(await store.load()).toEqual([]);

    // A bridge restart must not resurrect the rollout-less thread id that was
    // cleared in memory by the sweep.
    await h.runtime.stop();
    const restarted = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sweepIntervalMs: 0,
    });
    expect(restarted.runtime.getStatus(sessionId)).toBeNull();
  });

  test("a re-attach failure clears the binding instead of stranding the session", async () => {
    let clock = 1_000_000;
    const h = await harness(
      {
        "thread/resume": () => {
          const error = new Error("thread/resume: no rollout found for thread id thread-1");
          (error as { rpcCode?: number }).rpcCode = -32600;
          throw error;
        },
      },
      { now: () => clock, threadIdleMs: 1_000, sweepIntervalMs: 0 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 60_000;
    await h.runtime.sweepIdle();

    // Rollout deleted underneath us: the session must recover, not wedge.
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
  });

  test("a transient re-attach failure preserves the original thread for retry", async () => {
    let clock = 1_000_000;
    let resumeAttempts = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeAttempts += 1;
          if (resumeAttempts === 1) {
            const error = new Error("temporary transport failure");
            (error as { rpcCode?: number }).rpcCode = -32603;
            throw error;
          }
          return { thread: threadPayload("thread-1") };
        },
      },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    clock += 60_000;
    await h.runtime.sweepIdle();

    // A read must not 500 on an ambiguous re-attach: the transcript the bridge
    // still knows about is a better answer than an error page.
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBe("thread-1");
    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(resumeAttempts).toBe(2);
  });

  test("a read falls back to the last known transcript rather than failing", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "hello", requestId: "req-1", attachments: [] });
    h.child().notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "i1", type: "agentMessage", text: "answer" },
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    // Force the slow path and fail it the way an in-flight restart would.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("temporary transport failure");
    };

    const messages = (await h.runtime.getMessages(sessionId))!;
    expect(messages.map((message) => message.content)).toEqual(["hello", "answer"]);
  });

  test("a prompt never forks when transient re-attach fails", async () => {
    let clock = 1_000_000;
    let resumeAttempts = 0;
    const h = await harness(
      {
        "thread/resume": () => {
          resumeAttempts += 1;
          if (resumeAttempts === 1) {
            const error = new Error("temporary transport failure");
            (error as { rpcCode?: number }).rpcCode = -32603;
            throw error;
          }
          return { thread: threadPayload("thread-1") };
        },
      },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "first", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();
    clock += 60_000;
    await h.runtime.sweepIdle();
    h.child().requests.length = 0;

    expect(await h.runtime.prompt(sessionId, {
      prompt: "retry later",
      requestId: "req-2",
      attachments: [],
    })).toMatchObject({ ok: false, status: 503 });
    expect(h.runtime.getRegistry().getSession(sessionId)?.threadId).toBe("thread-1");
    expect(h.child().requests.map((request) => request.method)).toEqual(["thread/resume"]);

    expect((await h.runtime.prompt(sessionId, {
      prompt: "retry now",
      requestId: "req-3",
      attachments: [],
    })).ok).toBe(true);
    const methods = h.child().requests.map((request) => request.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  test("a resumed history thread remains materialized when swept", async () => {
    let clock = 1_000_000;
    const h = await harness(
      { "thread/resume": () => ({ thread: threadPayload("thread-history") }) },
      { now: () => clock, threadIdleMs: 1_000 },
    );
    const resumed = await h.runtime.resumeSession({ threadId: "thread-history", mode: "build" });
    expect(
      h.runtime.getRegistry().getThread("thread-history")?.materialized,
    ).toBe(true);

    clock += 60_000;
    await h.runtime.sweepIdle();
    expect(h.runtime.getRegistry().getSession(resumed!.sessionId)?.threadId).toBe(
      "thread-history",
    );
  });

  test("a long-dead session id is eventually forgotten", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });

    clock += 60_000;
    const result = await h.runtime.sweepIdle();

    // Only a tiny mapping was retained, and past retention even that goes.
    expect(result.forgotten).toBe(1);
    expect(h.runtime.getRegistry().getSession(sessionId)).toBeUndefined();
  });

  test("an active session is not forgotten", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 1_000,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    clock += 60_000;
    h.runtime.getRegistry().touch(sessionId);

    expect(await h.runtime.sweepIdle()).toMatchObject({ forgotten: 0 });
    expect(h.runtime.getRegistry().getSession(sessionId)).toBeDefined();
  });

  test("normal activity refreshes durable retention across a runtime restart", async () => {
    let clock = 1_000_000;
    const options = {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    };
    const first = await harness({}, options);
    const { sessionId } = first.runtime.createSession({ mode: "build" });
    await first.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-retained",
      attachments: [],
    });
    first.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.drain();

    // Past half of the short retention window, an ordinary messages read carries
    // the in-memory touch to disk. Repeated status polls inside that window share
    // the same bounded heartbeat rather than writing on every request.
    clock += 6_000;
    await first.runtime.getMessages(sessionId);
    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 10_000,
    });
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
    first.runtime.getStatus(sessionId);
    first.runtime.getStatus(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
    await first.runtime.stop();

    // The original creation time is now outside retention, but the durable
    // activity heartbeat is not, so the same bridge id must survive restart.
    clock += 6_000;
    const second = await harness({}, options);
    expect(await second.runtime.getMessages(sessionId)).not.toBeNull();
    expect(second.runtime.getStatus(sessionId)).toMatchObject({
      status: "idle",
      phase: "idle",
      threadId: "thread-1",
    });
    await second.runtime.stop();
  });

  test("activity heartbeats are bounded by an hour in production settings", async () => {
    let clock = 1_000_000;
    // Default retention (seven days), so the interval is the one-hour cap rather
    // than half of a deliberately short test window.
    const h = await harness({}, { now: () => clock, threadIdleMs: 0, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-hourly",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws", now: () => clock });
    const written = Date.parse((await store.load())[0]!.lastAccessed);

    // A mounted tab polls many times an hour; every touch must not be a write.
    clock += 59 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(written);

    clock += 2 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("disabled retention still heartbeats on the hourly interval", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 0,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-no-retention",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    const written = Date.parse((await store.load())[0]!.lastAccessed);

    // Retention 0 has no half-window to shrink to, so the hourly default applies.
    clock += 30 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(written);

    clock += 31 * 60 * 1000;
    await h.runtime.getMessages(sessionId);
    expect(Date.parse((await store.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("shutdown waits for an in-flight registry write", async () => {
    let clock = 1_000_000;
    const h = await harness({}, {
      now: () => clock,
      threadIdleMs: 0,
      sessionRetentionMs: 10_000,
      sweepIntervalMs: 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, {
      prompt: "materialize",
      requestId: "req-shutdown",
      attachments: [],
    });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const store = (h.runtime as unknown as { store: BridgeSessionStore }).store;
    const upsert = store.upsert.bind(store);
    let landed = false;
    store.upsert = async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await upsert(record);
      landed = true;
    };

    // `getStatus` heartbeats without awaiting, so this write is genuinely in
    // flight when shutdown begins. Abandoning it loses the record the UI's
    // session id resolves through after a restart.
    clock += 6_000;
    h.runtime.getStatus(sessionId);
    await h.runtime.stop();

    expect(landed).toBe(true);
    const verifier = new BridgeSessionStore({
      codexHome,
      cwd: "/tmp/ws",
      now: () => clock,
      retentionMs: 10_000,
    });
    expect(Date.parse((await verifier.load())[0]!.lastAccessed)).toBe(clock);
  });

  test("a thread dropped for a missing rollout releases its runtime state", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    const runtime = h.runtime as unknown as { threadState: Map<string, unknown> };
    expect(runtime.threadState.has("thread-1")).toBe(true);

    // Force the slow path, then delete the rollout underneath it.
    h.runtime.getRegistry().getThread("thread-1")!.unsubscribed = true;
    h.engine.resumeThread = async () => {
      throw new Error("thread/resume: no rollout found for thread id thread-1");
    };

    expect(await h.runtime.getMessages(sessionId)).toEqual([]);
    expect(h.runtime.getRegistry().getSession(sessionId)!.threadId).toBeNull();
    // The diff baselines are the largest per-thread allocation, and the coalescer
    // owns a live timer; neither can be reclaimed by a thread that never returns.
    expect(runtime.threadState.has("thread-1")).toBe(false);
  });

  test("detaching can be disabled", async () => {
    let clock = 1_000_000;
    const h = await harness({}, { now: () => clock, threadIdleMs: 0, sweepIntervalMs: 0 });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    clock += 24 * 60 * 60 * 1000;
    expect(await h.runtime.sweepIdle()).toMatchObject({ detached: 0 });
  });
});



describe("activity polling", () => {
  /** A session mid-turn: its thread is materialized and running. */
  async function workingSession() {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();
    return { h, sessionId };
  }

  /** The scripted child asks for approval on the session's live turn. */
  async function parkApproval(h: Harness): Promise<void> {
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 9101,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        command: "rm -rf build",
        cwd: "/tmp/ws",
      },
    });
    await h.drain();
  }

  test("an unknown session is reported in band as missing", async () => {
    const h = await harness();
    // Not an error: the caller has to be able to tell "this session is gone"
    // apart from "this bridge is too old to answer".
    expect(h.runtime.getActivity("session-never-existed")).toBe("missing");
  });

  test("a session with no thread, and one whose turn finished, are both idle", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    // Never prompted, so no thread has been materialized at all.
    expect(h.runtime.getActivity(sessionId)).toBe("idle");

    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await h.drain();

    expect(h.runtime.getActivity(sessionId)).toBe("idle");
  });

  test("a running turn with nothing parked is working", async () => {
    const { h, sessionId } = await workingSession();
    expect(h.runtime.getStatus(sessionId)?.status).toBe("running");
    expect(h.runtime.getActivity(sessionId)).toBe("working");
  });

  test("a parked approval is waiting rather than working", async () => {
    const { h, sessionId } = await workingSession();
    await parkApproval(h);

    expect(h.runtime.listApprovals(sessionId)).toHaveLength(1);
    expect(h.runtime.getActivity(sessionId)).toBe("waiting");
  });

  test("a parked interaction is waiting rather than working", async () => {
    const { h, sessionId } = await workingSession();
    h.child().stdout.pushMessage({
      jsonrpc: "2.0",
      id: 7101,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{
          id: "language",
          header: "Language",
          question: "Which language?",
          options: [{ label: "TypeScript" }],
        }],
      },
    });
    await h.drain();

    expect(h.runtime.listInteractions(sessionId)).toHaveLength(1);
    expect(h.runtime.getActivity(sessionId)).toBe("waiting");
  });

  test("cancelling, recovering and starting are never reported idle", async () => {
    const { h, sessionId } = await workingSession();
    const context = h.runtime.getRegistry().getThread("thread-1")!;

    for (const phase of ["starting", "cancelling", "recovering"] as const) {
      context.phase = phase;
      // All three map to `running`. Reporting them idle would let the build
      // pipeline advance on a turn that may still be executing.
      expect(phaseToExternalStatus(phase)).toBe("running");
      expect(h.runtime.getActivity(sessionId)).toBe("working");
    }

    await parkApproval(h);
    for (const phase of ["starting", "cancelling", "recovering"] as const) {
      context.phase = phase;
      expect(h.runtime.getActivity(sessionId)).toBe("waiting");
    }
  });

  test("a session awaiting dispatch recovery is working, never idle", async () => {
    const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
    await store.upsert(
      store.toRecord({
        bridgeSessionId: "session-awaiting",
        threadId: "thread-awaiting",
        cwd: "/tmp/ws",
        config: { mode: "build", sandbox: "danger-full-access" },
        title: "Awaiting",
        titleSource: "prompt",
        lastAcceptedRequestId: "req-live",
      }),
    );
    const h = await harness();
    // Startup clears the claim once recovery has run; re-arm it to model the
    // window where a restored thread's last turn may still be executing.
    (h.runtime as unknown as { threadsAwaitingDispatchRecovery: Set<string> })
      .threadsAwaitingDispatchRecovery.add("thread-awaiting");

    // Restored lazily, so there is no thread context — the recovery claim is the
    // only thing standing between this session and a misleading `idle`.
    expect(h.runtime.getRegistry().getThread("thread-awaiting")).toBeUndefined();
    expect(h.runtime.getActivity("session-awaiting")).toBe("working");
  });

  /**
   * The regression this endpoint exists for.
   *
   * The backend polls every persisted session every two seconds. Doing that
   * through `getStatus` touches `lastAccessed` on each poll, which keeps
   * `detachableThreads` permanently false, so the idle sweep never frees a
   * transcript, its render state or its app-server subscription.
   */
  test("polling activity still lets the sweep detach; polling status does not", async () => {
    async function pollPastTheIdleWindow(
      poll: (runtime: AppServerRuntime, sessionId: string) => void,
    ): Promise<{ detached: number; forgotten: number }> {
      let clock = 1_000_000;
      const h = await harness({}, { now: () => clock, sweepIntervalMs: 0 });
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();

      // The backend's own cadence, run past the production idle window.
      for (let elapsed = 0; elapsed <= DEFAULT_THREAD_IDLE_MS + 60_000; elapsed += 2_000) {
        clock += 2_000;
        poll(h.runtime, sessionId);
      }
      return h.runtime.sweepIdle();
    }

    expect(
      await pollPastTheIdleWindow((runtime, sessionId) => {
        runtime.getActivity(sessionId);
      }),
    ).toMatchObject({ detached: 1 });

    // The control: this is exactly what the sweep used to call, and why nothing
    // was ever detached.
    expect(
      await pollPastTheIdleWindow((runtime, sessionId) => {
        runtime.getStatus(sessionId);
      }),
    ).toMatchObject({ detached: 0 });
  });
});



describe("health", () => {
  test("reports engine state, generation and counters", async () => {
    const h = await harness();
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "x", requestId: "req-1", attachments: [] });

    const health = h.runtime.getHealth();
    expect(health).toMatchObject({
      state: "ready",
      generation: 1,
      codexVersion: "0.145.0",
      activeThreads: 1,
      activeTurns: 1,
      bridgeSessions: 1,
    });
    expect(health.environmentFingerprint).toMatch(/^sha256:/);
  });
});



describe("runtime health", () => {
  test("scopes the snapshot to the session's thread when there is one", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    const health = await h.runtime.getRuntimeHealth(sessionId) as Record<string, unknown>;
    expect(health.engine).toBeDefined();
    expect(h.child().requests.find((request) => request.method === "mcpServerStatus/list")?.params)
      .toMatchObject({ threadId: "thread-1" });
  });

  test("an unknown session is rejected instead of returning environment-wide data", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });

    expect(await h.runtime.getRuntimeHealth("session-nope")).toBeNull();
    expect(
      h.child().requests.some((request) => request.method === "mcpServerStatus/list"),
    ).toBe(false);
  });

  /**
   * Protocol drift is what operators watch after a Codex bump, and this is the
   * authenticated surface it is served on — the public `/global/health` payload
   * stays stripped.
   */
  test("carries the engine-global protocol drift counters", async () => {
    const h = await harness({
      "mcpServerStatus/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
      "hooks/list": () => ({ data: [] }),
      "account/rateLimits/read": () => ({ rateLimits: {} }),
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("codex/invented/method", { threadId: "thread-1" });
    await h.drain();

    const health = await h.runtime.getRuntimeHealth(sessionId) as {
      protocol: {
        unknownNotifications: number;
        unsupportedItems: number;
        serverRequests: Record<string, unknown>;
      };
    };
    expect(health.protocol.unknownNotifications).toBe(1);
    expect(health.protocol.unsupportedItems).toBe(0);
    expect(health.protocol.serverRequests).toMatchObject({ pending: expect.any(Number) });
  });
});
