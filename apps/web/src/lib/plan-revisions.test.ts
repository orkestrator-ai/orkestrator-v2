import { describe, expect, test } from "bun:test";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import {
  buildPlanRevisionIndex,
  implementPlanPrompt,
  planCardKey,
  planDisplayTitle,
} from "./plan-revisions";

function plan(
  toolUseId: string | undefined,
  output: string,
  toolState: "success" | "failure" | "pending" = "success",
  toolTitle?: string,
): NativeMessagePart {
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

describe("planCardKey", () => {
  test("prefers the provider call id and falls back to the display row", () => {
    expect(planCardKey("call-1", "message-1")).toBe("tool:call-1");
    expect(planCardKey(undefined, "message-1")).toBe("message:message-1");
  });
});

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

  test("keys a plan without a call id by its row", () => {
    const index = buildPlanRevisionIndex([assistant("a1", [plan(undefined, "# Row plan")])], {
      historyComplete: true,
    });
    expect(index.currentKey).toBe("message:a1");
  });
});

describe("implementPlanPrompt", () => {
  test("names the plan being implemented", () => {
    expect(implementPlanPrompt("Split  discovery\n")).toBe(
      'The plan "Split discovery" is approved. Exit plan mode and implement it.',
    );
  });

  test("falls back to the latest plan when it has no title", () => {
    expect(implementPlanPrompt(undefined)).toBe(
      "The latest plan you proposed is approved. Exit plan mode and implement it.",
    );
  });
});
