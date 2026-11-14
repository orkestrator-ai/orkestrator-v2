import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  abortSession,
  answerQuestion,
  getPendingQuestions,
  captureEvents,
  createSession,
  getSession,
  getSessionActivity,
  nextQueryCall,
  materializePersistedSession,
  readSessionPreferences,
  settleSessionPreferenceWritesForTesting,
  PERSISTED_SDK_ID,
  pendingCalls,
  queryControlOverrides,
  getPendingInteractions,
  respondToInteraction,
  releaseWithBackgroundWork,
  sendPrompt,
  stopBackgroundTask,
  track,
  waitFor,
  withTemporaryClaudeHome,
  blockClaudeConfigDir,
} from "./session-manager-test-harness.js";
import {
  CONTINUATION_SILENCE_MS,
  CLAUDE_RUNTIME_IDLE_MS_ENV,
  CLAUDE_MAX_IDLE_RUNTIMES_ENV,
  DEFAULT_CLAUDE_RUNTIME_IDLE_MS,
  DEFAULT_MAX_IDLE_CLAUDE_RUNTIMES,
  claudeRuntimeIdleMs,
  setClaudeRuntimeIdleTimingForTesting,
} from "./session-manager-runtime-idle.js";
import { admitPrompt, applyPromptPlanMode } from "./session-manager-prompt-admission.js";
import {
  assertClaudeRuntimeStaticAccepts,
  claudeRuntimeOwesWork,
} from "./session-manager-runtime.js";
import { sessionRuntimeHealthBody } from "../routes/runtime-health-body.js";

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

