/**
 * The change signal (to-do 8102 task 2, D7): the state revision moves on every
 * change of what the backend's state read gets, `/status` answers a
 * still-current `knownStateRevision` with `unchanged`, and the observe stream
 * announces each change with the revisions.
 *
 * The harness (`expectStateRevisionMoves`) reads the state exactly as the
 * backend does — `/status` without the query, `/approvals`, `/interactions` —
 * before and after each mutation path the bridge's other suites drive, and
 * fails when that read changed but the revision peeked without reading did
 * not. A new mutation path belongs here too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bridgeObservationRevisionVersion,
  isBridgeStateUnchanged,
  parseBridgeObservationFrame,
} from "@orkestrator/protocol/bridge-state-revision";
import { expectStateRevisionMoves } from "@orkestrator/protocol/node/bridge-state-revision";
import { detachAgent } from "./agent-session.js";
import { refreshAgentUsage } from "./prompt.js";
import { publicStatus } from "./public.js";
import { closeSessionPermanently } from "./session-close.js";
import { sessions, type SessionState } from "./state.js";
import {
  observationHub,
  stateReadContent,
  stateRevisions,
  transcriptRevision,
} from "./state-revision.js";
import { noteSteerRefusal } from "./steer-journal.js";
import { attachFake, fakeAgent } from "./testing/fake-agent.js";
import {
  defaultPolicy,
  deferred,
  startRouterHarness,
  stubAttach,
  waitFor,
  type RouterHarness,
} from "./testing/router-harness.js";
import { applyInteractionUpdate } from "./translate.js";

let harness: RouterHarness;

beforeEach(async () => {
  harness = await startRouterHarness();
});

afterEach(async () => {
  observationHub.close();
  await harness.close();
});

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await harness.call(path);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Everything the backend's state read gets for a Cursor session. */
async function stateRead(state: SessionState): Promise<unknown> {
  const [status, approvals, interactions] = await Promise.all([
    getJson(`/session/${state.id}/status`),
    getJson(`/session/${state.id}/approvals`),
    getJson(`/session/${state.id}/interactions`),
  ]);
  return stateReadContent({ status, approvals, interactions });
}

function moves(label: string, state: SessionState, mutate: () => unknown) {
  return expectStateRevisionMoves({
    label,
    read: () => stateRead(state),
    peek: () => stateRevisions.peek(state.id),
    mutate,
  });
}

