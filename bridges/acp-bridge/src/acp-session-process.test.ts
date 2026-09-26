import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import { attachChild, ensureSessionProcess, parkGrokInteraction } from "./acp-session.js";
import { closeSessionRetaining } from "./acp-session-close.js";
import { publicInteractions } from "./acp-public.js";

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
      interactions: new Map(),
      status: "idle",
    } as SessionState;

    const first = await ensureSessionProcess(state);
    const second = await ensureSessionProcess(state);
    expect(first).toBe(child);
    expect(second).toBe(child);
    expect(closed).toBe(0);
  });
});

describe("close of Cursor tool metadata replay", () => {
  test("waits for the replay child to exit before confirming close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closes = 0;
    const childState = { exitCode: null as number | null, signalCode: null as string | null };
    const replayChild = {
      child: childState,
      close: async () => {
        closes += 1;
        await gate;
        childState.exitCode = 0;
      },
    } as AcpProcess;
    const state = {
      id: "replay-close-test",
      acpSessionId: "vendor-session",
      child: null,
      approvals: new Map(),
      interactions: new Map(),
      cursorToolReplayChildren: new Set([replayChild]),
      status: "idle",
    } as SessionState;
    sessions.set(state.id, state);
    try {
      let settled = false;
      const closing = closeSessionRetaining(state).finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(closes).toBe(1);
      expect(settled).toBe(false);
      release();
      expect(await closing).toBe("closed");
      expect(sessions.has(state.id)).toBe(false);
    } finally {
      release();
      sessions.delete(state.id);
    }
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
      interactions: new Map(),
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

describe("Grok reverse interactions", () => {
  test("parks plan mode exits under the provider tool-call id and resolves exactly once", () => {
    const responses: Array<{ id: number; result: unknown }> = [];
    const child = {
      respond: (id: number, result: unknown) => responses.push({ id, result }),
    } as AcpProcess;
    const state = {
      id: "grok-test",
      acpSessionId: "vendor-session",
      child,
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
      status: "running",
    } as SessionState;

    parkGrokInteraction(state, child, 17, "x.ai/exit_plan_mode", {
      sessionId: state.acpSessionId,
      toolCallId: "tool-plan-1",
      planContent: "# Plan\n\nImplement the adapter.",
    });

    expect(publicInteractions(state)).toEqual([
      expect.objectContaining({
        id: "tool-plan-1",
        kind: "plan-approval",
        plan: "# Plan\n\nImplement the adapter.",
        planTruncated: false,
      }),
    ]);
    state.interactions.get("tool-plan-1")!.respond({ outcome: "approved" });
    state.interactions.get("tool-plan-1")?.respond({ outcome: "cancelled" });
    expect(responses).toEqual([{ id: 17, result: { outcome: "approved" } }]);
    expect(state.interactions).toHaveLength(0);
  });
});
