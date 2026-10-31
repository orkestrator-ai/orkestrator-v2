import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  codexHome,
  deferredSignal,
  harness,
  threadPayload,
  waitUntil,
  type Harness,
} from "./app-server-runtime-test-harness.js";
import type { NormalizedPart } from "./messages/types.js";
import {
  CAPACITY_RETRY_CANCELLED_TEXT,
  CAPACITY_RETRY_CONTINUATION_MARKER,
  CODEX_POLICY_CAPACITY_UNAVAILABLE_MESSAGE,
  CODEX_SERVER_OVERLOADED_MESSAGE,
} from "./sessions/capacity-retry.js";

/** `turn/completed` for a capacity refusal, as codex 0.164.0 reports one. */
const OVERLOADED = { message: CODEX_SERVER_OVERLOADED_MESSAGE, codexErrorInfo: "serverOverloaded" };

/** Fast waits for most tests; `random: 1` makes every wait its nominal length. */
const FAST = { baseDelayMs: 5, multiplier: 2, maxDelayMs: 50 };

/** Each `turn/start` names a new turn: turn-1, turn-2, … */
function numberedTurns(): Record<string, () => unknown> {
  let turns = 0;
  return { "turn/start": () => ({ turn: { id: `turn-${++turns}` } }) };
}

function turnStarts(h: Harness) {
  return h.child().requests.filter((request) => request.method === "turn/start");
}

function failTurn(h: Harness, turnId: string, error: unknown = OVERLOADED): void {
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "failed", error },
  });
}

function answer(h: Harness, turnId: string, text: string): void {
  h.child().notify("item/completed", {
    threadId: "thread-1",
    turnId,
    item: { id: `answer-${turnId}`, type: "agentMessage", text },
  });
  h.child().notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "completed" },
  });
}

async function parts(h: Harness, sessionId: string): Promise<NormalizedPart[]> {
  const messages = (await h.runtime.getMessages(sessionId)) ?? [];
  return messages.flatMap((message) => message.parts);
}

async function retryCards(h: Harness, sessionId: string) {
  return (await parts(h, sessionId))
    .filter((part) => part.type === "retry")
    .map((part) => ({ content: part.content, toolState: part.toolState }));
}

function errors(h: Harness) {
  return h.events.filter((event) => event.type === "session.error");
}

