import { describe, expect, test } from "bun:test";
import { ToolTracker, parseMessageContent } from "./session-manager-messages.js";

function sdkMessage(
  uuid: string,
  timestamp: string,
  content: unknown[],
): Record<string, unknown> {
  return { uuid, timestamp, message: { role: "assistant", content } };
}

describe("settle stamps", () => {
  /*
   * A long-running child is shown at the bottom of the transcript while it runs,
   * so the renderer needs to be told where it belongs once it stops. That answer
   * is recorded here, from the record carrying the result — never from this
   * process's clock, which would give a different answer every time the same
   * transcript was replayed.
   */
  const launch = sdkMessage("assistant-1", "2026-08-17T10:00:00.000Z", [{
    type: "tool_use",
    id: "task-1",
    name: "Task",
    input: { description: "Review the bridge" },
  }]);
  const result = (isError = false) => sdkMessage(
    "user-1",
    "2026-08-17T10:04:30.000Z",
    [{
      type: "tool_result",
      tool_use_id: "task-1",
      content: isError ? "boom" : "done",
      is_error: isError,
    }],
  );

  test.each([[false], [true]])(
    "stamps a child's terminal edge from the record that carried it (error: %s)",
    (isError) => {
      const toolTracker = new ToolTracker();
      parseMessageContent(launch, toolTracker);
      parseMessageContent(result(isError), toolTracker);

      const [part] = toolTracker.getTools();
      expect(part?.toolState).toBe(isError ? "failure" : "success");
      // The result record's own clock, so a replay after a restart reproduces
      // exactly this position rather than "whenever the bridge came back".
      expect(part?.settledAt).toBe("2026-08-17T10:04:30.000Z");
      // Distinct from the launch, which is where the card would otherwise snap
      // back to the moment the child finished.
      expect(part?.settledAt).not.toBe(part?.createdAt);
    },
  );

  test("leaves a child with no result unstamped", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);

    const [part] = toolTracker.getTools();
    expect(part?.toolState).not.toBe("success");
    // Still running: it belongs at the bottom, and a position would move it off
    // the spot the reader is watching.
    expect(part?.settledAt).toBeUndefined();
  });

  test("keeps the first terminal edge when a later record repeats it", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);
    parseMessageContent(result(), toolTracker);
    parseMessageContent(
      sdkMessage("user-2", "2026-08-17T11:00:00.000Z", [{
        type: "tool_result",
        tool_use_id: "task-1",
        content: "done again",
        is_error: false,
      }]),
      toolTracker,
    );

    // A child settles once. Rewriting the stamp would move a card the reader has
    // already found in its place.
    expect(toolTracker.getTools()[0]?.settledAt).toBe("2026-08-17T10:04:30.000Z");
  });

  test("leaves the stamp off when the record carries no usable timestamp", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);
    parseMessageContent(
      { uuid: "user-1", timestamp: "not-a-date", message: { role: "user", content: [{
        type: "tool_result",
        tool_use_id: "task-1",
        content: "done",
        is_error: false,
      }] } },
      toolTracker,
    );

    const [part] = toolTracker.getTools();
    expect(part?.toolState).toBe("success");
    // No position is better than a wrong one: the card stays in its launch row.
    expect(part?.settledAt).toBeUndefined();
  });
});
