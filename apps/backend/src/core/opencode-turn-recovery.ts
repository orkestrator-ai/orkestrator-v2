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
 * The same path retries turns a provider API error ended mid-flight (for
 * example a gateway 400 that OpenCode marks non-retryable), with backoff and a
 * bounded retry budget.
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

/**
 * Continuation prompt for turns a provider API error ended mid-flight.
 *
 * Like {@link OPENCODE_INCOMPLETE_TURN_CONTINUATION}, its exact value is the
 * durable retry counter: the number of consecutive automatic continuations at
 * the end of the transcript bounds the retries across restarts.
 */
export const OPENCODE_PROVIDER_ERROR_CONTINUATION =
  "The previous model request failed with a provider error. Continue from the current session state. Do not repeat completed actions. Finish the remaining work and provide the final conclusion.";

/**
 * Wait before each automatic retry of a provider error, measured from when the
 * failed message completed. Its length is the retry budget.
 */
export const OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
/** A restart may resume a recent backoff, but must not revive an abandoned turn. */
export const OPENCODE_PROVIDER_ERROR_MAX_AGE_MS = 5 * 60_000;

/**
 * HTTP statuses that will fail the same way on retry: credentials, billing,
 * an unknown model, or a request the provider refuses to accept at this size.
 */
const NON_RETRYABLE_PROVIDER_STATUSES = new Set([401, 402, 403, 404, 413]);

const AUTOMATIC_CONTINUATIONS = new Set<string>([
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
  OPENCODE_PROVIDER_ERROR_CONTINUATION,
]);

export interface OpenCodeIncompleteTurnRecovery {
  action: "continue" | "exhausted";
  /** Which failure shape was detected; selects the continuation prompt. */
  reason: "incomplete" | "provider-error";
  /** Earliest epoch ms a provider-error retry may be dispatched (backoff). */
  notBefore?: number;
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
export function openCodeMessageFinishReason(entry: unknown): string | undefined {
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

/**
 * A provider API failure worth retrying automatically.
 *
 * Only `APIError` qualifies: aborts, auth failures, output-length and context
 * overflow errors are either deliberate or deterministic. Statuses that cannot
 * succeed on retry are excluded; everything else — including 400s gateways
 * return for transient upstream faults — is retried within a small budget.
 */
function isRetryableProviderError(error: unknown): boolean {
  if (!isRecord(error) || error.name !== "APIError") return false;
  const statusCode = isRecord(error.data) ? error.data.statusCode : undefined;
  return typeof statusCode !== "number" || !NON_RETRYABLE_PROVIDER_STATUSES.has(statusCode);
}

/** Count back to a manual prompt; a clipped history cannot prove the budget remains. */
function trailingAutomaticContinuations(messages: readonly unknown[]): {
  count: number;
  foundManualBoundary: boolean;
} {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageInfo(messages[index])?.role !== "user") continue;
    if (!AUTOMATIC_CONTINUATIONS.has(textContent(messages[index]).trim())) {
      return { count, foundManualBoundary: true };
    }
    count += 1;
  }
  return { count, foundManualBoundary: false };
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
 *   work the user deliberately stopped. The exception is a retryable provider
 *   `APIError`, retried with backoff up to the length of
 *   {@link OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS};
 * - a pending tool or subagent means continuing could overlap side effects;
 * - the fixed continuation prompt as the latest user turn means recovery
 *   already ran once and the provider stalled again — report `exhausted`
 *   instead of looping. Consecutive automatic continuations of either kind
 *   share the provider-error retry budget.
 */
export function inspectOpenCodeIncompleteTurn(
  messages: readonly unknown[],
  options: { historyComplete?: boolean; now?: number } = {},
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
  if (typeof info.id !== "string") return null;
  const providerError = isRetryableProviderError(info.error);
  if (
    !providerError &&
    ((info.error !== undefined && info.error !== null) ||
      openCodeMessageFinishReason(latestAssistant) !== "unknown" ||
      textContent(latestAssistant).trim().length > 0)
  ) {
    return null;
  }

  for (const message of turnMessages) {
    if (messageInfo(message)?.role !== "assistant") continue;
    if (hasPendingToolWork(message)) return null;
  }

  // Both recoveries share one budget, so alternating failure shapes cannot
  // keep the session continuing itself indefinitely.
  const { count: automatic, foundManualBoundary } = trailingAutomaticContinuations(messages);
  const budgetUnknown = options.historyComplete === false && !foundManualBoundary;
  const settings = turnExecutionSettings(messages[latestUserIndex], latestAssistant);
  if (providerError) {
    const retries = OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS.length;
    const time = isRecord(info.time) ? info.time : undefined;
    const failedAt = [time?.completed, time?.created].find(
      (candidate): candidate is number =>
        typeof candidate === "number" && Number.isFinite(new Date(candidate).getTime()),
    );
    if (
      options.now !== undefined &&
      (failedAt === undefined ||
        !Number.isFinite(options.now) ||
        failedAt > options.now ||
        options.now - failedAt > OPENCODE_PROVIDER_ERROR_MAX_AGE_MS)
    ) {
      return null;
    }
    return {
      action: budgetUnknown || automatic >= retries ? "exhausted" : "continue",
      reason: "provider-error",
      ...(failedAt !== undefined && !budgetUnknown && automatic < retries
        ? { notBefore: failedAt + OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS[automatic]! }
        : {}),
      assistantMessageId: info.id,
      ...settings,
    };
  }
  return {
    action:
      textContent(messages[latestUserIndex]).trim() === OPENCODE_INCOMPLETE_TURN_CONTINUATION ||
      budgetUnknown ||
      automatic >= OPENCODE_PROVIDER_ERROR_RETRY_DELAYS_MS.length
        ? "exhausted"
        : "continue",
    reason: "incomplete",
    assistantMessageId: info.id,
    ...settings,
  };
}

/** The fixed continuation prompt for one detected recovery. */
export function openCodeTurnRecoveryPrompt(recovery: OpenCodeIncompleteTurnRecovery): string {
  return recovery.reason === "provider-error"
    ? OPENCODE_PROVIDER_ERROR_CONTINUATION
    : OPENCODE_INCOMPLETE_TURN_CONTINUATION;
}

/**
 * Durable dispatch identity for one stalled assistant message. Routing the
 * continuation through `dispatchNativeAgentPromptOnce` with this id makes the
 * whole recovery at-most-once per stall across sweeps and backend restarts.
 */
export function openCodeIncompleteTurnRequestId(assistantMessageId: string): string {
  return `opencode-incomplete-${assistantMessageId}`;
}
