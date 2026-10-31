import { randomBytes } from "node:crypto";
import {
  capacityRetryDelayMs,
  formatRetryDelay,
  namesLimitOrLogin,
} from "@orkestrator/protocol/capacity-retry";
import {
  AcpProcess,
  POLICY_DENIAL_MAX_CONTINUATIONS,
  PROMPT_TIMEOUT_MS,
  RETRIABLE_PROVIDER_MAX_RETRIES,
  RETRIABLE_PROVIDER_RETRY_POLICY,
  provider,
  sessions,
  shuttingDown,
  type BridgeMessage,
  type BridgeRetryPart,
  type BridgeTextPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { recordTurnUsage } from "./acp-session.js";
import { STRUCTURED_PROMPT_INSTRUCTION_PREFIX } from "./structured-prompt-marker.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { currentAssistantMessage, noteMessageMutation, notePartMutation } from "./acp-rows.js";
import { schedulePersist } from "./acp-persist-writer.js";
import {
  startPromptTurnClock,
  stopPromptTurnClock,
  type PromptTurnClock,
} from "./acp-prompt-clock.js";
import type { PromptResponse, StopReason } from "@agentclientprotocol/sdk";

// Transient provider codes the bridge auto-retries. `resource_exhausted` is
// Cursor's capacity signal; `unavailable` is a dropped connection / PING
// timeout. The trailing detail is whatever the provider wrote (`Error`,
// `PING timed out`, …) — matching only the word `Error` would leave the
// latter dead in the transcript.
const RETRIABLE_PROVIDER_CODE = String.raw`\[(?:resource_exhausted|unavailable)\]`;
// One definition of "what separates the code from its detail", shared by both
// classifiers below, which recognise the same provider failure arriving over
// two different transports. Accept horizontal whitespace or one wrapped line,
// but never cross a blank-line paragraph boundary: flattened assistant text is
// model-controlled, so treating a later paragraph as the error detail would
// delete a real answer and silently retry the turn.
const RETRIABLE_PROVIDER_SEPARATOR = String.raw`(?:[^\S\r\n]+(?:\r?\n[^\S\r\n]*)?|\r?\n[^\S\r\n]*)`;
// A real detail starts with a non-whitespace character. Both classifiers use
// this so whitespace-only tails (`[unavailable]  `) are retriable to neither:
// the flattened suffix used to use `[^\n]+`, which treated extra spaces as a
// detail while the RPC matcher required `\S`.
const RETRIABLE_PROVIDER_DETAIL = String.raw`\S`;
export const RETRIABLE_PROVIDER_ERROR = new RegExp(
  `${RETRIABLE_PROVIDER_CODE}${RETRIABLE_PROVIDER_SEPARATOR}${RETRIABLE_PROVIDER_DETAIL}`,
  "i",
);
// The class name is whatever the provider's own error carried — `RetriableError`
// is only the one Cursor happens to emit today. Matching a single character here
// would silently exclude every other name and leave the turn dead, so the
// identifier is quantified and the flag set matches `RETRIABLE_PROVIDER_ERROR`.
//
// The detail is deliberately bounded to the final line (`\S[^\n]*\s*$`). A
// provider error whose detail carries its own stack trace is therefore *not*
// stripped or retried: it stays in the transcript and the turn ends. That is
// the safe direction. Assistant text is model-controlled, so a pattern that
// swallowed trailing lines could delete a real answer and silently re-run the
// turn — a far worse failure than surfacing one unretried provider error.
export const FLATTENED_RETRIABLE_PROVIDER_SUFFIX = new RegExp(
  `(?:^|\\n\\n)Error: [A-Za-z_$][\\w$]*: ${RETRIABLE_PROVIDER_CODE}${RETRIABLE_PROVIDER_SEPARATOR}${RETRIABLE_PROVIDER_DETAIL}[^\\n]*\\s*$`,
  "i",
);
/**
 * Grok's own wording for a model overload (Grok 1.0.70), which carries no
 * `[code]`. Accepted on a JSON-RPC error only: assistant text is
 * model-controlled, and this exact sentence there proves nothing.
 */
const GROK_OVERLOADED_RPC_ERROR =
  /\b(?:Grok|Model) is temporarily overloaded\. (?:Please t|T)ry again in a moment\./;
export const RETRIABLE_PROVIDER_CONTINUATION =
  "Continue from where the interrupted turn stopped. A transient provider error ended the previous attempt. Do not repeat work or tool calls that already completed; inspect the session history and finish the original request.";
export const POLICY_DENIAL_CONTINUATION =
  "Your last tool call was refused because this session's policy does not permit it. That is final: do not retry the call or work around it with another tool. Continue the original request without it, and say in your answer what you could not do.";

/** Grok's `cancellationCategory` values for a turn ended on a permission answer. */
const PERMISSION_CANCELLATION_CATEGORIES = new Set(["PermissionRejected", "PermissionCancelled"]);

/**
 * Whether a `cancelled` turn ended on the policy refusal the bridge gave
 * during it, so continuing cannot override anything else.
 *
 * Grok 1.0.52 ends its turn on any non-allow permission answer, so a
 * coordinator's or reviewer's first denied write used to end the turn before
 * it reported anything. A turn the user cancelled or closed sets
 * `retryCancelledPromptSequence` and is never continued. Grok names its
 * reason in `_meta.cancellationCategory`; one naming any other cause (a hook,
 * a mid-turn abort) is left ended. An agent that sends no category is
 * continued on the bridge's own refusal record.
 */
function endedOnPolicyRefusal(state: SessionState, result: unknown, deniedBefore: number): boolean {
  if ((state.policyDeniedRequests ?? 0) <= deniedBefore) return false;
  const meta = (result as { _meta?: unknown })._meta;
  const category =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as { cancellationCategory?: unknown }).cancellationCategory
      : undefined;
  return category === undefined || PERMISSION_CANCELLATION_CATEGORIES.has(String(category));
}

