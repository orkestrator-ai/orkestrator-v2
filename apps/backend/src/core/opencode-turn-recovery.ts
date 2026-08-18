/**
 * Backend detection of OpenCode's incomplete-turn failure mode.
 *
 * Some providers (notably DeepSeek through opencode-go) end a step with
 * `finish_reason: unknown` after emitting only reasoning. OpenCode treats the
 * unrecognized reason as terminal and exits its loop, so the turn reports idle
 * with no final assistant text. The backend observes that exact turn-end edge
 * through its activity sweep and dispatches one bounded continuation prompt —
 * no mounted renderer is involved, which is what makes the recovery survive
 * closed tabs, inactive environments, and app restarts.
 *
 * The inspection works on raw `session.messages()` SDK payloads
 * (`{ info, parts }`), the same authoritative transcript OpenCode persists.
 */

/**
 * Continuation prompt for turns that ended with `unknown` and no final text.
 *
 * Its exact value is deliberately stable: seeing it as the latest user turn is
 * the durable, transcript-backed guard that bounds recovery to one consecutive
 * continuation, across backend restarts and any number of observers. It must
 * stay byte-identical to the prompt previous renderer-side recovery dispatched,
 * so transcripts continued by older clients still read as already-continued.
 */
export const OPENCODE_INCOMPLETE_TURN_CONTINUATION =
  "Continue from the current session state. Do not repeat completed actions. Finish the remaining work and provide the final conclusion.";

export interface OpenCodeIncompleteTurnRecovery {
  action: "continue" | "exhausted";
  /** Stalled assistant message id; keys the durable dispatch request id. */
  assistantMessageId: string;
  /** `providerID/modelID` of the stalled turn, when the transcript reports it. */
  modelId?: string;
  /** Execution agent of the stalled turn (`build`, `plan`, …). */
  agent?: string;
  /** Model variant/reasoning profile used by the stalled turn. */
  variant?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageInfo(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || !isRecord(entry.info)) return undefined;
  return entry.info;
}

function messageParts(entry: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(entry) || !Array.isArray(entry.parts)) return [];
  return entry.parts.filter(isRecord);
}

function textContent(entry: unknown): string {
  let text = "";
  for (const part of messageParts(entry)) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * OpenCode has persisted execution settings in two compatible shapes across
 * its message-schema transition: directly on `info`, and under the v2
 * `info.request` object. Read both, preferring the user request because it is
 * the authoritative record of what was asked to run.
 */
function turnExecutionSettings(
  userEntry: unknown,
  assistantEntry: unknown,
): Pick<OpenCodeIncompleteTurnRecovery, "modelId" | "agent" | "variant"> {
  const user = messageInfo(userEntry);
  const request = isRecord(user?.request) ? user.request : undefined;
  const assistant = messageInfo(assistantEntry);
  const model = isRecord(request?.model)
    ? request.model
    : isRecord(user?.model)
      ? user.model
      : undefined;
  const providerID = nonBlankString(model?.providerID) ?? nonBlankString(assistant?.providerID);
  const modelID = nonBlankString(model?.modelID) ?? nonBlankString(assistant?.modelID);
  const agent =
    nonBlankString(request?.agent) ??
    nonBlankString(user?.agent) ??
    nonBlankString(assistant?.agent);
  const variant = nonBlankString(request?.variant) ?? nonBlankString(user?.variant);
  return {
    ...(providerID && modelID ? { modelId: `${providerID}/${modelID}` } : {}),
    ...(agent ? { agent } : {}),
    ...(variant ? { variant } : {}),
  };
}

/**
 * The terminal step reason for one assistant message. A message can carry more
 * than one `step-finish` marker in replayed or malformed data; the final one is
 * the reason that ended the message. Falls back to the message-level `finish`
 * field, which newer OpenCode versions also persist.
 */
function finishReason(entry: unknown): string | undefined {
  let reason: string | undefined;
  for (const part of messageParts(entry)) {
    if (
      part.type === "step-finish" &&
      typeof part.reason === "string" &&
      part.reason.trim().length > 0
    ) {
      reason = part.reason.trim();
    }
  }
  if (reason) return reason;
  const finish = messageInfo(entry)?.finish;
  return typeof finish === "string" && finish.trim().length > 0 ? finish.trim() : undefined;
}

function hasPendingToolWork(entry: unknown): boolean {
  for (const part of messageParts(entry)) {
    if (part.type !== "tool") continue;
    const status = isRecord(part.state) ? part.state.status : undefined;
    if (status === "pending" || status === "running") return true;
  }
  return false;
}

/**
 * Inspect an authoritative OpenCode transcript for the incomplete-turn shape.
 *
 * Recovery is intentionally conservative:
 * - final assistant text means the turn is usable, even if its reason is odd;
 * - an assistant error means the turn was aborted or failed — a user stop
 *   stamps `MessageAbortedError` on the message, so continuing would re-run
 *   work the user deliberately stopped;
 * - a pending tool or subagent means continuing could overlap side effects;
 * - the fixed continuation prompt as the latest user turn means recovery
 *   already ran once and the provider stalled again — report `exhausted`
 *   instead of looping.
 */
export function inspectOpenCodeIncompleteTurn(
  messages: readonly unknown[],
): OpenCodeIncompleteTurnRecovery | null {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageInfo(messages[index])?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return null;

  const turnMessages = messages.slice(latestUserIndex + 1);
  let latestAssistant: unknown;
  for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
    if (messageInfo(turnMessages[index])?.role === "assistant") {
      latestAssistant = turnMessages[index];
      break;
    }
  }
  if (!latestAssistant) return null;

  const info = messageInfo(latestAssistant)!;
  if (
    typeof info.id !== "string" ||
    (info.error !== undefined && info.error !== null) ||
    finishReason(latestAssistant) !== "unknown" ||
    textContent(latestAssistant).trim().length > 0
  ) {
    return null;
  }

  for (const message of turnMessages) {
    if (messageInfo(message)?.role !== "assistant") continue;
    if (hasPendingToolWork(message)) return null;
  }

  return {
    action:
      textContent(messages[latestUserIndex]).trim() === OPENCODE_INCOMPLETE_TURN_CONTINUATION
        ? "exhausted"
        : "continue",
    assistantMessageId: info.id,
    ...turnExecutionSettings(messages[latestUserIndex], latestAssistant),
  };
}

/**
 * Durable dispatch identity for one stalled assistant message. Routing the
 * continuation through `dispatchNativeAgentPromptOnce` with this id makes the
 * whole recovery at-most-once per stall across sweeps and backend restarts.
 */
export function openCodeIncompleteTurnRequestId(assistantMessageId: string): string {
  return `opencode-incomplete-${assistantMessageId}`;
}
