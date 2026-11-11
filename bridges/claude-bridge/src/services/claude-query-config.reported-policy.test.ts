import { describe, expect, test } from "bun:test";
import {
  READ_ONLY_TURN_POLICY_NOTE,
  readOnlyCommandSandboxOffNote,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { CLAUDE_LINUX_SANDBOX_LOOPBACK_NOTE, claudeReportedPolicy } from "./claude-query-config.js";

const sessionPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

describe("claudeReportedPolicy", () => {
  test("reports the read-only policy only while a read-only turn runs", () => {
    const reported = claudeReportedPolicy({
      executionPolicy: sessionPolicy,
      status: "running",
      commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
    });
    expect(reported).toMatchObject({
      id: "coordinator-read-only",
      approvals: "deny",
      projectResources: false,
      note: READ_ONLY_TURN_POLICY_NOTE,
    });
  });

  test("a read-only turn without the command sandbox reports no sandbox, and why", () => {
    const reason = "Claude's command sandbox cannot run commands on this host: bwrap is missing.";
    const reported = claudeReportedPolicy({
      executionPolicy: sessionPolicy,
      status: "running",
      commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
      readOnlyCommandSandboxOff: reason,
    });
    expect(reported).toMatchObject({
      id: "coordinator-read-only",
      sandbox: "none",
      approvals: "deny",
      networkAccess: "restricted",
    });
    expect(reported?.note).toBe(
      `${READ_ONLY_TURN_POLICY_NOTE} ${readOnlyCommandSandboxOffNote(reason)}`,
    );
    // Between turns the session's own policy is reported, as before.
    expect(
      claudeReportedPolicy({
        executionPolicy: sessionPolicy,
        status: "idle",
        commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
        readOnlyCommandSandboxOff: reason,
      }),
    ).toEqual(sessionPolicy);
  });

  test("reports the session's policy between turns and during ordinary turns", () => {
    for (const session of [
      {
        status: "idle" as const,
        commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
      },
      {
        status: "running" as const,
        commandDiscoveryInputs: { readOnly: false, includeLocalSettings: false },
      },
      { status: "running" as const },
    ]) {
      expect(claudeReportedPolicy({ executionPolicy: sessionPolicy, ...session })).toEqual(
        sessionPolicy,
      );
    }
  });

  test("a Linux provider sandbox with full network says loopback is out of direct reach", () => {
    const provider: NativeAgentExecutionPolicy = { ...sessionPolicy, sandbox: "provider" };
    const reported = claudeReportedPolicy({ executionPolicy: provider, status: "idle" }, "linux");
    // The network axis stays full: every host but loopback is reachable.
    expect(reported).toEqual({ ...provider, note: CLAUDE_LINUX_SANDBOX_LOOPBACK_NOTE });
    expect(reported?.note).toContain("loopback");
    // A caveat the session already carries is kept, and the note is not repeated.
    const noted = { ...provider, note: "Earlier caveat." };
    const once = claudeReportedPolicy({ executionPolicy: noted, status: "idle" }, "linux");
    expect(once?.note).toBe(`Earlier caveat. ${CLAUDE_LINUX_SANDBOX_LOOPBACK_NOTE}`);
    expect(claudeReportedPolicy({ executionPolicy: once, status: "idle" }, "linux")).toEqual(once);
    // The session's own policy object is never mutated.
    expect(provider.note).toBeUndefined();
  });

  test("the loopback note is Linux-only and needs both the provider sandbox and full network", () => {
    const provider: NativeAgentExecutionPolicy = { ...sessionPolicy, sandbox: "provider" };
    const cases: [NativeAgentExecutionPolicy, NodeJS.Platform][] = [
      // macOS's Seatbelt honours allowLocalBinding.
      [provider, "darwin"],
      [provider, "win32"],
      // Restricted network refuses loopback on every system, as intended.
      [{ ...provider, networkAccess: "restricted" }, "linux"],
      // No provider sandbox, no namespace.
      [sessionPolicy, "linux"],
      [{ ...sessionPolicy, sandbox: "container" }, "linux"],
    ];
    for (const [policy, platform] of cases) {
      expect(claudeReportedPolicy({ executionPolicy: policy, status: "idle" }, platform)).toEqual(
        policy,
      );
    }
    expect(claudeReportedPolicy({ executionPolicy: undefined, status: "idle" }, "linux")).toBe(
      undefined,
    );
    // A running read-only turn reports its own restricted policy, never the note.
    const readOnly = claudeReportedPolicy(
      {
        executionPolicy: provider,
        status: "running",
        commandDiscoveryInputs: { readOnly: true, includeLocalSettings: false },
      },
      "linux",
    );
    expect(readOnly?.networkAccess).toBe("restricted");
    expect(readOnly?.note).not.toContain(CLAUDE_LINUX_SANDBOX_LOOPBACK_NOTE);
  });
});
