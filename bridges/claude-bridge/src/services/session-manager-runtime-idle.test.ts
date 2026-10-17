import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  abortSession,
  captureEvents,
  createSession,
  getSession,
  getSessionActivity,
  nextQueryCall,
  pendingCalls,
  queryControlOverrides,
  releaseWithBackgroundWork,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import { pendingQuestions } from "./session-manager-core.js";
import {
  CONTINUATION_SILENCE_MS,
  setClaudeRuntimeIdleTimingForTesting,
} from "./session-manager-runtime-idle.js";
import { assertClaudeRuntimeStaticAccepts } from "./session-manager-runtime.js";

// The session's CLI stays open after a turn that leaves nothing owed, so the
// next prompt is written into it, and releases itself once it has been idle
// for the window. The window runs on a scheduler these tests fire by hand.

const IDLE_MS = 60_000;

type Scheduled = { fire: () => void; delayMs: number; done: boolean };

function controlIdleWindow(timing: { idleMs?: number; maxIdle?: number } = {}) {
  const scheduled: Scheduled[] = [];
  setClaudeRuntimeIdleTimingForTesting({
    idleMs: IDLE_MS,
    ...timing,
    schedule: (fire, delayMs) => {
      const entry: Scheduled = { fire, delayMs, done: false };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.done = true;
        },
      };
    },
  });
  const armed = () => scheduled.filter((entry) => !entry.done);
  return {
    armed,
    /** Let every armed window run out, as if that much silence had passed. */
    elapse: () => {
      for (const entry of armed()) {
        entry.done = true;
        entry.fire();
      }
    },
  };
}

afterEach(() => setClaudeRuntimeIdleTimingForTesting());

type QueryCall = Awaited<ReturnType<typeof nextQueryCall>>;

function inputOf(call: QueryCall) {
  return (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
}

/** One completed turn whose CLI stayed open. */
async function idleAfterOneTurn(name: string, options?: Parameters<typeof sendPrompt>[2]) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "hello", options);
  const call = await nextQueryCall();
  const input = inputOf(call);
  expect((await input.next()).done).toBe(false);
  call.push({ type: "result", subtype: "success" });
  // The prompt settles at its own result, not when the process exits.
  await prompt;
  expect(session.status).toBe("idle");
  expect(session.claudeRuntime?.state).toBe("open");
  return { session, call, input };
}

