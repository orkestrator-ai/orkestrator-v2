import {
  WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import type { WorkflowResultRefusals, WorkflowResultService } from "./result-service.js";

/**
 * The refused calls associated with an open slot, from a service that may predate
 * `refusals` (test doubles): undefined when there is nothing to report.
 */
export function workflowResultRefusals(
  service: Partial<Pick<WorkflowResultService, "refusals">> | undefined,
  resultKey: string | undefined,
): WorkflowResultRefusals | undefined {
  if (!resultKey || typeof service?.refusals !== "function") return undefined;
  return service.refusals(resultKey);
}

/** Bound on the refusal reason quoted in a reminder (a durable prompt under 4 KiB). */
const REMINDER_REFUSAL_MAX_CHARS = 700;

function calls(count: number): string {
  return `${count} call${count === 1 ? "" : "s"}`;
}

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
  /**
   * Calls the tool refused before validation (`WorkflowResultService.refusals`).
   * Such a call never reaches the slot, so without this a step whose every
   * call was refused read as one that never called its tool.
   */
  refusals?: WorkflowResultRefusals;
}): string {
  const { subject, resultLabel, toolName } = input;
  if (input.submission === "correcting" || input.submission === "needs-attention") {
    return `${subject} stopped before ${toolName} accepted its ${resultLabel}; its last submission was rejected`;
  }
  if (input.refusals && input.refusals.count > 0) {
    const { count, processed, lastReason } = input.refusals;
    const refused =
      processed === 0
        ? `called ${toolName} (or its validation tool) ${count === 1 ? "once" : `${count} times`}, and the input check refused every call before validation`
        : `made ${calls(count)} to ${toolName} (or its validation tool) that the input check refused before validation`;
    return `${subject} ${refused}, so no ${resultLabel} was accepted${lastReason ? `. The last refusal: ${lastReason}` : ""}`;
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
 * with malformed arguments — typically a long nested object whose closing
 * braces are off by one, missing or extra — and then concluded the tool itself
 * was broken (or that the payload was too large). OpenCode
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
  /** What is already done, e.g. "discovery work". Defaults to "analysis". */
  workLabel?: string;
  /** Calls the tool refused before validation, with the newest reason. */
  refusals?: WorkflowResultRefusals;
}): string {
  const { resultLabel, toolName } = input;
  const workLabel = input.workLabel ?? "analysis";
  const refusals = input.refusals && input.refusals.count > 0 ? input.refusals : undefined;
  const lastReason =
    refusals?.lastReason && refusals.lastReason.length > REMINDER_REFUSAL_MAX_CHARS
      ? `${refusals.lastReason.slice(0, REMINDER_REFUSAL_MAX_CHARS - 1)}…`
      : refusals?.lastReason;
  const cause =
    input.submission === "correcting"
      ? `Your last submission was rejected. Correct only the problems it reported and submit again.`
      : refusals
        ? `The input check refused your ${calls(refusals.count)} before validation. Those calls targeted \`${toolName}\` or its validation tool.${lastReason ? ` The last refusal said: ${lastReason}` : ""} Sending the same arguments again is refused the same way: fix exactly the point the refusal names, and pass \`result\` as a JSON object, not as a string.`
        : input.finalText !== undefined && looksLikeJsonObject(input.finalText)
          ? `You wrote the ${resultLabel} as reply text. Reply text is not read; pass it to \`${toolName}\` instead.`
          : `No call to \`${toolName}\` was accepted.`;
  return [
    `Orkestrator has not received your ${resultLabel}. ${cause} Your ${workLabel} is already done: do not repeat it, only submit the result.`,
    `The result tools are working. ${WORKFLOW_RESULT_MALFORMED_CALL_GUIDANCE} Only call tools that were offered to you: never call a tool named \`invalid\`, and never write a tool error yourself.`,
    `The earlier resultKey is closed. Use only the resultKey (and capability, when one is given) from the instructions below.`,
  ].join("\n\n");
}