describe("capacity retry", () => {
  test("continues a turn the model refused for capacity and succeeds", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: FAST,
      capacityRetryRandom: () => 1,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    failTurn(h, "turn-1");
    await h.drain();
    // Still the same turn: nothing reads as failed while the retry is due.
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "running", phase: "running" });
    expect(errors(h)).toEqual([]);

    await h.child().waitForRequest("turn/start", 2);
    await h.drain();
    const retry = turnStarts(h)[1]!.params;
    expect(retry.clientUserMessageId).toBe("req-1:capacity-retry:2");
    const text = (retry.input as Array<{ text: string }>)[0]!.text;
    expect(text.startsWith(`${CAPACITY_RETRY_CONTINUATION_MARKER} attempt 2 of 5.`)).toBe(true);
    expect(text).not.toContain("go");
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "running", turnId: "turn-2" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "accepted",
      turnId: "turn-2",
    });

    answer(h, "turn-2", "Done");
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "completed",
      turnId: "turn-2",
    });
    expect(errors(h)).toEqual([]);
    // One user message: the continuation is the bridge's, never shown as typed.
    const messages = (await h.runtime.getMessages(sessionId)) ?? [];
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(await retryCards(h, sessionId)).toEqual([
      {
        content: "Model at capacity, retried automatically (attempt 2 of 5)",
        toolState: "success",
      },
    ]);
    expect((await parts(h, sessionId)).some((part) => part.type === "status")).toBe(false);
    expect((await parts(h, sessionId)).some((part) => part.content === "Done")).toBe(true);
  });

  test("continues a turn refused for policy-restricted capacity", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: FAST,
      capacityRetryRandom: () => 1,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    failTurn(h, "turn-1", {
      message: CODEX_POLICY_CAPACITY_UNAVAILABLE_MESSAGE,
      codexErrorInfo: "policyCapacityUnavailable",
    });
    await h.drain();
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "running", phase: "running" });
    expect(errors(h)).toEqual([]);

    await h.child().waitForRequest("turn/start", 2);
    await h.drain();
    answer(h, "turn-2", "Done");
    await h.drain();
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(errors(h)).toEqual([]);
    expect(turnStarts(h)).toHaveLength(2);
  });

  test("ends with the original error once retries are exhausted", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: { ...FAST, maxAttempts: 3 },
      capacityRetryRandom: () => 0,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    failTurn(h, "turn-1");
    await h.child().waitForRequest("turn/start", 2);
    await h.drain();
    failTurn(h, "turn-2");
    await h.child().waitForRequest("turn/start", 3);
    await h.drain();
    expect(errors(h)).toEqual([]);
    failTurn(h, "turn-3");
    await h.drain();

    const exhausted = `${CODEX_SERVER_OVERLOADED_MESSAGE} Automatic retries exhausted after 3 attempts.`;
    expect(turnStarts(h)).toHaveLength(3);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "error", error: exhausted });
    expect(errors(h).map((event) => event.data)).toEqual([{ error: exhausted }]);
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "failed",
      turnId: "turn-3",
    });
    expect(await retryCards(h, sessionId)).toEqual([
      expect.objectContaining({ toolState: "success" }),
      expect.objectContaining({ toolState: "success" }),
    ]);
    expect(await parts(h, sessionId)).toContainEqual({
      type: "status",
      severity: "error",
      content: exhausted,
    });
  });

  test.each([
    [
      "a usage limit",
      { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    ],
    ["a rate limit", { message: "Rate limit reached.", codexErrorInfo: "rateLimitExceeded" }],
    ["a refused login", { message: "Unauthorized", codexErrorInfo: "unauthorized" }],
    [
      "a 401",
      {
        message: "unexpected status 401 Unauthorized",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      },
    ],
    [
      "a 403",
      {
        message: "Forbidden",
        codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 403 } },
      },
    ],
    ["an invalid request", { message: "Invalid request", codexErrorInfo: "badRequest" }],
    [
      "capacity text under another code",
      { message: CODEX_SERVER_OVERLOADED_MESSAGE, codexErrorInfo: "other" },
    ],
  ])("never retries %s", async (_label, error) => {
    const h = await harness(numberedTurns(), { capacityRetry: FAST });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    failTurn(h, "turn-1", error);
    await h.drain();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.drain();

    expect(turnStarts(h)).toHaveLength(1);
    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      error: error.message,
    });
    expect(errors(h)).toHaveLength(1);
    expect(await retryCards(h, sessionId)).toEqual([]);
  });

  test("shows the wait in the transcript, and Stop during it cancels the retry", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: { baseDelayMs: 8_000 },
      capacityRetryRandom: () => 1,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });

    failTurn(h, "turn-1");
    await h.drain();
    expect(await retryCards(h, sessionId)).toEqual([
      { content: "Model at capacity, retrying in 8 s (attempt 2 of 5)", toolState: "pending" },
    ]);
    // The card reached mounted tabs, not only the snapshot.
    expect(
      h.events.some((event) =>
        JSON.stringify(event.data).includes("retrying in 8 s (attempt 2 of 5)"),
      ),
    ).toBe(true);

    expect(await h.runtime.abort(sessionId)).toEqual({ status: "cancelling", phase: "cancelling" });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(turnStarts(h)).toHaveLength(1);
    // The refused turn already ended; there was nothing to interrupt.
    expect(h.child().requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "interrupted",
    });
    expect(errors(h)).toEqual([]);
    expect(await retryCards(h, sessionId)).toEqual([
      { content: CAPACITY_RETRY_CANCELLED_TEXT, toolState: "failure" },
    ]);
  });

  test("Stop while the continuation is starting interrupts it once app-server names it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turns = 0;
    const h = await harness(
      {
        "turn/start": () => {
          turns += 1;
          const turn = { turn: { id: `turn-${turns}` } };
          return turns === 1 ? turn : gate.then(() => turn);
        },
      },
      { capacityRetry: FAST, capacityRetryRandom: () => 1 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    failTurn(h, "turn-1");
    await h.child().waitForRequest("turn/start", 2);

    expect(await h.runtime.abort(sessionId)).toEqual({ status: "cancelling", phase: "cancelling" });
    release();
    await h.child().waitForRequest("turn/interrupt");
    const interrupt = h.child().requests.find((request) => request.method === "turn/interrupt");
    expect(interrupt!.params).toMatchObject({ threadId: "thread-1", turnId: "turn-2" });
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "interrupted" },
    });
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "interrupted" });
    expect(errors(h)).toEqual([]);
    expect(await retryCards(h, sessionId)).toEqual([
      { content: CAPACITY_RETRY_CANCELLED_TEXT, toolState: "failure" },
    ]);
  });

  test("an unattended schema turn reads running throughout and is credited after the retry", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: { ...FAST, baseDelayMs: 40 },
      capacityRetryRandom: () => 1,
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    await h.runtime.prompt(sessionId, {
      prompt: "Fix the findings",
      requestId: "fix-1",
      attachments: [],
      outputSchema,
    });

    // What a Multi Review step or build stage polls: the status route's
    // `status`, and `/dispatch`'s pending flag from the journal record.
    const polls: Array<{ status: string; pending: boolean }> = [];
    const poll = () =>
      polls.push({
        status: String(h.runtime.getStatus(sessionId)?.status),
        pending: h.runtime.getJournal().get("fix-1")?.state === "accepted",
      });
    failTurn(h, "turn-1");
    await h.drain();
    poll();
    const started = h.child().waitForRequest("turn/start", 2);
    const sampler = setInterval(poll, 2);
    await started;
    await h.drain();
    poll();
    clearInterval(sampler);
    expect(polls.length).toBeGreaterThan(2);
    expect(polls.every((entry) => entry.status === "running" && entry.pending)).toBe(true);
    expect(turnStarts(h)[1]!.params.outputSchema).toEqual(outputSchema);

    answer(h, "turn-2", JSON.stringify({ summary: "Fixed" }));
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(h.runtime.getStructuredOutput(sessionId, "fix-1")).toEqual({
      requestId: "fix-1",
      structuredOutput: {
        ok: true,
        provider: "codex",
        requestId: "fix-1",
        value: { summary: "Fixed" },
      },
    });
    expect(errors(h)).toEqual([]);
  });

  test("a continuation that never started ends the turn with the refusal", async () => {
    let turns = 0;
    const h = await harness(
      {
        "turn/start": () => {
          turns += 1;
          if (turns === 1) return { turn: { id: "turn-1" } };
          throw Object.assign(new Error("thread not found"), { rpcCode: -32600 });
        },
      },
      { capacityRetry: FAST, capacityRetryRandom: () => 1 },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    failTurn(h, "turn-1");
    await h.child().waitForRequest("turn/start", 2);
    await h.drain();

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      error: CODEX_SERVER_OVERLOADED_MESSAGE,
    });
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "failed" });
    expect(errors(h)).toHaveLength(1);
  });

  test("bridge shutdown during the wait fails the turn instead of starting one", async () => {
    const h = await harness(numberedTurns(), {
      capacityRetry: { baseDelayMs: 60_000 },
    });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    failTurn(h, "turn-1");
    await h.drain();

    await h.runtime.stop();

    expect(turnStarts(h)).toHaveLength(1);
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "failed" });
  });

  test.each(["waiting", "starting"])(
    "deleting the last session cancels a %s retry before unsubscribe",
    async (stage) => {
      const gate = deferredSignal();
      let turns = 0;
      let h!: Harness;
      h = await harness(
        {
          "turn/start": () =>
            ++turns === 1
              ? { turn: { id: "turn-1" } }
              : gate.promise.then(() => ({ turn: { id: "turn-2" } })),
          "turn/interrupt": (params) => {
            h.child().notify("turn/completed", {
              threadId: "thread-1",
              turn: { id: params.turnId, status: "interrupted" },
            });
            return {};
          },
        },
        {
          capacityRetry: stage === "waiting" ? { baseDelayMs: 60_000 } : FAST,
          capacityRetryRandom: () => 1,
        },
      );
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
      failTurn(h, "turn-1");
      if (stage === "starting") await h.child().waitForRequest("turn/start", 2);
      else await h.drain();
      const deletion = h.runtime.deleteSession(sessionId);
      if (stage === "starting") {
        await Promise.resolve();
        expect(h.child().requests.some((r) => r.method === "thread/unsubscribe")).toBe(false);
        gate.resolve();
      }
      expect(await deletion).toBe(true);
      await h.drain();
      const methods = h.child().requests.map((r) => r.method);
      if (stage === "starting")
        expect(methods.indexOf("turn/interrupt")).toBeLessThan(
          methods.indexOf("thread/unsubscribe"),
        );
      else expect(methods).not.toContain("turn/interrupt");
      expect(h.runtime.getJournal().get("req-1")).toMatchObject({
        state: "terminal",
        terminalStatus: "interrupted",
      });
      expect(h.runtime.getRegistry().getThread("thread-1")).toBeUndefined();
    },
  );

  test("parent exit really settles a waiting retry as a restart failure", async () => {
    const h = await harness(numberedTurns(), { capacityRetry: { baseDelayMs: 60_000 } });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    failTurn(h, "turn-1");
    await h.drain();
    const turn = h.runtime.getRegistry().getThread("thread-1")!.activeTurn!;
    expect(await h.runtime.interruptForParentExit(100)).toBe(0);
    await h.drain();
    expect(turn.stoppedByShutdown).toBe(true);
    expect(turn.error?.code).toBe("app-server-restarted");
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "failed" });
    expect(turnStarts(h)).toHaveLength(1);
    expect(await retryCards(h, sessionId)).toEqual([
      { content: CAPACITY_RETRY_CANCELLED_TEXT, toolState: "failure" },
    ]);
  });

  test("a standalone capacity error before completion does not survive a successful retry", async () => {
    const h = await harness(numberedTurns(), { capacityRetry: FAST });
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    const turn = h.runtime.getRegistry().getThread("thread-1")!.activeTurn!;
    h.child().notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: OVERLOADED,
      willRetry: false,
    });
    failTurn(h, "turn-1");
    await h.child().waitForRequest("turn/start", 2);
    await h.drain();
    answer(h, "turn-2", "Done");
    await h.drain();
    expect(turn.error).toBeUndefined();
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ status: "idle" });
    expect(errors(h)).toEqual([]);
  });

  test("notifications stay ordered while continuation acceptance is persisted", async () => {
    const gate = deferredSignal();
    const rollout = join(codexHome, "ordered-retry.jsonl");
    writeFileSync(rollout, "{}\n");
    const watches = new Set<symbol>();
    let turns = 0;
    let h!: Harness;
    h = await harness(
      {
        "thread/start": () => ({ thread: threadPayload("thread-1", { path: rollout }) }),
        "turn/start": () => {
          if (++turns === 1) return { turn: { id: "turn-1" } };
          h.child().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
          h.child().notify("item/completed", {
            threadId: "thread-1",
            turnId: "turn-2",
            item: { id: "early", type: "agentMessage", text: "Early" },
          });
          return { turn: { id: "turn-2" } };
        },
      },
      {
        capacityRetry: FAST,
        watchRolloutFile: () => {
          const token = Symbol();
          watches.add(token);
          return { close: () => watches.delete(token) };
        },
      },
    );
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    h.child().notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
    await h.drain();
    expect(watches.size).toBe(1);
    const journal = h.runtime.getJournal();
    const accept = journal.markAccepted.bind(journal);
    let persisting = false;
    journal.markAccepted = async (...args) => {
      persisting = true;
      await gate.promise;
      await accept(...args);
    };
    failTurn(h, "turn-1");
    await waitUntil(() => persisting, "continuation did not reach acceptance");
    answer(h, "turn-2", "Late");
    await h.engine.drainNotifications("thread-1");
    expect(h.runtime.getJournal().get("req-1")?.state).toBe("accepted");
    gate.resolve();
    await h.drain();
    const texts = (await parts(h, sessionId))
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join(" ");
    expect(texts).toContain("Early");
    expect(texts.indexOf("Early")).toBeLessThan(texts.indexOf("Late"));
    expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "completed" });
    expect(h.events.filter((event) => event.type === "session.idle")).toHaveLength(1);
    expect(watches.size).toBe(0);
  });

  test.each(["inProgress", "interrupted"])(
    "generation and startup recovery follow the %s continuation",
    async (status) => {
      const persisted = () => ({
        thread: threadPayload("thread-1", {
          turns: [
            {
              id: "turn-1",
              status: "failed",
              error: OVERLOADED,
              items: [{ id: "u1", type: "userMessage", clientId: "req-1", content: [] }],
            },
            {
              id: "turn-2",
              status,
              items: [
                { id: "u2", type: "userMessage", clientId: "req-1:capacity-retry:2", content: [] },
              ],
            },
          ],
        }),
      });
      const h = await harness(
        { ...numberedTurns(), "thread/read": persisted },
        { capacityRetry: FAST },
      );
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
      failTurn(h, "turn-1");
      await h.child().waitForRequest("turn/start", 2);
      await h.drain();
      await h.engine.getSupervisor().restartNow("test continuation recovery");
      await h.drain();
      expect(h.runtime.getJournal().get("req-1")).toMatchObject({
        turnId: "turn-2",
        providerRequestId: "req-1:capacity-retry:2",
        ...(status === "interrupted" ? { terminalStatus: "failed" } : { state: "accepted" }),
      });
      if (status === "inProgress")
        expect(h.runtime.getStatus(sessionId)).toMatchObject({
          status: "running",
          turnId: "turn-2",
        });
      else expect(h.runtime.getRegistry().getThread("thread-1")?.activeTurn).toBeNull();

      // Use an unresolved record for the independent bridge-process startup path.
      await h.runtime
        .getJournal()
        .markAccepted("req-1", { threadId: "thread-1", turnId: "turn-2" });
      await h.runtime.stop();
      const restored = await harness({ "thread/read": persisted });
      await restored.drain();
      expect(restored.runtime.getJournal().get("req-1")).toMatchObject({
        turnId: "turn-2",
        ...(status === "interrupted" ? { terminalStatus: "failed" } : { state: "accepted" }),
      });
      expect(restored.runtime.getStatus(sessionId)).toMatchObject(
        status === "inProgress" ? { status: "running", turnId: "turn-2" } : { status: "error" },
      );
      expect(turnStarts(restored)).toHaveLength(0);
    },
  );

  test.each(["inProgress", "completed", "failed", "absent", "unreadable"])(
    "ambiguous continuation reconciles %s authoritative state",
    async (status) => {
      let turns = 0;
      let readable = status !== "unreadable";
      const persisted = () => {
        if (!readable) throw new Error("read unavailable");
        return {
          thread: threadPayload("thread-1", {
            turns:
              status === "absent"
                ? []
                : [
                    {
                      id: "turn-2",
                      status: status === "unreadable" ? "inProgress" : status,
                      ...(status === "failed" ? { error: OVERLOADED } : {}),
                      items: [
                        {
                          id: "u2",
                          type: "userMessage",
                          clientId: "req-1:capacity-retry:2",
                          content: [],
                        },
                        ...(status === "completed"
                          ? [
                              {
                                id: "answer",
                                type: "agentMessage",
                                text: '{"summary":"Recovered"}',
                              },
                            ]
                          : []),
                      ],
                    },
                  ],
          }),
        };
      };
      const h = await harness(
        {
          "turn/start": () => {
            if (++turns === 2) throw new Error("lost response");
            return { turn: { id: `turn-${turns}` } };
          },
          "thread/read": persisted,
        },
        { capacityRetry: FAST, ambiguousRecoveryTimeoutMs: 60_000 },
      );
      const { sessionId } = h.runtime.createSession({ mode: "build" });
      await h.runtime.prompt(sessionId, {
        prompt: "go",
        requestId: "req-1",
        attachments: [],
        ...(status === "completed"
          ? {
              outputSchema: {
                type: "object",
                properties: { summary: { type: "string" } },
                required: ["summary"],
                additionalProperties: false,
              },
            }
          : {}),
      });
      failTurn(h, "turn-1");
      await h.child().waitForRequest("turn/start", 2);
      await h.drain();
      if (status === "completed") {
        expect(h.runtime.getStructuredOutput(sessionId, "req-1")).toMatchObject({
          requestId: "req-1",
          structuredOutput: { ok: true, value: { summary: "Recovered" } },
        });
        expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "completed" });
      } else if (status === "failed") {
        await h.child().waitForRequest("turn/start", 3);
        await h.drain();
        failTurn(h, "turn-3", { message: "Provider detail", codexErrorInfo: "badRequest" });
        await h.drain();
        expect(h.runtime.getStatus(sessionId)).toMatchObject({
          status: "error",
          error: "Provider detail",
        });
        expect(turnStarts(h)).toHaveLength(3);
      } else if (status === "absent") {
        expect(h.runtime.getJournal().get("req-1")).toMatchObject({ terminalStatus: "failed" });
        expect(turnStarts(h)).toHaveLength(2);
      } else {
        if (status === "unreadable") {
          expect(h.runtime.getStatus(sessionId)).toMatchObject({ phase: "recovering" });
          readable = true;
          await h.engine.getSupervisor().restartNow("test reconciliation recovery");
          await h.drain();
        }
        expect(h.runtime.getStatus(sessionId)).toMatchObject({
          status: "running",
          turnId: "turn-2",
        });
        if (status === "unreadable") {
          // Recovery must retain the attempt number too; reusing client id 2
          // would reattach to the capacity-failed continuation forever.
          failTurn(h, "turn-2");
          await h.child().waitForRequest("turn/start");
          await h.drain();
          expect(turnStarts(h)[0]!.params.clientUserMessageId).toBe("req-1:capacity-retry:3");
          answer(h, "turn-3", "Recovered");
        } else answer(h, "turn-2", "Recovered");
        await h.drain();
        expect(h.runtime.getJournal().get("req-1")).toMatchObject({
          terminalStatus: "completed",
          turnId: status === "unreadable" ? "turn-3" : "turn-2",
        });
      }
    },
  );
});
