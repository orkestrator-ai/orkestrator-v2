import { describe, expect, test } from "bun:test";
import {
  READ_ONLY_TURN_POLICY_NOTE,
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
