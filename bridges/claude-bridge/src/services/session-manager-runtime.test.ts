import { describe, expect, mock, test } from "bun:test";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  releaseWithBackgroundWork,
  abortSession,
  captureEvents,
  createSession,
  getSession,
  mockGetPluginsForSdk,
  nextQueryCall,
  pushSuccessfulContinuationResult,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  MAX_RUNTIME_TOOL_OWNERS,
  claudeLaunchConflict,
  recordClaudeToolOwner,
  routeClaudeFrame,
  type ClaudeLaunchProfile,
  type ClaudeRuntime,
  type ClaudeRuntimeTurn,
} from "./session-manager-runtime.js";
import { closeSessionRetainingHistory } from "./session-manager-close.js";
import { setClaudeRuntimeIdleTimingForTesting } from "./session-manager-runtime-idle.js";

// One Claude conversation runs in one CLI. These pin what a turn that starts
// while the session's CLI is still running background work does: it joins that
// process instead of resuming the rollout in a second one.

type QueryCall = Awaited<ReturnType<typeof nextQueryCall>>;

/**
 * Start a turn that leaves `taskId` running and release it, returning the
 * running CLI and an iterator over its input.
 */

async function expectNoSecondProcess(): Promise<void> {
  await expect(nextQueryCall(50)).rejects.toThrow();
}

function finish(call: QueryCall) {
  call.push({ type: "result", subtype: "success" });
  call.finish();
}

