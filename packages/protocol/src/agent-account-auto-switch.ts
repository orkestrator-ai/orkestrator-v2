/**
 * Automatic account switching: the settings, which limits count, and the rule
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

/** Between turns, the general weekly limit or the 5-hour limit at or past this moves the machine. */
export const AUTO_SWITCH_THRESHOLD_PERCENT = 98;
/** A limit error moves the machine when a fresh reading says this of the weekly limit. */
export const WEEKLY_LIMIT_USED_UP_PERCENT = 100;
/** Resends of one stopped turn. Each needs another confirmed used-up account. */
export const MAX_USAGE_LIMIT_RESENDS = 3;
/**
 * For `soonest-reset` alone: another login has to reset more than this much
 * sooner to be worth a move. Applied in `decideAutoSwitch`, not when ranking,
 * because a tolerance in a comparator is not transitive.
 */
export const AUTO_SWITCH_RESET_TOLERANCE_MS = 60 * 60_000;

const WEEK_MINUTES = 7 * 24 * 60;
const FIVE_HOUR_MINUTES = 5 * 60;
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

export const AUTO_SWITCH_REASONS = [
  "threshold",
  "five-hour",
  "limit",
  "soonest-reset",
  "not-included",
  "signed-out",
] as const;
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

/**
 * The limit that runs out within a day, on the general allowance.
 *
 * Claude: window `five_hour`. Codex: whichever of `primary` and `secondary` is
 * shorter than the week, because the slot says nothing and the length is the
 * provider's to change. Those slots only come from the general limit, as above.
 */
export function fiveHourWindow<W extends UsageWindowLike>(
  platform: AgentAccountPlatform,
  windows: readonly W[],
): W | undefined {
  if (platform === "claude") return windows.find((window) => window.window === "five_hour");
  return windows.find(
    (window) =>
      (window.window === "primary" || window.window === "secondary") &&
      window.windowMinutes !== undefined &&
      window.windowMinutes < WEEK_MINUTES,
  );
}

/** The 5-hour limit, as one snapshot says it. It decides who has room, never the order. */
export interface FiveHourLimitReading {
  freshness: "fresh" | "stale";
  usedPercent: number;
  /** Epoch ms. Only a reset still ahead counts as known. */
  resetsAt?: number;
}

