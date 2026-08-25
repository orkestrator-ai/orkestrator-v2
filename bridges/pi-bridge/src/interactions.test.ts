import { describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import {
  denyAllApprovals,
  publicApprovals,
  publicInteractions,
  requestToolApproval,
  resolveApproval,
} from "./interactions.js";
import type { SessionState } from "./state.js";

/**
 * The gate is off unless the environment turns it on, and `config.ts` reads
 * that once at import. These tests exercise the parked-approval machinery
 * directly rather than through `requestToolApproval`'s early return, which is
 * what the default configuration takes.
 */
function park(state: SessionState, toolName: string, input: Record<string, unknown>) {
  const decisions: Array<{ block: boolean; reason?: string }> = [];
  const id = `approval-${state.approvals.size}`;
  const now = Date.now();
  state.approvals.set(id, {
    id,
    toolCallId: `call-${state.approvals.size}`,
    toolName,
    input,
    createdAt: now,
    expiresAt: now + 60_000,
    settle: (decision, reason) => {
      state.approvals.delete(id);
      decisions.push(
        decision === "allow" ? { block: false } : { block: true, reason: reason ?? "denied" },
      );
    },
  });
  return { id, decisions };
}

describe("permissive default", () => {
  test("runs the tool without parking anything", async () => {
    const state = newSessionState();
    await expect(requestToolApproval(state, "call-1", "bash", { command: "ls" })).resolves.toEqual({
      block: false,
    });
    expect(state.approvals.size).toBe(0);
  });
});

describe("approval projection", () => {
  test("describes a shell call as a command", () => {
    const state = newSessionState();
    park(state, "bash", { command: "rm -rf build" });

    const payload = publicApprovals(state) as { approvals: Array<Record<string, unknown>> };
    expect(payload.approvals[0]).toMatchObject({
      kind: "command",
      command: "rm -rf build",
    });
    expect(payload.approvals[0]!.approvalId).toBeString();
    expect(payload.approvals[0]!.expiresAt).toBeGreaterThan(
      payload.approvals[0]!.requestedAt as number,
    );
  });

  test("describes an edit and a write as file changes", () => {
    const state = newSessionState();
    park(state, "edit", { path: "src/a.ts" });
    park(state, "write", { path: "src/b.ts" });

    const payload = publicApprovals(state) as { approvals: Array<Record<string, unknown>> };
    expect(payload.approvals[0]).toMatchObject({
      kind: "file-change",
      changes: [{ path: "src/a.ts", kind: "update" }],
    });
    expect(payload.approvals[1]).toMatchObject({
      kind: "file-change",
      changes: [{ path: "src/b.ts", kind: "create" }],
    });
  });

  test("marks a file change with no path unactionable rather than approvable", () => {
    const state = newSessionState();
    park(state, "edit", {});

    const payload = publicApprovals(state) as { approvals: Array<Record<string, unknown>> };
    expect(payload.approvals[0]).toMatchObject({ kind: "file-change", actionable: false });
  });

  test("names a custom tool with its bounded arguments", () => {
    const state = newSessionState();
    park(state, "deploy_service", { service: "api", stage: "prod" });

    const payload = publicApprovals(state) as { approvals: Array<Record<string, unknown>> };
    expect(payload.approvals[0]).toMatchObject({
      kind: "command",
      command: 'deploy_service {"service":"api","stage":"prod"}',
    });
  });

  test("serves the second interaction family as an empty list, never a 404", () => {
    const state = newSessionState();
    expect(publicInteractions(state)).toEqual({ interactions: [], revision: state.revision });
  });
});

describe("resolution", () => {
  test("approves only on an explicit allow", () => {
    const state = newSessionState();
    const { id, decisions } = park(state, "bash", { command: "ls" });

    expect(resolveApproval(state, id, "allow")).toBe(true);
    expect(decisions).toEqual([{ block: false }]);
    expect(state.approvals.size).toBe(0);
  });

  test("reports an unknown id rather than inventing a decision", () => {
    const state = newSessionState();
    expect(resolveApproval(state, "never-existed", "allow")).toBe(false);
  });

  test("settles exactly once even when answered twice", () => {
    const state = newSessionState();
    const { id, decisions } = park(state, "bash", { command: "ls" });

    expect(resolveApproval(state, id, "deny")).toBe(true);
    expect(resolveApproval(state, id, "allow")).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.block).toBe(true);
  });

  test("denies everything still parked when the session goes away", () => {
    const state = newSessionState();
    const first = park(state, "bash", { command: "one" });
    const second = park(state, "write", { path: "two.ts" });

    denyAllApprovals(state, "shutting down");

    expect(state.approvals.size).toBe(0);
    expect(first.decisions).toEqual([{ block: true, reason: "shutting down" }]);
    expect(second.decisions).toEqual([{ block: true, reason: "shutting down" }]);
  });
});
