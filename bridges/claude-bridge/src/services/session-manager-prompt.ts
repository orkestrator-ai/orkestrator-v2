import type { PromptOptions } from "../types/index.js";
import {
  admitPrompt,
  appendPromptMessage,
  applyPromptPlanMode,
  beginPromptActivity,
  createClaudeTurn,
  installPromptTranscript,
  promptPlanModeChange,
  readTranscriptForPrompt,
} from "./session-manager-prompt-admission.js";
import { runTurnOnRuntime } from "./session-manager-prompt-launch.js";
import { resolveQueryPlan } from "./session-manager-prompt-query.js";
import { finalizeTurn, settleFailedTurn, settleTurnEnd } from "./session-manager-prompt-settle.js";
import type { PromptTestHooks } from "./session-manager-prompt-turn.js";
export { RETAINED_CONTINUATION_TIMEOUT_MS } from "./session-manager-prompt-turn-lifecycle.js";
export { memoryRecallPart } from "./session-manager-messages.js";
export { THINKING_TOKENS_EMIT_INTERVAL_MS } from "./session-manager-prompt-handlers/system.js";
export { applyClaudeUsageReport } from "./session-manager-prompt-handlers/assistant.js";
export { claudeStartupFailureMessage } from "./session-manager-prompt-handlers/result.js";
export {
  MAX_STREAM_CONTENT_BLOCK_INDEX,
  STREAM_EVENT_COALESCE_MS,
} from "./session-manager-prompt-admission.js";
export { PLAN_MODE_INSTRUCTIONS } from "./session-manager-prompt-query.js";

/**
 * Send a prompt to a session and process the response.
 *
 * Every phase below runs in the order it always did, and the async ones end
 * at an await the turn always made. The follow-up re-prompts call back in
 * here: the outer turn's `finally` runs only once the follow-up has finished,
 * and a follow-up failure bypasses the `catch`, so it is never recorded as
 * the outer turn's error.
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options?: PromptOptions,
  testHooks?: PromptTestHooks,
): Promise<void> {
  const admission = admitPrompt(sessionId, options);
  if (!admission) return;
  const { session } = admission;
  const planMode = promptPlanModeChange(session, options);
  if (planMode !== undefined) await applyPromptPlanMode(admission, planMode);
  beginPromptActivity(admission);
  const transcriptHydrationFailed =
    admission.needsTranscriptHydration &&
    installPromptTranscript(session, await readTranscriptForPrompt(session));
  const { userMessage, sdkTextPrompt } = appendPromptMessage(admission, prompt, options);
  const turn = createClaudeTurn(admission, {
    options,
    userMessage,
    transcriptHydrationFailed,
    testHooks,
  });
  try {
    const plan = await resolveQueryPlan(turn, sdkTextPrompt, testHooks);
    if (!(await runTurnOnRuntime(turn, plan, testHooks))) return;
    // Frames arrive through the runtime's consumer. This turn is done waiting
    // once a newer turn takes over or the process ends.
    await turn.turnEnded;
    const followUp = settleTurnEnd(turn);
    if (!followUp) return;
    try {
      await sendPrompt(sessionId, followUp.prompt, followUp.options);
    } catch (repromptError) {
      console.error(followUp.failureLog, repromptError);
      return Promise.reject(repromptError);
    }
  } catch (error) {
    settleFailedTurn(turn, error);
  } finally {
    finalizeTurn(turn);
  }
}
