/**
 * The newest plan-usage reading of each login, shared across machines.
 *
 * Every machine reads usage only for its own logins, and the same login is
 * often signed in on several machines under different local account ids. The
 * command node keeps, per login identity, the newest reading any machine took
 * and hands it to every machine that has the same login, which then shows and
 * switches on whichever of its own and the shared reading is newer. See
 * docs/architecture/agent-accounts.md ("Shared readings").
 *
 * A shared reading carries usage only: windows (percentages, token counts,
 * spend, credits, reset times), the plan name, whether paid overage is on, when
 * it was taken, and which machine took it. Every field is rebuilt one by one
 * from what arrived ({@link parseSharedUsageReading}), so nothing else a peer
 * sends (a token, a cookie, a message) is kept or passed on.
 *
 * Browser-safe.
 */
import { isAgentAccountPlatform, type AgentAccountPlatform } from "./agent-accounts.js";
import type { NativeAgentAccountUsageWindow } from "./native-agent.js";
import {
  restartPassedPlanWindows,
  type PlanUsagePaidOverage,
  type PlanUsageReadingSource,
  type PlanUsageSnapshot,
} from "./plan-usage.js";

/** Announces a reading newly kept on this machine; carries no reading. */
export const AGENT_USAGE_READINGS_CHANGED_EVENT = "agent-usage-readings-changed";

/**
 * How far in the future a reading's fetch time may be, to allow for clocks
 * that disagree a little. A reading within it is dated now; one beyond it is
 * refused, because a clock far ahead would otherwise make an old reading look
 * newer than every real one for as long as the clock stays ahead.
 */
export const SHARED_USAGE_CLOCK_SKEW_MS = 2 * 60_000;

export const SHARED_USAGE_LIMITS = {
  /** Readings per store, per collect answer and per apply call. */
  maxReadings: 256,
  /** Windows per reading. */
  maxWindows: 16,
  maxStringLength: 320,
} as const;

/**
 * Which login a reading belongs to: provider, email (trimmed, lower case), and
 * the organisation or workspace id where the provider reports one (Claude's
 * organisation, a ChatGPT workspace). A login without an email is never shared.
 */
export interface UsageIdentity {
  platform: AgentAccountPlatform;
  email: string;
  organizationId?: string;
}

export interface SharedUsageReading {
  identity: UsageIdentity;
  windows: NativeAgentAccountUsageWindow[];
  plan?: string;
  paidOverage?: PlanUsagePaidOverage;
  fetchedAt: string;
  /** The machine that took the reading. */
  source: PlanUsageReadingSource;
}

/** What a machine answers when its command node collects (`collect_shared_usage_readings`). */
export interface SharedUsageCollect {
  /** Every signed-in login this machine has that can be matched elsewhere. */
  identities: UsageIdentity[];
  /** The newest reading this machine has of each of them. */
  readings: SharedUsageReading[];
}

function boundedString(value: unknown, max: number = SHARED_USAGE_LIMITS.maxStringLength) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The identity of a login, or `undefined` when it cannot be matched across machines. */
export function normalizeUsageIdentity(
  platform: unknown,
  email: unknown,
  organizationId?: unknown,
): UsageIdentity | undefined {
  if (!isAgentAccountPlatform(platform)) return undefined;
  const normalizedEmail = boundedString(email)?.toLowerCase();
  if (!normalizedEmail) return undefined;
  const organization = boundedString(organizationId, 128);
  return {
    platform,
    email: normalizedEmail,
    ...(organization ? { organizationId: organization } : {}),
  };
}

export function parseUsageIdentity(value: unknown): UsageIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return normalizeUsageIdentity(record.platform, record.email, record.organizationId);
}

/**
 * One key per login. Two identities match only when provider, email and
 * organisation all agree, so the same email in two organisations, or a login
 * that reports an organisation and one that does not, are different logins.
 */
export function usageIdentityKey(identity: UsageIdentity): string {
  return [identity.platform, identity.email, identity.organizationId ?? ""].join("\u0000");
}

function parseWindow(value: unknown): NativeAgentAccountUsageWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const window = boundedString(record.window, 64);
  if (!window) return undefined;
  const result: NativeAgentAccountUsageWindow = { window };
  const label = boundedString(record.label, 120);
  if (label) result.label = label;
  const resetsAt = boundedString(record.resetsAt, 64);
  if (resetsAt && Number.isFinite(Date.parse(resetsAt))) result.resetsAt = resetsAt;
  const creditBalance = boundedString(record.creditBalance, 64);
  if (creditBalance) result.creditBalance = creditBalance;
  for (const key of [
    "tokens",
    "usedPercent",
    "windowMinutes",
    "spendUsd",
    "creditsRemaining",
    "limitUsd",
  ] as const) {
    const number = finite(record[key]);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function parsePaidOverage(value: unknown): PlanUsagePaidOverage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") return undefined;
  return {
    enabled: record.enabled,
    ...(typeof record.inUse === "boolean" ? { inUse: record.inUse } : {}),
  };
}

function parseSource(value: unknown): PlanUsageReadingSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nodeId = boundedString(record.nodeId, 200);
  const nodeName = boundedString(record.nodeName, 200);
  return nodeId && nodeName ? { nodeId, nodeName } : undefined;
}

