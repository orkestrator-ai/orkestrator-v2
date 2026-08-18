import { getToolDisplayName, getToolTitleDisplayName } from "@/lib/tool-names";
import type { NativeAgentActivityPart, NativeMessagePart } from "./native-message-types";

/**
 * Latest child action for an agent row or composer rail: a command, tool
 * title, or a compact type label. Launch metadata is not a substitute — the
 * caller falls back to the agent name when this is undefined.
 */
export function nativeAgentLatestActivity(part: NativeAgentActivityPart): string | undefined {
  const actions = part.type === "task-group" ? part.childTools : (part.subagentActions ?? []);
  const latest = actions.at(-1);
  return latest ? summarizeNativeAgentAction(latest) : undefined;
}

export function summarizeNativeAgentAction(part: NativeMessagePart): string {
  if (part.type === "text") return part.content.trim() || "Response";
  if (part.type === "thinking") return "Thinking";
  if (part.type === "file") return part.content.trim() || "File";

  const command = typeof part.toolArgs?.command === "string" ? part.toolArgs.command : null;
  if (command) return command;

  return (
    getToolTitleDisplayName(part.toolTitle, part.toolName, part.content) ||
    getToolDisplayName(part.toolName, part.content)
  );
}
