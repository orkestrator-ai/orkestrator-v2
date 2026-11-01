/**
 * Automatic account switching: the settings, which limit counts, and the rule
 * that picks an account. Pure, so the machine applying the rule and the views
 * explaining it cannot disagree. See docs/architecture/agent-accounts.md
 * ("Automatic switching").
 *
 * The main tick and the per-account ticks are preferences a command node hands
 * down, matched by email, so they hold no account id and no credential. Which
 * account is pinned, and the tick of an account with no email, stay on the
 * machine (`agent-accounts.json`).
 */
import type {
  AgentAccountIdentity,
  AgentAccountPlatform,
  AgentAccountSummary,
} from "./agent-accounts.js";
import type { PlanUsageSnapshot } from "./plan-usage.js";

// `agent-accounts.ts` imports this module to parse peer answers.
const PLATFORMS: readonly AgentAccountPlatform[] = ["claude", "codex"];

/** Between turns, the general weekly limit at or past this moves the machine. */
export const AUTO_SWITCH_THRESHOLD_PERCENT = 98;
/** A limit error only moves the machine when a fresh reading says this. */
export const WEEKLY_LIMIT_USED_UP_PERCENT = 100;
/** Resends of one stopped turn. Each needs another confirmed used-up account. */
export const MAX_USAGE_LIMIT_RESENDS = 3;

const WEEK_MINUTES = 7 * 24 * 60;
const MAX_TICKED_EMAILS = 64;
const MAX_EMAIL_LENGTH = 320;

/** The ticks of one provider, as they travel from a command node. */
export interface AgentAccountAutoSwitchTicks {
  /** The main tick. Off unless the user ticks it. */
  enabled: boolean;
  /** Lowercase emails of the accounts whose own tick is off. A new login starts included. */
  excludedEmails: string[];
}

export type AgentAccountAutoSwitchSettings = Partial<
  Record<AgentAccountPlatform, AgentAccountAutoSwitchTicks>
>;

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email && email.length <= MAX_EMAIL_LENGTH ? email : undefined;
}

