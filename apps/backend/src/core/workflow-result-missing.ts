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

/**
 * The one follow-up turn sent before a missing result becomes a failure.
 *
 * The common cause is not a model that forgot the tool but one that called it
 * with malformed arguments — typically a long nested object missing its final
 * closing brace — and then concluded the tool itself was broken. OpenCode
 * reroutes such a call to its internal `invalid` tool, which a model can then
 * keep calling directly with errors it invents, so the result tool is never
 * reached again. The reminder names both so the retry targets the real fault.
 *
 * Bounded well below the 4 KiB durable continuation-prompt limit; the
 * attempt's fresh result-tool instruction is appended at dispatch.
 */
export function workflowResultReminderPrompt(input: {
  /** e.g. "structured report". */
  resultLabel: string;
  toolName: string;
  submission: WorkflowResultSubmissionState | undefined;
  finalText?: string;
}): string {
  const { resultLabel, toolName } = input;
  const cause =
    input.submission === "correcting"
      ? `Your last submission was rejected. Correct only the problems it reported and submit again.`
      : input.finalText !== undefined && looksLikeJsonObject(input.finalText)
        ? `You wrote the ${resultLabel} as reply text. Reply text is not read; pass it to \`${toolName}\` instead.`
        : `No call to \`${toolName}\` was accepted.`;
  return [
    `Orkestrator has not received your ${resultLabel}. ${cause} Your analysis is already done: do not repeat it, only submit the result.`,
    `The result tools are working. If a call was rejected because its arguments could not be parsed as JSON (for example "JSON Parse error: Expected '}'"), the arguments you emitted were malformed, most often a closing brace missing at the end of a long nested object. Emit the arguments as one complete JSON object, check that every brace and bracket is closed, and keep prose fields short so the payload stays small. Only call tools that were offered to you: never call a tool named \`invalid\`, and never write a tool error yourself.`,
    `The earlier resultKey is closed. Use only the resultKey (and capability, when one is given) from the instructions below.`,
  ].join("\n\n");
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