function continuationPrompt(
  state: SessionState,
  text: string,
  schema: JsonObject | undefined,
): JsonObject {
  return {
    sessionId: state.acpSessionId,
    // The schema instruction rides every attempt. The continuation replaces
    // the original prompt on the wire, so omitting it would ask a structured
    // turn to finish without restating the contract it must satisfy.
    prompt: [
      { type: "text", text: schema ? `${text}\n\n${structuredPromptInstruction(schema)}` : text },
    ],
  };
}

export function flattenedRetriableProviderTail(state: SessionState): {
  message: BridgeMessage;
  part: BridgeTextPart;
} | null {
  const message = state.messages.at(-1);
  const part = message?.parts.at(-1);
  if (message?.role !== "assistant" || part?.type !== "text") return null;
  const suffix = FLATTENED_RETRIABLE_PROVIDER_SUFFIX.exec(part.content)?.[0];
  return suffix !== undefined &&
    !namesLimitOrLogin(suffix) &&
    FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(message.content)
    ? { message, part }
    : null;
}

export function stripFlattenedRetriableProviderTail(
  state: SessionState,
  tail: { message: BridgeMessage; part: BridgeTextPart },
): void {
  tail.part.content = tail.part.content.replace(FLATTENED_RETRIABLE_PROVIDER_SUFFIX, "");
  tail.message.content = tail.message.content.replace(FLATTENED_RETRIABLE_PROVIDER_SUFFIX, "");
  if (!tail.part.content) tail.message.parts.pop();
  // Interim provider serialization is not part of the transcript users should
  // have to interpret. The final marker is retained if all retries exhaust.
  state.revision += 1;
  schedulePersist();
}

/**
 * The schema constrains the *final* message, not the whole turn.
 *
 * The reader of an agent tab watches the text channel, and this instruction
 * used to forbid commentary outright — so a long structured turn showed them
 * nothing at all, or a half-written JSON document, until it finished. Turn
 * output is recovered with `tryParseStructuredOutputText`, which takes the last
 * well-formed document in the concatenated turn, so prose before it is already
 * safe; saying so is what makes the agent willing to narrate its progress.
 */
export function structuredPromptInstruction(schema: JsonObject): string {
  return `${STRUCTURED_PROMPT_INSTRUCTION_PREFIX} matching this JSON Schema. That final message must be the JSON value alone, with no Markdown fence and no commentary around it.\n\nBefore that final message you may send ordinary prose progress updates. Keep them plain sentences: never send a JSON object or array as a progress update, and never draft or preview the final value.\n\n${JSON.stringify(schema)}`;
}

/**
 * A transient provider failure. A `[resource_exhausted]` naming a usage or rate
 * limit, or a login, is not one: gRPC uses that code for quota too, and waiting
 * a minute cures none of them.
 */
export function retriableProviderError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (RETRIABLE_PROVIDER_ERROR.test(error.message) ||
      GROK_OVERLOADED_RPC_ERROR.test(error.message)) &&
    !namesLimitOrLogin(error.message)
  );
}

/** The wait before a continuation; `state.wakeRetryWait` ends it early. */
export function retryDelay(state: SessionState, milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      state.wakeRetryWait = undefined;
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    state.wakeRetryWait = finish;
  });
}

const RETRY_CARD_SUBJECT = "Provider temporarily unavailable";

