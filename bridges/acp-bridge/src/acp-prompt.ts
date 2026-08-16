import {
  AcpProcess,
  PROMPT_TIMEOUT_MS,
  RESOURCE_EXHAUSTED_MAX_RETRIES,
  RESOURCE_EXHAUSTED_RETRY_BASE_MS,
  provider,
  sessions,
  shuttingDown,
  type BridgeMessage,
  type BridgeTextPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { schedulePersist } from "./acp-persist-writer.js";

export const RESOURCE_EXHAUSTED_ERROR = /\[resource_exhausted\]\s+Error/i;
// The class name is whatever the provider's own error carried — `RetriableError`
// is only the one Cursor happens to emit today. Matching a single character here
// would silently exclude every other name and leave the turn dead, so the
// identifier is quantified and the flag set matches `RESOURCE_EXHAUSTED_ERROR`.
export const FLATTENED_RESOURCE_EXHAUSTED_SUFFIX =
  /(?:^|\n\n)Error: [A-Za-z_$][\w$]*: \[resource_exhausted\] Error\s*$/i;
export const RESOURCE_EXHAUSTED_CONTINUATION =
  "Continue from where the interrupted turn stopped. A transient provider capacity error ended the previous attempt. Do not repeat work or tool calls that already completed; inspect the session history and finish the original request.";

export function flattenedResourceExhaustedTail(state: SessionState): {
  message: BridgeMessage;
  part: BridgeTextPart;
} | null {
  const message = state.messages.at(-1);
  const part = message?.parts.at(-1);
  if (message?.role !== "assistant" || part?.type !== "text") return null;
  return FLATTENED_RESOURCE_EXHAUSTED_SUFFIX.test(part.content)
    && FLATTENED_RESOURCE_EXHAUSTED_SUFFIX.test(message.content)
    ? { message, part }
    : null;
}

export function stripFlattenedResourceExhaustedTail(
  state: SessionState,
  tail: { message: BridgeMessage; part: BridgeTextPart },
): void {
  tail.part.content = tail.part.content.replace(FLATTENED_RESOURCE_EXHAUSTED_SUFFIX, "");
  tail.message.content = tail.message.content.replace(FLATTENED_RESOURCE_EXHAUSTED_SUFFIX, "");
  if (!tail.part.content) tail.message.parts.pop();
  // Interim provider serialization is not part of the transcript users should
  // have to interpret. The final marker is retained if all retries exhaust.
  state.revision += 1;
  schedulePersist();
}

export function structuredPromptInstruction(schema: JsonObject): string {
  return `Return only one JSON value matching this JSON Schema. Do not use a Markdown fence or add commentary.\n\n${JSON.stringify(schema)}`;
}

export function resourceExhaustedError(error: unknown): error is Error {
  return error instanceof Error && RESOURCE_EXHAUSTED_ERROR.test(error.message);
}

export function retryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref();
  });
}

export function retryStillOwned(
  state: SessionState,
  child: AcpProcess,
  promptSequence: number,
): boolean {
  return !shuttingDown
    && sessions.get(state.id) === state
    && state.child === child
    && state.status === "running"
    && state.promptSequence === promptSequence
    && state.retryCancelledPromptSequence !== promptSequence;
}

export function retryOwnershipLostError(state: SessionState): Error {
  // A child exit or a transcript-limit failure records the real cause before the
  // retry wakes up, and `/prompt` clears `error` per turn so anything here
  // belongs to this one. Preserve it rather than hiding "the agent died" behind
  // the generic message.
  return new Error(state.error || `${provider} prompt retry lost its live session`);
}

export async function requestPromptWithResourceExhaustedRetries(
  state: SessionState,
  child: AcpProcess,
  initialPrompt: JsonObject,
  promptSequence: number,
  schema: JsonObject | undefined,
): Promise<unknown> {
  let prompt = initialPrompt;
  let retries = 0;

  while (true) {
    let result: unknown;
    let requestError: Error | undefined;
    try {
      result = await child.request("session/prompt", prompt, PROMPT_TIMEOUT_MS);
    } catch (error) {
      if (!resourceExhaustedError(error)) throw error;
      requestError = error;
    }

    const flattened = requestError ? null : flattenedResourceExhaustedTail(state);
    if (!requestError && !flattened) return result;
    if (!retryStillOwned(state, child, promptSequence)) {
      if (state.retryCancelledPromptSequence === promptSequence) {
        return { stopReason: "cancelled" };
      }
      throw requestError ?? retryOwnershipLostError(state);
    }
    if (retries >= RESOURCE_EXHAUSTED_MAX_RETRIES) {
      throw new Error(
        `${provider} remained resource exhausted after ${RESOURCE_EXHAUSTED_MAX_RETRIES} retries`,
        requestError ? { cause: requestError } : undefined,
      );
    }

    if (flattened) stripFlattenedResourceExhaustedTail(state, flattened);
    // Discard every attempt's partial structured output, on both the flattened
    // and the typed-RPC path. The continuation re-emits the whole value, so a
    // retained prefix would concatenate into unparseable JSON and fail a turn
    // that actually recovered.
    if (state.currentTurnOutput !== null) state.currentTurnOutput = "";
    // A provider can stop between a tool's start and terminal update. Settle
    // that attempt before the continuation starts; completed tools remain
    // successful and the continuation is explicitly told not to repeat them.
    reconcileStaleToolParts(state);
    retries += 1;
    await retryDelay(RESOURCE_EXHAUSTED_RETRY_BASE_MS * (2 ** (retries - 1)));

    if (!retryStillOwned(state, child, promptSequence)) {
      if (state.retryCancelledPromptSequence === promptSequence) {
        return { stopReason: "cancelled" };
      }
      throw retryOwnershipLostError(state);
    }
    prompt = {
      sessionId: state.acpSessionId,
      // The schema instruction rides every attempt. The continuation replaces
      // the original prompt on the wire, so omitting it would ask a structured
      // turn to finish without restating the contract it must satisfy.
      prompt: [{
        type: "text",
        text: schema
          ? `${RESOURCE_EXHAUSTED_CONTINUATION}\n\n${structuredPromptInstruction(schema)}`
          : RESOURCE_EXHAUSTED_CONTINUATION,
      }],
    };
  }
}