/** Stored and peer values are untrusted; anything unreadable reads as off. */
export function normalizeAgentAccountAutoSwitchSettings(
  value: unknown,
): AgentAccountAutoSwitchSettings {
  const settings: AgentAccountAutoSwitchSettings = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return settings;
  for (const platform of PLATFORMS) {
    const entry = (value as Record<string, unknown>)[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { enabled, excludedEmails } = entry as Record<string, unknown>;
    const emails = Array.isArray(excludedEmails)
      ? Array.from(new Set(excludedEmails.flatMap((email) => normalizeEmail(email) ?? []))).slice(
          0,
          MAX_TICKED_EMAILS,
        )
      : [];
    if (enabled !== true && emails.length === 0) continue;
    settings[platform] = { enabled: enabled === true, excludedEmails: emails };
  }
  return settings;
}

/** The settings with one provider's ticks changed. A provider with nothing left is dropped. */
export function withAutoSwitchTicks(
  settings: AgentAccountAutoSwitchSettings,
  platform: AgentAccountPlatform,
  change: { enabled?: boolean; email?: string; included?: boolean },
): AgentAccountAutoSwitchSettings {
  const current = settings[platform] ?? { enabled: false, excludedEmails: [] };
  const email = normalizeEmail(change.email);
  const excludedEmails =
    email === undefined || change.included === undefined
      ? current.excludedEmails
      : change.included
        ? current.excludedEmails.filter((entry) => entry !== email)
        : Array.from(new Set([...current.excludedEmails, email]));
  return normalizeAgentAccountAutoSwitchSettings({
    ...settings,
    [platform]: { enabled: change.enabled ?? current.enabled, excludedEmails },
  });
}

/**
 * Whether an account's own tick is on. An account with an email follows the
 * ticks that travel. One without cannot be matched across machines, and its
 * login may be a pay-per-use API key, so it stays out until ticked on this
 * machine.
 */
export function isAutoSwitchAccountIncluded(
  identity: AgentAccountIdentity,
  ticks: AgentAccountAutoSwitchTicks | undefined,
  locallyIncluded: boolean,
): boolean {
  const email = normalizeEmail(identity.email);
  if (!email) return locallyIncluded;
  return !ticks?.excludedEmails.includes(email);
}

/**
 * What one machine's automatic switching is doing for one provider, shown
 * beside its accounts. `pinned` is a manual switch that turned it off here
 * until the user ticks it again.
 */
export type AgentAccountAutoSwitchMode = "off" | "automatic" | "pinned";

export const AUTO_SWITCH_REASONS = ["threshold", "limit", "soonest-reset", "not-included"] as const;
export type AutoSwitchReason = (typeof AUTO_SWITCH_REASONS)[number];

export interface AgentAccountAutoSwitchLastSwitch {
  fromAccountId: string;
  toAccountId: string;
  reason: AutoSwitchReason;
  at: string;
}

export interface AgentAccountAutoSwitchState {
  mode: AgentAccountAutoSwitchMode;
  pinnedAccountId?: string;
  pinnedAt?: string;
  /** The accounts on this machine whose own tick is on. */
  includedAccountIds: string[];
  lastSwitch?: AgentAccountAutoSwitchLastSwitch;
}

export type AgentAccountAutoSwitchStates = Partial<
  Record<AgentAccountPlatform, AgentAccountAutoSwitchState>
>;

function isShortId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** Peer answers are untrusted, and older machines send nothing. */
export function parseAgentAccountAutoSwitchStates(
  value: unknown,
): AgentAccountAutoSwitchStates | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const states: AgentAccountAutoSwitchStates = {};
  for (const platform of PLATFORMS) {
    const entry = (value as Record<string, unknown>)[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { mode, pinnedAccountId, pinnedAt, includedAccountIds, lastSwitch } = entry as Record<
      string,
      unknown
    >;
    if (mode !== "off" && mode !== "automatic" && mode !== "pinned") continue;
    const last = lastSwitch as Record<string, unknown> | null | undefined;
    states[platform] = {
      mode,
      ...(isShortId(pinnedAccountId) ? { pinnedAccountId } : {}),
      ...(typeof pinnedAt === "string" ? { pinnedAt: pinnedAt.slice(0, 64) } : {}),
      includedAccountIds: Array.isArray(includedAccountIds)
        ? includedAccountIds.filter(isShortId).slice(0, 64)
        : [],
      ...(last &&
      typeof last === "object" &&
      isShortId(last.fromAccountId) &&
      isShortId(last.toAccountId) &&
      typeof last.at === "string" &&
      (AUTO_SWITCH_REASONS as readonly unknown[]).includes(last.reason)
        ? {
            lastSwitch: {
              fromAccountId: last.fromAccountId,
              toAccountId: last.toAccountId,
              reason: last.reason as AutoSwitchReason,
              at: last.at.slice(0, 64),
            },
          }
        : {}),
    };
  }
  return states;
}

interface UsageWindowLike {
  window: string;
  usedPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
}

/**
 * The general weekly limit, and only that.
 *
 * Claude: window `seven_day`. Model limits are `seven_day_<model>`, apps are
 * `seven_day_oauth_apps` and the session limit is `five_hour`.
 *
 * Codex: whichever of `primary` and `secondary` is a week long. The slot itself
 * says nothing, because an account's usage endpoint can report the week in
 * either. Those two slots only ever come from the general limit: the reader
 * takes `rate_limit`, or `rate_limits_by_limit_id.codex`, and never the
 * `additional_rate_limits` that metered features report separately.
 */
export function generalWeeklyWindow<W extends UsageWindowLike>(
  platform: AgentAccountPlatform,
  windows: readonly W[],
): W | undefined {
  if (platform === "claude") return windows.find((window) => window.window === "seven_day");
  return windows.find(
    (window) =>
      (window.window === "primary" || window.window === "secondary") &&
      window.windowMinutes === WEEK_MINUTES,
  );
}

/** How much one reading can be trusted to say about the general weekly limit. */
export interface WeeklyLimitReading {
  /** `fresh`: read just now. `stale`: an earlier reading. `none`: nothing is known. */
  freshness: "fresh" | "stale" | "none";
  usedPercent?: number;
  /** Epoch ms. Only a reset still ahead counts as known. */
  resetsAt?: number;
  /** A turn here would be paid for rather than come out of the plan. */
  wouldPay: boolean;
}

function windowUsed(window: UsageWindowLike, now: number): number | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // A window whose reset time has passed has started over, whatever it said.
  if (Number.isFinite(reset) && reset <= now) return 0;
  return typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    ? Math.max(0, Math.min(100, window.usedPercent))
    : undefined;
}

