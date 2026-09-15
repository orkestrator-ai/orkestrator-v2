import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { NativeMessage, NativeTextPart } from "./native-message-types";
import { isFixOpeningPrompt } from "./user-prompt-display";

function userPromptSources(message: NativeMessage): string[] {
  const sources = message.parts
    .filter((part): part is NativeTextPart => part.type === "text")
    .map((part) => part.content);
  if (sources.length > 0) return sources;
  return message.content ? [message.content] : [];
}

/**
 * Attach the durable Fix-tab report to the address or custom-fix opening row.
 *
 * The first loaded user bubble is not a reliable anchor: a reused session can
 * start with a review-stage prompt, and a windowed transcript can start on a
 * later follow-up. When the opening prompt is outside the loaded window,
 * nothing is pinned so a later bubble does not inherit the card.
 */
export function attachFixPromptEvidence(
  messages: NativeMessage[],
  report: StructuredReviewReport,
): NativeMessage[] {
  const openingIndex = messages.findIndex(
    (message) =>
      message.role === "user" &&
      userPromptSources(message).some((source) =>
        isFixOpeningPrompt(source, message.promptPresentation),
      ),
  );
  if (openingIndex < 0) return messages;
  return messages.map((message, index) =>
    index === openingIndex ? { ...message, promptEvidence: report } : message,
  );
}
