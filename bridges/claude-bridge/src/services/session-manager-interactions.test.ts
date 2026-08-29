import { describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";

import {
  abortSession,
  answerQuestion,
  captureEvents,
  createSession,
  deleteSession,
  dismissQuestion,
  getPendingPlanApprovals,
  getPendingQuestions,
  getSession,
  nextQueryCall,
  pendingCalls,
  readSdkPrompt,
  readSessionPreferences,
  respondToPlanApproval,
  sendPrompt,
  sessionManagerTestHome,
  setClaudeHomeForTesting,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

// ---------------------------------------------------------------------------
// AskUserQuestion flow via canUseTool
// ---------------------------------------------------------------------------

describe("AskUserQuestion flow", () => {
  test("pins AskUserQuestion as parked in canUseTool under bypassPermissions", async () => {
    const session = createSession("question-flow");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "ask me", {
      permissionMode: "bypassPermissions",
    });
    const call = await nextQueryCall();

    expect(typeof call.options.canUseTool).toBe("function");
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);

    const requestedAt = Date.now();
    const canUseToolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [
        {
          question: "Pick a color",
          header: "Color choice",
          options: [{ label: "red" }, { label: "blue" }],
        },
      ],
    });

    // The pending question should now be visible to the API surface.
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [pending] = getPendingQuestions(session.id);
    expect(pending?.questions[0]?.question).toBe("Pick a color");
    expect(pending?.expiresAt).toBeGreaterThanOrEqual(requestedAt + 5 * 60 * 1000);
    expect(pending?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

    expect(answerQuestion(pending!.id, { "Pick a color": "blue" })).toBe(true);

    const result = (await canUseToolPromise) as {
      behavior: string;
      updatedInput?: { answers?: Record<string, string> };
    };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.answers).toEqual({ "Pick a color": "blue" });

    expect(getPendingQuestions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
  });

  test("answerQuestion returns false for unknown ids", () => {
    expect(answerQuestion("missing", {})).toBe(false);
  });

  test("logs question settlement metadata without answer content", async () => {
    const session = createSession("question-log-redaction");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask privately");
    const call = await nextQueryCall();
    const canUseToolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Private question", header: "Private", options: [] }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [pending] = getPendingQuestions(session.id);
    const privateAnswer = "private-answer-that-must-not-be-logged";
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(answerQuestion(pending!.id, { "Private question": privateAnswer })).toBe(true);
      await expect(canUseToolPromise).resolves.toMatchObject({ behavior: "allow" });

      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(privateAnswer);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Answering question",
        { requestId: pending!.id, answerCount: 1 },
      ]);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Received question answers",
        { questionId: pending!.id, answerCount: 1 },
      ]);
    } finally {
      logSpy.mockRestore();
    }

    call.finish();
    await promptPromise;
  });

  test("denies duplicate question text instead of overwriting one answer", async () => {
    const session = createSession("duplicate-question-text");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask twice");
    const call = await nextQueryCall();

    await expect(
      call.options.canUseTool!("AskUserQuestion", {
        questions: [
          { question: "Same question?", header: "First", options: [] },
          { question: "Same question?", header: "Second", options: [] },
        ],
      }),
    ).resolves.toEqual({
      behavior: "deny",
      message:
        "AskUserQuestion contains duplicate question text. Ask the questions again with distinct wording.",
    });
    expect(getPendingQuestions(session.id)).toEqual([]);

    call.finish();
    await promptPromise;
  });

  test("dismissQuestion denies the SDK tool and removes the pending request", async () => {
    const session = createSession("question-dismiss");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "ask");
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Continue?" }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const question = getPendingQuestions(session.id)[0];

    expect(dismissQuestion(question.id)).toBe(true);
    expect(await toolPromise).toEqual({
      behavior: "deny",
      message: "User dismissed the question",
    });
    expect(getPendingQuestions(session.id)).toEqual([]);
    expect(dismissQuestion(question.id)).toBe(false);

    call.finish();
    await promptPromise;
  });

  test("abort and query failures release pending questions instead of leaving callbacks suspended", async () => {
    const abortedSession = createSession("question-abort");
    track(abortedSession.id);
    const abortedPrompt = sendPrompt(abortedSession.id, "ask");
    const abortedCall = await nextQueryCall();
    const abortedTool = abortedCall.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Abort?" }],
    });
    await waitFor(() => getPendingQuestions(abortedSession.id).length === 1);
    expect(abortSession(abortedSession.id)).toBe(true);
    expect((await abortedTool).behavior).toBe("deny");
    expect(getPendingQuestions(abortedSession.id)).toEqual([]);
    await abortedPrompt;

    const failedSession = createSession("question-failure");
    track(failedSession.id);
    const failedPrompt = sendPrompt(failedSession.id, "ask");
    const failedCall = await nextQueryCall();
    const failedTool = failedCall.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Fail?" }],
    });
    await waitFor(() => getPendingQuestions(failedSession.id).length === 1);
    failedCall.fail(new Error("query failed"));
    await expect(failedPrompt).rejects.toThrow("query failed");
    expect((await failedTool).behavior).toBe("deny");
    expect(getPendingQuestions(failedSession.id)).toEqual([]);
  });

  test("pending question and plan approval getters isolate sessions", async () => {
    const first = createSession("first");
    const second = createSession("second");
    track(first.id);
    track(second.id);
    const firstPrompt = sendPrompt(first.id, "first");
    const secondPrompt = sendPrompt(second.id, "second");
    const firstCall = await nextQueryCall();
    const secondCall = await nextQueryCall();
    const firstTool = firstCall.options.canUseTool!("AskUserQuestion", { questions: [] });
    const secondTool = secondCall.options.canUseTool!("AskUserQuestion", { questions: [] });
    await waitFor(() => getPendingQuestions().length === 2);

    expect(getPendingQuestions(first.id)).toHaveLength(1);
    expect(getPendingQuestions(second.id)).toHaveLength(1);

    for (const question of getPendingQuestions()) dismissQuestion(question.id);
    await Promise.all([firstTool, secondTool]);
    firstCall.finish();
    secondCall.finish();
    await Promise.all([firstPrompt, secondPrompt]);
  });

  test("denies and removes an unanswered question after five minutes", async () => {
    const session = createSession("question-timeout");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "ask");
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const toolPromise = call.options.canUseTool!("AskUserQuestion", {
        questions: [{ question: "Still there?" }],
      });
      await Promise.resolve();
      expect(getPendingQuestions(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      await expect(toolPromise).resolves.toEqual({
        behavior: "deny",
        message: "Question timed out after 5 minutes",
      });
      expect(getPendingQuestions(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.finish();
    await promptPromise;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "question.answered",
        sessionId: session.id,
        data: expect.objectContaining({ cancelled: true }),
      }),
    );
    stop();
  });
});

