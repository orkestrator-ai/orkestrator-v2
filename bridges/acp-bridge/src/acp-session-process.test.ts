import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import { attachChild, ensureSessionProcess } from "./acp-session.js";

describe("ensureSessionProcess fingerprint", () => {
  test("a session created without agentMcp keeps the same child", async () => {
    let closed = 0;
    const child = {
      close: async () => {
        closed += 1;
      },
    } as AcpProcess;
    const state = {
      child,
      approvals: new Map(),
      status: "idle",
    } as SessionState;

    const first = await ensureSessionProcess(state);
    const second = await ensureSessionProcess(state);
    expect(first).toBe(child);
    expect(second).toBe(child);
    expect(closed).toBe(0);
  });
});

describe("ACP child generations", () => {
  test("declines a superseded child's permission on that child", () => {
    const oldResponses: Array<{ id: number; result: unknown }> = [];
    const newResponses: Array<{ id: number; result: unknown }> = [];
    const child = (responses: Array<{ id: number; result: unknown }>) =>
      ({
        respond: (id: number, result: unknown) => responses.push({ id, result }),
      }) as AcpProcess;
    const oldChild = child(oldResponses);
    const newChild = child(newResponses);
    const state = {
      id: "generation-test",
      acpSessionId: "vendor-session",
      child: oldChild,
      approvals: new Map(),
      status: "idle",
    } as SessionState;
    sessions.set(state.id, state);
    try {
      attachChild(state, oldChild);
      attachChild(state, newChild);

      oldChild.onPermission(7, {
        sessionId: state.acpSessionId,
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      });

      expect(oldResponses).toEqual([{ id: 7, result: { outcome: { outcome: "cancelled" } } }]);
      expect(newResponses).toEqual([]);
      expect(state.approvals).toHaveLength(0);
    } finally {
      sessions.delete(state.id);
    }
  });
});
