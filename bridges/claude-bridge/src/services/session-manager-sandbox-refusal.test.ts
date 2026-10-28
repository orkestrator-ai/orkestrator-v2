import { afterEach, describe, expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  setClaudeLinuxSandboxStatusForTests,
  type ClaudeLinuxSandboxStatus,
} from "@orkestrator/protocol/node/claude-linux-sandbox";
import { READ_ONLY_TURN_POLICY_NOTE } from "@orkestrator/protocol/native-agent";
import { claudeReportedPolicy } from "./claude-query-config.js";
import { READ_ONLY_TOOLS } from "./read-only-policy.js";
import {
  createSession,
  getSession,
  mockQuery,
  nextQueryCall,
  sendPrompt,
  track,
} from "./session-manager-test-harness.js";

const reason =
  "Claude's command sandbox cannot run commands on this host: bubblewrap starts, but AppArmor's bwrap-userns-restrict profile strips capabilities from the user namespace the Claude CLI nests inside it.";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  setClaudeLinuxSandboxStatusForTests({ available: true });
});

describe("a turn that requires a sandbox the host cannot run commands in", () => {
  test("fails with the probe's reason without starting the CLI", async () => {
    // The prompt route refuses this first; a turn that reaches `sendPrompt`
    // another way, or after the host changed, still never starts a CLI whose
    // every Bash call would fail.
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    setClaudeLinuxSandboxStatusForTests({
      available: false,
      failure: "nested-user-namespace",
      reason,
    });
    const session = createSession("sandbox refused");
    track(session.id);
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    };
    const queriesBefore = mockQuery.mock.calls.length;
    await expect(sendPrompt(session.id, "List the files")).rejects.toThrow(reason);
    expect(mockQuery.mock.calls.length).toBe(queriesBefore);
    expect(getSession(session.id)?.status).toBe("error");
    expect(getSession(session.id)?.error).toContain("bwrap-userns-restrict");
  });
});

const missingPrograms: ClaudeLinuxSandboxStatus = {
  available: false,
  failure: "missing-programs",
  reason:
    "Claude's command sandbox cannot run commands on this host: the Claude CLI's Linux sandbox needs bubblewrap and socat on PATH, and bwrap and socat are missing. Install the bubblewrap and socat packages.",
};
const nestedRefused: ClaudeLinuxSandboxStatus = {
  available: false,
  failure: "nested-user-namespace",
  reason,
};

describe("a read-only turn where the command sandbox cannot run (todo 0190)", () => {
  for (const [host, status] of [
    ["without bubblewrap or socat (every container)", missingPrograms],
    ["whose bubblewrap cannot nest the CLI's namespace (AppArmor)", nestedRefused],
  ] as const) {
    test(`runs on the hook alone on a Linux host ${host}, and says so`, async () => {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      setClaudeLinuxSandboxStatusForTests(status);
      const session = createSession("read-only review without a sandbox");
      track(session.id);
      const prompt = sendPrompt(session.id, "Review this", { readOnly: true });
      const call = await nextQueryCall();
      // The CLI is not asked for a sandbox it would refuse the turn over, or
      // run every command into a failure under.
      expect(call.options.sandbox).toMatchObject({
        enabled: false,
        failIfUnavailable: false,
        allowUnsandboxedCommands: false,
      });
      // Everything else that holds a read-only turn is unchanged: the denied
      // writes, the reading-tool allowlist and the command hook.
      expect(call.options.sandbox?.filesystem?.denyWrite?.length).toBeGreaterThan(0);
      expect(call.options.allowedTools).toEqual(expect.arrayContaining([...READ_ONLY_TOOLS]));
      for (const tool of ["Write", "Edit", "NotebookEdit", "WebFetch"]) {
        expect(call.options.allowedTools).not.toContain(tool);
        expect(call.options.disallowedTools).toContain(tool);
      }
      expect(call.options.hooks?.PreToolUse?.length).toBeGreaterThan(0);
      expect(call.options.permissionMode).toBe("default");
      const hook = (call.options.hooks as Options["hooks"])!.PreToolUse![0]!.hooks[0]!;
      for (const command of [
        "xxd in.txt -out.txt",
        "xxd -r dump.txt -out.bin",
        "git diff",
        "git --git-dir=.git diff",
        "git status",
      ]) {
        const verdict = await hook(
          { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as never,
          undefined as never,
          { signal: new AbortController().signal } as never,
        );
        expect(verdict).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      }

      const running = getSession(session.id)!;
      expect(running.status).toBe("running");
      expect(running.readOnlyCommandSandboxOff).toBe(status.reason);
      const reported = claudeReportedPolicy(running);
      expect(reported).toMatchObject({ id: "coordinator-read-only", sandbox: "none" });
      expect(reported?.note).toContain(READ_ONLY_TURN_POLICY_NOTE);
      expect(reported?.note).toContain("read-only command filter");
      expect(reported?.note).toContain(status.reason);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
      // Kept after the turn, so a workflow reading it late still learns it.
      expect(getSession(session.id)?.readOnlyCommandSandboxOff).toBe(status.reason);
    });
  }

  test("asks for the sandbox, and requires it, where the probe finds one", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    setClaudeLinuxSandboxStatusForTests({ available: true });
    const session = createSession("read-only review with a sandbox");
    track(session.id);
    const prompt = sendPrompt(session.id, "Review this", { readOnly: true });
    const call = await nextQueryCall();
    expect(call.options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    const running = getSession(session.id)!;
    expect(running.readOnlyCommandSandboxOff).toBeUndefined();
    expect(claudeReportedPolicy(running)).toMatchObject({ sandbox: "provider" });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("an ordinary turn after it clears the note", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    setClaudeLinuxSandboxStatusForTests(missingPrograms);
    const session = createSession("read-only review then a build turn");
    track(session.id);
    const review = sendPrompt(session.id, "Review this", { readOnly: true });
    const reviewCall = await nextQueryCall();
    reviewCall.push({ type: "result", subtype: "success" });
    reviewCall.finish();
    await review;
    expect(getSession(session.id)?.readOnlyCommandSandboxOff).toBe(missingPrograms.reason);

    const build = sendPrompt(session.id, "Fix it");
    const buildCall = await nextQueryCall();
    expect(getSession(session.id)?.readOnlyCommandSandboxOff).toBeUndefined();
    buildCall.push({ type: "result", subtype: "success" });
    buildCall.finish();
    await build;
  });
});