/**
 * Read one snapshot for the rule. A reset in the past is not a known reset: the
 * window has started over and the next reset cannot be told until it is read.
 */
export function weeklyLimitReading(
  platform: AgentAccountPlatform,
  snapshot: PlanUsageSnapshot | undefined,
  now: number,
): WeeklyLimitReading {
  if (!snapshot || snapshot.status !== "ok") return { freshness: "none", wouldPay: false };
  const freshness = snapshot.stale === true ? "stale" : "fresh";
  // Past its plan allowance on any other limit, an account with paid usage on
  // would bill the next turn, so its weekly room is no reason to move onto it.
  const otherLimitOut =
    snapshot.paidOverage?.enabled === true &&
    snapshot.windows.some((window) => (windowUsed(window, now) ?? 0) >= 100);
  const wouldPay = snapshot.paidOverage?.inUse === true || otherLimitOut;
  const window = generalWeeklyWindow(platform, snapshot.windows);
  if (!window) return { freshness, wouldPay };
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const usedPercent = windowUsed(window, now);
  return {
    freshness,
    wouldPay,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(Number.isFinite(reset) && reset > now ? { resetsAt: reset } : {}),
  };
}

/** Whether a fresh reading proves the general weekly limit is used up. */
export function weeklyLimitConfirmedUsedUp(reading: WeeklyLimitReading): boolean {
  return (
    reading.freshness === "fresh" &&
    reading.usedPercent !== undefined &&
    reading.usedPercent >= WEEKLY_LIMIT_USED_UP_PERCENT
  );
}

/**
 * Whether an account has room to be switched onto.
 *
 * Only a fresh reading can say the active account has run out, so an old
 * reading never moves the machine. An idle account's reading is often old, and
 * a weekly limit does not fall before its reset, so a stale reading past the
 * threshold with its reset still ahead keeps that account out until the reset.
 * With no reset to go on, the reading says too little to rule the account out.
 */
function hasRoom(reading: WeeklyLimitReading, active: boolean): boolean {
  if (reading.usedPercent === undefined || reading.usedPercent < AUTO_SWITCH_THRESHOLD_PERCENT) {
    return true;
  }
  if (reading.freshness === "fresh") return false;
  return active || reading.resetsAt === undefined;
}

export interface AutoSwitchAccount {
  account: Pick<AgentAccountSummary, "id" | "signedIn">;
  included: boolean;
  reading: WeeklyLimitReading;
}

export type AutoSwitchDecision =
  { action: "stay" } | { action: "switch"; accountId: string; reason: AutoSwitchReason };

/** Included, signed-in accounts with room, soonest reset first; no known reset ranks last. */
export function rankAutoSwitchAccounts(
  accounts: readonly AutoSwitchAccount[],
  activeAccountId: string,
): AutoSwitchAccount[] {
  return accounts
    .filter(({ account, included, reading }) => {
      if (!included || !account.signedIn) return false;
      const active = account.id === activeAccountId;
      return hasRoom(reading, active) && (active || !reading.wouldPay);
    })
    .sort((left, right) => {
      const leftReset = left.reading.resetsAt ?? Number.POSITIVE_INFINITY;
      const rightReset = right.reading.resetsAt ?? Number.POSITIVE_INFINITY;
      if (leftReset !== rightReset) return leftReset - rightReset;
      // Equal on what the rule asks: staying put never costs a switch.
      if (left.account.id === activeAccountId) return -1;
      if (right.account.id === activeAccountId) return 1;
      const freshness = { fresh: 0, stale: 1, none: 2 } as const;
      return (
        freshness[left.reading.freshness] - freshness[right.reading.freshness] ||
        (left.reading.usedPercent ?? 100) - (right.reading.usedPercent ?? 100) ||
        left.account.id.localeCompare(right.account.id)
      );
    });
}

