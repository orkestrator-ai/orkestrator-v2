import { expect, test } from "bun:test";
import { BridgeRunDiagnostics } from "@orkestrator/protocol/bridge-diagnostics";
import { observeClaudeMessage } from "./diagnostics.js";

test("Claude tool envelopes preserve pending work without recording content", () => {
  const lines: string[] = [];
  const diagnostics = new BridgeRunDiagnostics(
    "claude",
    { id: "PRIVATE" },
    () => 0,
    (line) => lines.push(line),
  );
  try {
    observeClaudeMessage(diagnostics, {
      message: {
        content: [
          { type: "text", text: "PRIVATE" },
          { type: "tool_use", id: "PRIVATE-tool", name: "Bash", input: { command: "PRIVATE" } },
          { type: "tool_use", id: "PRIVATE-agent", name: "Agent", input: { prompt: "PRIVATE" } },
        ],
      },
    });
    diagnostics.report("heartbeat");
    expect(lines.at(-1)).toContain('"pendingToolCount":2');
    expect(lines.at(-1)).toContain('"kind":"bash"');
    expect(lines.at(-1)).toContain('"kind":"task"');
    observeClaudeMessage(diagnostics, {
      message: {
        content: [{ type: "tool_result", tool_use_id: "PRIVATE-tool", content: "PRIVATE" }],
      },
    });
    diagnostics.report("heartbeat");
    expect(lines.at(-1)).toContain('"pendingToolCount":1');
    expect(lines.at(-1)).toContain('"completedTools":1');
    expect(lines.join("\n")).not.toContain("PRIVATE");
  } finally {
    diagnostics.close();
  }
});
