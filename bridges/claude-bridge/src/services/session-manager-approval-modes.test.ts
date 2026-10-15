import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  createSession,
  track,
  sendPrompt,
  nextQueryCall,
  queryControlOverrides,
  getPendingInteractions,
  respondToInteraction,
  getPendingPlanApprovals,
  respondToPlanApproval,
  waitFor,
  releaseWithBackgroundWork,
  mockQuery,
} from "./session-manager-test-harness.js";

const policy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};
const context = (requestId: string) => ({
  signal: new AbortController().signal,
  requestId,
  toolUseID: requestId,
});

describe("selected Claude approvals through the query", () => {
  test.each(["default", "acceptEdits", "auto"] as const)(
    "%s disables sandbox Bash auto-allow and parks commands after plan acceptance",
    async (approvalMode) => {
      const setPermissionMode = mock(async (_mode: string) => {});
      queryControlOverrides.setPermissionMode = setPermissionMode;
      const session = createSession("selected approvals");
      session.executionPolicy = policy;
      track(session.id);
      const prompt = sendPrompt(session.id, "Plan the change", {
        permissionMode: "plan",
        approvalMode,
      });
      const call = await nextQueryCall();
      expect(call.options.permissionMode).toBe("plan");
      expect(call.options.sandbox?.autoAllowBashIfSandboxed).toBe(false);
      expect(call.options.allowedTools).not.toContain("Bash");
      expect(call.options.allowedTools).not.toContain("Edit");
      const exit = call.options.canUseTool!(
        "ExitPlanMode",
        { plan: "Change the code" },
        context("plan"),
      );
      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
      respondToPlanApproval(getPendingPlanApprovals(session.id)[0]!.id, true);
      expect(await exit).toMatchObject({ behavior: "allow" });
      expect(setPermissionMode).toHaveBeenCalledWith(approvalMode);
      expect(session.planMode).toBe(false);
      const command = call.options.canUseTool!(
        "Bash",
        { command: "touch reviewed" },
        context("bash"),
      );
      await waitFor(() => getPendingInteractions(session.id).length === 1);
      expect(getPendingInteractions(session.id)[0]).toMatchObject({
        id: "bash",
        kind: "command-approval",
      });
      respondToInteraction("bash", { action: "decline" });
      expect(await command).toMatchObject({ behavior: "deny" });
      const edit = call.options.canUseTool!(
        "Edit",
        { file_path: "/workspace/file", old_string: "old", new_string: "new" },
        context("edit"),
      );
      await waitFor(() => getPendingInteractions(session.id).length === 1);
      expect(getPendingInteractions(session.id)[0]?.kind).toBe("file-approval");
      respondToInteraction("edit", { action: "decline" });
      expect(await edit).toMatchObject({ behavior: "deny" });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
    },
  );

  test("plan acceptance fails closed when the live mode change fails", async () => {
    queryControlOverrides.setPermissionMode = mock(async () => {
      throw new Error("Control unavailable");
    });
    const session = createSession("failed mode transition");
    session.executionPolicy = policy;
    track(session.id);
    const prompt = sendPrompt(session.id, "Plan", {
      permissionMode: "plan",
      approvalMode: "acceptEdits",
    });
    const call = await nextQueryCall();
    const exit = call.options.canUseTool!(
      "ExitPlanMode",
      { plan: "Implementation" },
      context("plan-fail"),
    );
    await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    respondToPlanApproval(getPendingPlanApprovals(session.id)[0]!.id, true);
    expect(await exit).toMatchObject({ behavior: "deny" });
    expect(session.planMode).toBe(true);
    expect(session.claudeRuntime?.abortController.signal.aborted ?? true).toBe(true);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test.each([
    ["bypassPermissions", "default"],
    ["default", "bypassPermissions"],
  ] as const)("a retained runtime refuses crossing %s to %s before dispatch", async (from, to) => {
    const { session, call, firstPrompt } = await releaseWithBackgroundWork(
      "approval boundary",
      "background",
      { permissionMode: from, approvalMode: from },
      policy,
    );
    const count = mockQuery.mock.calls.length;
    await expect(
      sendPrompt(session.id, "Change approval boundary", { permissionMode: to, approvalMode: to }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mockQuery.mock.calls.length).toBe(count);
    expect(session.claudeRuntime?.state).toBe("open");
    call.finish();
    await firstPrompt;
    const restarted = sendPrompt(session.id, "Use the new boundary", {
      permissionMode: to,
      approvalMode: to,
    });
    const newCall = await nextQueryCall();
    expect(newCall.options.permissionMode).toBe(to);
    expect(mockQuery.mock.calls.length).toBe(count + 1);
    newCall.push({ type: "result", subtype: "success" });
    newCall.finish();
    await restarted;
  });

  test("a retained asking runtime applies another asking mode without starting a second CLI", async () => {
    const setPermissionMode = mock(async (_mode: string) => {});
    queryControlOverrides.setPermissionMode = setPermissionMode;
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork(
      "retained asking",
      "background",
      { permissionMode: "default", approvalMode: "default" },
      policy,
    );
    const count = mockQuery.mock.calls.length;
    const second = sendPrompt(session.id, "Continue", {
      permissionMode: "acceptEdits",
      approvalMode: "acceptEdits",
    });
    await input.next();
    expect(mockQuery.mock.calls.length).toBe(count);
    expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await Promise.all([firstPrompt, second]);
  });
});
