/**
 * Covers the descriptor built from raw params and the per-method response mapping.
 *
 * The shapes here are checked against the pinned bindings under
 * `generated/typescript/`, not against memory: the v2 and legacy methods disagree
 * about nearly every field name, and getting one wrong means either a hung turn or
 * an action authorised that the user declined.
 */
import { describe, expect, test } from "bun:test";
import {
  APPROVAL_DECISIONS,
  buildApprovalResponse,
  describeApproval,
  describeApprovalOutcome,
  isApprovalDecision,
  isInteractiveApprovalMethod,
  type ApprovalRequest,
} from "./approvals.js";

function describeWith(method: Parameters<typeof describeApproval>[0]["method"], params: unknown) {
  return describeApproval({
    approvalId: "apr-1-1",
    method,
    params,
    generation: 1,
    requestedAt: 1_000,
    expiresAt: 301_000,
  });
}

describe("isInteractiveApprovalMethod", () => {
  test("accepts the approval methods and rejects the rest", () => {
    expect(isInteractiveApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isInteractiveApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isInteractiveApprovalMethod("item/permissions/requestApproval")).toBe(true);
    expect(isInteractiveApprovalMethod("execCommandApproval")).toBe(true);
    expect(isInteractiveApprovalMethod("applyPatchApproval")).toBe(true);

    // Not approvals: these need form UI or are ours to execute, so they keep the
    // existing automatic handling.
    expect(isInteractiveApprovalMethod("item/tool/requestUserInput")).toBe(false);
    expect(isInteractiveApprovalMethod("mcpServer/elicitation/request")).toBe(false);
    expect(isInteractiveApprovalMethod("item/tool/call")).toBe(false);
    expect(isInteractiveApprovalMethod("attestation/generate")).toBe(false);
  });
});

describe("describeApproval", () => {
  test("reads the v2 command approval shape", () => {
    const approval = describeWith("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 5,
      command: "rm -rf build",
      cwd: "/workspace",
      reason: "needs write access outside the sandbox",
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
    });

    expect(approval.kind).toBe("command");
    expect(approval.threadId).toBe("thread-1");
    expect(approval.turnId).toBe("turn-1");
    expect(approval.itemId).toBe("item-1");
    expect(approval.command).toBe("rm -rf build");
    expect(approval.cwd).toBe("/workspace");
    expect(approval.reason).toBe("needs write access outside the sandbox");
    expect(approval.networkHost).toBe("registry.npmjs.org");
    expect(approval.supportsApproveForSession).toBe(true);
    // Timestamps come from our clock, not app-server's `startedAtMs`, so the UI
    // countdown cannot be skewed by a clock difference in the child.
    expect(approval.requestedAt).toBe(1_000);
    expect(approval.expiresAt).toBe(301_000);
  });

  test("joins legacy argv into a displayable command", () => {
    const approval = describeWith("execCommandApproval", {
      conversationId: "thread-legacy",
      callId: "call-9",
      command: ["bash", "-lc", "ls -1"],
      cwd: "/workspace",
    });

    // The legacy method sends argv and spells the thread `conversationId`.
    expect(approval.threadId).toBe("thread-legacy");
    expect(approval.itemId).toBe("call-9");
    expect(approval.command).toBe("bash -lc ls -1");
  });

  test("reads the legacy patch approval's fileChanges map", () => {
    const approval = describeWith("applyPatchApproval", {
      conversationId: "thread-1",
      callId: "call-1",
      fileChanges: {
        "/workspace/a.ts": { type: "update", unified_diff: "…", move_path: null },
        "/workspace/b.ts": { type: "add", content: "new" },
      },
      grantRoot: "/workspace",
    });

    expect(approval.kind).toBe("file-change");
    expect(approval.changes).toEqual([
      { path: "/workspace/a.ts", kind: "update" },
      { path: "/workspace/b.ts", kind: "add" },
    ]);
    expect(approval.grantRoot).toBe("/workspace");
  });

  test("the v2 file-change approval legitimately has no changes", () => {
    // Its params are ids plus a reason; the changes live on the fileChange item
    // the UI already holds. An empty `changes` is correct, not a parse failure.
    const approval = describeWith("item/fileChange/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 5,
      reason: "write outside the workspace",
    });

    expect(approval.kind).toBe("file-change");
    expect(approval.changes).toBeUndefined();
    expect(approval.reason).toBe("write outside the workspace");
  });

  test("reads a permission escalation request", () => {
    const approval = describeWith("item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      cwd: "/workspace",
      reason: "needs network access",
      permissions: { network: { allowAll: true }, fileSystem: null },
    });

    expect(approval.kind).toBe("permissions");
    // Only whether each class was requested — never the profile itself, which the
    // UI has no way to render meaningfully.
    expect(approval.permissions).toEqual({ network: true, fileSystem: false });
  });

  test("survives entirely absent params", () => {
    // Every field is optional in the protocol; a malformed request must still
    // produce a usable prompt rather than throwing in the read-loop handoff.
    const approval = describeWith("item/commandExecution/requestApproval", undefined);
    expect(approval.kind).toBe("command");
    expect(approval.threadId).toBeNull();
    expect(approval.command).toBeUndefined();
  });

  test("ignores malformed change entries rather than emitting empty paths", () => {
    const approval = describeWith("applyPatchApproval", {
      conversationId: "t",
      fileChanges: { "/ok.ts": { type: "delete", content: "" } },
    });
    expect(approval.changes).toEqual([{ path: "/ok.ts", kind: "delete" }]);
  });
});

