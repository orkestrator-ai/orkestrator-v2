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
 * Explicit lifecycle is authoritative for providers whose launch tool can
 * resolve before the child finishes. Otherwise a terminal parent tool state is
 * authoritative: transcript hydration can retain stale pending descendants
 * after Codex or OpenCode has reported the agent's final result.
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

  if (toolState === "success") {
    return "finished";
  }

  const childParts = part.type === "task-group"
    ? part.childTools
    : part.subagentActions ?? [];

  if (containsActiveWork(childParts)) {
    return "active";
  }

  return "active";
}

export function isNativeAgentActive(part: NativeAgentActivityPart): boolean {
  return getNativeAgentStatus(part) === "active";
}