/**
 * A reading rebuilt field by field from what a peer sent, or `null` when it
 * cannot be used: no matchable identity, no machine, an unreadable fetch time,
 * or one further in the future than {@link SHARED_USAGE_CLOCK_SKEW_MS}. A fetch
 * time a little ahead of `now` is dated `now`.
 */
export function parseSharedUsageReading(value: unknown, now: number): SharedUsageReading | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const identity = parseUsageIdentity(record.identity);
  const source = parseSource(record.source);
  const fetchedAtText = boundedString(record.fetchedAt, 64);
  const fetchedAt = fetchedAtText ? Date.parse(fetchedAtText) : Number.NaN;
  if (!identity || !source || !Number.isFinite(fetchedAt)) return null;
  if (fetchedAt - now > SHARED_USAGE_CLOCK_SKEW_MS) return null;
  if (!Array.isArray(record.windows)) return null;
  const windows = record.windows
    .slice(0, SHARED_USAGE_LIMITS.maxWindows)
    .map(parseWindow)
    .filter((window): window is NativeAgentAccountUsageWindow => window !== undefined);
  const plan = boundedString(record.plan, 64);
  const paidOverage = parsePaidOverage(record.paidOverage);
  return {
    identity,
    windows,
    ...(plan ? { plan } : {}),
    ...(paidOverage ? { paidOverage } : {}),
    fetchedAt: new Date(Math.min(fetchedAt, now)).toISOString(),
    source,
  };
}

/** Every usable reading of a list, at most {@link SHARED_USAGE_LIMITS.maxReadings}. */
export function parseSharedUsageReadings(value: unknown, now: number): SharedUsageReading[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, SHARED_USAGE_LIMITS.maxReadings)
    .map((entry) => parseSharedUsageReading(entry, now))
    .filter((entry): entry is SharedUsageReading => entry !== null);
}

export function parseUsageIdentities(value: unknown): UsageIdentity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: UsageIdentity[] = [];
  for (const entry of value.slice(0, SHARED_USAGE_LIMITS.maxReadings)) {
    const identity = parseUsageIdentity(entry);
    if (!identity || seen.has(usageIdentityKey(identity))) continue;
    seen.add(usageIdentityKey(identity));
    result.push(identity);
  }
  return result;
}

/** Whether `candidate` was taken strictly after `current` (or there is no `current`). */
export function isNewerSharedUsageReading(
  candidate: Pick<SharedUsageReading, "fetchedAt">,
  current: Pick<SharedUsageReading, "fetchedAt"> | undefined,
): boolean {
  if (!current) return true;
  return Date.parse(candidate.fetchedAt) > Date.parse(current.fetchedAt);
}

/**
 * The newest reading of each identity across several lists, keyed by
 * {@link usageIdentityKey}. A tie keeps the reading seen first.
 */
export function newestSharedUsageReadings(
  ...lists: ReadonlyArray<readonly SharedUsageReading[]>
): Map<string, SharedUsageReading> {
  const newest = new Map<string, SharedUsageReading>();
  for (const list of lists) {
    for (const reading of list) {
      const key = usageIdentityKey(reading.identity);
      if (isNewerSharedUsageReading(reading, newest.get(key))) newest.set(key, reading);
    }
  }
  return newest;
}

/**
 * The shareable part of a fresh reading this machine took, or `null` for
 * anything that is not one: a failed read, or a last known reading served
 * stale. Built from named fields only, so a snapshot's `message` and any
 * other field never travel.
 */
export function sharedUsageReadingFromSnapshot(
  identity: UsageIdentity,
  snapshot: PlanUsageSnapshot,
  source: PlanUsageReadingSource,
  now: number,
): SharedUsageReading | null {
  if (snapshot.status !== "ok" || snapshot.stale || snapshot.readOn) return null;
  return parseSharedUsageReading(
    {
      identity,
      windows: snapshot.windows,
      plan: snapshot.plan,
      paidOverage: snapshot.paidOverage,
      fetchedAt: snapshot.fetchedAt,
      source,
    },
    now,
  );
}

/**
 * A shared reading as this machine shows it. `readOn` names the machine that
 * took it unless that is `selfNodeId`. Windows whose reset has passed since
 * are shown started over, as for a last known reading.
 */
export function planUsageSnapshotFromSharedReading(
  reading: SharedUsageReading,
  selfNodeId: string,
  now: number,
): PlanUsageSnapshot {
  return {
    platform: reading.identity.platform,
    status: "ok",
    windows: restartPassedPlanWindows(reading.windows, now),
    ...(reading.plan ? { plan: reading.plan } : {}),
    ...(reading.paidOverage ? { paidOverage: reading.paidOverage } : {}),
    fetchedAt: reading.fetchedAt,
    ...(reading.source.nodeId !== selfNodeId ? { readOn: reading.source } : {}),
  };
}

/**
 * Of this machine's own answer for an account and the shared reading of the
 * same login, the one to show and switch on: the newer by `fetchedAt`. A
 * failed read with no last known reading has no reading at all, so any shared
 * reading wins over it.
 */
export function newestPlanUsage(
  local: PlanUsageSnapshot,
  shared: PlanUsageSnapshot | undefined,
): PlanUsageSnapshot {
  if (!shared) return local;
  if (local.status !== "ok") return shared;
  return Date.parse(shared.fetchedAt) > Date.parse(local.fetchedAt) ? shared : local;
}
