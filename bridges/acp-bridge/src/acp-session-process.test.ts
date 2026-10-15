import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import { sessions, type AcpProcess, type SessionState } from "./acp-context.js";
import {
  attachChild,
  clearApprovals,
  ensureSessionProcess,
  parkGrokInteraction,
} from "./acp-session.js";
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

describe("permission metadata ownership", () => {
  test("a reused id cannot inherit trusted wrapper input from a completed turn", () => {
    for (const toolName of ["orkestrator__check_inbox", "orkestrator__get_annotation_request"]) {
      const responses: unknown[] = [];
      const child = {
        respond: (_id: number, result: unknown) => responses.push(result),
      } as AcpProcess;
      const state = {
        id: "permission-turn-test",
        acpSessionId: "vendor-session",
        status: "running",
        policy: { approvals: "ask" },
        messages: [
          { id: "old-user", role: "user", content: "old", parts: [] },
          {
            id: "old-assistant",
            role: "assistant",
            content: "",
            parts: [
              {
                type: "tool-invocation",
                toolUseId: "reused",
                toolName: "use_tool",
                toolArgs: { tool_name: toolName },
                toolState: "completed",
              },
            ],
          },
          { id: "new-user", role: "user", content: "new", parts: [] },
        ],
        approvals: new Map(),
        interactions: new Map(),
        revision: 0,
      } as unknown as SessionState;
      sessions.set(state.id, state);
      try {
        attachChild(state, child);
        const params = {
          sessionId: state.acpSessionId,
          toolCall: {
            toolCallId: "reused",
            _meta: { "x.ai/tool": { name: "use_tool" } },
          },
          options: [{ optionId: "allow", kind: "allow_once" }],
        };
        child.onPermission(1, params);
        expect(responses).toEqual([]);
        expect(state.approvals.size).toBe(1);
        clearApprovals(state);
        // Once the current turn supplies its own metadata the same wrapper is trusted.
        state.messages.push({
          id: "new-assistant",
          role: "assistant",
          content: "",
          createdAt: "",
          parts: [
            {
              type: "tool-invocation",
              content: "",
              toolUseId: "reused",
              toolName: "use_tool",
              toolArgs: { tool_name: toolName },
              sourcePartId: "new:0",
              sourceMessageId: "new-assistant",
            },
          ],
        });
        child.onPermission(2, params);
        expect(responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }]);
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    }
  });

  test("auto-approve leaves denied provider tools and unclassified requests pending", () => {
    for (const [name, kind, deny] of [
      ["write_file", "edit", "write_file"],
      ["run_terminal_cmd", "execute", "run_terminal_cmd"],
      ["run_terminal_cmd", "other", "shell"],
      ["unknown_tool", "vendor_kind", "shell"],
    ]) {
      const responses: unknown[] = [];
      const child = {
        respond: (_id: number, result: unknown) => responses.push(result),
      } as AcpProcess;
      const state = {
        id: "denied-provider-tool",
        acpSessionId: "vendor-session",
        messages: [],
        policy: { approvals: "auto-approve", toolPolicy: { deny: [deny] } },
        approvals: new Map(),
        interactions: new Map(),
        revision: 0,
      } as unknown as SessionState;
      sessions.set(state.id, state);
      try {
        attachChild(state, child);
        child.onPermission(1, {
          sessionId: state.acpSessionId,
          toolCall: { _meta: { "x.ai/tool": { name } }, kind },
          options: [{ optionId: "allow", kind: "allow_once" }],
        });
        expect(responses).toEqual([]);
        expect(state.approvals.size).toBe(1);
      } finally {
        clearApprovals(state);
        sessions.delete(state.id);
      }
    }
  });

  test("even trusted Orkestrator tools respect explicit tool denials", () => {
    const responses: unknown[] = [];
    const child = {
      respond: (_id: number, result: unknown) => responses.push(result),
    } as AcpProcess;
    const state = {
      id: "denied-mail",
      acpSessionId: "vendor-session",
      messages: [],
      policy: { approvals: "auto-approve", toolPolicy: { deny: ["orkestrator__check_inbox"] } },
      approvals: new Map(),
      interactions: new Map(),
      revision: 0,
    } as unknown as SessionState;
    sessions.set(state.id, state);
    try {
      attachChild(state, child);
      child.onPermission(1, {
        sessionId: state.acpSessionId,
        toolCall: {
          name: "use_tool",
          kind: "other",
          rawInput: { tool_name: "orkestrator__check_inbox" },
        },
        options: [{ optionId: "allow", kind: "allow_once" }],
      });
      expect(responses).toEqual([]);
      expect(state.approvals.size).toBe(1);
    } finally {
      clearApprovals(state);
      sessions.delete(state.id);
    }
  });
});
