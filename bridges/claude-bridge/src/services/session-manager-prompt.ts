import type { WriterLiveness } from "@orkestrator/protocol/change-evidence";
import type { BackgroundTaskSnapshot, PromptOptions } from "../types/index.js";
import { claudeEvidenceTurnId, recordClaudeTurn } from "./change-evidence.js";
import { LIVE_BACKGROUND_TASK_STATUSES } from "./session-manager-background-tasks.js";
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
import type { PromptTestHooks, TurnState } from "./session-manager-prompt-turn.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");
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
 * Whether anything this turn's process started may still write. A live
 * background task or subagent may; a process that has ended cannot. A warm
 * CLI that has merely answered is not proof that every writer stopped.
 */
function turnWriterLiveness(turn: TurnState): WriterLiveness {
  const tasks = Object.values(turn.session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[];
  if (tasks.some((task) => LIVE_BACKGROUND_TASK_STATUSES.has(task.status))) return "may-write";
  return turn.runtime?.state === "ended" ? "quiescent" : "unknown";
}

/** Report how a turn this bridge dispatched ended, as change evidence. */
function recordTurnOutcome(turn: TurnState, failed: boolean): void {
  const phase = turn.abortController.signal.aborted
    ? "cancelled"
    : failed
      ? "failed"
      : turn.receivedPromptResult
        ? "succeeded"
        : // Superseded or ended before its own result: the outcome is not known here.
          "unknown";
  recordClaudeTurn(turn.sessionId, claudeEvidenceTurnId(turn), phase, turnWriterLiveness(turn));
}

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
  });
  // Set once the CLI accepted the turn: only a turn that ran has an outcome.
  let turnRunning = false;
  try {
    const plan = await resolveQueryPlan(turn, sdkTextPrompt, testHooks);
    if (!(await runTurnOnRuntime(turn, plan, testHooks))) return;
    turnRunning = true;
    recordClaudeTurn(sessionId, claudeEvidenceTurnId(turn), "running", "may-write");
    // Frames arrive through the runtime's consumer. This turn is done waiting
    // once a newer turn takes over or the process ends.
    await turn.turnEnded;
    turnRunning = false;
    recordTurnOutcome(turn, false);
    const followUp = settleTurnEnd(turn);
    if (!followUp) return;
    try {
      await sendPrompt(sessionId, followUp.prompt, followUp.options);
    } catch (repromptError) {
      log.error(followUp.failureEvent, { error: formatLogError(repromptError) });
      return Promise.reject(repromptError);
    }
  } catch (error) {
    if (turnRunning) recordTurnOutcome(turn, true);
    settleFailedTurn(turn, error);
  } finally {
    finalizeTurn(turn);
  }
}