const envKeys = [CLAUDE_RUNTIME_IDLE_MS_ENV, CLAUDE_MAX_IDLE_RUNTIMES_ENV];
const originalEnv = envKeys.map((key) => process.env[key]);
afterEach(() => {
  setClaudeRuntimeIdleTimingForTesting();
  envKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
});

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
  for (const initiallyPresent of [false, true]) {
    test(`refreshes repository instructions on a warm CLI (initially present: ${initiallyPresent})`, async () => {
      controlIdleWindow();
      const workspace = await mkdtemp(join(tmpdir(), "claude-warm-rules-"));
      const previous = process.env.CWD;
      process.env.CWD = workspace;
      try {
        if (initiallyPresent) await writeFile(join(workspace, "AGENTS.md"), "Original rules");
        const session = createSession("warm rules");
        track(session.id);
        session.executionPolicy = {
          id: "interactive-host",
          sandbox: "none",
          approvals: "auto-approve",
          projectResources: false,
          networkAccess: "full",
        };
        const first = sendPrompt(session.id, "hello");
        const call = await nextQueryCall();
        const input = inputOf(call);
        await input.next();
        call.push({ type: "result", subtype: "success" });
        await first;
        expect(session.claudeRuntime?.state).toBe("open");
        await writeFile(join(workspace, "AGENTS.md"), "Updated repository rules");
        const second = sendPrompt(session.id, "continue");
        expect((await input.next()).done).toBe(true);
        call.finish();
        const relaunched = await nextQueryCall();
        expect(relaunched).not.toBe(call);
        expect((relaunched.options.systemPrompt as { append: string }).append).toContain(
          "Updated repository rules",
        );
        relaunched.push({ type: "result", subtype: "success" });
        relaunched.finish();
        await second;
      } finally {
        if (previous === undefined) delete process.env.CWD;
        else process.env.CWD = previous;
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }

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
    const decision = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Which?", header: "Pick", options: [] }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("open");
    const [question] = getPendingQuestions(session.id);
    expect(answerQuestion(question!.id, { "Which?": "First" })).toBe(true);
    await decision;
    expect(getPendingQuestions(session.id)).toHaveLength(0);
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
    const [busyWindow] = window.armed();
    expect(session.claudeRuntime?.state).toBe("open");
    failJoin!(new Error("Setting failed"));
    await expect(second).rejects.toThrow("Setting failed");

    // Rollback preserves the existing silence deadline, then the next window
    // releases the CLI the failed join left.
    expect(window.armed()).toEqual([busyWindow!]);
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
  });

  test("a frame restarts an armed silence window", async () => {
    const window = controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("frame resets silence");
    const [before] = window.armed();
    call.push({ type: "system", subtype: "status", status: null });
    await waitFor(() => before!.done);
    expect(window.armed()).toHaveLength(1);
    expect(window.armed()[0]).not.toBe(before);
    expect(window.armed()[0]!.delayMs).toBe(IDLE_MS);
    expect(session.claudeRuntime?.state).toBe("open");
    window.elapse();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
  });

  test("a failed join rechecks capacity after restoring idle ownership", async () => {
    controlIdleWindow({ maxIdle: 1 });
    let rejectJoin!: (error: Error) => void;
    const setModel = mock(
      () =>
        new Promise<void>((_, reject) => {
          rejectJoin = reject;
        }),
    );
    queryControlOverrides.setModel = setModel;
    const older = await idleAfterOneTurn("failed join oldest");
    older.session.claudeRuntime!.lastFrameAt -= 1_000;
    const joining = sendPrompt(older.session.id, "join fails");
    // Attach rejection handling before releasing the deferred control call.
    const rejected = joining.catch((error: unknown) => error);
    await waitFor(() => setModel.mock.calls.length === 1);
    const newer = await idleAfterOneTurn("fills cap during join");
    expect(older.session.claudeRuntime?.state).toBe("open");
    rejectJoin(new Error("join rejected"));
    expect(await rejected).toMatchObject({ message: "join rejected" });
    expect(older.session.status).toBe("idle");
    expect(older.session.claudeRuntime?.state).toBe("draining");
    expect(newer.session.claudeRuntime?.state).toBe("open");
    older.call.finish();
    newer.call.finish();
  });

  test("failed plan-mode admission rechecks capacity after restoring idle ownership", async () => {
    controlIdleWindow({ maxIdle: 1 });
    const older = await idleAfterOneTurn("failed admission oldest");
    older.session.claudeRuntime!.lastFrameAt -= 1_000;
    const admission = admitPrompt(older.session.id)!;
    const newer = await idleAfterOneTurn("fills cap during admission");
    await withTemporaryClaudeHome("claude-idle-admission-", async (directory) => {
      await blockClaudeConfigDir(directory);
      await expect(applyPromptPlanMode(admission, true)).rejects.toBeTruthy();
    });
    expect(older.session.status).toBe("idle");
    expect(older.session.claudeRuntime?.state).toBe("draining");
    expect(newer.session.claudeRuntime?.state).toBe("open");
    older.call.finish();
    newer.call.finish();
  });

  test("successful turns settling together obey the idle cap", async () => {
    controlIdleWindow({ maxIdle: 1 });
    const turns = [];
    for (const name of ["simultaneous A", "simultaneous B"]) {
      const session = createSession(name);
      track(session.id);
      const prompt = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      turns.push({ session, prompt, call });
    }
    for (const { call } of turns) call.push({ type: "result", subtype: "success" });
    await Promise.all(turns.map(({ prompt }) => prompt));
    expect(turns.filter(({ session }) => session.claudeRuntime?.state === "open")).toHaveLength(1);
    expect(turns.filter(({ session }) => session.claudeRuntime?.state === "draining")).toHaveLength(
      1,
    );
    for (const { call } of turns) call.finish();
  });

  test("capacity never evicts a runtime owing a continuation", async () => {
    controlIdleWindow({ maxIdle: 1 });
    const owed = await releaseWithBackgroundWork("capacity continuation");
    owed.call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-bg",
      tool_use_id: "agent-call",
      status: "completed",
    });
    await waitFor(() => owed.session.claudeRuntime!.latestTurn.isAwaitingContinuation());
    const older = await idleAfterOneTurn("capacity ordinary older");
    older.session.claudeRuntime!.lastFrameAt -= 1_000;
    const newer = await idleAfterOneTurn("capacity ordinary newer");
    expect(owed.session.claudeRuntime?.state).toBe("open");
    expect(older.session.claudeRuntime?.state).toBe("draining");
    expect(newer.session.claudeRuntime?.state).toBe("open");
    owed.call.finish();
    older.call.finish();
    newer.call.finish();
    await owed.firstPrompt;
  });

  test("stop aborts an idle runtime that owes a continuation", async () => {
    controlIdleWindow();
    const { session, call, firstPrompt } =
      await releaseWithBackgroundWork("stop owed continuation");
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-bg",
      tool_use_id: "agent-call",
      status: "completed",
    });
    await waitFor(() => session.claudeRuntime!.latestTurn.isAwaitingContinuation());
    expect(session.status).toBe("idle");
    expect(session.abortController).toBeUndefined();
    const runtime = session.claudeRuntime!;
    expect(abortSession(session.id)).toBe(true);
    await firstPrompt;
    await runtime.ended;
    expect(session.claudeRuntime).toBeUndefined();
    expect(session.retainedContinuationRequestIds).toBeUndefined();
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

  test.each([false, true])("changing Chrome from %s replaces an idle CLI", async (chrome) => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("Chrome toggle", {
      parameterValues: { chrome },
    });
    expect(call.options.extraArgs).toEqual(chrome ? { chrome: null } : { "no-chrome": null });
    const next = sendPrompt(session.id, "toggle Chrome", { parameterValues: { chrome: !chrome } });
    expect(await input.next()).toEqual({ done: true, value: undefined });
    expect(pendingCalls).toHaveLength(0);
    call.finish();
    const relaunched = await nextQueryCall();
    expect(relaunched.options.extraArgs).toEqual(chrome ? { "no-chrome": null } : { chrome: null });
    relaunched.push({ type: "result", subtype: "success" });
    await next;
    relaunched.finish();
  });

  test("Chrome stays disabled on a read-only coordinator across toggles", async () => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("coordinator Chrome", {
      readOnly: true,
      parameterValues: { chrome: true },
    });
    expect(call.options.extraArgs).toEqual({ "no-chrome": null });
    const next = sendPrompt(session.id, "still read-only", {
      readOnly: true,
      parameterValues: { chrome: false },
    });
    expect((await input.next()).done).toBe(false);
    expect(session.claudeRuntime!.launch.chrome).toBe(false);
    expect(pendingCalls).toHaveLength(0);
    call.push({ type: "result", subtype: "success" });
    await next;
    call.finish();
  });

  test("Chrome changes conflict before dispatch while work is owed", async () => {
    controlIdleWindow();
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("busy Chrome toggle");
    expect(() =>
      assertClaudeRuntimeStaticAccepts(session, { parameterValues: { chrome: true } }),
    ).toThrow(/Chrome/);
    await expect(
      sendPrompt(session.id, "toggle", { parameterValues: { chrome: true } }),
    ).rejects.toThrow(/Chrome/);
    expect(pendingCalls).toHaveLength(0);
    call.finish();
    await firstPrompt;
  });

  test("changing prompt suggestions replaces an idle CLI", async () => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("suggestions toggle", {
      promptSuggestions: false,
    });
    const next = sendPrompt(session.id, "with suggestions", { promptSuggestions: true });
    expect(await input.next()).toEqual({ done: true, value: undefined });
    call.finish();
    const relaunched = await nextQueryCall();
    expect(relaunched.options.promptSuggestions).toBe(true);
    relaunched.push({ type: "result", subtype: "success" });
    await next;
    relaunched.finish();
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

  test("signal death after the prompt settled retains a restart interruption", async () => {
    await withTemporaryClaudeHome("claude-orphaned-signal-", async () => {
      controlIdleWindow();
      const session = await materializePersistedSession();
      const prompt = sendPrompt(session.id, "work", { requestId: "spontaneous-signal" });
      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      await prompt;
      expect(session.status).toBe("idle");
      expect(session.abortController).toBeUndefined();
      call.push({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "msg-resumed-signal",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Continuing." }],
        },
      });
      await waitFor(() => session.status === "running");
      call.fail(
        Object.assign(new Error("CLI killed"), {
          errorClass: "process_killed_by_signal",
          signal: "SIGKILL",
        }),
      );
      await waitFor(() => session.claudeRuntime === undefined);
      expect(session).toMatchObject({ status: "error", interruption: "restart" });
      expect(session.error).toContain("SIGKILL");
      expect(session.abortController).toBeUndefined();
      // The mark is written without waiting, and this session queued three
      // writes: set by the prompt, cleared when it settled, set again by the
      // resumed root. Polling for "a mark on disk" can stop on the first one
      // while the clear is still queued, then read the clear (1221). Wait for
      // the whole queue so the read sees the last write.
      await settleSessionPreferenceWritesForTesting();
      expect((await readSessionPreferences(PERSISTED_SDK_ID))?.turnInFlight).toBeDefined();
    });
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

/** What `/session/:id/runtime-health` reports about the session's CLI. */
function healthOf(session: { id: string }) {
  return sessionRuntimeHealthBody(getSession(session.id) ?? undefined).summary as {
    state?: string;
    runtimeGeneration?: number;
  };
}

// 0005 task 8: the generation is how the app path proves "the same process"
// without reading a PID, so it must stay put for everything a warm CLI takes
// in place and advance for everything that launches one.
describe("the warm CLI's runtime generation in health", () => {
  test("is absent before the first launch", () => {
    const session = createSession("no CLI yet");
    track(session.id);
    expect(healthOf(session)).toEqual({ state: "detached" });
  });

  test("stays put across a follow-up, live setting changes and a parked approval", async () => {
    controlIdleWindow();
    const setPermissionMode = mock(async (_mode: string) => {});
    const setModel = mock(async (_model?: string) => {});
    queryControlOverrides.setPermissionMode = setPermissionMode;
    queryControlOverrides.setModel = setModel;
    const { session, call, input } = await idleAfterOneTurn("one warm CLI", {
      approvalMode: "default",
    });
    const first = healthOf(session);
    expect(first.state).toBe("attached");
    expect(first.runtimeGeneration).toBeGreaterThan(0);
    expect(session.claudeRuntime?.generation).toBe(first.runtimeGeneration);

    // A follow-up, then a turn that switches to plan mode and another model:
    // both are written into the open process and restated on it.
    for (const options of [
      { approvalMode: "default" as const },
      { approvalMode: "default" as const, permissionMode: "plan" as const, model: "haiku" },
    ]) {
      const turn = sendPrompt(session.id, "next", options);
      expect((await input.next()).done).toBe(false);
      call.push({ type: "result", subtype: "success" });
      await turn;
      expect(healthOf(session)).toEqual(first);
    }
    expect(pendingCalls).toHaveLength(0);
    expect(setPermissionMode).toHaveBeenCalledWith("plan");
    expect(setModel).toHaveBeenCalledWith("haiku");

    // A command approval parked mid-turn and answered later.
    const turn = sendPrompt(session.id, "run it", { approvalMode: "default" });
    expect((await input.next()).done).toBe(false);
    const decision = call.options.canUseTool!("Bash", { command: "touch reviewed" }, {
      signal: new AbortController().signal,
      requestId: "bash-parked",
      toolUseID: "bash-parked",
    } as never);
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect(healthOf(session)).toEqual(first);
    respondToInteraction(getPendingInteractions(session.id)[0]!.id, { action: "accept" });
    expect(await decision).toMatchObject({ behavior: "allow" });
    call.push({ type: "result", subtype: "success" });
    await turn;
    expect(healthOf(session)).toEqual(first);
    expect(pendingCalls).toHaveLength(0);
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);
  });

  test("names the released CLI while detached and advances on the next launch", async () => {
    const window = controlIdleWindow();
    const { session, call } = await idleAfterOneTurn("released then relaunched");
    const first = healthOf(session).runtimeGeneration!;
    window.elapse();
    call.finish();
    await waitFor(() => session.claudeRuntime === undefined);
    expect(healthOf(session)).toEqual({ state: "detached", runtimeGeneration: first });

    const next = sendPrompt(session.id, "back again");
    const relaunch = await nextQueryCall();
    relaunch.push({ type: "result", subtype: "success" });
    await next;
    const second = healthOf(session);
    expect(second.state).toBe("attached");
    expect(second.runtimeGeneration).toBeGreaterThan(first);
    relaunch.finish();
  });

  test("advances when a launch-only change replaces an idle CLI", async () => {
    controlIdleWindow();
    const { session, call, input } = await idleAfterOneTurn("replaced CLI");
    const first = healthOf(session).runtimeGeneration!;
    const replaced = sendPrompt(session.id, "with suggestions", { promptSuggestions: true });
    expect(await input.next()).toEqual({ done: true, value: undefined });
    call.finish();
    const relaunch = await nextQueryCall();
    relaunch.push({ type: "result", subtype: "success" });
    await replaced;
    expect(healthOf(session).runtimeGeneration).toBeGreaterThan(first);
    relaunch.finish();
  });

  test("is never reused by another session on the same bridge", async () => {
    controlIdleWindow();
    const a = await idleAfterOneTurn("generation a");
    const b = await idleAfterOneTurn("generation b");
    expect(healthOf(b.session).runtimeGeneration).not.toBe(healthOf(a.session).runtimeGeneration);
    a.call.finish();
    b.call.finish();
  });
});

describe("idle environment settings", () => {
  const settings = [undefined, "", "bad", "-1", "1.5", "Infinity", "9007199254740992", "0", " 1 "];
  test.each(settings)("idle window parses %s", (raw) => {
    if (raw === undefined) delete process.env[CLAUDE_RUNTIME_IDLE_MS_ENV];
    else process.env[CLAUDE_RUNTIME_IDLE_MS_ENV] = raw;
    expect(claudeRuntimeIdleMs()).toBe(
      raw === "0" ? 0 : raw === " 1 " ? 1 : DEFAULT_CLAUDE_RUNTIME_IDLE_MS,
    );
  });
  test.each(settings)("idle cap parses %s", async (raw) => {
    if (raw === undefined) delete process.env[CLAUDE_MAX_IDLE_RUNTIMES_ENV];
    else process.env[CLAUDE_MAX_IDLE_RUNTIMES_ENV] = raw;
    controlIdleWindow();
    const cap = raw === "0" ? 0 : raw === " 1 " ? 1 : DEFAULT_MAX_IDLE_CLAUDE_RUNTIMES;
    const turns = [];
    for (let i = 0; i <= DEFAULT_MAX_IDLE_CLAUDE_RUNTIMES; i++) {
      const session = createSession(`env cap ${i}`);
      track(session.id);
      const prompt = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      await prompt;
      turns.push({ session, call });
    }
    expect(turns.filter(({ session }) => session.claudeRuntime?.state === "open")).toHaveLength(
      cap,
    );
    for (const { call } of turns) call.finish();
  });
});

/**
 * A background Bash command started by the first turn, then two follow-ups
 * written into the same CLI, the shape of the live run in todo 0005 task 10.
 */
async function bashTaskAfterTwoFollowUps(name: string) {
  const session = createSession(name);
  track(session.id);
  void sendPrompt(session.id, "start it in the background").catch(() => undefined);
  const call = await nextQueryCall();
  const input = inputOf(call);
  expect((await input.next()).done).toBe(false);
  call.push({
    type: "assistant",
    message: {
      id: "msg-bash",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_bg",
          name: "Bash",
          input: { command: "sleep 900", description: "Wait", run_in_background: true },
        },
      ],
    },
    parent_tool_use_id: null,
  });
  call.push({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bg",
          content:
            "Command running in background with ID: bg-task. Output is being written to: /tmp/bg-task.output",
        },
      ],
    },
    parent_tool_use_id: null,
  });
  call.push({
    type: "system",
    subtype: "task_started",
    task_id: "bg-task",
    tool_use_id: "toolu_bg",
    description: "Wait",
  });
  call.push({ type: "result", subtype: "success" });
  await waitFor(() => session.status === "idle");
  for (const index of [1, 2]) {
    void sendPrompt(session.id, `follow-up ${index}`).catch(() => undefined);
    const next = await input.next();
    expect(next.done).toBe(false);
    call.push({
      type: "result",
      subtype: "success",
      user_message_uuid: (next.value as SDKUserMessage).uuid,
      result_index: index,
    });
    await waitFor(() => session.status === "idle");
  }
  expect(session.backgroundTasks?.["bg-task"]?.status).toBe("running");
  return { session, call, input };
}

