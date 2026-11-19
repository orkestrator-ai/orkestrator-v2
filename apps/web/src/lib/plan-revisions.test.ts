import { describe, expect, test } from "bun:test";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import { buildPlanRevisionIndex, implementPlanPrompt, planDisplayTitle } from "./plan-revisions";

function plan(
  toolUseId: string | undefined,
  output: string,
  toolState: "success" | "failure" | "pending" = "success",
  toolTitle?: string,
): Extract<NativeMessagePart, { type: "tool-invocation" }> {
  return {
    type: "tool-invocation",
    content: "Plan",
    toolName: "createPlan",
    toolState,
    ...(toolUseId ? { toolUseId } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    toolOutput: output,
  };
}

function assistant(id: string, parts: NativeMessagePart[]): NativeMessage {
  return { id, role: "assistant", content: "", createdAt: "2026-11-19T10:00:00.000Z", parts };
}

describe("planDisplayTitle", () => {
  test("uses the tool title, then the first heading", () => {
    expect(planDisplayTitle("createPlan", "Split discovery", "# Other")).toBe("Split discovery");
    expect(planDisplayTitle("createPlan", undefined, "# From heading\n\nbody")).toBe(
      "From heading",
    );
    expect(planDisplayTitle("createPlan", undefined, "no heading")).toBeUndefined();
  });
});

describe("buildPlanRevisionIndex", () => {
  test("marks the newest finished plan current and earlier ones superseded", () => {
    const index = buildPlanRevisionIndex(
      [
        assistant("a1", [plan("p1", "# First plan")]),
        { id: "u1", role: "user", content: "change it", createdAt: "", parts: [] },
        assistant("a2", [plan("p2", "# Second plan")]),
      ],
      { historyComplete: true },
    );

    expect(index.currentKey).toBe("tool:p2");
    expect(index.total).toBe(2);
    expect(index.byKey.get("tool:p1")).toMatchObject({
      state: "superseded",
      revision: 1,
      title: "First plan",
      messageId: "a1",
    });
    expect(index.byKey.get("tool:p2")).toMatchObject({
      state: "current",
      revision: 2,
      title: "Second plan",
      messageId: "a2",
    });
  });

  test("a draft or a failed plan does not replace the current one", () => {
    const index = buildPlanRevisionIndex(
      [
        assistant("a1", [plan("p1", "# Settled")]),
        assistant("a2", [plan("p2", "", "failure")]),
        assistant("a3", [plan("p3", "", "pending")]),
      ],
      { historyComplete: true },
    );

    expect(index.currentKey).toBe("tool:p1");
    expect(index.total).toBe(1);
    expect(index.byKey.get("tool:p1")?.state).toBe("current");
    expect(index.byKey.get("tool:p2")?.state).toBe("failed");
    expect(index.byKey.get("tool:p3")?.state).toBe("drafting");
  });

  test("omits revision numbers while earlier history is not loaded", () => {
    const index = buildPlanRevisionIndex(
      [assistant("a1", [plan("p1", "# One")]), assistant("a2", [plan("p2", "# Two")])],
      { historyComplete: false },
    );

    expect(index.total).toBeUndefined();
    expect(index.byKey.get("tool:p2")).toMatchObject({ state: "current" });
    expect(index.byKey.get("tool:p2")?.revision).toBeUndefined();
    expect(index.byKey.get("tool:p1")?.revision).toBeUndefined();
  });

  test("counts plans in tool groups but not a sub-agent's or a denied call", () => {
    const index = buildPlanRevisionIndex(
      [
        assistant("a1", [
          { type: "tool-group", content: "", parts: [plan("grouped", "# Grouped")] },
        ]),
        assistant("a2", [
          {
            type: "subagent",
            content: "child",
            subagentActions: [plan("child", "# Child plan")],
          } as NativeMessagePart,
          { ...plan("denied", "# Denied"), toolDenied: {} } as NativeMessagePart,
        ]),
      ],
      { historyComplete: true },
    );

    expect(index.currentKey).toBe("tool:grouped");
    expect(index.byKey.has("tool:child")).toBe(false);
    expect(index.byKey.has("tool:denied")).toBe(false);
  });

  test("distinguishes id-less parts in a row and preserves coalesced source identity", () => {
    const first = plan(undefined, "# First");
    const second = plan(undefined, "# Second");
    const source = {
      ...plan(undefined, "# Coalesced"),
      sourceMessageId: "source",
      sourcePartId: "s1",
    };
    const index = buildPlanRevisionIndex([assistant("a1", [first, second, source])], {
      historyComplete: true,
    });
    expect(index.byKey.size).toBe(3);
    expect(index.byKey.get(index.keyByPart.get(first)!)).toMatchObject({ revision: 1 });
    expect(index.byKey.get(index.keyByPart.get(second)!)).toMatchObject({ revision: 2 });
    expect(index.keyByPart.get(source)).toBe('source:["source","s1"]');
    expect(index.byKey.get(index.keyByPart.get(source)!)).toMatchObject({ revision: 3 });
  });
});

describe("implementPlanPrompt", () => {
  test("includes the selected revision and exact Markdown for same-title and title-less plans", () => {
    const bodies = ["# Plan\n\nUse a queue.", "# Plan\n\nUse a stream.", "Write tests.\n"];
    const index = buildPlanRevisionIndex(
      bodies.map((body, i) => assistant(`a${i}`, [plan(`p${i}`, body)])),
      { historyComplete: true },
    );
    for (const [i, body] of bodies.entries()) {
      const key = `tool:p${i}`;
      const prompt = implementPlanPrompt(index.byKey.get(key)!, body);
      expect(prompt).toContain(`plan revision ${i + 1} (reference "${key}")`);
      expect(prompt.endsWith(`<<< BEGIN PLAN >>>\n${body}\n<<< END PLAN >>>`)).toBe(true);
    }
  });
});
