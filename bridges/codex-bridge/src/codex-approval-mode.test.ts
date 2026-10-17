import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexApprovalConfig, isCodexApprovalMode } from "./codex-approval-mode.js";

const hostPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

describe("codexApprovalConfig", () => {
  test("keeps the policy's settings when no mode is chosen", () => {
    expect(codexApprovalConfig(hostPolicy, "danger-full-access", undefined)).toBeUndefined();
  });

  test("maps modes onto approvalPolicy and the reviewer", () => {
    expect(codexApprovalConfig(hostPolicy, "danger-full-access", "untrusted")).toEqual({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
    expect(codexApprovalConfig(hostPolicy, "danger-full-access", "never")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    expect(codexApprovalConfig(hostPolicy, "danger-full-access", "auto-review")).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
  });

  test("escalating modes narrow host full access but leave plan and containers alone", () => {
    expect(codexApprovalConfig(hostPolicy, "danger-full-access", "on-request")?.sandbox).toBe(
      "workspace-write",
    );
    expect(codexApprovalConfig(hostPolicy, "read-only", "on-request")?.sandbox).toBeUndefined();
    expect(
      codexApprovalConfig(
        { ...hostPolicy, id: "interactive-container", sandbox: "container" },
        "danger-full-access",
        "on-request",
      )?.sandbox,
    ).toBeUndefined();
  });

  test("never widens an ask or deny policy", () => {
    const ask = { ...hostPolicy, approvals: "ask" as const };
    expect(codexApprovalConfig(ask, "danger-full-access", "never")).toBeUndefined();
    expect(codexApprovalConfig(ask, "danger-full-access", "auto-review")).toBeUndefined();
    expect(codexApprovalConfig(ask, "danger-full-access", "untrusted")?.approvalPolicy).toBe(
      "untrusted",
    );
    expect(
      codexApprovalConfig({ ...hostPolicy, approvals: "deny" }, "read-only", "untrusted"),
    ).toBeUndefined();
  });

  test("an ask policy in a container asks for commands rather than for leaving a sandbox", () => {
    const containerAsk: NativeAgentExecutionPolicy = {
      ...hostPolicy,
      id: "interactive-container",
      sandbox: "container",
      approvals: "ask",
    };
    expect(codexApprovalConfig(containerAsk, "danger-full-access", "on-request")).toEqual({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
    // An auto-approve container keeps the mode it was given.
    expect(
      codexApprovalConfig(
        { ...containerAsk, approvals: "auto-approve" },
        "danger-full-access",
        "on-request",
      )?.approvalPolicy,
    ).toBe("on-request");
  });

  test("recognises only the composer's modes", () => {
    expect(isCodexApprovalMode("auto-review")).toBe(true);
    expect(isCodexApprovalMode({ granular: {} })).toBe(false);
    expect(isCodexApprovalMode("on-failure")).toBe(false);
  });
});
