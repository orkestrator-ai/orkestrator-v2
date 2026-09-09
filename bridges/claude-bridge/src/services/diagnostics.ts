import type { BridgeRunDiagnostics } from "@orkestrator/protocol/bridge-diagnostics";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only tool envelopes; content, input and result bodies are never inspected. */
export function observeClaudeMessage(diagnostics: BridgeRunDiagnostics, message: unknown): void {
  diagnostics.activity("message");
  diagnostics.streamEvent();
  if (!record(message)) return;
  const body = record(message.message) ? message.message : undefined;
  if (!Array.isArray(body?.content)) return;
  for (const block of body.content.slice(0, 512)) {
    if (!record(block)) continue;
    if (block.type === "tool_use") {
      const name =
        typeof block.name === "string" && block.name.length <= 64
          ? block.name.toLowerCase()
          : "other";
      diagnostics.tool(block.id, name === "agent" ? "task" : name, "started");
    } else if (block.type === "tool_result") {
      diagnostics.tool(block.tool_use_id, "other", "completed");
    }
  }
}
