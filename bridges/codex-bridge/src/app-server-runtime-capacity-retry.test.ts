import { describe, expect, test } from "bun:test";

import { harness, type Harness } from "./app-server-runtime-test-harness.js";
import type { NormalizedPart } from "./messages/types.js";
import {
  CAPACITY_RETRY_CANCELLED_TEXT,
  CAPACITY_RETRY_CONTINUATION_MARKER,
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
});
