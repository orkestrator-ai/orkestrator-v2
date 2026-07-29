import type {
  NativeAgentActivityPart,
  NativeAgentState,
  NativeMessagePart,
} from "./native-message-types";

export type NativeAgentStatus = NativeAgentState;

function containsActiveWork(parts: NativeMessagePart[]): boolean {
  return parts.some((part) => {
    if (part.type === "subagent" || part.type === "task-group") {
      return getNativeAgentStatus(part) === "active";
    }

    if (part.type === "agent-group" || part.type === "tool-group") {
      return containsActiveWork(part.parts);
    }

    return part.type === "tool-invocation" && part.toolState === "pending";
  });
}

/**
 * Agent launch tools can resolve successfully before the child agent has
 * finished. Prefer live descendant activity over that launch result so the UI
 * does not present an active agent as finished.
 */
export function getNativeAgentStatus(
  part: NativeAgentActivityPart,
): NativeAgentStatus {
  const agentState = part.type === "task-group"
    ? part.task.agentState
    : part.agentState;
  if (agentState) return agentState;

  const toolState = part.type === "task-group"
    ? part.task.toolState
    : part.toolState;

  if (toolState === "failure") {
    return "failed";
  }

  const childParts = part.type === "task-group"
    ? part.childTools
    : part.subagentActions ?? [];

  if (containsActiveWork(childParts)) {
    return "active";
  }

  return toolState === "success" ? "finished" : "active";
}

export function isNativeAgentActive(part: NativeAgentActivityPart): boolean {
  return getNativeAgentStatus(part) === "active";
}
