import type { WorkflowResultSubmissionState } from "@orkestrator/protocol/workflow-results";

/**
 * Explains why a tool-transport step went idle with no accepted result.
 *
 * "Became idle without returning its report" gave the user nothing to act
 * on. The result slot already knows whether anything was submitted, and the
 * final reply shows the common failure outright: a model that could not call
 * its submit tool usually pastes the result as JSON text instead.
 */
export function missingWorkflowResultMessage(input: {
  /** Sentence subject, e.g. "The consolidation model". */
  subject: string;
  /** e.g. "consolidated report". */
  resultLabel: string;
  toolName: string;
  submission: WorkflowResultSubmissionState | undefined;
  finalText?: string;
}): string {
  const { subject, resultLabel, toolName } = input;
  if (input.submission === "correcting" || input.submission === "needs-attention") {
    return `${subject} stopped before ${toolName} accepted its ${resultLabel}; its last submission was rejected`;
  }
  if (input.finalText !== undefined && looksLikeJsonObject(input.finalText)) {
    return `${subject} replied with its ${resultLabel} as text instead of calling ${toolName}`;
  }
  return `${subject} finished without calling ${toolName} to submit its ${resultLabel}`;
}

/** Deliberately a shape check, not a parse: the text can be any size. */
function looksLikeJsonObject(text: string): boolean {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

/** Text of the last assistant message in a normalized transcript. */
export function lastAssistantText(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown; parts?: unknown };
    if (!message || message.role !== "assistant") continue;
    if (Array.isArray(message.parts)) {
      const text = message.parts
        .filter(
          (part): part is { type: "text"; content: string } =>
            !!part &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { content?: unknown }).content === "string",
        )
        .map((part) => part.content)
        .join("\n");
      if (text) return text;
    }
    return typeof message.content === "string" ? message.content : undefined;
  }
  return undefined;
}
