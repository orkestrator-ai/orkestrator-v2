/**
 * How long a Claude native session may keep a background shell command alive.
 *
 * Since Claude Code 2.1.285 an Agent SDK session stops a `run_in_background`
 * command at its `timeout`: 30 minutes unless Claude asks for longer, and never
 * more than 2 hours. The CLI raises that ceiling to `BASH_MAX_TIMEOUT_MS` when
 * the variable is larger, and clamps the result to the largest timer delay
 * Node accepts, so the setting is delivered to every Claude bridge as that
 * variable. The same variable also lifts the longest timeout Claude may give a
 * foreground command, which is why the default leaves it unset.
 */
export const CLAUDE_BASH_MAX_TIMEOUT_ENV = "BASH_MAX_TIMEOUT_MS";
export const CLAUDE_BASH_DEFAULT_TIMEOUT_ENV = "BASH_DEFAULT_TIMEOUT_MS";

const HOUR_MS = 60 * 60 * 1000;

/** The CLI's built-in ceiling; it cannot be lowered. */
export const DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS = 2;
export const MIN_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS =
  DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS;
/** One week, well inside the CLI's 2^31-1 ms timer clamp. */
export const MAX_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS = 168;

/** The CLI's own constants, mirrored so the bridge can describe the limit. */
const CLI_BACKGROUND_DEFAULT_MS = 30 * 60 * 1000;
const CLI_BACKGROUND_MAX_MS = DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS * HOUR_MS;
const CLI_FOREGROUND_DEFAULT_MS = 120_000;
const CLI_FOREGROUND_MAX_MS = 600_000;
const CLI_TIMER_CLAMP_MS = 2_147_483_647;

export function isValidClaudeBackgroundCommandLimitHours(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS &&
    value <= MAX_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS
  );
}

export function resolveClaudeBackgroundCommandLimitHours(value: unknown): number {
  return isValidClaudeBackgroundCommandLimitHours(value)
    ? value
    : DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS;
}

/**
 * The value a Claude bridge's `BASH_MAX_TIMEOUT_MS` should carry for this
 * setting, or `undefined` to leave the CLI default (and anything the user set
 * in their own environment) untouched.
 */
export function claudeBashMaxTimeoutEnvValue(limitHours: unknown): string | undefined {
  const hours = resolveClaudeBackgroundCommandLimitHours(limitHours);
  if (hours === DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS) return undefined;
  return String(hours * HOUR_MS);
}

function positiveMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The background-command default and ceiling the Claude CLI derives from this
 * environment, following its own resolution of the two `BASH_*` variables.
 */
export function claudeBackgroundCommandTimeouts(env: Record<string, string | undefined>): {
  defaultMs: number;
  maxMs: number;
} {
  const foregroundDefault =
    positiveMs(env[CLAUDE_BASH_DEFAULT_TIMEOUT_ENV]) ?? CLI_FOREGROUND_DEFAULT_MS;
  const configuredMax = positiveMs(env[CLAUDE_BASH_MAX_TIMEOUT_ENV]);
  const foregroundMax = Math.max(configuredMax ?? CLI_FOREGROUND_MAX_MS, foregroundDefault);
  return {
    defaultMs: Math.max(CLI_BACKGROUND_DEFAULT_MS, foregroundDefault),
    maxMs: Math.min(Math.max(CLI_BACKGROUND_MAX_MS, foregroundMax), CLI_TIMER_CLAMP_MS),
  };
}

/** "30 minutes", "2 hours", "1 day 6 hours" — whole minutes, largest units first. */
export function formatClaudeCommandDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}
