import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import type { NativeAgentAccountUsageWindow } from "./native-agent.js";

/**
 * Provider plan/quota usage read without an active agent session.
 *
 * The settings page is global, so it cannot borrow a running session's usage
 * snapshot. This is the shape the backend returns for one platform: the same
 * account windows the information panel draws, plus an explicit status so the
 * UI can tell "the plan has no metered limits" from "we could not read it".
 */
export type PlanUsageStatus = "ok" | "unavailable" | "error";

/**
 * Platforms whose plan quota Orkestrator can read outside an agent session.
 *
 * Grok and Pi are deliberately absent: neither exposes an account quota read,
 * and inventing one from session spend is exactly the fake meter the account
 * panel was rewritten to avoid. This list is the single source of truth for
 * both the backend reader and the settings section that offers the card.
 */
export const PLAN_USAGE_PLATFORMS = ["claude", "codex", "cursor", "opencode"] as const;
export type PlanUsagePlatform = (typeof PLAN_USAGE_PLATFORMS)[number];

export function isPlanUsagePlatform(value: unknown): value is PlanUsagePlatform {
  return typeof value === "string" && (PLAN_USAGE_PLATFORMS as readonly string[]).includes(value);
}

export interface PlanUsageSnapshot {
  platform: AgentPlatform;
  status: PlanUsageStatus;
  /** Quota windows the provider reported. Empty is valid only when `status` is `ok`. */
  windows: NativeAgentAccountUsageWindow[];
  /** The account's plan name, when the provider reports one. */
  plan?: string;
  /** User-facing explanation for `unavailable` or `error`, or why a reading is stale. */
  message?: string;
  /**
   * Whether the account can spend money past its plan allowance, when the
   * provider says: Claude's extra usage, Codex's credits. Absent means the
   * reading did not say, not that it cannot.
   */
  paidOverage?: PlanUsagePaidOverage;
  /**
   * Limit resets the account holds and has not used: Claude's free resets and
   * Codex's banked reset credits. Absent when the account holds none, or the
   * provider did not say; never `available: 0`.
   */
  resets?: PlanUsageResets;
  /**
   * The windows are the last successful reading, served because a fresh one
   * could not be made. `fetchedAt` is when that reading was taken.
   */
  stale?: boolean;
  fetchedAt: string;
  /**
   * The machine that took this reading, when it was another machine: the
   * newest reading of the same login, shared through the command node
   * (`agent-account-shared-usage.ts`). Absent for a reading taken here.
   */
  readOn?: PlanUsageReadingSource;
}

/** The machine (node) that took a shared usage reading. */
export interface PlanUsageReadingSource {
  nodeId: string;
  nodeName: string;
}

/**
 * How old a reading can be before Settings shows it as stale (muted bars and
 * a "Stale" label). Display only: automatic switching keeps its own, much
 * shorter bound (`AUTO_SWITCH_MAX_READING_AGE_MS`, five minutes), because it
 * acts on a reading while a person only reads it. Half an hour is long enough
 * that a reading taken by the periodic checks or another machine is not
 * flagged between refreshes, and short enough that a figure older than a
 * fraction of the 5-hour window never passes for current.
 */
export const PLAN_USAGE_DISPLAY_STALE_MS = 30 * 60_000;

/**
 * Whether Settings shows a reading as stale: served as the last known reading
 * after a failed read, older than {@link PLAN_USAGE_DISPLAY_STALE_MS}, or
 * carrying a fetch time that is unreadable.
 */
export function isPlanUsageReadingStale(
  snapshot: Pick<PlanUsageSnapshot, "fetchedAt" | "stale">,
  now: number,
): boolean {
  if (snapshot.stale) return true;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return true;
  return now - fetchedAt > PLAN_USAGE_DISPLAY_STALE_MS;
}

/**
 * A reading's windows brought forward to `now`: a window whose reset time has
 * passed has started over, so it is shown empty and its next reset is unknown.
 */
export function restartPassedPlanWindows(
  windows: readonly NativeAgentAccountUsageWindow[],
  now: number,
): NativeAgentAccountUsageWindow[] {
  return windows.map((window) => {
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isFinite(resetsAt) || resetsAt > now) return window;
    const restarted = { ...window };
    delete restarted.resetsAt;
    if (restarted.usedPercent !== undefined) restarted.usedPercent = 0;
    return restarted;
  });
}

export interface PlanUsagePaidOverage {
  /** Paid usage is switched on for this account. */
  enabled: boolean;
  /** The provider says the included allowance is unavailable, so a turn would be paid for. */
  inUse?: boolean;
}

/** What a reset gives back. Absent when the provider does not say. */
export type PlanUsageResetScope = "session" | "weekly" | "full";

/** One grant of unused resets, as the provider lists it. */
export interface PlanUsageReset {
  /** The provider's own name for it, e.g. "Weekly reset". */
  label?: string;
  scope?: PlanUsageResetScope;
  /** How many resets this grant still holds: Claude's grants hold several, a Codex credit one. */
  count: number;
  /** When it lapses unused (ISO timestamp). Absent when it does not expire or is unknown. */
  expiresAt?: string;
}

/**
 * The unused resets an account holds. `available` is the provider's own count
 * and is authoritative; `items` are its detail rows, which can be fewer (a
 * provider may cap the list, or the detail read may have failed).
 */
export interface PlanUsageResets {
  available: number;
  items: PlanUsageReset[];
}

/**
 * Resets still usable at `now`: a grant whose expiry has passed is dropped and
 * the count reduced by what it held. `undefined` when none are left, so a
 * reading kept past a reset's expiry stops advertising it. A count the detail
 * rows cannot account for (an item cap) is kept as is.
 */
