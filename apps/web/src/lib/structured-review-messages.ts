import { isStructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { NativeMessage } from "@/lib/chat/native-message-types";

function structuredPayload(value: string): boolean {
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("```json") && trimmed.endsWith("```")
    ? trimmed.slice(7, -3).trim()
    : trimmed;
  if (!candidate.startsWith("{")) return false;
  try {
    return isStructuredReviewReport(JSON.parse(candidate));
  } catch {
    return false;
  }
}

/**
 * Provider transcripts may echo a schema-constrained final payload as JSON.
 * The payload remains available through the explicit inspection action, so a
 * review tab removes only validated report JSON from its ordinary transcript.
 * This is presentation filtering, never a success or validation fallback.
 */
export function hideRawStructuredReviewMessages(
  messages: NativeMessage[],
): NativeMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    const parts = message.parts.filter(
      (part) => part.type !== "text" || !structuredPayload(part.content),
    );
    const content = structuredPayload(message.content) ? "" : message.content;
    if (parts.length === 0 && content.length === 0) return [];
    return [{ ...message, content, parts }];
  });
}
