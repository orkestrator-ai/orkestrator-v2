/**
 * `POST /session/:id/compact`: `agent.summarize()` as a turn.
 *
 * The router, the translator and the run follower are production code; only
 * the SDK agent is replaced.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BridgeMessage } from "./state.js";
import { type SessionState } from "./state.js";
import { attachFake, fakeAgent } from "./testing/fake-agent.js";
import {
  deferred,
  holdPublication,
  stubAttach,
  startRouterHarness,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";
import { modelSelection } from "./models.js";
import { sessions } from "./state.js";
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

  test("uses the latest model and parameters on the same durable conversation", async () => {
    const state = await harness.createSession();
    state.composer = {
      ...state.composer,
      selectedModelId: "model-a",
      models: [
        { platform: "cursor", id: "model-a", label: "A" },
        {
          platform: "cursor",
          id: "model-b",
          label: "B",
          supportsSpeed: true,
          reasoning: [{ id: "high", label: "High" }],
          parameters: [
            {
              id: "context",
              label: "Context",
              kind: "select",
              scope: "turn",
              options: [{ id: "max", label: "Max" }],
            },
          ],
        },
      ],
    };
    const original = attachFake(state, { result: "previous answer" });
    expect(
      (
        await harness.call(`/session/${state.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ prompt: "keep this history", requestId: "warm" }),
        })
      ).status,
    ).toBe(202);
    await waitFor(() => state.status === "idle");
    const history = structuredClone(state.messages);
    const changed = await harness.call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({
        modelId: "model-b",
        reasoningId: "high",
        fastMode: true,
        parameterValues: { context: "max" },
      }),
    });
    expect(changed.status).toBe(200);
    expect(state.agent).toBe(original);
    const current = modelSelection(state.composer);
    expect(current).toEqual({
      id: "model-b",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "context", value: "max" },
      ],
    });
    const resumed = fakeAgent({ initialModel: current, result: "summary" });
    const loads: string[] = [];
    const restore = stubAttach({
      resume: async (id, options) => {
        loads.push(id);
        expect(options.model).toEqual(current);
        return resumed;
      },
    });
    try {
      expect((await compact(state)).status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(loads).toEqual([original.agentId]);
      expect(resumed.summaryModels).toEqual([current]);
      expect(original.summarizes).toBe(0);
      expect(state.agentId).toBe(original.agentId);
      expect(state.messages.slice(0, history.length)).toEqual(history);
    } finally {
      restore();
    }
  });

  test("a failed model reattach retains the conversation instead of creating another", async () => {
    const state = await harness.createSession();
    attachFake(state);
    const id = state.agentId;
    state.composer.selectedModelId = "changed-model";
    const restore = stubAttach({
      resume: async () => {
        throw new Error("resume failed");
      },
    });
    try {
      expect((await compact(state)).status).toBe(500);
      expect(state.agentId).toBe(id);
      expect(state.agent).toBeNull();
      expect(state.configResumePending).toBe(true);
      expect(state.dispatching).toBe(false);
    } finally {
      restore();
    }
  });

  for (const phase of ["attach", "publication", "summarize"] as const) {
    for (const action of ["cancel", "close"] as const) {
      test(`${action} during ${phase} leaves no abandoned compaction run`, async () => {
        const state = await harness.createSession();
        const startup = deferred<void>();
        const running = deferred<void>();
        const agent = fakeAgent({
          initialModel: modelSelection(state.composer),
          ...(phase === "summarize" ? { holdSend: startup.promise, hold: running.promise } : {}),
        });
        const restoreAttach =
          phase === "attach"
            ? stubAttach({
                create: async () => {
                  await startup.promise;
                  return agent;
                },
              })
            : undefined;
        if (phase !== "attach") {
          state.agent = agent;
          state.agentId = agent.agentId;
        }
        const publication = phase === "publication" ? holdPublication() : undefined;
        const dispatch = compact(state);
        try {
          if (phase === "publication") await publication!.held;
          else
            await waitFor(() =>
              phase === "attach" ? Boolean(state.attaching) : agent.summarizes === 1,
            );
          const stop = harness.call(`/session/${state.id}/${action}`, { method: "POST" });
          await waitFor(() =>
            action === "close"
              ? state.closed === true
              : state.pendingCancelPromptSequence !== undefined,
          );
          publication?.release();
          startup.resolve();
          if (phase === "summarize") {
            await waitFor(() => agent.cancels > 0);
            expect(state.activeRun).toBeDefined();
            running.resolve();
          }
          const [started, stopped] = await Promise.all([dispatch, stop]);
          expect(stopped.status).toBe(action === "cancel" ? 202 : 200);
          if (action === "close") {
            expect(await stopped.json()).toMatchObject({ closed: true, retained: true });
            expect(sessions.has(state.id)).toBe(false);
          } else expect(started.status).toBe(202);
          expect(agent.summarizes).toBe(phase === "summarize" ? 1 : 0);
          await waitFor(() => !state.activeRun && !state.dispatching);
          expect(state.cancelTurn).toBeUndefined();
        } finally {
          startup.resolve();
          running.resolve();
          publication?.restore();
          restoreAttach?.();
          await dispatch;
        }
      });
    }
  }

  test.each([undefined, "provider failure detail"])(
    "a failed summary with result %s fails the boundary, not the session",
    async (result) => {
      const state = await harness.createSession();
      attachFake(state, {
        result,
        streamMessages: [
          { type: "summary", status: "running" },
          { type: "summary", status: "error" },
        ],
      });

      expect((await compact(state)).status).toBe(202);
      await waitFor(() => state.status === "idle");
      expect(compactionParts(state)).toMatchObject([
        {
          toolState: "failure",
          content: result ? `${FAILED_COMPACTION_NOTE}.\n\n${result}` : FAILED_COMPACTION_NOTE,
        },
      ]);
      expect(state.error).toBeUndefined();
    },
  );

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
