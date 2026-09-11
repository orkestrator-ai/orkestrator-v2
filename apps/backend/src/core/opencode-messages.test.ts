import { describe, expect, test } from "bun:test";
import { normalizeOpenCodeInteractiveMessage } from "./opencode-messages.js";

function message(parts: unknown[]): unknown {
  return {
    info: { id: "msg-1", role: "assistant", time: { created: 0 } },
    parts,
  };
}

function firstTool(value: ReturnType<typeof normalizeOpenCodeInteractiveMessage>) {
  return (value?.parts as Array<Record<string, unknown>> | undefined)?.[0];
}

describe("normalizeOpenCodeInteractiveMessage edit diffs", () => {
  test("projects OpenCode filediff onto toolDiff so the edit row has a path and counts", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "apps/web/src/a.ts",
            input: {},
            output: "Edit applied successfully.",
            metadata: {
              filediff: {
                file: "apps/web/src/a.ts",
                patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
                additions: 1,
                deletions: 1,
              },
            },
          },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)).toMatchObject({
      type: "tool-invocation",
      toolName: "edit",
      toolState: "success",
      toolTitle: "apps/web/src/a.ts",
      toolDiff: {
        filePath: "apps/web/src/a.ts",
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
      },
    });
  });

  test("recovers the path from a path-like title when metadata is missing", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "edit",
          state: {
            status: "completed",
            title: "apps/web/src/app/about/you/decks/actions.test.ts",
            input: {},
            output: "Edit applied successfully.",
          },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)?.toolDiff).toMatchObject({
      filePath: "apps/web/src/app/about/you/decks/actions.test.ts",
    });
  });

  test("does not attach toolDiff to a non-edit tool", () => {
    const normalized = normalizeOpenCodeInteractiveMessage(
      message([
        {
          id: "p1",
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "a.ts" },
        },
      ]),
      0,
    );

    expect(firstTool(normalized)?.toolDiff).toBeUndefined();
  });
});
