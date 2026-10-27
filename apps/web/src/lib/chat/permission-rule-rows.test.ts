import { describe, expect, test } from "bun:test";
import type { PermissionRuleApplication } from "@orkestrator/protocol/permission-rules";
import type { NativeMessage } from "./native-message-types";
import { withPermissionRuleRows } from "./permission-rule-rows";

function row(id: string, at: number): NativeMessage {
  return { id, role: "assistant", content: id, parts: [], createdAt: new Date(at).toISOString() };
}

function applied(
  interactionId: string,
  appliedAt: number,
  ruleId = "rule-1",
): PermissionRuleApplication {
  return {
    ruleId,
    kind: "command-prefix",
    pattern: "npm test",
    scope: "project",
    environmentId: "env-1",
    agent: "codex",
    logicalSessionKey: "tab-1",
    interactionId,
    appliedAt,
  };
}

describe("withPermissionRuleRows", () => {
  test("places each note where the rule answered, and marks removed rules", () => {
    const rows = withPermissionRuleRows(
      [row("a", 1_000), row("b", 3_000)],
      [applied("late", 5_000, "gone"), applied("early", 2_000)],
      [
        {
          id: "rule-1",
          provider: "codex",
          scope: "project",
          projectId: "p",
          kind: "command-prefix",
          pattern: "npm test",
          createdAt: 1,
          createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "x" },
          useCount: 1,
        },
      ],
    );
    expect(rows.map((message) => message.id)).toEqual([
      "a",
      "permission-rule:early",
      "b",
      "permission-rule:late",
    ]);
    const parts = rows.flatMap((message) => message.parts);
    expect(parts.map((part) => (part.type === "permission-rule" ? part.ruleExists : null))).toEqual(
      [true, false],
    );
  });

  test("leaves a transcript without applications as it was", () => {
    const messages = [row("a", 1)];
    expect(withPermissionRuleRows(messages, [], [])).toEqual(messages);
  });
});