/**
 * The transcript's account of a wait. It joins the row the failed attempt
 * ended on, and is settled in place on that row when the wait ends.
 */
function openRetryCard(state: SessionState, text: string): BridgeRetryPart {
  const message = currentAssistantMessage(state);
  const part: BridgeRetryPart = {
    type: "retry",
    content: text,
    toolState: "pending",
    sourcePartId: randomBytes(12).toString("hex"),
    sourceMessageId: message.id,
    createdAt: new Date().toISOString(),
  };
  message.parts.push(part);
  noteMessageMutation(state, message);
  state.revision += 1;
  schedulePersist();
  return part;
}

function settleRetryCard(
  state: SessionState,
  part: BridgeRetryPart,
  text: string,
  toolState: "success" | "failure",
): void {
  part.content = text;
  part.toolState = toolState;
  notePartMutation(state, part);
  state.revision += 1;
  schedulePersist();
}

export function retryStillOwned(
  state: SessionState,
  child: AcpProcess,
  promptSequence: number,
): boolean {
  return (
    !shuttingDown &&
    !state.closing &&
    sessions.get(state.id) === state &&
    state.child === child &&
    state.status === "running" &&
    state.promptSequence === promptSequence &&
    state.retryCancelledPromptSequence !== promptSequence
  );
}

export function retryOwnershipLostError(state: SessionState): Error {
  // A child exit or a transcript-limit failure records the real cause before the
  // retry wakes up, and `/prompt` clears `error` per turn so anything here
  // belongs to this one. Preserve it rather than hiding "the agent died" behind
  // the generic message.
  return new Error(state.error || `${provider} prompt retry lost its live session`);
}

export async function requestPromptWithRetriableProviderRetries(
  state: SessionState,
  child: AcpProcess,
  initialPrompt: JsonObject,
  promptSequence: number,
  schema: JsonObject | undefined,
): Promise<unknown> {
  state.currentAttemptUsage = {};
  state.completedAttemptUsage = undefined;
  let prompt = initialPrompt;
  let retries = 0;
  let policyContinuations = 0;

  while (true) {
    let result: unknown;
    let requestError: Error | undefined;
    const deniedBefore = state.policyDeniedRequests ?? 0;
    // `request` arms its timeout synchronously, so the attempt times out at
    // this instant or a moment after it, never before. The timeout terminates
    // the child that would answer a parked request, so it caps a countdown;
    // holding a request stops it (`acp-prompt-clock.ts`).
    const promptDeadlineAt = Date.now() + PROMPT_TIMEOUT_MS;
    state.promptDeadlineAt = promptDeadlineAt;
    let clock: PromptTurnClock | undefined;
    try {
      const request = child.request(
        "session/prompt",
        prompt,
        PROMPT_TIMEOUT_MS,
        undefined,
        (rearm) => {
          clock = startPromptTurnClock(state, PROMPT_TIMEOUT_MS, rearm);
        },
      );
      result = await request;
    } catch (error) {
      if (!retriableProviderError(error)) throw error;
      requestError = error;
    } finally {
      if (clock) stopPromptTurnClock(state, clock);
      else if (state.promptDeadlineAt === promptDeadlineAt) state.promptDeadlineAt = undefined;
    }

    recordTurnUsage(state, result);
    const flattened = requestError ? null : flattenedRetriableProviderTail(state);
    if (!requestError && !flattened) {
      const last = state.messages.at(-1);
      const part = last?.parts.at(-1);
      const suffix =
        part?.type === "text"
          ? FLATTENED_RETRIABLE_PROVIDER_SUFFIX.exec(part.content)?.[0]
          : undefined;
      if (
        last?.role === "assistant" &&
        suffix &&
        namesLimitOrLogin(suffix) &&
        FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(last.content)
      ) {
        throw new Error(suffix.trim());
      }
    }
    if (!requestError && !flattened) {
      if (
        promptStopReason(result) !== "cancelled" ||
        !endedOnPolicyRefusal(state, result, deniedBefore) ||
        !retryStillOwned(state, child, promptSequence)
      ) {
        return result;
      }
      if (policyContinuations >= POLICY_DENIAL_MAX_CONTINUATIONS) {
        cancelEndedAttemptInteractions(state);
        state.policyDenialExhaustedPromptSequence = promptSequence;
        return result;
      }
      resetEndedAttempt(state);
      policyContinuations += 1;
      prompt = continuationPrompt(state, POLICY_DENIAL_CONTINUATION, schema);
      continue;
    }
    if (!retryStillOwned(state, child, promptSequence)) {
      if (state.retryCancelledPromptSequence === promptSequence) {
        return { stopReason: "cancelled" };
      }
      throw requestError ?? retryOwnershipLostError(state);
    }
    if (retries >= RETRIABLE_PROVIDER_MAX_RETRIES) {
      throw new Error(
        `${provider} remained in a retriable provider error after ${RETRIABLE_PROVIDER_MAX_RETRIES} retries`,
        requestError ? { cause: requestError } : undefined,
      );
    }

    if (flattened) stripFlattenedRetriableProviderTail(state, flattened);
    // Discard every attempt's partial structured output, on both the flattened
    // and the typed-RPC path. The continuation re-emits the whole value, so a
    // retained prefix would concatenate into unparseable JSON and fail a turn
    // that actually recovered.
    resetEndedAttempt(state);
    retries += 1;
    const nextAttempt = retries + 1;
    const { maxAttempts } = RETRIABLE_PROVIDER_RETRY_POLICY;
    const delayMs = capacityRetryDelayMs(RETRIABLE_PROVIDER_RETRY_POLICY, nextAttempt);
    const card = openRetryCard(
      state,
      `${RETRY_CARD_SUBJECT}, retrying in ${formatRetryDelay(delayMs)} (attempt ${nextAttempt} of ${maxAttempts})`,
    );
    await retryDelay(state, delayMs);

    if (!retryStillOwned(state, child, promptSequence)) {
      settleRetryCard(state, card, `${RETRY_CARD_SUBJECT}, automatic retry cancelled`, "failure");
      if (state.retryCancelledPromptSequence === promptSequence) {
        return { stopReason: "cancelled" };
      }
      throw retryOwnershipLostError(state);
    }
    settleRetryCard(
      state,
      card,
      `${RETRY_CARD_SUBJECT}, retried automatically (attempt ${nextAttempt} of ${maxAttempts})`,
      "success",
    );
    prompt = continuationPrompt(state, RETRIABLE_PROVIDER_CONTINUATION, schema);
  }
}

