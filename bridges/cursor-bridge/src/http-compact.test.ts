/**
 * `POST /session/:id/compact`: `agent.summarize()` as a turn.
 *
 * The router, the translator and the run follower are production code; only
 * the SDK agent is replaced.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BridgeMessage } from "./state.js";
import { type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";
import {
  deferred,
  startRouterHarness,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";
import { ABANDONED_COMPACTION_NOTE, FAILED_COMPACTION_NOTE } from "./translate.js";

let harness: RouterHarness;

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  await harness.close();
});

function compact(state: SessionState): Promise<Response> {
  return harness.call(`/session/${state.id}/compact`, { method: "POST" });
}

function compactionParts(state: SessionState) {
  return state.messages.flatMap((message: BridgeMessage) =>
    message.parts.filter((part) => part.type === "compaction"),
  );
}

describe("POST /session/:id/compact", () => {
  test("answers once the run starts and settles the boundary with the summary", async () => {
    const state = await harness.createSession();
    const gate = deferred<void>();
    const agent = attachFake(state, { hold: gate.promise, result: "kept the plan" });

    const response = await compact(state);
    expect(response.status).toBe(202);
    expect(agent.summarizes).toBe(1);
    expect(agent.sends).toHaveLength(0);
    // Busy like any turn, with the boundary explaining why.
    expect(state.status).toBe("running");
    expect(compactionParts(state)).toMatchObject([{ toolState: "pending" }]);

    gate.resolve();
    await waitFor(() => state.status === "idle");
    expect(compactionParts(state)).toMatchObject([
      { toolState: "success", content: "kept the plan" },
    ]);
    // The summary belongs on the boundary, not in the transcript as prose.
    expect(
      state.messages.flatMap((message) => message.parts).filter((part) => part.type === "text"),
    ).toEqual([]);
    expect(state.messages.filter((message) => message.role === "user")).toEqual([]);
  });

  test("a summary the run reports as failed fails the boundary, not the session", async () => {
    const state = await harness.createSession();
    attachFake(state, {
      streamMessages: [
        { type: "summary", status: "running" },
        { type: "summary", status: "error" },
      ],
    });

    expect((await compact(state)).status).toBe(202);
    await waitFor(() => state.status === "idle");
    expect(compactionParts(state)).toMatchObject([
      { toolState: "failure", content: FAILED_COMPACTION_NOTE },
    ]);
    expect(state.error).toBeUndefined();
  });

  test("a cancel stops the run and leaves a failed boundary", async () => {
    const state = await harness.createSession();
    const gate = deferred<void>();
    const agent = attachFake(state, { hold: gate.promise });

    expect((await compact(state)).status).toBe(202);
    const cancelled = await harness.call(`/session/${state.id}/cancel`, { method: "POST" });
    expect(cancelled.ok).toBe(true);
    expect(agent.cancels).toBe(1);

    gate.resolve();
    await waitFor(() => state.status === "idle");
    expect(compactionParts(state)).toMatchObject([
      { toolState: "failure", content: ABANDONED_COMPACTION_NOTE },
    ]);
  });

  test("a run that errors fails the boundary and reports the session error", async () => {
    const state = await harness.createSession();
    attachFake(state, { status: "error", errorMessage: "model unavailable" });

    expect((await compact(state)).status).toBe(202);
    await waitFor(() => state.status === "error");
    expect(compactionParts(state)).toMatchObject([{ toolState: "failure" }]);
    expect(state.error).toBe("model unavailable");
  });

  test("refuses while a turn is running, without touching the agent", async () => {
    const state = await harness.createSession();
    const gate = deferred<void>();
    const agent = attachFake(state, { hold: gate.promise });
    const prompt = await harness.call(`/session/${state.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: "synthetic prompt", requestId: "busy-1" }),
    });
    expect(prompt.status).toBe(202);

    expect((await compact(state)).status).toBe(409);
    expect(agent.summarizes).toBe(0);

    gate.resolve();
    await waitFor(() => state.status === "idle");
  });

  test("a session with no saved conversation is told so and stays usable", async () => {
    const state = await harness.createSession();
    const agent = attachFake(state, {
      failSummarize: Object.assign(new Error("Agent x has no saved conversation"), {
        name: "ConfigurationError",
      }),
    });

    const response = await compact(state);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This Cursor session has nothing to compact yet",
    });
    expect(state.status).toBe("idle");
    expect(state.dispatching).toBe(false);
    expect(compactionParts(state)).toEqual([]);
    // The agent is fine: only an unexplained failure detaches it.
    expect(state.agent).toBe(agent);
  });

  test("a configuration error that is not about history is not called empty", async () => {
    const state = await harness.createSession();
    attachFake(state, {
      failSummarize: Object.assign(new Error("Local SDK agents require an explicit `model`"), {
        name: "ConfigurationError",
      }),
    });

    const response = await compact(state);
    expect(response.status).toBe(502);
    expect(state.status).toBe("idle");
  });

  test("an unexplained start failure answers fixed text and detaches the agent", async () => {
    const state = await harness.createSession();
    attachFake(state, { failSummarize: new Error("secret path /Users/someone") });

    const response = await compact(state);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Cursor could not start compaction" });
    expect(state.status).toBe("idle");
    expect(state.dispatching).toBe(false);
    await waitFor(() => state.agent === null || state.agent === undefined);
  });
});