// ---------------------------------------------------------------------------
// ExitPlanMode (plan approval) flow via canUseTool
// ---------------------------------------------------------------------------

describe("plan approval flow", () => {
  test("approving the plan resolves canUseTool with allow and emits plan.exit-requested", async () => {
    const session = createSession("plan-approve");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
      const call = await nextQueryCall();

      const observePlanWrite = (
        call.options.hooks as {
          PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
        }
      ).PreToolUse[0]!.hooks[0]!;
      await observePlanWrite({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: "/home/node/.claude/plans/approved-plan.md",
          content: "do stuff",
        },
      });

      const requestedAt = Date.now();
      const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", {});

      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
      const [approval] = getPendingPlanApprovals(session.id);
      expect(approval?.sessionId).toBe(session.id);
      expect(approval?.plan).toBe("do stuff");
      expect(approval?.expiresAt).toBeGreaterThanOrEqual(requestedAt + 5 * 60 * 1000);
      expect(approval?.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

      expect(respondToPlanApproval(approval!.id, true)).toBe(true);

      const result = (await canUseToolPromise) as { behavior: string };
      expect(result.behavior).toBe("allow");
      expect(session.planMode).toBe(false);
      expect(await readSessionPreferences(session.id.slice("session-".length))).toMatchObject({
        planMode: false,
      });

      const exitEvent = events.find(
        (e) => e.type === "plan.exit-requested" && e.sessionId === session.id,
      );
      expect(exitEvent).toBeDefined();

      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("retains a captured plan across rejection and applies an Edit-only revision", async () => {
    const session = createSession("plan-write-captured");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const hooks = call.options.hooks as
      | {
          PreToolUse?: Array<{
            hooks: Array<(input: unknown) => Promise<unknown>>;
          }>;
        }
      | undefined;
    const observePlanWrite = hooks?.PreToolUse?.[0]?.hooks[0];
    expect(observePlanWrite).toBeDefined();
    await observePlanWrite!({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/home/node/.claude/plans/calm-moon.md",
        content: "# Plan\n\n1. Inspect the flow.\n2. Show this plan before approval.",
      },
      tool_use_id: "write-plan",
      session_id: "sdk-plan-write-captured",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/workspace",
      permission_mode: "plan",
    });

    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(approval?.plan).toBe(
      "# Plan\n\n1. Inspect the flow.\n2. Show this plan before approval.",
    );

    expect(respondToPlanApproval(approval!.id, false, "Clarify verification")).toBe(true);
    await canUseToolPromise;
    expect(session.observedPlan?.content).toContain("Show this plan before approval");
    call.finish();
    const repromptCall = await nextQueryCall();
    const repromptHooks = repromptCall.options.hooks as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
    };
    await repromptHooks.PreToolUse[0]!.hooks[0]!({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/node/.claude/plans/calm-moon.md",
        old_string: "2. Show this plan before approval.",
        new_string: "2. Show the revised plan before approval.\n3. Run focused tests.",
      },
    });
    const revisedToolPromise = repromptCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [revisedApproval] = getPendingPlanApprovals(session.id);
    expect(revisedApproval?.plan).toBe(
      "# Plan\n\n1. Inspect the flow.\n2. Show the revised plan before approval.\n3. Run focused tests.",
    );
    expect(respondToPlanApproval(revisedApproval!.id, true)).toBe(true);
    await expect(revisedToolPromise).resolves.toMatchObject({ behavior: "allow" });
    expect(session.observedPlan).toBeUndefined();
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();
    await promptPromise;
  });

  test("captures only plan-like paths and replays replace_all edits for the same plan", async () => {
    const session = createSession("plan-path-filter");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const observe = (
      call.options.hooks as {
        PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
      }
    ).PreToolUse[0]!.hooks[0]!;

    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/home/node/.claude/plans/steady-river.md",
        content: "# Plan\n\nCheck behavior.\nCheck behavior.",
      },
    });
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/workspace/README.md", content: "# Not the plan" },
    });
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/workspace/notes.txt", content: "Not Markdown" },
    });
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/workspace/plans/another.md",
        old_string: "Check behavior.",
        new_string: "Wrong file.",
        replace_all: true,
      },
    });
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/node/.claude/plans/steady-river.md",
        old_string: "Check behavior.",
        new_string: "Verify behavior.",
        replace_all: true,
      },
    });

    const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(approval?.plan).toBe("# Plan\n\nVerify behavior.\nVerify behavior.");
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    await expect(toolPromise).resolves.toMatchObject({ behavior: "allow" });
    call.finish();
    await promptPromise;
  });

  test("keeps oversized plans truncated and refuses positive settlement", async () => {
    const session = createSession("plan-truncated");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "make a large plan", {
      permissionMode: "plan",
    });
    const call = await nextQueryCall();
    const observe = (
      call.options.hooks as {
        PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>;
      }
    ).PreToolUse[0]!.hooks[0]!;
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/home/node/.claude/plans/large-plan.md",
        content: "x".repeat(AGENT_INTERACTION_LIMITS.maxTextLength + 100),
      },
    });
    await observe({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/home/node/.claude/plans/large-plan.md",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      },
    });

    const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(approval?.plan).toHaveLength(AGENT_INTERACTION_LIMITS.maxTextLength);
    expect(approval?.plan?.startsWith("x")).toBe(true);
    expect(approval?.planTruncated).toBe(true);
    expect(respondToPlanApproval(approval!.id, true)).toBe(false);
    expect(getPendingPlanApprovals(session.id)).toHaveLength(1);
    expect(respondToPlanApproval(approval!.id, false)).toBe(true);
    await expect(toolPromise).resolves.toMatchObject({ behavior: "deny" });
    call.finish();
    const repromptCall = await nextQueryCall();
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();
    await promptPromise;
  });

  test("rejecting the plan resolves canUseTool with deny and includes feedback", async () => {
    const session = createSession("plan-reject");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const originalTurnStartedAt = session.turnStartedAt;
    expect(typeof originalTurnStartedAt).toBe("string");

    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    const privateFeedback = "needs more detail";
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    let result: { behavior: string; message?: string };
    try {
      expect(respondToPlanApproval(approval!.id, false, privateFeedback)).toBe(true);
      result = (await canUseToolPromise) as { behavior: string; message?: string };

      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(privateFeedback);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Responding to plan approval",
        {
          requestId: approval!.id,
          approved: false,
          hasFeedback: true,
        },
      ]);
      expect(logSpy.mock.calls).toContainEqual([
        "[session-manager] Plan approval result",
        {
          approvalId: approval!.id,
          approved: false,
          hasFeedback: true,
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain(privateFeedback);

    // Finish the original turn. session-manager will then re-prompt with the
    // captured rejection feedback - serve a quick success for that re-prompt.
    call.finish();

    const repromptCall = await nextQueryCall();
    expect(session.turnStartedAt).toBe(originalTurnStartedAt);
    repromptCall.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-reprompt",
      mcp_servers: [],
    });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    expect(getSession(session.id)?.status).toBe("idle");
    expect(getSession(session.id)?.turnStartedAt).toBeUndefined();
  });

  test("rejecting a plan without feedback denies it and requests a generic revision", async () => {
    const session = createSession("plan-reject-without-feedback");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "do stuff" });
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);

    expect(respondToPlanApproval(approval!.id, false)).toBe(true);
    await expect(toolPromise).resolves.toEqual({
      behavior: "deny",
      message:
        "User rejected the plan. No specific feedback was provided. Please revise your approach based on this feedback.",
    });
    call.finish();

    const repromptCall = await nextQueryCall();
    expect(repromptCall.options.permissionMode).toBe("plan");
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();
    await promptPromise;

    const sdkMessages = (await readSdkPrompt(repromptCall)) as Array<{
      message: { role: string; content: Array<{ type: string; text: string }> };
    }>;
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0]?.message.role).toBe("user");
    expect(sdkMessages[0]?.message.content[0]?.text).toContain(
      "I don't approve it as-is. Please revise your approach.",
    );
    expect(getPendingPlanApprovals(session.id)).toEqual([]);
  });

  test("surfaces a failed plan-rejection re-prompt instead of reporting success", async () => {
    const session = createSession("reprompt-failure");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const firstCall = await nextQueryCall();
    const toolPromise = firstCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const approval = getPendingPlanApprovals(session.id)[0];
    expect(respondToPlanApproval(approval.id, false, "change it")).toBe(true);
    expect((await toolPromise).behavior).toBe("deny");
    firstCall.finish();

    const repromptCall = await nextQueryCall();
    repromptCall.fail(new Error("reprompt failed"));

    await expect(promptPromise).rejects.toThrow("reprompt failed");
    expect(session.status).toBe("error");
    expect(session.error).toBe("reprompt failed");
  });

  test("respondToPlanApproval returns false for unknown ids", () => {
    expect(respondToPlanApproval("missing", true)).toBe(false);
  });

  test("forwards permissionMode: 'plan' to the SDK so ExitPlanMode runs in real plan mode", async () => {
    const session = createSession("plan-mode-forwarded");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    expect(call.options.permissionMode).toBe("plan");
    // Real plan mode does not need allowDangerouslySkipPermissions
    expect(call.options.allowDangerouslySkipPermissions).toBeFalsy();

    call.finish();
    await promptPromise;
  });

  test("approval is resolvable even if the UI responds before the SDK awaits the promise", async () => {
    const session = createSession("plan-fast-approve");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    // Kick off canUseTool but respond before awaiting it — this exercises the
    // race where the UI's approve fires synchronously after the request event.
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ok" });

    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);

    const result = (await canUseToolPromise) as { behavior: string };
    expect(result.behavior).toBe("allow");

    call.finish();
    await promptPromise;
  });

  // -------------------------------------------------------------------------
  // Defensive fallback: if the SDK fails ExitPlanMode despite an approval
  // (e.g. SDK plan-mode regression), the bridge should rewrite the tool
  // result to success and re-prompt Claude to continue.
  // -------------------------------------------------------------------------
  test("approved ExitPlanMode failure is overridden to success and triggers continuation re-prompt", async () => {
    const session = createSession("plan-approve-but-fail");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "make a plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    call.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });

    // User approves the plan via canUseTool
    const canUseToolPromise = call.options.canUseTool!("ExitPlanMode", { plan: "ship it" });
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    const [approval] = getPendingPlanApprovals(session.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    const canUseToolResult = (await canUseToolPromise) as { behavior: string };
    expect(canUseToolResult.behavior).toBe("allow");

    // Simulate the SDK emitting an assistant message containing the
    // ExitPlanMode tool_use, then a user message with a FAILED tool_result.
    call.push({
      type: "assistant",
      uuid: "asst-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-exit-1",
            name: "ExitPlanMode",
            input: { plan: "ship it" },
          },
        ],
      },
    });
    call.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-exit-1",
            content: "Error: not in plan mode",
            is_error: true,
          },
        ],
      },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();

    // Bridge should have queued a continuation re-prompt — serve it.
    const repromptCall = await nextQueryCall();
    // The re-prompt should NOT be in plan mode (user has approved; Claude needs full tools)
    expect(repromptCall.options.permissionMode).not.toBe("plan");
    repromptCall.push({
      type: "system",
      subtype: "init",
      session_id: "sdk-approved-fail",
      mcp_servers: [],
    });
    repromptCall.push({ type: "result", subtype: "success" });
    repromptCall.finish();

    await promptPromise;

    // Recursion guard: after the original sendPrompt resolves, there should be
    // no further queued query calls. The `_isReprompt` flag on the recursive
    // sendPrompt prevents the fallback from re-triggering on the re-prompt
    // itself.
    expect(pendingCalls.length).toBe(0);

    // The original assistant message's ExitPlanMode tool should now show success,
    // not the SDK's reported failure.
    const messages = getSession(session.id)?.messages ?? [];
    const assistantWithTool = messages.find(
      (m) => m.role === "assistant" && m.parts.some((p) => p.toolName === "ExitPlanMode"),
    );
    expect(assistantWithTool).toBeDefined();
    const exitPart = assistantWithTool?.parts.find((p) => p.toolName === "ExitPlanMode");
    expect(exitPart?.toolState).toBe("success");
    expect(exitPart?.toolError).toBeUndefined();
  });

  test("deleteSession releases a pending plan approval", async () => {
    const session = createSession("delete-plan");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);

    expect(deleteSession(session.id)).toBe(true);
    expect((await toolPromise).behavior).toBe("deny");
    expect(getPendingPlanApprovals(session.id)).toEqual([]);
    await promptPromise;
  });

  test("abort and query failures release pending plan approvals", async () => {
    const abortedSession = createSession("plan-abort");
    track(abortedSession.id);
    const abortedPrompt = sendPrompt(abortedSession.id, "plan", { permissionMode: "plan" });
    const abortedCall = await nextQueryCall();
    const abortedTool = abortedCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(abortedSession.id).length === 1);

    expect(abortSession(abortedSession.id)).toBe(true);
    await expect(abortedTool).resolves.toEqual({
      behavior: "deny",
      message: "Session terminated",
    });
    expect(getPendingPlanApprovals(abortedSession.id)).toEqual([]);
    await abortedPrompt;

    const failedSession = createSession("plan-query-failure");
    track(failedSession.id);
    const failedPrompt = sendPrompt(failedSession.id, "plan", { permissionMode: "plan" });
    const failedCall = await nextQueryCall();
    const failedTool = failedCall.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(failedSession.id).length === 1);

    failedCall.fail(new Error("query failed"));
    await expect(failedPrompt).rejects.toThrow("query failed");
    await expect(failedTool).resolves.toEqual({
      behavior: "deny",
      message: "Session terminated",
    });
    expect(getPendingPlanApprovals(failedSession.id)).toEqual([]);
  });

  test("EnterPlanMode emits its event and unrelated tools pass their input through", async () => {
    const session = createSession("tool-routing");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "tools");
      const call = await nextQueryCall();
      expect(await call.options.canUseTool!("EnterPlanMode", { reason: "plan" })).toEqual({
        behavior: "allow",
        updatedInput: { reason: "plan" },
      });
      expect(await call.options.canUseTool!("Read", { file_path: "a.ts" })).toEqual({
        behavior: "allow",
        updatedInput: { file_path: "a.ts" },
      });
      expect(session.planMode).toBe(true);
      expect(await readSessionPreferences(session.id.slice("session-".length))).toMatchObject({
        planMode: true,
      });
      call.finish();
      await promptPromise;
      expect(events.some((event) => event.type === "plan.enter-requested")).toBe(true);
    } finally {
      stop();
    }
  });

  test("denies EnterPlanMode when its durable preference cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-enter-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("enter-plan-failure");
      track(session.id);
      const { events, stop } = captureEvents();
      try {
        const promptPromise = sendPrompt(session.id, "tools", {
          permissionMode: "default",
        });
        const call = await nextQueryCall();
        await writeFile(join(directory, ".claude"), "not a directory", "utf-8");

        const result = await call.options.canUseTool!("EnterPlanMode", { reason: "plan" });
        expect(result.behavior).toBe("deny");
        expect(result.message).toContain("could not be persisted safely");
        expect(session.planMode).toBeUndefined();
        expect(events.some((event) => event.type === "plan.enter-requested")).toBe(false);

        call.finish();
        await promptPromise;
      } finally {
        stop();
      }
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps plan mode enabled when an approved exit cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-exit-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("exit-plan-failure");
      track(session.id);
      session.planMode = true;
      const { events, stop } = captureEvents();
      try {
        const promptPromise = sendPrompt(session.id, "tools", {
          permissionMode: "default",
        });
        const call = await nextQueryCall();
        const toolPromise = call.options.canUseTool!("ExitPlanMode", {
          plan: "Persist the completed plan-mode exit",
        });
        await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
        await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
        const approval = getPendingPlanApprovals(session.id)[0];
        expect(respondToPlanApproval(approval.id, true)).toBe(true);

        const result = await toolPromise;
        expect(result.behavior).toBe("deny");
        expect(result.message).toContain("could not be exited safely");
        expect(session.planMode).toBe(true);
        expect(events.some((event) => event.type === "plan.exit-requested")).toBe(false);

        call.finish();
        await promptPromise;
      } finally {
        stop();
      }
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("denies and removes an unanswered plan approval after five minutes", async () => {
    const session = createSession("plan-timeout");
    track(session.id);
    const { events, stop } = captureEvents();
    const promptPromise = sendPrompt(session.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();

    jest.useFakeTimers();
    try {
      const toolPromise = call.options.canUseTool!("ExitPlanMode", {});
      await Promise.resolve();
      expect(getPendingPlanApprovals(session.id)).toHaveLength(1);

      jest.advanceTimersByTime(5 * 60 * 1000);
      await expect(toolPromise).resolves.toEqual({
        behavior: "deny",
        message: "Plan approval timed out after 5 minutes",
      });
      expect(getPendingPlanApprovals(session.id)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }

    call.finish();
    await promptPromise;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "plan.approval-responded",
        sessionId: session.id,
        data: expect.objectContaining({ cancelled: true }),
      }),
    );
    stop();
  });
});