describe("one CLI per session", () => {
  test("a follow-up joins the running CLI under its own prompt id", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("join");
    const secondPrompt = sendPrompt(session.id, "what did it find?");
    const followUp = await input.next();
    // Read before matching: Bun's `toMatchObject` writes asymmetric matchers
    // back into the object it inspects.
    const followUpUuid = (followUp.value as SDKUserMessage).uuid!;
    expect(followUpUuid).toEqual(expect.any(String));
    expect(followUp.value).toMatchObject({
      type: "user",
      message: { content: [{ type: "text", text: "what did it find?" }] },
    });
    await expectNoSecondProcess();
    await firstPrompt;
    expect(session.status).toBe("running");
    expect(session.queryControl).toBe(session.claudeRuntime!.control);

    // The follow-up's own result names its prompt, which records the rollout
    // record a fork or rewind resolves through.
    call.push({
      type: "result",
      subtype: "success",
      user_message_uuid: followUpUuid,
      result_index: 1,
    });
    await waitFor(() => session.status === "idle");
    const userRow = session.messages.find((message) => message.content === "what did it find?");
    expect(userRow?.sdkUuid).toBe(followUpUuid);
    // The agent is still running, so the process is too.
    expect(session.claudeRuntime?.state).toBe("open");

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-bg",
      tool_use_id: "agent-call",
      status: "completed",
    });
    pushSuccessfulContinuationResult(call);
    call.finish();
    await secondPrompt;
    await waitFor(() => session.claudeRuntime === undefined);
  });

  test("a subagent's frames stay in the row of the turn that started it", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("routing");
    const secondPrompt = sendPrompt(session.id, "carry on");
    await input.next();
    await firstPrompt;

    call.push({
      type: "assistant",
      message: {
        id: "msg-second",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Carrying on." }],
      },
      parent_tool_use_id: null,
    });
    // The agent the first turn started keeps reporting into its call.
    call.push({
      type: "assistant",
      message: {
        id: "msg-subagent",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Subagent progress note" }],
      },
      parent_tool_use_id: "agent-call",
    });
    await waitFor(() =>
      session.messages.some((message) =>
        message.parts.some((part) => part.content === "Subagent progress note"),
      ),
    );
    const rowWith = (text: string) =>
      session.messages.find((message) => message.parts.some((part) => part.content === text));
    const subagentRow = rowWith("Subagent progress note");
    const followUpRow = rowWith("Carrying on.");
    expect(subagentRow).toBeDefined();
    expect(subagentRow?.parts.some((part) => part.toolUseId === "agent-call")).toBe(true);
    expect(subagentRow).not.toBe(followUpRow);

    finish(call);
    await secondPrompt;
  });

  test("an agent's report lands on the earlier turn's row", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("report");
    const secondPrompt = sendPrompt(session.id, "anything back yet?");
    await input.next();
    await firstPrompt;

    call.push({
      type: "user",
      message: {
        role: "user",
        content: `<task-notification>
<task-id>agent-bg</task-id>
<tool-use-id>agent-call</tool-use-id>
<status>completed</status>
<summary>Agent "Survey" finished</summary>
<result>Found three call sites.</result>
</task-notification>`,
      },
      parent_tool_use_id: null,
    });
    await waitFor(() =>
      session.messages
        .flatMap((message) => message.parts)
        .some((part) => part.toolUseId === "agent-call" && part.toolOutput?.includes("three")),
    );
    // Attached to the call, not appended as an orphan status row.
    expect(
      session.messages.some(
        (message) => message.role === "system" && message.content.includes("three call sites"),
      ),
    ).toBe(false);

    finish(call);
    await secondPrompt;
  });

  test("an earlier turn's late subagent frame cannot release the newer turn's hold", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("late frame");
    const secondPrompt = sendPrompt(session.id, "start another task");
    const followUp = await input.next();
    const followUpUuid = (followUp.value as SDKUserMessage).uuid!;
    await firstPrompt;
    let inputClosed = false;
    void input.next().then((result) => {
      inputClosed = result.done === true;
    });

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "second-task",
      description: "Started by the follow-up",
    });
    call.push({
      type: "result",
      subtype: "success",
      user_message_uuid: followUpUuid,
      result_index: 1,
    });
    await waitFor(() => session.status === "idle");
    // Both tasks finish; the follow-up now waits for the continuation they owe.
    for (const taskId of ["second-task", "agent-bg"]) {
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "completed",
      });
    }
    await waitFor(() => session.backgroundTasks?.["agent-bg"]?.status === "completed");
    expect(session.claudeRuntime?.latestTurn.isAwaitingContinuation()).toBe(true);

    // A straggling frame from the first turn's agent reaches the first turn.
    call.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "subagent-read", content: "done" }],
      },
      parent_tool_use_id: "agent-call",
    });
    // Anything that asks whether the process is still in use must hear yes.
    call.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await Bun.sleep(20);
    expect(session.claudeRuntime?.latestTurn.isAwaitingContinuation()).toBe(true);
    expect(call.isClosed()).toBe(false);
    expect(inputClosed).toBe(false);

    call.push({
      type: "assistant",
      message: {
        id: "msg-continuation",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Both tasks are done." }],
      },
      parent_tool_use_id: null,
    });
    await waitFor(() => session.status === "running");
    pushSuccessfulContinuationResult(call);
    // The answered continuation ends the turn; the CLI stays warm for the next.
    await secondPrompt;
    expect(session.status).toBe("idle");
    expect(inputClosed).toBe(false);
    expect(session.claudeRuntime?.state).toBe("open");
    call.finish();
  });

  test("live settings are restated on the running CLI", async () => {
    const setModel = mock(async (_model?: string) => {});
    const setPermissionMode = mock(async (_mode: string) => {});
    const setMaxThinkingTokens = mock(async (_tokens: number | null, _display?: string) => {});
    const applyFlagSettings = mock(async (_settings: Record<string, unknown>) => {});
    Object.assign(queryControlOverrides, {
      setModel,
      setPermissionMode,
      setMaxThinkingTokens,
      applyFlagSettings,
    });
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("settings");

    const secondPrompt = sendPrompt(session.id, "plan the next step", {
      model: "claude-opus-test",
      permissionMode: "plan",
      effort: "low",
      fastMode: true,
      parameterValues: { thinking: "budget-2048" },
    });
    await input.next();
    await firstPrompt;
    expect(setModel).toHaveBeenCalledWith("claude-opus-test");
    expect(setPermissionMode).toHaveBeenCalledWith("plan");
    expect(setMaxThinkingTokens).toHaveBeenCalledWith(2048, "summarized");
    expect(applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: "low",
      fastMode: true,
      ultracode: false,
    });
    finish(call);
    await secondPrompt;
  });

  test.each([
    ["structured output", { outputSchema: { type: "object" } }],
    ["execution policy", { readOnly: true }],
    ["agent", { agent: "reviewer" }],
    ["settings sources", { includeLocalSettings: true }],
  ] as const)(
    "a follow-up that changes the %s is refused while background work runs",
    async (setting, options) => {
      const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("conflict");
      const rowsBefore = session.messages.length;
      let written = false;
      void input.next().then((result) => {
        written = result.done === false;
      });

      await expect(sendPrompt(session.id, "switch it up", options)).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining(setting),
      });
      await Bun.sleep(10);
      expect(written).toBe(false);
      await expectNoSecondProcess();
      // Refused before anything was claimed or recorded.
      expect(session.status).toBe("idle");
      expect(session.messages).toHaveLength(rowsBefore);
      expect(session.claudeRuntime?.state).toBe("open");

      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: "agent-bg",
        status: "completed",
      });
      pushSuccessfulContinuationResult(call);
      call.finish();
      await firstPrompt;
    },
  );

  test("a follow-up that leaves launch-only settings unsaid inherits them", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("inherit");
    // Mail delivery, the control MCP and the public API say nothing about the
    // agent or local settings.
    const secondPrompt = sendPrompt(session.id, "mail from another agent", {
      agent: undefined,
      includeLocalSettings: undefined,
    });
    expect((await input.next()).done).toBe(false);
    await firstPrompt;
    await expectNoSecondProcess();
    finish(call);
    await secondPrompt;
  });

  test("a follow-up that leaves local settings unsaid builds its plugin set from the running CLI's settings sources", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork(
      "inherit plugins",
      "agent-bg",
      { includeLocalSettings: true },
    );
    const cwd = process.env.CWD || process.cwd();
    // The launch read installs' enablement from the local layer too.
    expect(mockGetPluginsForSdk).toHaveBeenLastCalledWith(cwd, true, ["user", "project", "local"]);
    mockGetPluginsForSdk.mockClear();
    const secondPrompt = sendPrompt(session.id, "mail from another agent", {
      includeLocalSettings: undefined,
    });
    expect((await input.next()).done).toBe(false);
    await firstPrompt;
    await expectNoSecondProcess();
    // Joining inherits the local layer, so the plugin set is the one it runs.
    expect(mockGetPluginsForSdk).toHaveBeenCalled();
    for (const args of mockGetPluginsForSdk.mock.calls)
      expect(args).toEqual([cwd, true, ["user", "project", "local"]]);
    finish(call);
    await secondPrompt;
  });

  test.each(["plugins", "credentials"])(
    "a warm replacement after changing %s keeps inherited local sources",
    async (resource) => {
      const session = createSession("replace with local settings");
      track(session.id);
      const first = sendPrompt(session.id, "first", { includeLocalSettings: true });
      const initial = await nextQueryCall();
      const input = (initial.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      expect((await input.next()).done).toBe(false);
      initial.push({ type: "result", subtype: "success" });
      await first;
      expect(session.claudeRuntime?.state).toBe("open");
      const oldRuntime = session.claudeRuntime!;
      if (resource === "plugins") {
        mockGetPluginsForSdk.mockImplementation(async () => [
          { type: "local", path: "/test/locally-enabled-plugin" },
        ]);
      } else {
        // Simulate a resource digest changed by credential rotation, independently
        // of the credential-file reader covered by the runtime regressions.
        oldRuntime.launch.credentials = "previous-credential-digest";
      }
      mockGetPluginsForSdk.mockClear();
      const second = sendPrompt(session.id, "follow-up");
      expect(await input.next()).toEqual({ done: true, value: undefined });
      initial.finish();
      const replacement = await nextQueryCall();
      expect(initial.isClosed()).toBe(true);
      expect(replacement.options.settingSources).toEqual(["user", "project", "local"]);
      expect(session.claudeRuntime?.launch.settingSources).toBe(
        JSON.stringify(replacement.options.settingSources),
      );
      expect(mockGetPluginsForSdk).toHaveBeenCalled();
      for (const args of mockGetPluginsForSdk.mock.calls)
        expect(args[2]).toEqual(replacement.options.settingSources);
      if (resource === "plugins")
        expect(replacement.options.plugins).toEqual([
          { type: "local", path: "/test/locally-enabled-plugin" },
        ]);
      finish(replacement);
      await second;
    },
  );

  test("stopping a follow-up stops the CLI it shares, and the agents with it", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("stop");
    const secondPrompt = sendPrompt(session.id, "carry on");
    await input.next();
    await firstPrompt;
    const firstController = call.options.abortController!;
    expect(session.abortController).not.toBe(firstController);

    expect(abortSession(session.id)).toBe(true);
    await secondPrompt;
    expect(firstController.signal.aborted).toBe(true);
    expect(call.isClosed()).toBe(true);
    await waitFor(() => session.claudeRuntime === undefined);
    expect(session.backgroundTasks?.["agent-bg"]?.status).toBe("killed");
    expect(session.status).toBe("idle");
  });

  test("the next prompt after a stop starts a fresh CLI", async () => {
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("restart");
    const secondPrompt = sendPrompt(session.id, "carry on");
    await input.next();
    await firstPrompt;
    abortSession(session.id);
    await secondPrompt;

    const thirdPrompt = sendPrompt(session.id, "start over");
    const fresh = await nextQueryCall();
    expect(fresh).not.toBe(call);
    expect(session.claudeRuntime?.control).not.toBe(call as unknown);
    finish(fresh);
    await thirdPrompt;
  });

  test("closing the tab while background work runs closes the CLI", async () => {
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("tab close");
    expect(session.status).toBe("idle");
    expect(await closeSessionRetainingHistory(session.id)).toBe("closed");
    expect(call.isClosed()).toBe(true);
    await firstPrompt;
    expect(getSession(session.id)).toBeUndefined();
  });

  test("with no idle window, a turn that ends with nothing left running drains the CLI", async () => {
    // The default keeps the CLI warm (`session-manager-runtime-idle.test.ts`);
    // a window of zero restores closing input at the end of the turn.
    setClaudeRuntimeIdleTimingForTesting({ idleMs: 0 });
    const { events, stop } = captureEvents();
    try {
      const session = createSession("drain");
      track(session.id);
      const firstPrompt = sendPrompt(session.id, "quick question");
      const first = await nextQueryCall();
      const input = (first.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      expect((await input.next()).done).toBe(false);
      const inputCompletion = input.next();
      first.push({ type: "result", subtype: "success" });
      expect(await inputCompletion).toEqual({ done: true, value: undefined });
      // Draining: the CLI is exiting and owns nothing, so it is not joined.
      expect(session.claudeRuntime?.state).toBe("draining");
      first.finish();
      await firstPrompt;
      await waitFor(() => session.claudeRuntime === undefined);
      expect(events.filter((event) => event.type === "session.idle")).toHaveLength(1);

      const secondPrompt = sendPrompt(session.id, "another");
      const second = await nextQueryCall();
      expect(second).not.toBe(first);
      finish(second);
      await secondPrompt;
    } finally {
      stop();
    }
  });
});