/** How much one reading can be trusted to say about the limits that count. */
export interface UsageLimitReading {
  /**
   * How far the general weekly limit is known. `fresh`: read just now. `stale`:
   * an earlier reading. `none`: nothing is known about it.
   */
  freshness: "fresh" | "stale" | "none";
  usedPercent?: number;
  /** Epoch ms. Only a reset still ahead counts as known. */
  resetsAt?: number;
  /** Absent when the snapshot does not report one. */
  fiveHour?: FiveHourLimitReading;
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

function fiveHourLimitReading(
  platform: AgentAccountPlatform,
  snapshot: PlanUsageSnapshot,
  now: number,
): FiveHourLimitReading | undefined {
  const window = fiveHourWindow(platform, snapshot.windows);
  const usedPercent = window && windowUsed(window, now);
  if (!window || usedPercent === undefined) return undefined;
  const freshness = snapshot.stale === true ? "stale" : "fresh";
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  // With no reset to go on, a window still cannot outlast its own length from
  // when it was read, so a used-up one is never held out for longer than that.
  const ends = Number.isFinite(reset)
    ? reset
    : Date.parse(snapshot.fetchedAt) + (window.windowMinutes ?? FIVE_HOUR_MINUTES) * 60_000;
  if (ends <= now) return { freshness, usedPercent: 0 };
  return { freshness, usedPercent, ...(Number.isFinite(ends) ? { resetsAt: ends } : {}) };
}

/**
 * Read one snapshot for the rule. A reset in the past is not a known reset: the
 * window has started over and the next reset cannot be told until it is read.
 */
export function usageLimitReading(
  platform: AgentAccountPlatform,
  snapshot: PlanUsageSnapshot | undefined,
  now: number,
): UsageLimitReading {
  if (!snapshot || snapshot.status !== "ok") return { freshness: "none", wouldPay: false };
  const freshness = snapshot.stale === true ? "stale" : "fresh";
  // Past its plan allowance on any other limit, an account with paid usage on
  // would bill the next turn, so its weekly room is no reason to move onto it.
  const fiveHour = fiveHourLimitReading(platform, snapshot, now);
  const shortWindow = fiveHourWindow(platform, snapshot.windows);
  const otherLimitOut =
    snapshot.paidOverage?.enabled === true &&
    snapshot.windows.some(
      (window) =>
        ((window === shortWindow ? fiveHour?.usedPercent : windowUsed(window, now)) ?? 0) >= 100,
    );
  const wouldPay = snapshot.paidOverage?.inUse === true || otherLimitOut;
  const window = generalWeeklyWindow(platform, snapshot.windows);
  if (!window) return { freshness: "none", wouldPay, ...(fiveHour ? { fiveHour } : {}) };
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const usedPercent = windowUsed(window, now);
  return {
    freshness,
    wouldPay,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(Number.isFinite(reset) && reset > now ? { resetsAt: reset } : {}),
    ...(fiveHour ? { fiveHour } : {}),
  };
}

function weeklyConfirmedUsedUp(reading: UsageLimitReading): boolean {
  return (
    reading.freshness === "fresh" &&
    reading.usedPercent !== undefined &&
    reading.usedPercent >= WEEKLY_LIMIT_USED_UP_PERCENT
  );
}

/** One limit's reading, as far as who has room is concerned. */
type LimitLevel = Pick<UsageLimitReading, "freshness" | "usedPercent" | "resetsAt">;

function freshlyPast(level: LimitLevel | undefined): boolean {
  return level?.freshness === "fresh" && (level.usedPercent ?? 0) >= AUTO_SWITCH_THRESHOLD_PERCENT;
}

/**
 * Whether a fresh reading proves a limit that moves the machine stopped the turn:
 * the general weekly limit used up, or the 5-hour limit at the threshold. A 5-hour
 * window fills fast enough to read just under 100% at the refusal, and the machine
 * leaves it at the threshold anyway.
 */
export function limitConfirmedUsedUp(reading: UsageLimitReading): boolean {
  return weeklyConfirmedUsedUp(reading) || freshlyPast(reading.fiveHour);
}

/** When the limit a confirmed stop proved used up lifts; the week outlasts the 5 hours. */
export function confirmedLimitResetsAt(reading: UsageLimitReading): number | undefined {
  return weeklyConfirmedUsedUp(reading) ? reading.resetsAt : reading.fiveHour?.resetsAt;
}

/**
 * Whether one limit leaves room for a switch onto the account.
 *
 * Only a fresh reading can say the active account has run out, so an old
 * reading never moves the machine. An idle account's reading is often old, and
 * neither limit falls before its reset, so a stale reading past the threshold
 * with its reset still ahead keeps that account out until the reset. With no
 * reset to go on, the reading says too little to rule the account out.
 */
function levelHasRoom(level: LimitLevel, active: boolean): boolean {
  if (level.usedPercent === undefined || level.usedPercent < AUTO_SWITCH_THRESHOLD_PERCENT) {
    return true;
  }
  if (level.freshness === "fresh") return false;
  return active || level.resetsAt === undefined;
}

function hasRoom(reading: UsageLimitReading, active: boolean): boolean {
  return (
    levelHasRoom(reading, active) && (!reading.fiveHour || levelHasRoom(reading.fiveHour, active))
  );
}

function freshlyPastThreshold(reading: UsageLimitReading): boolean {
  return freshlyPast(reading) || freshlyPast(reading.fiveHour);
}

export interface AutoSwitchAccount {
  account: Pick<AgentAccountSummary, "id" | "signedIn"> &
    Partial<Pick<AgentAccountSummary, "identity">>;
  included: boolean;
  reading: UsageLimitReading;
}

export type AutoSwitchDecision =
  { action: "stay" } | { action: "switch"; accountId: string; reason: AutoSwitchReason };

/**
 * Two entries with one email are one login, sharing one allowance. An entry with
 * no email cannot be matched, so it is never a twin of another.
 */
function sameLogin(left: AutoSwitchAccount, right: AutoSwitchAccount): boolean {
  const email = normalizeEmail(left.account.identity?.email);
  return email !== undefined && email === normalizeEmail(right.account.identity?.email);
}

/**
 * Included, signed-in accounts with room on both limits, soonest weekly reset
 * first; no known reset ranks last. The 5-hour limit only says who has room, so an
 * account that gets it back takes its place in the order again. A used-up entry's twins have no room either, though only a fresh
 * reading says so about the active entry. While the active entry is usable its
 * twins are left out, because moving to one gains no allowance. Once it is signed
 * out or unticked, a twin is a real way off it.
 */
export function rankAutoSwitchAccounts(
  accounts: readonly AutoSwitchAccount[],
  activeAccountId: string,
): AutoSwitchAccount[] {
  const current = accounts.find(({ account }) => account.id === activeAccountId);
  const currentUsable = current?.included === true && current.account.signedIn;
  return accounts
    .filter((entry) => {
      const { account, included, reading } = entry;
      if (!included || !account.signedIn) return false;
      const active = account.id === activeAccountId;
      if (!active && currentUsable && sameLogin(entry, current)) return false;
      const twinOut = accounts.some(
        (other) =>
          other !== entry &&
          sameLogin(other, entry) &&
          (active ? freshlyPastThreshold(other.reading) : !hasRoom(other.reading, false)),
      );
      return !twinOut && hasRoom(reading, active) && (active || !reading.wouldPay);
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
  const current = accounts.find(({ account }) => account.id === activeAccountId);
  const login = accounts.filter(
    (entry) => current !== undefined && (entry === current || sameLogin(entry, current)),
  );
  const loginPastThreshold = login.some((entry) => freshlyPastThreshold(entry.reading));
  if (
    current?.included &&
    current.account.signedIn &&
    current.reading.freshness === "none" &&
    !loginPastThreshold
  )
    return { action: "stay" };
  const best = rankAutoSwitchAccounts(accounts, activeAccountId)[0];
  if (!best || best.account.id === activeAccountId) return { action: "stay" };
  const reason: AutoSwitchReason =
    current && !current.account.signedIn
      ? "signed-out"
      : !current?.included
        ? "not-included"
        : login.some((entry) => freshlyPast(entry.reading))
          ? "threshold"
          : loginPastThreshold
            ? "five-hour"
            : "soonest-reset";
  if (reason === "soonest-reset") {
    // Ranked ahead of the active account, so `best` has a known reset.
    const soonerBy =
      (current?.reading.resetsAt ?? Number.POSITIVE_INFINITY) -
      (best.reading.resetsAt ?? Number.POSITIVE_INFINITY);
    if (!(soonerBy > AUTO_SWITCH_RESET_TOLERANCE_MS)) return { action: "stay" };
  }
  return { action: "switch", accountId: best.account.id, reason };
}

/**
 * When the next other account the 5-hour limit alone keeps out gets it back, which
 * is when the machine may want to move again.
 */
export function nextFiveHourRefresh(
  accounts: readonly AutoSwitchAccount[],
  activeAccountId: string,
): number | undefined {
  const refreshes = accounts.flatMap(({ account, included, reading }) => {
    const resetsAt = reading.fiveHour?.resetsAt;
    return account.id !== activeAccountId &&
      included &&
      account.signedIn &&
      resetsAt !== undefined &&
      levelHasRoom(reading, false) &&
      !levelHasRoom(reading.fiveHour!, false)
      ? [resetsAt]
      : [];
  });
  return refreshes.length > 0 ? Math.min(...refreshes) : undefined;
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
    `${USAGE_LIMIT_RESEND_MARKER} The previous turn stopped because the account's 5-hour or weekly usage limit ran out, and this session has moved to another account. This message was sent automatically, not by the user.`,
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

/** Older event-stream consumers predate five-hour reasons; outbox/state keep the detail. */
export function legacyAutoSwitchEvent(
  notice: AgentAccountAutoSwitchedEvent,
): AgentAccountAutoSwitchedEvent {
  return notice.reason === "five-hour" ? { ...notice, reason: "limit" } : notice;
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
    "five-hour":
      "its 5-hour limit reached 98%, and the machine returns to it after that limit resets if its weekly limit still resets soonest",
    limit:
      "a turn stopped and a fresh reading confirmed its 5-hour or general weekly limit is used up",
    "soonest-reset": "another included account with room has a weekly limit that resets sooner",
    "signed-out": "the current account is signed out",
    "not-included": "its tick is off, so it is no longer included",
  }[input.reason];
  return {
    subject: `${input.platformLabel} moved to ${input.to} on ${input.machineName}`.slice(0, 200),
    body: `Automatic account switching moved ${input.platformLabel} on ${input.machineName} from ${input.from} to ${input.to}, because ${why}. Nothing needs doing: work a 5-hour or weekly limit stopped resends itself, and any other stopped work stays stopped. To see or change this, use list_provider_accounts and set_account_auto_switch.`,
  };
}
