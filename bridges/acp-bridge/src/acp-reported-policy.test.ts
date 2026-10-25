import { describe, expect, test } from "bun:test";
import {
  READ_ONLY_TURN_POLICY_NOTE,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import {
  acpReportedPolicy,
  acpSessionReportedPolicy,
  coordinatorProcessPolicy,
} from "./acp-policy.js";

const sessionPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

describe("acpSessionReportedPolicy", () => {
  test("a session reports its own policy as applied", () => {
    expect(acpSessionReportedPolicy({ policy: sessionPolicy }, "grok")).toEqual(
      acpReportedPolicy(sessionPolicy, "grok"),
    );
    expect(acpSessionReportedPolicy({}, "grok")).toBeUndefined();
  });

  test("a read-only session reports the coordinator policy it runs under", () => {
    const reported = acpSessionReportedPolicy({ policy: sessionPolicy, readOnly: true }, "grok");
    // The coordinator policy as Grok applies it (no sandbox of its own),
    // marked as a read-only turn.
    const applied = acpReportedPolicy(coordinatorProcessPolicy(), "grok");
    expect(reported).toMatchObject({
      ...applied,
      id: "coordinator-read-only",
      approvals: "deny",
      note: `${applied.note} ${READ_ONLY_TURN_POLICY_NOTE}`,
    });
    expect(acpSessionReportedPolicy({ policy: sessionPolicy, readOnly: false }, "grok")).toEqual(
      acpReportedPolicy(sessionPolicy, "grok"),
    );
  });
});
