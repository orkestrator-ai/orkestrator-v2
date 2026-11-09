import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import { presentPeerMailCarrierRow } from "@/lib/chat/client-only-messages";
import { isPeerMailCarrierContent } from "@orkestrator/protocol/agent-mail";
import { createGoalTurnNativeMessage } from "@/lib/chat/goal-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeAgentMessagePage } from "@orkestrator/protocol/native-agent";
import { coordinatorToolName } from "./coordinator-action-cards";

/** Keep action evidence, not prose/tool output, independently of the rendered window. */
export function actionEvidence(message: NativeMessage): NativeMessage {
  const parts = message.parts.flatMap(function pick(part): NativeMessage["parts"] {
    if (part.type === "tool-group")
      return [{ type: "text", content: "" }, ...part.parts.flatMap(pick)];
    const tool = coordinatorToolName(part.toolName);
    if (part.type === "async-question") return [part];
    if (
      !tool ||
      !/^(mark_topic|mark_question|AskUserQuestion|request_user_input|ask_question|question)$/.test(
        tool,
      )
    )
      return [{ type: "text", content: "" }];
    return [
      {
        type: "tool-invocation",
        content: "",
        toolName: part.toolName,
        toolUseId: part.toolUseId,
        toolArgs: part.toolArgs,
        toolState: part.toolState,
        toolError: part.toolError,
        toolTitle: part.toolTitle,
      },
    ];
  });
  return { ...message, content: "", parts };
}

function pageEvidence(messages: readonly NativeMessage[]): NativeMessage[] {
  return normalizeNativeMessages(messages).flatMap((message) => {
    if (message.role === "user" && isPeerMailCarrierContent(message.content)) {
      return (presentPeerMailCarrierRow(message) ?? [message]).map(actionEvidence);
    }
    return [actionEvidence(createGoalTurnNativeMessage(message) ?? message)];
  });
}

/** Sequential page reads never enlarge the renderer's history budget. Explicit
 * count/byte bounds refuse an incomplete index rather than silently publishing it. */
export async function recoverActionHistory(
  tail: readonly NativeMessage[],
  cursor: string | undefined,
  epoch: string,
  read: (before: string) => Promise<NativeAgentMessagePage<NativeMessage>>,
  stopped: () => boolean = () => false,
): Promise<NativeMessage[]> {
  let evidence = pageEvidence(tail);
  let bytes = new TextEncoder().encode(JSON.stringify(evidence)).byteLength;
  if (bytes > 8 * 1024 * 1024) throw new Error("Action history evidence limit");
  const visited = new Set<string>();
  while (cursor && !stopped()) {
    if (visited.has(cursor) || visited.size >= 10_000)
      throw new Error("Action history cursor limit");
    visited.add(cursor);
    const page = await read(cursor);
    if (stopped()) return [];
    if (page.historyEpoch !== epoch || page.truncated)
      throw new Error("Action history changed or truncated");
    const older = pageEvidence(page.messages);
    bytes += new TextEncoder().encode(JSON.stringify(older)).byteLength;
    if (bytes > 8 * 1024 * 1024) throw new Error("Action history evidence limit");
    evidence = [...older, ...evidence];
    cursor = page.nextCursor;
    if (!cursor && !page.complete) throw new Error("Action history unavailable");
  }
  return evidence;
}
