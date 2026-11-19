/**
 * Whether the agent of a prompt environment may talk with the user.
 *
 * The create dialog offers three ways to start work, and each one fixes what
 * the agent is told about the user:
 *
 * - **Pipeline** creates a pipeline environment. It is never interactive:
 *   every stage prompt carries the unattended policy
 *   (`UNATTENDED_POLICY_INSTRUCTION` in `agent-interactions.ts`), and the
 *   pipeline runs through to a pull request without the user. Pipeline
 *   environments do not carry an interaction mode.
 * - **Task** (`"task"`) creates a prompt environment that is not interactive
 *   until its opening task is finished. The agent completes the prompt without
 *   asking questions, then stops and waits; the user's later messages are an
 *   ordinary interactive conversation.
 * - **Interactive** (`"interactive"`) creates a prompt environment that is
 *   interactive from the start: the agent is told it may ask the user
 *   questions and check decisions with them while it works.
 *
 * The mode reaches the agent as a system-instructions frame on the
 * environment's opening prompt, so it applies to every provider and to both
 * native and terminal launches. Transcripts strip the frame
 * (`stripSystemInstructions`), so the user sees only what they typed.
 */
import { wrapSystemInstructions } from "./review-evidence-frames.js";

export const ENVIRONMENT_INTERACTION_MODES = ["task", "interactive"] as const;
export type EnvironmentInteractionMode = (typeof ENVIRONMENT_INTERACTION_MODES)[number];

export function isEnvironmentInteractionMode(value: unknown): value is EnvironmentInteractionMode {
  return value === "task" || value === "interactive";
}

export const TASK_INTERACTION_INSTRUCTION =
  "This environment was opened as a task. Complete the request above on your own: do not ask the user questions, ask for confirmation or wait for their input while you work. " +
  "Where something is ambiguous, choose the most reasonable interpretation, state the assumption in your final message and carry on. " +
  "When the task is finished, end with a short summary of what you did and anything left open, then stop and wait. " +
  "After that the user may continue the conversation, and from then on you may ask them questions and work with them interactively.";

export const INTERACTIVE_INTERACTION_INSTRUCTION =
  "This environment was opened for interactive work. The user is following along and can answer you while you work. " +
  "Ask clarifying questions when a requirement is ambiguous or a decision is genuinely theirs to make, and check in before large or hard-to-reverse changes, rather than guessing. " +
  "Treat the work as a collaboration with the user, not a task to finish unattended.";

export function environmentInteractionInstruction(mode: EnvironmentInteractionMode): string {
  return mode === "task" ? TASK_INTERACTION_INSTRUCTION : INTERACTIVE_INTERACTION_INSTRUCTION;
}

/**
 * The opening prompt with the interaction mode's instructions appended as one
 * system-instructions frame. No mode, or a blank prompt, returns the prompt
 * unchanged: a prompt-less launch waits for the user's own first message.
 */
export function withEnvironmentInteraction(
  prompt: string,
  mode: EnvironmentInteractionMode | undefined,
): string {
  if (!mode || prompt.trim().length === 0) return prompt;
  return `${prompt}\n\n${wrapSystemInstructions(environmentInteractionInstruction(mode))}`;
}