// 0005 task 10: CLI 2.1.319 answers a stop with a `stopped` edge that can beat
// its answer to the stop request, and queues the `killed` notification for the
// next prompt instead of starting a turn. Waiting for that turn refused every
// launch-only change for the whole idle window.
describe("a stop the bridge issued", () => {
  test("owes no continuation when its edge arrives before the stop's answer", async () => {
    const window = controlIdleWindow();
    // Installed before the CLI starts, which is when its control is built.
    let stopping: (taskId: string) => Promise<void> = async () => undefined;
    queryControlOverrides.stopTask = mock((taskId: string) => stopping(taskId));
    const { session, call, input } = await bashTaskAfterTwoFollowUps("stopped ahead");
    stopping = async (taskId: string) => {
      call.push({
        type: "system",
        subtype: "task_updated",
        task_id: taskId,
        patch: { status: "killed" },
      });
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        tool_use_id: "toolu_bg",
        status: "stopped",
      });
      await waitFor(() => session.backgroundTasks?.[taskId]?.status === "killed");
    };
    expect(await stopBackgroundTask(session.id, "bg-task")).toEqual({ ok: true });
    const runtime = session.claudeRuntime!;
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);
    expect(claudeRuntimeOwesWork(runtime)).toBe(false);
    expect(runtime.tasks.stopRequested.size).toBe(0);
    // The ordinary idle window, not the continuation bound.
    expect(window.armed().map((entry) => entry.delayMs)).toEqual([IDLE_MS]);

    // A launch-only change replaces the idle CLI rather than being refused.
    expect(() =>
      assertClaudeRuntimeStaticAccepts(session, { promptSuggestions: true }),
    ).not.toThrow();
    const replaced = sendPrompt(session.id, "with suggestions", { promptSuggestions: true });
    expect(await input.next()).toEqual({ done: true, value: undefined });
    call.finish();
    const relaunch = await nextQueryCall();
    relaunch.push({ type: "result", subtype: "success" });
    await replaced;
    relaunch.finish();
  });

  test("a task that completed on its own during the stop keeps its continuation", async () => {
    controlIdleWindow();
    let stopping: (taskId: string) => Promise<void> = async () => undefined;
    queryControlOverrides.stopTask = mock((taskId: string) => stopping(taskId));
    const { session, call } = await bashTaskAfterTwoFollowUps("completed during stop");
    stopping = async (taskId: string) => {
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        tool_use_id: "toolu_bg",
        status: "completed",
      });
      await waitFor(() => session.backgroundTasks?.[taskId]?.status === "completed");
    };
    expect(await stopBackgroundTask(session.id, "bg-task")).toEqual({ ok: true });
    expect(session.backgroundTasks?.["bg-task"]?.status).toBe("completed");
    // The CLI answers a natural ending with a turn, so it is still owed.
    expect(session.claudeRuntime!.latestTurn.isAwaitingContinuation()).toBe(true);
    expect(session.claudeRuntime!.tasks.stopRequested.size).toBe(0);
    expect(() => assertClaudeRuntimeStaticAccepts(session, { promptSuggestions: true })).toThrow(
      /background work/,
    );
    call.finish();
  });

  test("a stop that never reached the CLI leaves no mark", async () => {
    controlIdleWindow();
    queryControlOverrides.stopTask = mock(async () => {
      throw new Error("Query closed before response received");
    });
    const { session, call } = await bashTaskAfterTwoFollowUps("stop failed");
    expect((await stopBackgroundTask(session.id, "bg-task")).ok).toBe(false);
    expect(session.claudeRuntime!.tasks.stopRequested.size).toBe(0);
    call.finish();
  });
});