/** Where the machine should be. With nothing to move onto, it stays: work stops at the limit. */
export function decideAutoSwitch(
  accounts: readonly AutoSwitchAccount[],
  activeAccountId: string,
): AutoSwitchDecision {
  const best = rankAutoSwitchAccounts(accounts, activeAccountId)[0];
  if (!best || best.account.id === activeAccountId) return { action: "stay" };
  const active = accounts.find(({ account }) => account.id === activeAccountId);
  const reason: AutoSwitchReason = !active?.included
    ? "not-included"
    : active.reading.freshness === "fresh" &&
        (active.reading.usedPercent ?? 0) >= AUTO_SWITCH_THRESHOLD_PERCENT
      ? "threshold"
      : "soonest-reset";
  return { action: "switch", accountId: best.account.id, reason };
}

const RESEND_REQUEST_ID = /^usage-limit-resend:(\d+):(.+)$/;
const MAX_RESEND_REQUEST_ID_LENGTH = 200;

/** How many times the work behind a request has already been resent. */
export function usageLimitResendCount(requestId: string): number {
  const count = RESEND_REQUEST_ID.exec(requestId)?.[1];
  return count === undefined ? 0 : Number(count);
}

/**
 * The durable identity of the next resend of a stopped turn. It is the same for
 * the same stop, so a repeated observation or a backend restart finds the
 * dispatch journal entry instead of sending twice, and it carries the count, so
 * a chain of refusals runs out.
 */
export function usageLimitResendRequestId(requestId: string): string {
  const match = RESEND_REQUEST_ID.exec(requestId);
  const root = match?.[2] ?? requestId;
  return `usage-limit-resend:${usageLimitResendCount(requestId) + 1}:${root}`.slice(
    0,
    MAX_RESEND_REQUEST_ID_LENGTH,
  );
}

/** Opens every resend. The transcript keeps it as a user message the user did not type. */
export const USAGE_LIMIT_RESEND_MARKER = "[Orkestrator automatic resend]";

/**
 * What a native tab receives. The stopped prompt stays in the conversation, so
 * the new account continues it rather than being handed it a second time.
 */
export function usageLimitResendPrompt(): string {
  return [
    `${USAGE_LIMIT_RESEND_MARKER} The previous turn stopped because the account's weekly usage limit ran out, and this session has moved to another account. This message was sent automatically, not by the user.`,
    "Continue the original request from where it stopped. Do not repeat work or tool calls that already completed; check the conversation so far and finish the request.",
  ].join("\n\n");
}

/**
 * What a workflow does with a turn that failed: `stop` fails it as before,
 * `wait` looks again on the next pass, and `resend` continues it in a new turn.
 */
export type UsageLimitStopVerdict = "stop" | "wait" | "resend";

/** Sent by a leaf to the command node's backend when its active account moved by itself. */
export const AGENT_ACCOUNT_AUTO_SWITCHED_EVENT = "node-agent-account-auto-switched";

export interface AgentAccountAutoSwitchedEvent {
  platform: AgentAccountPlatform;
  from: string;
  to: string;
  reason: AutoSwitchReason;
  at: string;
}

export function isAgentAccountAutoSwitchedEvent(
  value: unknown,
): value is AgentAccountAutoSwitchedEvent {
  if (!value || typeof value !== "object") return false;
  const { platform, from, to, reason, at } = value as Record<string, unknown>;
  return (
    PLATFORMS.includes(platform as AgentAccountPlatform) &&
    typeof from === "string" &&
    typeof to === "string" &&
    typeof at === "string" &&
    (AUTO_SWITCH_REASONS as readonly unknown[]).includes(reason)
  );
}

/** The notice a coordinator receives for an automatic switch. Names and reasons only. */
export function autoSwitchNoticeText(input: {
  platformLabel: string;
  machineName: string;
  from: string;
  to: string;
  reason: AutoSwitchReason;
}): { subject: string; body: string } {
  const why = {
    threshold: "its general weekly limit reached 98%",
    limit: "a turn stopped and a fresh reading confirmed its general weekly limit is used up",
    "soonest-reset": "another included account's weekly limit resets sooner",
    "not-included": "its tick is off, so it is no longer included",
  }[input.reason];
  return {
    subject: `${input.platformLabel} moved to ${input.to} on ${input.machineName}`.slice(0, 200),
    body: `Automatic account switching moved ${input.platformLabel} on ${input.machineName} from ${input.from} to ${input.to}, because ${why}. Nothing needs doing: work the weekly limit stopped resends itself, and any other stopped work stays stopped. To see or change this, use list_provider_accounts and set_account_auto_switch.`,
  };
}
