import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeAsksForApproval } from "./claude-query-config.js";

const autoApprove: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

describe("claudeAsksForApproval", () => {
  test("follows the approval mode under an auto-approve policy", () => {
    expect(claudeAsksForApproval(autoApprove, { permissionMode: "bypassPermissions" })).toBe(false);
    expect(claudeAsksForApproval(autoApprove, { permissionMode: "default" })).toBe(true);
    expect(claudeAsksForApproval(autoApprove, { permissionMode: "acceptEdits" })).toBe(true);
    expect(claudeAsksForApproval(autoApprove, { permissionMode: "auto" })).toBe(true);
    expect(claudeAsksForApproval(autoApprove, undefined)).toBe(false);
  });

  test("a plan turn asks according to the mode it returns to", () => {
    expect(
      claudeAsksForApproval(autoApprove, { permissionMode: "plan", approvalMode: "default" }),
    ).toBe(true);
    expect(
      claudeAsksForApproval(autoApprove, {
        permissionMode: "plan",
        approvalMode: "bypassPermissions",
      }),
    ).toBe(false);
    expect(claudeAsksForApproval(autoApprove, { permissionMode: "plan" })).toBe(false);
  });

  test("the policy wins over the mode", () => {
    expect(
      claudeAsksForApproval(
        { ...autoApprove, approvals: "ask" },
        { permissionMode: "bypassPermissions" },
      ),
    ).toBe(true);
    expect(
      claudeAsksForApproval({ ...autoApprove, approvals: "deny" }, { permissionMode: "default" }),
    ).toBe(false);
  });
});
