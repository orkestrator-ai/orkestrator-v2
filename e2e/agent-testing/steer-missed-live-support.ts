/**
 * Pure helpers for `steer-missed-live.spec.ts` (todo 0005 task 10): which
 * platforms a run selects, the prompts each scripted model answers, and the
 * transcript reads the checks are made from. Nothing here touches a profile,
 * so `steer-missed-live-support.test.ts` pins it without one.
 *
 * Every scripted model answers "reply with exactly W and nothing else" with W
 * (`finalReply` in `idle-observation-fake-claude.ts`, shared by the Codex and
 * Pi fakes). The fake Cursor SDK answers any prompt `Answer to: <prompt>`, so
 * its reply carries the word too, and it holds a run open while the prompt
 * says HOLD.
 */

export const MISSED_STEER_PLATFORMS = ["claude", "codex", "cursor", "pi"] as const;
export type MissedSteerPlatform = (typeof MISSED_STEER_PLATFORMS)[number];

export const MISSED_STEER_LABELS: Record<MissedSteerPlatform, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
};

/**
 * The platforms a run selects: `ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS`
 * (comma-separated) narrows the default of all four. An unknown name is an
 * error, so a typo cannot silently skip a platform.
 */
export function selectedMissedSteerPlatforms(env: NodeJS.ProcessEnv): Set<MissedSteerPlatform> {
  const raw = env.ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS?.trim();
  if (!raw) return new Set(MISSED_STEER_PLATFORMS);
  const selected = new Set<MissedSteerPlatform>();
  for (const name of raw.split(",").map((entry) => entry.trim())) {
    if (!name) continue;
    if (!(MISSED_STEER_PLATFORMS as readonly string[]).includes(name)) {
      throw new Error(
        `ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS names ${MISSED_STEER_PLATFORMS.join(", ")} only, not ${name}`,
      );
    }
    selected.add(name as MissedSteerPlatform);
  }
  return selected;
}

/** A short turn every scripted model ends with `word`. */
export function replyPrompt(word: string): string {
  return `Reply with exactly ${word} and nothing else. Do not use any tools.`;
}

/**
 * A turn that is still running when the steer arrives. The Claude, Codex and
 * Pi fakes run the shell command and reply once it returns; the fake Cursor
 * SDK holds the run until it is cancelled.
 */
export function longTurnPrompt(
  platform: MissedSteerPlatform,
  word: string,
  seconds: number,
): string {
  if (platform === "cursor") return `HOLD ${word}. Keep this run open until it is cancelled.`;
  return `Run this shell command and wait for it: sleep ${seconds}; echo ${word}`;
}

/**
 * A turn that leaves a background task running (the Claude fake's
 * `run_in_background` Bash call) and then replies `word`.
 */
export function backgroundTaskPrompt(marker: string, word: string, seconds: number): string {
  return [
    `Start this shell command as a background task and do not wait for it: sleep ${seconds}; echo ${marker}`,
    `Right after starting it, reply with exactly ${word} and nothing else. Do not run any other command.`,
  ].join(" ");
}

type Part = { type?: unknown; text?: unknown };
export type TranscriptMessage = { id?: string; role?: string; content?: unknown; parts?: unknown };

/** The visible text of one transcript row: its text parts, or its content. */
export function messageText(message: TranscriptMessage): string {
  const parts = Array.isArray(message.parts) ? (message.parts as Part[]) : [];
  const fromParts = parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  if (fromParts.trim()) return fromParts;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as Part[])
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
  }
  return "";
}

/** How many rows of `role` carry `marker` in their visible text. */
export function rowsCarrying(
  messages: readonly TranscriptMessage[],
  role: "user" | "assistant",
  marker: string,
): number {
  return messages.filter(
    (message) => message.role === role && messageText(message).includes(marker),
  ).length;
}

/** The controls a missed steer's new turn must leave as they were. */
export interface ComposerControls {
  modelId: string | null;
  modeId: string | null;
  approvalModeId: string | null;
}

export function composerControls(
  composer:
    | { selectedModelId?: string; selectedModeId?: string; selectedApprovalModeId?: string }
    | undefined,
): ComposerControls {
  return {
    modelId: composer?.selectedModelId ?? null,
    modeId: composer?.selectedModeId ?? null,
    approvalModeId: composer?.selectedApprovalModeId ?? null,
  };
}

/** Task states a stopped background task may settle to. */
const SETTLED_TASK_STATES: ReadonlySet<string> = new Set(["completed", "failed", "killed"]);

export function backgroundTaskSettled(status: string | undefined): boolean {
  return status !== undefined && SETTLED_TASK_STATES.has(status);
}

/** The bridge's answer for a task no live CLI can reach (HTTP 409). */
export const NO_CONTROL_CHANNEL_TEXT = "No live Claude control channel can reach this task";

/** Whether a failed stop command's text is that answer, relayed by the backend. */
export function isNoControlChannelRefusal(text: string): boolean {
  return text.includes("HTTP 409") && text.includes(NO_CONTROL_CHANNEL_TEXT);
}
