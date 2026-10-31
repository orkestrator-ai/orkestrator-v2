/**
 * Usage limits: a provider refusing a turn because the account's plan
 * allowance is used up, and what a switch of the active account changes.
 *
 * No provider reports a usage limit as structured state that reaches the
 * backend: Codex's `usageLimitExceeded` code, Claude's "You've hit your limit
 * · resets …" and Grok's `USAGE_EXHAUSTED` all arrive as the failed turn's
 * error text. The backend keeps that text, bounded, as the session's last turn
 * outcome; this module classifies it. Quota windows the provider reports
 * (`usedPercent`, `resetsAt`) are the other signal: a window at 100 % that has
 * not reset yet means the account cannot run a turn either.
 */

import type { AgentAccountPlatform } from "./agent-accounts.js";

export interface UsageLimitMatch {
  /** The provider's own words for when the limit lifts, when it gave any. */
  resetHint?: string;
}

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  // "usage limit", "usage_limit_reached", Codex's `usageLimitExceeded`.
  /usage[\s_-]?limit/i,
  // Claude: "You've hit your limit · resets 3pm".
  /hit your (?:usage |session |weekly )?limit/i,
  /\b(?:5|five)[\s-]?hour limit\b/i,
  /\bweekly limit\b/i,
  /\b(?:usage|quota|credits?|allowance) (?:is |has been )?(?:exhausted|exceeded|used up)\b/i,
  /\bquota exceeded\b|\binsufficient_quota\b|\bout of (?:credits|usage)\b/i,
  // Grok (ACP): `USAGE_EXHAUSTED`, `PAYMENT_REQUIRED`.
  /\bUSAGE_EXHAUSTED\b|\bPAYMENT_REQUIRED\b/,
  // OpenCode's retry action ("Go limit reached") and similar plan wording.
  /\b(?:usage|plan|session|daily|weekly|monthly|go) limit reached\b/i,
];

/**
 * Whether a failed turn's error text says the account ran out of plan usage.
 * Context-window and request-size limits are not usage limits, and neither is
 * a bare transient 429.
 */
export function classifyUsageLimitError(text: unknown): UsageLimitMatch | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const bounded = text.slice(0, 2_000);
  if (!USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(bounded))) return null;
  const reset = bounded.match(/\b(?:resets?|try again)(?:\s+(?:at|in|after))?\s+([^.\n·]{1,60})/i);
  const hint = reset?.[1]?.trim();
  return hint ? { resetHint: hint } : {};
}

/** One quota window, as the coordinator's tools report it. */
export interface UsageWindowView {
  window: string;
  label?: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
}

interface UsageWindowLike {
  window: string;
  label?: string;
  usedPercent?: number;
  resetsAt?: string;
}

export function usageWindowView(window: UsageWindowLike, now: number): UsageWindowView {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // A window whose reset time has passed is empty again, whatever it last said.
  const used =
    Number.isFinite(reset) && reset <= now
      ? 0
      : typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
        ? Math.max(0, Math.min(100, window.usedPercent))
        : undefined;
  return {
    window: window.window,
    ...(window.label ? { label: window.label } : {}),
    ...(used !== undefined ? { usedPercent: used, remainingPercent: 100 - used } : {}),
    ...(window.resetsAt && Number.isFinite(reset) && reset > now
      ? { resetsAt: window.resetsAt }
      : {}),
  };
}

/** Windows that are used up and have not reset yet. */
export function exhaustedUsageWindows(
  windows: readonly UsageWindowLike[],
  now: number,
): UsageWindowView[] {
  return windows
    .map((window) => usageWindowView(window, now))
    .filter((window) => window.usedPercent !== undefined && window.usedPercent >= 100);
}

/**
 * What a switch of the active account changes, told verbatim to the
 * coordinator and the user. Switching is machine-wide per platform; nothing is
 * killed or restarted.
 */
export function agentAccountSwitchEffect(platform: AgentAccountPlatform): string {
  const name = platform === "claude" ? "Claude" : "Codex";
  return `Machine-wide: every ${name} session on that machine moves to the new account. Idle sessions pick it up on their next turn (the bridge is replaced and the conversation resumes from the shared transcript); a turn already running finishes on the old account and the session moves once it is idle. No restart is needed. Tabs that stopped on a usage limit need a new prompt (for example "continue") to run again.`;
}