describe("buildApprovalResponse", () => {
  test("maps v2 command decisions onto the protocol enum", () => {
    const method = "item/commandExecution/requestApproval" as const;
    expect(buildApprovalResponse(method, "approve", {}).result).toEqual({ decision: "accept" });
    expect(buildApprovalResponse(method, "approve-for-session", {}).result).toEqual({
      decision: "acceptForSession",
    });
    expect(buildApprovalResponse(method, "deny", {}).result).toEqual({ decision: "decline" });
    expect(buildApprovalResponse(method, "cancel", {}).result).toEqual({ decision: "cancel" });
  });

  test("maps v2 file-change decisions the same way", () => {
    const method = "item/fileChange/requestApproval" as const;
    expect(buildApprovalResponse(method, "approve", {}).result).toEqual({ decision: "accept" });
    expect(buildApprovalResponse(method, "deny", {}).result).toEqual({ decision: "decline" });
  });

  test("maps legacy decisions onto ReviewDecision", () => {
    const method = "execCommandApproval" as const;
    expect(buildApprovalResponse(method, "approve", {}).result).toEqual({ decision: "approved" });
    expect(buildApprovalResponse(method, "approve-for-session", {}).result).toEqual({
      decision: "approved_for_session",
    });
    // `ReviewDecision` has a real `abort`, which is a better cancel than a denial.
    expect(buildApprovalResponse(method, "cancel", {}).result).toEqual({ decision: "abort" });
    expect(buildApprovalResponse(method, "deny", {}).result).toEqual({
      decision: { denied: { rejection: "The user declined this action" } },
    });
  });

  test("granting permissions echoes back exactly what was requested", () => {
    const params = {
      permissions: { network: { allowAll: true }, fileSystem: { writeRoots: ["/tmp"] } },
    };
    const granted = buildApprovalResponse(
      "item/permissions/requestApproval",
      "approve",
      params,
    ).result as { permissions: Record<string, unknown>; scope: string };

    expect(granted.permissions).toEqual(params.permissions);
    expect(granted.scope).toBe("turn");
  });

  test("granting for the session widens only the scope, never the profile", () => {
    const params = { permissions: { network: { allowAll: true }, fileSystem: null } };
    const granted = buildApprovalResponse(
      "item/permissions/requestApproval",
      "approve-for-session",
      params,
    ).result as { permissions: Record<string, unknown>; scope: string };

    expect(granted.scope).toBe("session");
    // fileSystem was not requested, so it must not appear in the grant.
    expect(granted.permissions).toEqual({ network: { allowAll: true } });
  });

  test("denying permissions grants an empty profile rather than erroring", () => {
    // An empty grant is protocol-valid and lets the turn continue sandboxed; a
    // JSON-RPC error would fail the turn outright.
    const denied = buildApprovalResponse("item/permissions/requestApproval", "deny", {
      permissions: { network: { allowAll: true }, fileSystem: null },
    }).result as { permissions: Record<string, unknown>; scope: string };

    expect(denied.permissions).toEqual({});
    expect(denied.scope).toBe("turn");
  });
});

describe("describeApprovalOutcome", () => {
  const base: ApprovalRequest = {
    approvalId: "apr-1-1",
    kind: "command",
    method: "item/commandExecution/requestApproval",
    threadId: "t",
    turnId: "u",
    itemId: "i",
    generation: 1,
    requestedAt: 0,
    expiresAt: 1,
    command: "rm -rf /",
    supportsApproveForSession: true,
  };

  test("says nothing when the user approved", () => {
    // An approval needs no transcript note; the command itself is the evidence.
    expect(describeApprovalOutcome(base, "approve", "answered")).toBeNull();
    expect(describeApprovalOutcome(base, "approve-for-session", "answered")).toBeNull();
  });

  test("explains each non-approval outcome and names the command", () => {
    expect(describeApprovalOutcome(base, "deny", "answered")).toContain("You declined");
    expect(describeApprovalOutcome(base, "deny", "answered")).toContain("rm -rf /");
    expect(describeApprovalOutcome(base, "cancel", "answered")).toContain("cancelled the turn");
    expect(describeApprovalOutcome(base, "deny", "timed-out")).toContain("expired");
    expect(describeApprovalOutcome(base, "deny", "engine-restarted")).toContain("restarted");
    expect(describeApprovalOutcome(base, "deny", "session-closed")).toContain("session closed");
    expect(describeApprovalOutcome(base, "deny", "auto-declined")).toContain(
      "interactive approval is not available",
    );
  });

  test("reads correctly for file changes and permissions", () => {
    const patch: ApprovalRequest = {
      ...base,
      kind: "file-change",
      command: undefined,
      changes: [{ path: "/a", kind: "update" }, { path: "/b", kind: "add" }],
    };
    expect(describeApprovalOutcome(patch, "deny", "answered")).toContain("change 2 file(s)");

    const permissions: ApprovalRequest = { ...base, kind: "permissions", command: undefined };
    expect(describeApprovalOutcome(permissions, "deny", "timed-out")).toContain(
      "additional permissions",
    );
  });
});

describe("isApprovalDecision", () => {
  test("accepts the four decisions and nothing else", () => {
    for (const decision of APPROVAL_DECISIONS) expect(isApprovalDecision(decision)).toBe(true);
    for (const input of ["accept", "yes", "", null, undefined, 1, {}]) {
      expect(isApprovalDecision(input)).toBe(false);
    }
  });
});
