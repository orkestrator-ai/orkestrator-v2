/**
 * Fixed model settings for small, non-agent Codex inference tasks.
 *
 * Keep these separate from interactive agent defaults: background helpers must
 * not inherit a user's selected model or reasoning effort.
 */
export const CODEX_BACKGROUND_TASK_MODEL = "gpt-5.6-luna";
export const CODEX_BACKGROUND_TASK_REASONING_EFFORT = "medium";
