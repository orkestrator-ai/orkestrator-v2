import { describe, expect, test } from "bun:test";
import type { NativeMessagePart } from "./native-message-types";
import {
  TOOL_GROUP_FOLD_MIN_CALLS,
  shouldFoldToolGroup,
  summarizeToolGroup,
} from "./tool-group-summary";

function tool(overrides: Partial<NativeMessagePart> = {}): NativeMessagePart {
  return {
    type: "tool-invocation",
    content: "",
    toolName: "Bash",
    toolArgs: { command: "ls" },
    toolState: "success",
    ...overrides,
  } as NativeMessagePart;
}

describe("summarizeToolGroup", () => {
  test("counts only tool calls and previews the newest one", () => {
    const latest = tool({ toolUseId: "c", toolArgs: { command: "git status" } });
    const summary = summarizeToolGroup([
      tool({ toolUseId: "a" }),
      { type: "thinking", content: "hmm" },
      tool({ toolUseId: "b" }),
      latest,
      { type: "thinking", content: "done" },
    ]);
    expect(summary?.toolCount).toBe(3);
    expect(summary?.latestTool).toBe(latest as never);
  });

  test("spans from the first call's start to the last call's end", () => {
    const summary = summarizeToolGroup([
      tool({ createdAt: "2026-10-20T10:00:00.000Z", toolDurationMs: 500 }),
      // Started later but finished last of all.
      tool({ createdAt: "2026-10-20T10:00:01.000Z", toolDurationMs: 9_000 }),
      tool({ createdAt: "2026-10-20T10:00:02.000Z", toolDurationMs: 100 }),
    ]);
    expect(summary?.spanMs).toBe(10_000);
  });

  test("ends a call without a runtime where it started and never ticks a pending one", () => {
    const summary = summarizeToolGroup([
      tool({ createdAt: "2026-10-20T10:00:00.000Z", toolDurationMs: 200 }),
      tool({
        createdAt: "2026-10-20T10:00:03.000Z",
        toolState: "pending",
        toolDurationMs: 60_000,
      }),
    ]);
    expect(summary?.spanMs).toBe(3_000);
    expect(summary?.pendingCount).toBe(1);
  });

  test("leaves the span out when no call carries a timestamp", () => {
    expect(summarizeToolGroup([tool(), tool()])?.spanMs).toBeUndefined();
  });

  test("counts failed and denied calls as failures", () => {
    const summary = summarizeToolGroup([
      tool({ toolState: "failure" }),
      tool({ toolDenied: { reason: "nope" } }),
      tool(),
    ]);
    expect(summary?.failureCount).toBe(2);
  });

  test("has nothing to summarize without a tool call", () => {
    expect(summarizeToolGroup([{ type: "thinking", content: "" }])).toBeUndefined();
  });
});

describe("shouldFoldToolGroup", () => {
  test("folds once the group reaches the minimum number of calls", () => {
    const calls = (count: number) => Array.from({ length: count }, () => tool());
    expect(shouldFoldToolGroup(calls(TOOL_GROUP_FOLD_MIN_CALLS - 1))).toBe(false);
    expect(shouldFoldToolGroup(calls(TOOL_GROUP_FOLD_MIN_CALLS))).toBe(true);
  });

  test("does not count reasoning rows toward the minimum", () => {
    expect(
      shouldFoldToolGroup([
        tool(),
        { type: "thinking", content: "" },
        tool(),
        { type: "thinking", content: "" },
      ]),
    ).toBe(false);
  });

  test("keeps a group holding a plan open", () => {
    expect(
      shouldFoldToolGroup([tool(), tool(), tool({ toolName: "createPlan", toolArgs: {} })]),
    ).toBe(false);
  });
  test("keeps pending questions visible, including provider question-shaped tools", () => {
    for (const toolName of ["AskUserQuestion", "question"]) {
      const question = tool({
        toolName,
        toolState: "pending",
        toolArgs: { questions: [{ question: "Which approach?", options: ["Simple"] }] },
      });
      expect(shouldFoldToolGroup([tool(), question, tool()])).toBe(false);
      expect(shouldFoldToolGroup([tool(), { ...question, toolState: "success" }, tool()])).toBe(
        true,
      );
      expect(
        shouldFoldToolGroup([tool(), { ...question, toolDenied: { reason: "cancelled" } }, tool()]),
      ).toBe(true);
    }
  });

  test("keeps a pending AskUserQuestion visible before its arguments arrive", () => {
    expect(
      shouldFoldToolGroup([
        tool(),
        tool(),
        tool({ toolName: "AskUserQuestion", toolState: "pending", toolArgs: {} }),
      ]),
    ).toBe(false);
  });
});
