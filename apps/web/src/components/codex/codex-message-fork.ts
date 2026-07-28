import {
  type MessageForkKind,
  type MessageForkPlanEntry,
} from "@/components/chat/message-fork";
import { CodexForkError } from "@/lib/codex-client";

export function requireCodexForkPlanEntry(
  plan: ReadonlyMap<string, MessageForkPlanEntry>,
  messageId: string,
  kind: MessageForkKind,
): MessageForkPlanEntry {
  const planned = plan.get(messageId);
  if (!planned || planned.kind !== kind) {
    throw new CodexForkError(
      404,
      "The selected message is no longer in this session",
    );
  }
  return planned;
}