describe("a warm Claude CLI between turns", () => {
  test("the next prompt is written into the same CLI", async () => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("warm follow-up");
    const runtime = session.claudeRuntime;

    const second = sendPrompt(session.id, "and then?");
    const followUp = await input.next();
    expect(followUp.value).toMatchObject({
      type: "user",
      message: { content: [{ type: "text", text: "and then?" }] },
    });
    // No second process on the same rollout.
    await expect(nextQueryCall(50)).rejects.toThrow();
    expect(session.claudeRuntime).toBe(runtime);
    expect(session.status).toBe("running");

    call.push({ type: "result", subtype: "success" });
    await second;
    expect(session.status).toBe("idle");
    expect(session.claudeRuntime).toBe(runtime);
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);
  });

  test("an idle CLI is released once the window passes", async () => {
    const window = controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("released after the window");
    expect(window.armed().map((entry) => entry.delayMs)).toEqual([IDLE_MS]);
    let inputClosed = false;
    const inputCompletion = input.next().then((result) => {
      inputClosed = result.done === true;
      return result;
    });
    await Promise.resolve();
    expect(inputClosed).toBe(false);

    window.elapse();
    // Closing input is the release: the CLI exits once it has nothing left.
    expect(await inputCompletion).toEqual({ done: true, value: undefined });
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);

    // The next prompt starts a new CLI, resumed from the same rollout.
    const next = sendPrompt(session.id, "back again");
    const relaunch = await nextQueryCall();
    expect(relaunch).not.toBe(call);
    relaunch.push({ type: "result", subtype: "success" });
    await next;
    relaunch.finish();
  });

  test("reads the backend polls never extend the window", async () => {
    const window = controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("polls do not touch");
    const [armed] = window.armed();

    await getSessionActivity(session.id);
    getSession(session.id);
    expect(window.armed()).toEqual([armed!]);
    call.finish();
  });

  test("a window of zero closes input at the end of the turn", async () => {
    const window = controlIdleWindow({ idleMs: 0 });
    const session = createSession("no warm runtime");
    track(session.id);
    const prompt = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    const input = inputOf(call);
    expect((await input.next()).done).toBe(false);
    call.push({ type: "result", subtype: "success" });
    await prompt;
    expect(window.armed()).toEqual([]);
    expect(await input.next()).toEqual({ done: true, value: undefined });
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);
  });

  test("the window never releases a CLI that still runs background work", async () => {
    const window = controlIdleWindow();
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("busy window");
    expect(window.armed().length).toBe(1);
    let inputClosed = false;
    void input.next().then((result) => {
      inputClosed = result.done === true;
    });

    window.elapse();
    await Promise.resolve();
    expect(inputClosed).toBe(false);
    expect(session.claudeRuntime?.state).toBe("open");
    // Looked at again later rather than given up on.
    expect(window.armed().length).toBe(1);

    call.finish();
    await firstPrompt;
  });

  test("an owed continuation lengthens the window to the continuation bound", async () => {
    const window = controlIdleWindow();
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("owed continuation");
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-bg",
      tool_use_id: "agent-call",
      status: "completed",
    });
    await waitFor(() => session.backgroundTasks?.["agent-bg"]?.status === "completed");
    expect(window.armed().map((entry) => entry.delayMs)).toEqual([
      Math.max(IDLE_MS, CONTINUATION_SILENCE_MS),
    ]);

    // A continuation that never comes still releases the CLI once that much
    // silence has passed, and the prompt waiting on it settles.
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
    await firstPrompt;
    expect(session.retainedContinuationRequestIds).toBeUndefined();
  });

  test("a card waiting on the user keeps the CLI", async () => {
    const window = controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("parked card");
    pendingQuestions.set("idle-question", {
      requestId: "idle-question",
      sessionId: session.id,
      questions: [],
      requestedAt: Date.now(),
      expiresAt: Date.now() + IDLE_MS,
    } as never);
    try {
      window.elapse();
      expect(session.claudeRuntime?.state).toBe("open");
    } finally {
      pendingQuestions.delete("idle-question");
    }
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
  });

  test("past the cap the CLI idle longest is released", async () => {
    controlIdleWindow({ maxIdle: 1 });
    const older = await idleAfterOneTurn("idle longest");
    expect(older.session.claudeRuntime?.state).toBe("open");
    // Strictly later, so the two are ordered by how long each has been idle.
    older.session.claudeRuntime!.lastFrameAt -= 1_000;
    const newer = await idleAfterOneTurn("idle shortest");

    expect(older.session.claudeRuntime?.state).toBe("draining");
    expect(newer.session.claudeRuntime?.state).toBe("open");
    older.call.finish();
    newer.call.finish();
  });

  test("a join that fails before its prompt is written leaves the window running", async () => {
    const window = controlIdleWindow();
    let failJoin: ((error: Error) => void) | undefined;
    const setModel = mock(
      () =>
        new Promise<void>((_, reject) => {
          failJoin = reject;
        }),
    );
    queryControlOverrides.setModel = setModel;
    const { session, call } = await idleAfterOneTurn("failed join");

    const second = sendPrompt(session.id, "and then?");
    await waitFor(() => setModel.mock.calls.length === 1);
    // The window runs out while the joining turn holds the foreground.
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("open");
    failJoin!(new Error("Setting failed"));
    await expect(second).rejects.toThrow("Setting failed");

    // Still bounded: the next window releases the CLI the failed join left.
    expect(window.armed().length).toBe(1);
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
  });

  test("a stop with nothing running leaves the warm CLI alone", async () => {
    controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("idle stop");
    const { events, stop } = captureEvents();
    try {
      expect(abortSession(session.id)).toBe(false);
      expect(session.claudeRuntime?.state).toBe("open");
      expect(events.filter((event) => event.type === "session.idle")).toEqual([]);
    } finally {
      stop();
    }
    call.finish();
  });
});

describe("launch-only changes on a warm CLI", () => {
  test("an idle CLI is replaced rather than refused", async () => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("replace idle runtime");

    // Prompt suggestions are fixed at launch. Nothing is owed to the open
    // process, so the prompt is accepted and starts a new one.
    expect(() =>
      assertClaudeRuntimeStaticAccepts(session, { promptSuggestions: true }),
    ).not.toThrow();
    const replaced = sendPrompt(session.id, "with suggestions", { promptSuggestions: true });
    expect(await input.next()).toEqual({ done: true, value: undefined });
    // Never two processes at once: the new one starts after the old exits.
    expect(pendingCalls.length).toBe(0);
    call.finish();
    const relaunch = await nextQueryCall();
    expect(relaunch.options.promptSuggestions).toBe(true);
    relaunch.push({ type: "result", subtype: "success" });
    await replaced;
    relaunch.finish();
  });

  test("a CLI that still runs background work refuses them", async () => {
    controlIdleWindow();
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("busy replace");
    expect(() => assertClaudeRuntimeStaticAccepts(session, { promptSuggestions: true })).toThrow(
      /background work/,
    );
    call.finish();
    await firstPrompt;
  });
});

describe("a root turn the warm CLI starts on its own", () => {
  test("takes the foreground and publishes its own end", async () => {
    controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("spontaneous root turn");
    const { events, stop } = captureEvents();
    try {
      call.push({
        type: "assistant",
        message: {
          id: "msg-spontaneous",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Picking that back up." }],
        },
        parent_tool_use_id: null,
      });
      await waitFor(() => session.status === "running");
      call.push({ type: "result", subtype: "success" });
      await waitFor(() => session.status === "idle");
      expect(events.some((event) => event.type === "session.idle")).toBe(true);
      expect(session.claudeRuntime?.state).toBe("open");
    } finally {
      stop();
    }
    call.finish();
  });

  test("ending the CLI under it hands the foreground back", async () => {
    controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("orphaned foreground");
    call.push({
      type: "assistant",
      message: {
        id: "msg-orphan",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Working on it." }],
      },
      parent_tool_use_id: null,
    });
    await waitFor(() => session.status === "running");
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);
    expect(session.status).toBe("idle");
    expect(session.abortController).toBeUndefined();
  });
});