function resetEndedAttempt(state: SessionState): void {
  state.completedAttemptUsage = state.currentTurnUsage;
  state.currentAttemptUsage = {};
  if (state.currentTurnOutput !== null) state.currentTurnOutput = "";
  reconcileStaleToolParts(state);
  cancelEndedAttemptInteractions(state);
}

function cancelEndedAttemptInteractions(state: SessionState): void {
  // Requests from an ended attempt must not outlive it or resolve a
  // request in the continuation. `respond` also settles each deadline.
  for (const interaction of Array.from(state.interactions.values())) {
    interaction.respond({ outcome: "cancelled" });
  }
}

export function promptStopReason(result: unknown): StopReason {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${provider} returned an invalid ACP prompt response`);
  }
  const stopReason = (result as Partial<PromptResponse>).stopReason;
  if (
    stopReason !== "end_turn" &&
    stopReason !== "max_tokens" &&
    stopReason !== "max_turn_requests" &&
    stopReason !== "refusal" &&
    stopReason !== "cancelled"
  ) {
    throw new Error(`${provider} returned an invalid ACP prompt stopReason`);
  }
  return stopReason;
}

/**
 * Why a finished turn was cut short, or undefined when it ended normally.
 *
 * The backend records an idle session's turn as completed unless this says
 * otherwise, so a turn the agent abandoned (a held request expired, or it
 * cancelled on its own) or one it stopped early must say so here. A cancel
 * the user asked for (`/cancel`, close) is the user's choice, not a failure.
 * Fixed, content-free text: it reaches request cards and run results.
 */
export function turnTerminalError(
  state: Pick<
    SessionState,
    | "expiredRequestPromptSequence"
    | "retryCancelledPromptSequence"
    | "policyDenialExhaustedPromptSequence"
  >,
  stopReason: StopReason,
  promptSequence: number,
): string | undefined {
  if (state.retryCancelledPromptSequence === promptSequence) return undefined;
  if (state.expiredRequestPromptSequence === promptSequence) {
    return `${provider} stopped after a permission request or question went unanswered for 5 minutes`;
  }
  if (state.policyDenialExhaustedPromptSequence === promptSequence) {
    return `${provider} kept ending the turn on tool calls this session's policy refuses`;
  }
  if (stopReason === "end_turn") return undefined;
  if (stopReason === "cancelled") return `${provider} cancelled the turn`;
  return `${provider} stopped the turn early (${stopReason})`;
}

export async function dispatchAcpPrompt(
  state: SessionState,
  child: AcpProcess,
  initialPrompt: JsonObject,
  promptSequence: number,
  schema: JsonObject | undefined,
): Promise<unknown> {
  return requestPromptWithRetriableProviderRetries(
    state,
    child,
    initialPrompt,
    promptSequence,
    schema,
  );
}
