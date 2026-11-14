/**
 * The limit resets an account holds, read from the same usage payloads as its
 * plan windows: Claude's free resets and Codex's banked reset credits. Both are
 * display-only here. Nothing in this module redeems a reset; using one is the
 * person's choice, made in the provider's own app.
 *
 * Neither provider documents these payloads. The shapes below are the ones the
 * pinned Claude Code binary (`cedar_ember` on `/api/oauth/usage?cedar_ember=1`)
 * and the Codex app-server protocol (`RateLimitResetCreditsSummary`) read, and
 * every parser here returns `undefined` for anything it cannot recognise rather
 * than showing a guessed count.
 */
import type { PlanUsageReset, PlanUsageResets } from "@orkestrator/protocol/plan-usage";
import { asRecord } from "../agent-provider-runtime.js";

/** ECMAScript `Date` only represents ±8.64e15 ms around the epoch. */
const MAX_DATE_MS = 8.64e15;
/** Detail rows kept per account; the provider's count stays authoritative past it. */
const MAX_RESET_ITEMS = 16;

function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed.slice(0, max) : undefined;
}

/** An ISO timestamp from an ISO string or epoch seconds/milliseconds. */
function isoTime(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim() !== "") {
    ms = Date.parse(value);
  } else {
    return undefined;
  }
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS
    ? new Date(ms).toISOString()
    : undefined;
}

function resetsOf(available: number, items: PlanUsageReset[]): PlanUsageResets | undefined {
  return available > 0 ? { available, items: items.slice(0, MAX_RESET_ITEMS) } : undefined;
}

/**
 * Claude's free resets: the `cedar_ember` block of the OAuth usage payload.
 * Each grant holds `resets_left` resets and says what it clears (`type`) and
 * when it ends. A paused grant, an ended one, or an account the program does
 * not apply to (`eligible: false`) holds nothing usable.
 */
export function claudePlanResets(value: unknown, now: number): PlanUsageResets | undefined {
  const body = asRecord(value);
  if (!body) return undefined;
  const block = asRecord(body.cedar_ember ?? asRecord(body.usage)?.cedar_ember);
  if (!block || block.eligible !== true || !Array.isArray(block.grants)) return undefined;
  let available = 0;
  const items: PlanUsageReset[] = [];
  for (const entry of block.grants) {
    const grant = asRecord(entry);
    const count = wholeCount(grant?.resets_left);
    if (!grant || !count || grant.paused === true) continue;
    const expiresAt = isoTime(grant.ends_at);
    if (expiresAt !== undefined && Date.parse(expiresAt) <= now) continue;
    const label = text(grant.label);
    const scope = (["session", "weekly", "full"] as const).find((kind) => kind === grant.type);
    available += count;
    items.push({
      count,
      ...(label ? { label } : {}),
      ...(scope ? { scope } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  return resetsOf(available, items);
}

/**
 * Codex's banked reset credits as the usage payload summarises them:
 * `rate_limit_reset_credits.available_count`. The count is authoritative and
 * can exceed the rows the backend lists, so it is not derived from them.
 */
export function codexResetCount(value: unknown): number | undefined {
  const body = asRecord(value);
  const summary = asRecord(body?.rate_limit_reset_credits ?? body?.rateLimitResetCredits);
  return wholeCount(summary?.available_count ?? summary?.availableCount);
}

/** Detail rows already inline in the usage payload's reset summary, if any. */
export function codexInlineResetCredits(value: unknown): unknown {
  const body = asRecord(value);
  return asRecord(body?.rate_limit_reset_credits ?? body?.rateLimitResetCredits)?.credits;
}

/**
 * Each `available` credit of a credits list (the summary's inline rows or the
 * reset-credits endpoint's `credits`), one reset apiece. `credits` is the
 * array or an object holding it. Redeemed, redeeming and expired credits are
 * dropped.
 */
export function codexResetItems(credits: unknown, now: number): PlanUsageReset[] {
  const list = Array.isArray(credits) ? credits : asRecord(credits)?.credits;
  if (!Array.isArray(list)) return [];
  const items: PlanUsageReset[] = [];
  for (const entry of list) {
    const credit = asRecord(entry);
    if (!credit || (credit.status !== undefined && credit.status !== "available")) continue;
    const expiresAt = isoTime(credit.expires_at ?? credit.expiresAt);
    if (expiresAt !== undefined && Date.parse(expiresAt) <= now) continue;
    const label = text(credit.title);
    items.push({ count: 1, ...(label ? { label } : {}), ...(expiresAt ? { expiresAt } : {}) });
  }
  return items;
}

/** Codex's resets: the summary's count, with whichever detail rows were read. */
export function codexPlanResets(
  available: number | undefined,
  items: PlanUsageReset[],
): PlanUsageResets | undefined {
  return available === undefined ? undefined : resetsOf(available, items);
}