function prompt(state: SessionState, body: Record<string, unknown>): Promise<Response> {
  return harness.call(`/session/${state.id}/prompt`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("the state revision moves with every state change", () => {
  test("a prompt's start, live usage, todo list, drift and finish", async () => {
    const state = await harness.createSession();
    const gate = deferred();
    attachFake(state, { hold: gate.promise, result: "done" });

    expect(
      await moves("prompt start", state, async () => {
        expect((await prompt(state, { prompt: "hi", requestId: "r1" })).status).toBe(202);
      }),
    ).toMatchObject({ changed: true });
    // The run handle (`turnId`) lands after the 202.
    await waitFor(() => state.activeRun !== undefined);

    expect(
      await moves("token delta", state, () =>
        applyInteractionUpdate(state, { type: "token-delta", tokens: 17 }),
      ),
    ).toMatchObject({ changed: true });
    expect(
      await moves("todo list", state, () =>
        applyInteractionUpdate(state, {
          type: "tool-call-completed",
          callId: "todos-1",
          modelCallId: "m1",
          toolCall: {
            type: "updateTodos",
            args: { todos: [{ content: "Ship it", status: "completed" }] },
            result: {
              status: "success",
              value: { todos: [{ content: "Ship it", status: "completed" }] },
            },
          },
        }),
      ),
    ).toMatchObject({ changed: true });
    expect(
      await moves("unknown update", state, () =>
        applyInteractionUpdate(state, { type: "an-sdk-addition" }),
      ),
    ).toMatchObject({ changed: true });
    expect(
      await moves("model call usage", state, () =>
        applyInteractionUpdate(state, {
          type: "turn-ended",
          usage: { inputTokens: 40, outputTokens: 2 },
        }),
      ),
    ).toMatchObject({ changed: true });

    expect(
      await moves("prompt finish", state, async () => {
        gate.resolve();
        await waitFor(() => state.status === "idle" && state.activeRun === undefined);
      }),
    ).toMatchObject({ changed: true });
  });

  test("a transcript-only change leaves the state read and its revision alone", async () => {
    const state = await harness.createSession();
    const before = transcriptRevision(state);
    expect(
      await moves("text delta", state, () =>
        applyInteractionUpdate(state, { type: "text-delta", text: "Hello" }),
      ),
    ).toEqual({ changed: false, moved: false });
    expect(transcriptRevision(state)).not.toBe(before);

    const local = transcriptRevision(state);
    await moves("idle steer reply", state, async () => {
      expect((await prompt(state, { prompt: "/steer go", requestId: "s1" })).status).toBe(200);
    });
    expect(transcriptRevision(state)).not.toBe(local);
  });

  test("a turn that fails, and a send that never started", async () => {
    const failed = await harness.createSession();
    attachFake(failed, { status: "error", errorMessage: "model unavailable" });
    await moves("prompt error", failed, async () => {
      await prompt(failed, { prompt: "hi", requestId: "r1" });
      await waitFor(() => failed.status === "error" && failed.activeRun === undefined);
    });

    const unstarted = await harness.createSession();
    attachFake(unstarted, { failToStart: new Error("transport closed") });
    expect(
      await moves("send failed", unstarted, async () => {
        expect((await prompt(unstarted, { prompt: "hi", requestId: "r1" })).status).toBe(502);
      }),
    ).toMatchObject({ changed: true });
  });

  test("composer, policy and read-only boundary changes", async () => {
    const state = await harness.createSession({ clientSessionKey: "tab", model: "composer-2" });
    attachFake(state);
    expect(
      await moves("model and mode", state, async () => {
        const response = await harness.call(`/session/${state.id}/config`, {
          method: "POST",
          body: JSON.stringify({ modelId: "composer-2.5", mode: "plan" }),
        });
        expect(response.status).toBe(200);
      }),
    ).toMatchObject({ changed: true });
    expect(
      await moves("narrower policy", state, async () => {
        await harness.createSession({
          clientSessionKey: "tab",
          policy: { ...defaultPolicy, approvals: "deny" },
        });
      }),
    ).toMatchObject({ changed: true });
    expect(
      await moves("read-only boundary", state, async () => {
        await harness.createSession({
          clientSessionKey: "tab",
          policy: { ...defaultPolicy, approvals: "deny" },
          readOnly: true,
        });
      }),
    ).toMatchObject({ changed: true });
  });

  test("attach and detach", async () => {
    const state = await harness.createSession();
    const restore = stubAttach({ create: async () => fakeAgent() });
    try {
      expect(
        await moves("attach", state, async () => {
          const response = await harness.call(`/session/${state.id}/attach`, {
            method: "POST",
            body: "{}",
          });
          expect(response.status).toBe(200);
        }),
      ).toMatchObject({ changed: true });
      expect(await moves("detach", state, () => detachAgent(state))).toMatchObject({
        changed: true,
      });
    } finally {
      restore();
    }
  });

  test("compaction start and finish", async () => {
    const state = await harness.createSession();
    const gate = deferred();
    attachFake(state, { hold: gate.promise, result: "kept the plan" });
    expect(
      await moves("compaction start", state, async () => {
        expect(
          (await harness.call(`/session/${state.id}/compact`, { method: "POST" })).status,
        ).toBe(202);
      }),
    ).toMatchObject({ changed: true });
    expect(
      await moves("compaction finish", state, async () => {
        gate.resolve();
        await waitFor(() => state.status === "idle" && state.activeRun === undefined);
      }),
    ).toMatchObject({ changed: true });
  });

  test("account usage, a runtime notice and the start of a close", async () => {
    const state = await harness.createSession();
    state.usage = { turn: { inputTokens: 10 }, updatedAt: new Date(1).toISOString() };
    expect(
      await moves("usage refresh", state, () =>
        refreshAgentUsage(
          state,
          {
            getUsage: async () => ({ usage: { totalTokens: 500 }, cost: { chargedCents: 7 } }),
          } as never,
          state.promptSequence,
          0,
        ),
      ),
    ).toMatchObject({ changed: true });
    expect(
      await moves("steer notice", state, () => noteSteerRefusal(state, "saturated", "run-1")),
    ).toMatchObject({ changed: true });

    const dispose = deferred();
    attachFake(state, { holdDispose: dispose.promise });
    expect(
      await moves("close begins", state, async () => {
        expect(await closeSessionPermanently(state, 1)).toBe("pending");
      }),
    ).toMatchObject({ changed: true });
    dispose.resolve();
    await waitFor(() => !sessions.has(state.id));
  });
});

describe("GET /session/:id/status?knownStateRevision=", () => {
  test("round trip: unchanged while current, full again after a change", async () => {
    const state = await harness.createSession();
    attachFake(state);
    const first = await getJson(`/session/${state.id}/status`);
    const revision = first.stateRevision as string;
    expect(revision).toMatch(/^[A-Za-z0-9_.-]+:\d+$/);

    const unchanged = await getJson(
      `/session/${state.id}/status?knownStateRevision=${encodeURIComponent(revision)}`,
    );
    expect(unchanged).toEqual({ unchanged: true, stateRevision: revision });
    expect(isBridgeStateUnchanged(unchanged)).toBe(true);

    // Transcript growth is not a state change: still unchanged.
    applyInteractionUpdate(state, { type: "text-delta", text: "streaming" });
    expect(await getJson(`/session/${state.id}/status?knownStateRevision=${revision}`)).toEqual({
      unchanged: true,
      stateRevision: revision,
    });

    await harness.call(`/session/${state.id}/config`, {
      method: "POST",
      body: JSON.stringify({ modelId: "composer-2.5" }),
    });
    const full = await getJson(`/session/${state.id}/status?knownStateRevision=${revision}`);
    expect(full.unchanged).toBeUndefined();
    expect(full.stateRevision).not.toBe(revision);
    expect(full).toMatchObject({ status: "idle", composer: { selectedModelId: "composer-2.5" } });
  });

  test("a revision from another process or a malformed one gets the full body", async () => {
    const state = await harness.createSession();
    for (const known of ["other-process:1", "not a revision"]) {
      const body = await getJson(
        `/session/${state.id}/status?knownStateRevision=${encodeURIComponent(known)}`,
      );
      expect(body.unchanged).toBeUndefined();
      expect(body.composer).toBeDefined();
    }
  });

  test("without the query the body is today's body plus stateRevision", async () => {
    const state = await harness.createSession();
    attachFake(state);
    const { stateRevision, ...body } = await getJson(`/session/${state.id}/status`);
    expect(stateRevision).toBe(stateRevisions.peek(state.id));
    expect(body).toEqual(
      JSON.parse(JSON.stringify(publicStatus(state, { state: "ready" }))) as Record<
        string,
        unknown
      >,
    );
  });
});

describe("GET /event/subscribe?observe=1", () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buffered: { text: string },
    predicate: (text: string) => boolean,
  ): Promise<void> {
    const decoder = new TextDecoder();
    while (!predicate(buffered.text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("observe stream ended");
      buffered.text += decoder.decode(value, { stream: true });
    }
  }

  function frames(text: string, event: string): string[] {
    return text
      .split("\n\n")
      .filter((frame) => frame.includes(`event: ${event}\n`))
      .map((frame) => /^data: (.*)$/m.exec(frame)?.[1] ?? "");
  }

  test("refuses a stream without observe=1 or without the token", async () => {
    expect((await harness.call("/event/subscribe")).status).toBe(400);
    const unauthorised = await Bun.fetch(
      new URL("/event/subscribe?observe=1", (await harness.call("/global/health")).url),
    );
    expect(unauthorised.status).toBe(401);
  });

  test("announces a session change with its revisions, never its content", async () => {
    const state = await harness.createSession();
    attachFake(state);
    const controller = new AbortController();
    const response = await harness.call("/event/subscribe?observe=1", {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const buffered = { text: "" };
    try {
      await readUntil(reader, buffered, (text) => text.includes("event: connected"));
      expect(bridgeObservationRevisionVersion(frames(buffered.text, "connected")[0])).toBe(1);

      // Transcript only: the transcript revision moves, the state one does not.
      const stateBefore = stateRevisions.peek(state.id);
      const transcriptBefore = transcriptRevision(state);
      applyInteractionUpdate(state, { type: "text-delta", text: "secret words" });
      await readUntil(reader, buffered, (text) => frames(text, "session.changed").length >= 1);
      const transcriptFrame = parseBridgeObservationFrame(
        frames(buffered.text, "session.changed")[0],
      );
      expect(transcriptFrame).toEqual({
        sessionId: state.id,
        stateRevision: stateBefore,
        transcriptRevision: transcriptRevision(state),
      });
      expect(transcriptFrame.transcriptRevision).not.toBe(transcriptBefore);
      expect(buffered.text).not.toContain("secret words");

      // A state change moves the state revision.
      await harness.call(`/session/${state.id}/config`, {
        method: "POST",
        body: JSON.stringify({ modelId: "composer-2.5" }),
      });
      await readUntil(reader, buffered, (text) => frames(text, "session.changed").length >= 2);
      const stateFrame = parseBridgeObservationFrame(frames(buffered.text, "session.changed")[1]);
      expect(stateFrame.sessionId).toBe(state.id);
      expect(stateFrame.stateRevision).not.toBe(stateBefore);
      expect(stateFrame.stateRevision).toBe(stateRevisions.peek(state.id));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test("a closed session's removal is announced", async () => {
    const state = await harness.createSession();
    const controller = new AbortController();
    const response = await harness.call("/event/subscribe?observe=1", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const buffered = { text: "" };
    try {
      await readUntil(reader, buffered, (text) => text.includes("event: connected"));
      expect((await harness.call(`/session/${state.id}/close`, { method: "POST" })).status).toBe(
        200,
      );
      await readUntil(reader, buffered, (text) =>
        frames(text, "session.changed").some(
          (data) => parseBridgeObservationFrame(data).sessionId === state.id,
        ),
      );
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