/**
 * The one follow-up turn sent when a provider restart cut a workflow turn
 * short (`ProviderSessionObservation.interruption`).
 *
 * Unlike the result reminder, the work is not done: the turn stopped partway,
 * and telling the model its analysis is complete made it refuse a task it had
 * never finished. The session keeps the earlier messages and tool results, so
 * it can pick up rather than start over. Bounded well below the 4 KiB durable
 * continuation-prompt limit; the fresh result instruction is appended at
 * dispatch.
 */
export function workflowRestartContinuationPrompt(input: {
  /** e.g. "review". */
  workLabel: string;
  /** e.g. "structured report". */
  resultLabel: string;
  /** The result tool, when the turn reports through one. */
  toolName?: string;
}): string {
  const { workLabel, resultLabel, toolName } = input;
  return [
    `Orkestrator restarted while you were working, so your last turn stopped partway. Your earlier messages and tool results are still in this conversation.`,
    `Continue the ${workLabel} from where it stopped. Do not start over: repeat a step only if you no longer have its result.`,
    toolName
      ? `When you are done, submit your ${resultLabel} by calling \`${toolName}\`. The earlier resultKey is closed. Use only the resultKey (and capability, when one is given) from the instructions below.`
      : `When you are done, return your ${resultLabel} as instructed.`,
  ].join("\n\n");
}

/** The turn that continues a session the user's pause stopped partway. */
export function workflowResumeContinuationPrompt(input: {
  workLabel: string;
  resultLabel: string;
  toolName?: string;
}): string {
  return workflowRestartContinuationPrompt(input).replace(
    "Orkestrator restarted while you were working, so",
    "This work was paused and has now resumed, so",
  );
}

/**
 * The turn sent after a five-hour or weekly limit stopped a workflow's turn and the machine
 * moved to another account. Like the restart continuation it continues the same
 * conversation rather than sending the step's prompt a second time.
 */
export function workflowUsageLimitContinuationPrompt(input: {
  workLabel: string;
  resultLabel: string;
  toolName?: string;
}): string {
  const { workLabel, resultLabel, toolName } = input;
  return [
    `Your last turn stopped because the account's five-hour or weekly usage limit ran out, and this session has moved to another account. Your earlier messages and tool results are still in this conversation.`,
    `Continue the ${workLabel} from where it stopped. Do not start over: repeat a step only if you no longer have its result.`,
    toolName
      ? `When you are done, submit your ${resultLabel} by calling \`${toolName}\`. The earlier resultKey is closed. Use only the resultKey (and capability, when one is given) from the instructions below.`
      : `When you are done, return your ${resultLabel} as instructed.`,
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

/**
 * Messages a caller reads to find the final reply. A row is one model
 * response, and a turn often ends on rows that only called tools, so the text
 * can sit several rows back.
 */
export const LAST_ASSISTANT_TEXT_READ_LIMIT = 100;

type TranscriptEntry = {
  role?: unknown;
  info?: { role?: unknown };
  content?: unknown;
  parts?: unknown;
};

function assistantText(message: TranscriptEntry): string | undefined {
  if (Array.isArray(message.parts)) {
    const text = message.parts
      .map((part: { type?: unknown; content?: unknown; text?: unknown } | null) => {
        if (part?.type !== "text") return undefined;
        return typeof part.content === "string" ? part.content : part.text;
      })
      .filter((text): text is string => typeof text === "string")
      .join("\n");
    if (text) return text;
  }
  return typeof message.content === "string" ? message.content : undefined;
}

/**
 * Text of the final reply in a normalized or raw provider transcript: the
 * newest assistant row with text, walking back over rows of the same turn
 * that only called tools. Stops at the user row that opened the turn, so an
 * earlier turn's reply is never reported as this one's. When no row of the
 * turn has text, the newest assistant row's own (empty) content is returned.
 */
export function lastAssistantText(messages: readonly unknown[] | undefined): string | undefined {
  if (!messages) return undefined;
  let newest: string | undefined;
  let found = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as TranscriptEntry | null;
    const role = message ? (message.role ?? message.info?.role) : undefined;
    if (found && role === "user") break;
    if (!message || role !== "assistant") continue;
    const text = assistantText(message);
    if (text) return text;
    if (!found) newest = text;
    found = true;
  }
  return newest;
}
