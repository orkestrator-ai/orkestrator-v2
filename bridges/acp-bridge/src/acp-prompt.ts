import {
  AcpProcess,
  CURSOR_BACKGROUND_WAIT_MS,
  MAX_CURSOR_BACKGROUND_CONTINUATIONS,
  PROMPT_TIMEOUT_MS,
  RETRIABLE_PROVIDER_MAX_RETRIES,
  RETRIABLE_PROVIDER_RETRY_BASE_MS,
  provider,
  sessions,
  shuttingDown,
  type BridgeMessage,
  type BridgeTextPart,
  type JsonObject,
  type SessionState,
} from "./acp-context.js";
import {
  cursorBackgroundContinueEnabled,
  formatCursorBackgroundContinuation,
  listWatchableCursorChildren,
  pushContinuationUserMessage,
  waitForWatchableCursorChildren,
} from "./acp-cursor-background.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { failAllActiveSubagents, finishSubagentTool } from "./acp-tools.js";

// Transient provider codes the bridge auto-retries. `resource_exhausted` is
// Cursor's capacity signal; `unavailable` is a dropped connection / PING
// timeout. The trailing detail is whatever the provider wrote (`Error`,
// `PING timed out`, …) — matching only the word `Error` would leave the
// latter dead in the transcript.
const RETRIABLE_PROVIDER_CODE = String.raw`\[(?:resource_exhausted|unavailable)\]`;
// One definition of "what separates the code from its detail", shared by both
// classifiers below, which recognise the same provider failure arriving over
// two different transports. A separator accepted by only one of them would
// retry the typed RPC rejection while reporting the flattened form as a
// finished turn, leaving the raw provider serialization in the transcript.
const RETRIABLE_PROVIDER_SEPARATOR = String.raw`\s+`;
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
export const RETRIABLE_PROVIDER_CONTINUATION =
  "Continue from where the interrupted turn stopped. A transient provider error ended the previous attempt. Do not repeat work or tool calls that already completed; inspect the session history and finish the original request.";

export function flattenedRetriableProviderTail(state: SessionState): {
  message: BridgeMessage;
  part: BridgeTextPart;
} | null {
  const message = state.messages.at(-1);
  const part = message?.parts.at(-1);
  if (message?.role !== "assistant" || part?.type !== "text") return null;
  return FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(part.content)
    && FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(message.content)
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

export function structuredPromptInstruction(schema: JsonObject): string {
  return `Return only one JSON value matching this JSON Schema. Do not use a Markdown fence or add commentary.\n\n${JSON.stringify(schema)}`;
}

export function retriableProviderError(error: unknown): error is Error {
  return error instanceof Error && RETRIABLE_PROVIDER_ERROR.test(error.message);
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

export async function requestPromptWithRetriableProviderRetries(
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
      if (!retriableProviderError(error)) throw error;
      requestError = error;
    }

    const flattened = requestError ? null : flattenedRetriableProviderTail(state);
    if (!requestError && !flattened) return result;
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
    if (state.currentTurnOutput !== null) state.currentTurnOutput = "";
    // A provider can stop between a tool's start and terminal update. Settle
    // that attempt before the continuation starts; completed tools remain
    // successful and the continuation is explicitly told not to repeat them.
    reconcileStaleToolParts(state);
    retries += 1;
    await retryDelay(RETRIABLE_PROVIDER_RETRY_BASE_MS * (2 ** (retries - 1)));

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
          ? `${RETRIABLE_PROVIDER_CONTINUATION}\n\n${structuredPromptInstruction(schema)}`
          : RETRIABLE_PROVIDER_CONTINUATION,
      }],
    };
  }
}

/**
 * Cursor's ACP `session/prompt` returns when the parent generation ends, even
 * if a background Task is still running. The IDE then waits for the child and
 * re-prompts; `cursor-agent acp` does not. Hold the HTTP turn open and inject
 * the child's transcript so the parent cannot miss the result. Grok is
 * excluded: it already notifies through `subagent_finished` and the parent
 * turn is allowed to go idle with live children.
 */
export async function dispatchAcpPrompt(
  state: SessionState,
  child: AcpProcess,
  initialPrompt: JsonObject,
  promptSequence: number,
  schema: JsonObject | undefined,
): Promise<unknown> {
  let result = await requestPromptWithRetriableProviderRetries(
    state,
    child,
    initialPrompt,
    promptSequence,
    schema,
  );
  if (!cursorBackgroundContinueEnabled()) return result;

  let continuations = 0;
  while (
    retryStillOwned(state, child, promptSequence)
    && continuations < MAX_CURSOR_BACKGROUND_CONTINUATIONS
  ) {
    // Only children Cursor itself named. An inferred binding is good enough to
    // show activity in a card; it is not good enough to hold this turn open.
    const watchable = listWatchableCursorChildren(state, { includeDiscovered: false });
    if (watchable.length === 0) return result;

    const wait = abortWhenPromptLost(state, child, promptSequence);
    let outcomes;
    try {
      outcomes = await waitForWatchableCursorChildren(
        state,
        watchable,
        CURSOR_BACKGROUND_WAIT_MS,
        wait.signal,
      );
    } finally {
      wait.stop();
    }

    if (!retryStillOwned(state, child, promptSequence)) {
      failAllActiveSubagents(state);
      if (state.retryCancelledPromptSequence === promptSequence) {
        return { stopReason: "cancelled" };
      }
      throw retryOwnershipLostError(state);
    }

    for (const outcome of outcomes) {
      finishSubagentTool(state, outcome.toolUseId, outcome.agentState);
    }

    continuations += 1;
    if (state.currentTurnOutput !== null) state.currentTurnOutput = "";
    const text = schema
      ? `${formatCursorBackgroundContinuation(outcomes)}\n\n${structuredPromptInstruction(schema)}`
      : formatCursorBackgroundContinuation(outcomes);
    pushContinuationUserMessage(state, text);
    result = await requestPromptWithRetriableProviderRetries(
      state,
      child,
      {
        sessionId: state.acpSessionId,
        prompt: [{ type: "text", text }],
      },
      promptSequence,
      schema,
    );
  }
  return result;
}

function abortWhenPromptLost(
  state: SessionState,
  child: AcpProcess,
  promptSequence: number,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (!retryStillOwned(state, child, promptSequence)) controller.abort();
  }, 100);
  timer.unref();
  if (!retryStillOwned(state, child, promptSequence)) controller.abort();
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}
