import { describe, expect, test } from "bun:test";
import {
  READ_ONLY_TURN_POLICY_NOTE,
  readOnlyCommandSandboxOffNote,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { claudeReportedPolicy } from "./claude-query-config.js";

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
});
