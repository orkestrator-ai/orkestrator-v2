import {
  acpToolSourceStates,
  type BridgeToolPart,
  type SessionState,
} from "./acp-context.js";
import { isCursorJsonlPart } from "./acp-cursor-transcript-parts.js";
import {
  failAllActiveSubagents,
  settleActiveSubagent,
  syncActiveSubagentTool,
} from "./acp-tools.js";

export function reconcileStaleToolParts(
  state: SessionState,
  failActiveSubagents = false,
): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation") continue;
      // Child JSONL projections are not ACP tool calls and were never
      // dispatched through this bridge, so "ended without a result" is not a
      // statement this function can make about them. Hydration owns their
      // lifecycle and re-derives it from the child transcript on every read;
      // settling one here would report a running child's tool as failed and
      // then flicker back to pending on the next poll.
      if (isCursorJsonlPart(part)) continue;
      const abandoned = part.toolState !== "success" && part.toolState !== "failure";
      if ((failActiveSubagents || abandoned) && part.agentState === "active") {
        part.agentState = "failed";
        const source = acpToolSourceStates.get(part);
        if (source) source.agentState = "failed";
      }
      if (part.toolState === "success" || part.toolState === "failure") continue;
      part.toolState = "failure";
      part.toolError = part.toolError ?? "Tool call ended without a result";
      // Keep the render source in step. A late update carrying no status of its
      // own would otherwise re-render this part straight back to `pending`.
      const source = acpToolSourceStates.get(part);
      if (source) source.toolState = "failure";
    }
  }
  if (failActiveSubagents) failAllActiveSubagents(state);
  else {
    for (const message of state.messages) {
      for (const part of message.parts) {
        if (part.type !== "tool-invocation" || isCursorJsonlPart(part)) continue;
        syncActiveSubagentTool(state, part);
      }
    }
    // The rendered launch may already have been evicted, but its bounded
    // descriptor still records whether the foreground launch ever completed.
    // Only successful launches may continue beyond the parent turn.
    for (const [toolUseId, descriptor] of state.activeSubagentDescriptors) {
      if (descriptor.toolState !== "success") settleActiveSubagent(state, toolUseId);
    }
  }
}

