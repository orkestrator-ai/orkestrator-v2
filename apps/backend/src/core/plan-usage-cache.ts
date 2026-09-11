/**
 * The plan-usage snapshot cache, and the session path that feeds it.
 *
 * Deliberately a leaf module: every provider read path imports it to hand over
 * the account quota a session just reported, and it must not drag the reader's
 * credential machinery — the Keychain, config and container command modules —
 * into that graph. `plan-usage.ts` owns the provider requests and uses the same
 * cache from the other side.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isPlanQuotaWindow } from "@orkestrator/protocol/cursor-plan-usage";
import type {
  NativeAgentAccountUsageWindow,
  NativeAgentContextUsage,
  NativeAgentRateLimitWindow,
} from "@orkestrator/protocol/native-agent";
import {
  isPlanUsagePlatform,
  type PlanUsagePlatform,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";
import { normalizeProviderContextUsage } from "./agent-provider-runtime.js";

/**
 * How long one read serves every caller, and how far a session update pushes
 * the next read out. Two minutes: quota percentages move on the scale of a
 * turn, and the settings pane is opened far more often than that.
 */
export const CACHE_TTL_MS = 120_000;
/** Failures are held briefly so a retry can recover rather than wait it out. */
export const ERROR_CACHE_TTL_MS = 10_000;

export function okSnapshot(
  platform: AgentPlatform,
  windows: NativeAgentAccountUsageWindow[],
  fetchedAt: string,
  plan?: string,
): PlanUsageSnapshot {
  return { platform, status: "ok", windows, ...(plan ? { plan } : {}), fetchedAt };
}

function sameWindows(
  left: NativeAgentAccountUsageWindow[],
  right: NativeAgentAccountUsageWindow[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type PlanUsageCache = {
  /** The cached snapshot, if it has not aged out. */
  peek: (platform: PlanUsagePlatform) => PlanUsageSnapshot | undefined;
  store: (platform: PlanUsagePlatform, snapshot: PlanUsageSnapshot, ttlMs: number) => void;
  /**
   * Fold account windows a running session just reported into the cache.
   *
   * A session read is as authoritative as the settings read and costs nothing,
   * so it both updates the card and defers the next provider read by a full
   * window.
   */
  recordSessionWindows: (platform: AgentPlatform, windows: NativeAgentAccountUsageWindow[]) => void;
};

export function createPlanUsageCache(now: () => number = Date.now): PlanUsageCache {
  const entries = new Map<PlanUsagePlatform, { expiresAt: number; snapshot: PlanUsageSnapshot }>();
  return {
    peek(platform) {
      const entry = entries.get(platform);
      return entry && entry.expiresAt > now() ? entry.snapshot : undefined;
    },
    store(platform, snapshot, ttlMs) {
      entries.set(platform, { expiresAt: now() + ttlMs, snapshot });
    },
    recordSessionWindows(platform, windows) {
      if (!isPlanUsagePlatform(platform) || windows.length === 0) return;
      // Cursor sessions report their own spend alongside the plan bars. Only
      // the plan rows belong on a card that describes the account.
      const planWindows =
        platform === "cursor"
          ? windows.filter((entry) => isPlanQuotaWindow(entry.window))
          : windows;
      if (planWindows.length === 0) return;
      const cached = entries.get(platform);
      // Sessions re-report an unchanged snapshot on every poll. Treating those
      // as updates would push the next read out forever and freeze the card.
      if (cached?.snapshot.status === "ok" && sameWindows(cached.snapshot.windows, planWindows)) {
        return;
      }
      const at = now();
      entries.set(platform, {
        expiresAt: at + CACHE_TTL_MS,
        snapshot: okSnapshot(platform, planWindows, new Date(at).toISOString()),
      });
    },
  };
}

/** The cache the settings reader serves from, and sessions write through. */
export const sharedPlanUsageCache = createPlanUsageCache();

/**
 * Claude reports its plan windows per session as rate limits, not as account
 * rows, so the same quota arrives under a different key. Slugified labels
 * match what the bridge's own plan read produces.
 */
function accountWindowsFromRateLimits(
  limits: NativeAgentRateLimitWindow[],
): NativeAgentAccountUsageWindow[] {
  return limits.map((limit) => ({
    window:
      limit.label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "window",
    label: limit.label,
    ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
    ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
    ...(limit.windowMinutes !== undefined ? { windowMinutes: limit.windowMinutes } : {}),
  }));
}

/**
 * Normalize a session usage payload and keep any account quota it carries.
 *
 * The settings plan-usage card reads the same windows straight from the
 * provider. A session that has just reported them makes that request
 * unnecessary for the next couple of minutes, so every provider read path
 * normalizes through here rather than letting the card poll on its own.
 */
export function contextUsageWithPlanUsage(
  agent: AgentPlatform,
  value: unknown,
): NativeAgentContextUsage | undefined {
  const usage = normalizeProviderContextUsage(value);
  const windows = usage?.account?.length
    ? usage.account
    : usage?.rateLimits?.length
      ? accountWindowsFromRateLimits(usage.rateLimits)
      : undefined;
  if (windows) sharedPlanUsageCache.recordSessionWindows(agent, windows);
  return usage;
}