describe("runtime routing", () => {
  const turn = (name: string) => ({ name }) as unknown as ClaudeRuntimeTurn;

  function runtimeWith(latest: ClaudeRuntimeTurn): ClaudeRuntime {
    return { toolOwners: new Map(), latestTurn: latest } as unknown as ClaudeRuntime;
  }

  test("routes a subagent frame to the turn whose row holds its call", () => {
    const first = turn("first");
    const latest = turn("latest");
    const runtime = runtimeWith(latest);
    recordClaudeToolOwner(runtime, "agent-call", first);
    const frame = (parent: string | null) =>
      ({ type: "assistant", parent_tool_use_id: parent }) as unknown as SDKMessage;
    expect(routeClaudeFrame(runtime, frame("agent-call"))).toBe(first);
    // Root frames, and frames for calls nobody recorded, are the latest turn's.
    expect(routeClaudeFrame(runtime, frame(null))).toBe(latest);
    expect(routeClaudeFrame(runtime, frame("unknown-call"))).toBe(latest);
  });

  test("keeps the tool-owner map within its bound, oldest first", () => {
    const runtime = runtimeWith(turn("latest"));
    const owner = turn("owner");
    for (let index = 0; index <= MAX_RUNTIME_TOOL_OWNERS; index += 1) {
      recordClaudeToolOwner(runtime, `call-${index}`, owner);
    }
    expect(runtime.toolOwners.size).toBe(MAX_RUNTIME_TOOL_OWNERS);
    expect(runtime.toolOwners.has("call-0")).toBe(false);
    expect(runtime.toolOwners.has(`call-${MAX_RUNTIME_TOOL_OWNERS}`)).toBe(true);
  });

  test("compares only what a running CLI cannot change", () => {
    const launched: ClaudeLaunchProfile = {
      context1m: false,
      chrome: false,
      promptSuggestions: false,
      thinking: "adaptive",
      bypassCapable: true,
      cwd: "/work",
      boundary: '{"policy":null}',
      outputSchema: null,
      agent: undefined,
      settingSources: '["user","project"]',
    };
    expect(claudeLaunchConflict(launched, { ...launched })).toBeUndefined();
    expect(
      claudeLaunchConflict(launched, { ...launched, agent: undefined, settingSources: undefined }),
    ).toBeUndefined();
    expect(claudeLaunchConflict(launched, { ...launched, cwd: "/elsewhere" })).toBe(
      "working directory",
    );
    expect(claudeLaunchConflict(launched, { ...launched, agent: "reviewer" })).toBe("agent");
    expect(
      claudeLaunchConflict(launched, {
        ...launched,
        settingSources: '["user","project","local"]',
      }),
    ).toBe("settings sources");
  });
});
