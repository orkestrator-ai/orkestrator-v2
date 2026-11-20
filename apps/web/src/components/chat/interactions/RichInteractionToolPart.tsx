import {
  RICH_INTERACTION_ID_PATTERN,
  RICH_INTERACTION_TOOL_NAMES,
} from "@orkestrator/protocol/rich-interactions";
import { orkestratorToolName } from "@orkestrator/protocol/transcript-artifacts";
import type { NativeToolInvocationPart } from "@/lib/chat/native-message-types";
import { RichInteractionCard } from "./RichInteractionCard";

const ID_IN_TEXT = /"interactionId"\s*:\s*"(ri_[A-Za-z0-9_-]{8,64})"/u;

export function isPresentInteractionTool(
  part: Pick<NativeToolInvocationPart, "toolName" | "toolTitle" | "mcpServerName">,
): boolean {
  return (
    orkestratorToolName(part.toolName, RICH_INTERACTION_TOOL_NAMES, {
      ...(part.toolTitle ? { toolTitle: part.toolTitle } : {}),
      ...(part.mcpServerName ? { mcpServerName: part.mcpServerName } : {}),
    }) === "present_interaction"
  );
}

/**
 * Which interaction a `present_interaction` call created. Read from the
 * tool's own result; a hint only — the card loads the request from the
 * backend, which refuses an id that does not belong to this environment.
 */
export function presentedInteractionId(
  part: Pick<NativeToolInvocationPart, "toolOutput">,
): string | null {
  const id = part.toolOutput ? ID_IN_TEXT.exec(part.toolOutput.slice(0, 16_384))?.[1] : undefined;
  return id && RICH_INTERACTION_ID_PATTERN.test(id) ? id : null;
}

/** The transcript placement of an agent-created interaction: the card sits where the agent asked. */
export function RichInteractionToolPart({ part }: { part: NativeToolInvocationPart }) {
  const interactionId = presentedInteractionId(part);
  if (!interactionId) {
    const failed = part.toolState === "failure" || part.toolError;
    return (
      <div
        className="my-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {failed
          ? `The agent's interaction could not be created${part.toolError ? `: ${String(part.toolError).slice(0, 300)}` : "."}`
          : "Preparing an interaction…"}
      </div>
    );
  }
  return <RichInteractionCard interactionId={interactionId} />;
}