export function activePlanUsageResets(
  resets: PlanUsageResets | undefined,
  now: number,
): PlanUsageResets | undefined {
  if (!resets) return undefined;
  let lapsed = 0;
  const items = resets.items.filter((item) => {
    const expiresAt = item.expiresAt ? Date.parse(item.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt > now) return true;
    lapsed += item.count;
    return false;
  });
  const available = Math.max(0, resets.available - lapsed);
  return available > 0 ? { available, items } : undefined;
}

export function isPlanUsageSnapshot(value: unknown): value is PlanUsageSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isAgentPlatform(candidate.platform)) return false;
  if (
    candidate.status !== "ok" &&
    candidate.status !== "unavailable" &&
    candidate.status !== "error"
  ) {
    return false;
  }
  if (!Array.isArray(candidate.windows)) return false;
  if (candidate.plan !== undefined && typeof candidate.plan !== "string") return false;
  if (candidate.message !== undefined && typeof candidate.message !== "string") return false;
  if (candidate.stale !== undefined && typeof candidate.stale !== "boolean") return false;
  return typeof candidate.fetchedAt === "string";
}

/**
 * An earlier successful reading, marked stale and brought forward to `now`.
 *
 * A window whose reset time has passed since the reading has started over, so
 * it is shown empty rather than at its old level. Its next reset is unknown.
 */
export function stalePlanUsageSnapshot(
  snapshot: PlanUsageSnapshot,
  now: number,
  message?: string,
): PlanUsageSnapshot {
  const windows = restartPassedPlanWindows(snapshot.windows, now);
  const resets = activePlanUsageResets(snapshot.resets, now);
  return {
    platform: snapshot.platform,
    status: "ok",
    windows,
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(snapshot.paidOverage ? { paidOverage: snapshot.paidOverage } : {}),
    ...(resets ? { resets } : {}),
    ...(message ? { message } : {}),
    stale: true,
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.readOn ? { readOn: snapshot.readOn } : {}),
  };
}

const WEEK_MINUTES = 7 * 24 * 60;

/**
 * Claude's known plan window ids, their labels and period.
 *
 * The single naming for Claude windows, and the same "5-hour limit" / "Weekly
 * limit" wording Codex windows get. Both the OAuth read and the bridge's
 * session rate limits label from here, so one quota is never shown twice under
 * two names.
 */
export const CLAUDE_PLAN_WINDOW_LABELS: Record<string, { label: string; windowMinutes: number }> = {
  five_hour: { label: "5-hour limit", windowMinutes: 300 },
  seven_day: { label: "Weekly limit", windowMinutes: WEEK_MINUTES },
  seven_day_opus: { label: "Weekly Opus limit", windowMinutes: WEEK_MINUTES },
  seven_day_sonnet: { label: "Weekly Sonnet limit", windowMinutes: WEEK_MINUTES },
  seven_day_oauth_apps: { label: "Weekly apps limit", windowMinutes: WEEK_MINUTES },
};

export interface ClaudePlanWindowIdentity {
  id: string;
  label: string;
  windowMinutes: number;
}

/** A weekly limit that applies to one model, e.g. "Weekly Fable limit". */
export function claudeModelWeeklyWindow(modelName: string): ClaudePlanWindowIdentity | undefined {
  const name = modelName.trim();
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return undefined;
  const id = `seven_day_${slug}`;
  const known = CLAUDE_PLAN_WINDOW_LABELS[id];
  return { id, label: known?.label ?? `Weekly ${name} limit`, windowMinutes: WEEK_MINUTES };
}

/** Identity from Claude's named OAuth limits and in-session `/usage` reports. */
export function claudePlanWindowFromKind(
  kind: unknown,
  modelName?: unknown,
): ClaudePlanWindowIdentity | undefined {
  if (kind === "session") return { id: "five_hour", ...CLAUDE_PLAN_WINDOW_LABELS.five_hour! };
  if (kind === "weekly_all") return { id: "seven_day", ...CLAUDE_PLAN_WINDOW_LABELS.seven_day! };
  if (kind === "weekly_scoped" && typeof modelName === "string") {
    return claudeModelWeeklyWindow(modelName);
  }
  return undefined;
}

/**
 * Labels older Claude bridges gave session rate limits, taken from Claude
 * Code's own `/usage` screen. A container can run an older bridge than the
 * app, so these still resolve to the canonical window.
 */
const LEGACY_CLAUDE_WINDOW_LABELS: Record<string, string> = {
  "five hour": "five_hour",
  session: "five_hour",
  weekly: "seven_day",
  "weekly all": "seven_day",
  "weekly (oauth apps)": "seven_day_oauth_apps",
};

/** The canonical identity for a Claude rate-limit label, when it names a known window. */
export function claudePlanWindowFromLabel(label: string): ClaudePlanWindowIdentity | undefined {
  const normalized = label.trim().toLowerCase();
  const legacyId = LEGACY_CLAUDE_WINDOW_LABELS[normalized];
  for (const [id, meta] of Object.entries(CLAUDE_PLAN_WINDOW_LABELS)) {
    if (id === legacyId || meta.label.toLowerCase() === normalized) return { id, ...meta };
  }
  // "Weekly (Fable)" from an older bridge, or "Weekly Fable limit".
  const model =
    label.trim().match(/^weekly \((.+)\)$/i)?.[1] ??
    label.trim().match(/^weekly (.+) limit$/i)?.[1];
  if (!model) return undefined;
  const known = Object.entries(CLAUDE_PLAN_WINDOW_LABELS).find(
    ([id]) => id === `seven_day_${model.trim().toLowerCase()}`,
  );
  return known ? { id: known[0], ...known[1] } : claudeModelWeeklyWindow(model);
}
