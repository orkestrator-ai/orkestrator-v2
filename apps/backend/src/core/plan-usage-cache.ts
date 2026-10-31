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
import { isPlanQuotaWindow } from "@orkestrator/protocol/node/cursor-plan-usage";
import type {
  NativeAgentAccountUsageWindow,
  NativeAgentContextUsage,
  NativeAgentRateLimitWindow,
} from "@orkestrator/protocol/native-agent";
import {
  claudePlanWindowFromLabel,
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
  /**
   * The last successful reading for the active account, however old. Served,
   * marked stale, when a fresh read fails.
   */
  lastOk: (platform: PlanUsagePlatform) => PlanUsageSnapshot | undefined;
  store: (platform: PlanUsagePlatform, snapshot: PlanUsageSnapshot, ttlMs: number) => void;
  /**
   * Fold account windows a running session just reported into the cache.
   *
   * A session read is as authoritative as the settings read and costs nothing,
   * so it both updates the card and defers the next provider read by a full
   * window.
   */
  recordSessionWindows: (platform: AgentPlatform, windows: NativeAgentAccountUsageWindow[]) => void;
  /** Drop one platform's entry, e.g. after its active account changed. */
  invalidate: (platform: PlanUsagePlatform) => void;
  /** Drop every cached entry. Test isolation, and a credential change. */
  clear: () => void;
};

function mergeSessionWindows(
  existing: NativeAgentAccountUsageWindow[],
  incoming: NativeAgentAccountUsageWindow[],
): NativeAgentAccountUsageWindow[] {
  if (existing.length === 0) return incoming;
  const merged = existing.map((row) => ({ ...row }));
  for (const window of incoming) {
    const index = merged.findIndex((row) => row.window === window.window);
    if (index >= 0) {
      const definedFields = Object.fromEntries(
        Object.entries(window).filter(([, value]) => value !== undefined),
      );
      merged[index] = { ...merged[index]!, ...definedFields };
    } else merged.push({ ...window });
  }
  return merged;
}

export function createPlanUsageCache(now: () => number = Date.now): PlanUsageCache {
  const entries = new Map<PlanUsagePlatform, { expiresAt: number; snapshot: PlanUsageSnapshot }>();
  const lastOk = new Map<PlanUsagePlatform, PlanUsageSnapshot>();
  return {
    peek(platform) {
      const entry = entries.get(platform);
      return entry && entry.expiresAt > now() ? entry.snapshot : undefined;
    },
    lastOk(platform) {
      return lastOk.get(platform);
    },
    store(platform, snapshot, ttlMs) {
      entries.set(platform, { expiresAt: now() + ttlMs, snapshot });
      if (snapshot.status === "ok" && !snapshot.stale) lastOk.set(platform, snapshot);
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
      const fresh = cached?.snapshot.status === "ok" && !cached.snapshot.stale;
      const existing = fresh ? cached.snapshot.windows : [];
      // A session may report one window at a time — Claude's rate-limit events
      // are sparse — so a wholesale replace would erase bars a provider read
      // just stored. Merge by window identity and keep the unmatched rows.
      const merged = mergeSessionWindows(existing, planWindows);
      // Sessions re-report an unchanged snapshot on every poll. Treating those
      // as updates would push the next read out forever and freeze the card.
      if (fresh && sameWindows(cached.snapshot.windows, merged)) {
        return;
      }
      const at = now();
      const snapshot = okSnapshot(
        platform,
        merged,
        new Date(at).toISOString(),
        cached?.snapshot.plan,
      );
      entries.set(platform, { expiresAt: at + CACHE_TTL_MS, snapshot });
      lastOk.set(platform, snapshot);
    },
    invalidate(platform) {
      entries.delete(platform);
      lastOk.delete(platform);
    },
    clear() {
      entries.clear();
      lastOk.clear();
    },
  };
}

/**
 * One backend's plan usage: the cache the settings reader serves from and
 * sessions write through, and the active account a session's windows must
 * belong to before they reach it. Owned by `AgentAccountsRuntime` as
 * `planUsage`; the HTTP bridge providers are handed it through their
 * dependencies, because they have no `CommandContext`.
 */
export class PlanUsageState {
  readonly cache: PlanUsageCache = createPlanUsageCache();
  private readonly activeAccountIds = new Map<"claude" | "codex", string>();

  setActiveAccount(platform: "claude" | "codex", accountId: string): void {
    this.activeAccountIds.set(platform, accountId);
  }

  initializeActiveAccount(platform: "claude" | "codex", accountId: string): void {
    if (!this.activeAccountIds.has(platform)) this.activeAccountIds.set(platform, accountId);
  }

  activeAccount(platform: "claude" | "codex"): string | undefined {
    return this.activeAccountIds.get(platform);
  }
}

/**
 * Claude reports its plan windows per session as rate limits, not as account
 * rows, so the same quota arrives under a different key. Known labels — and
 * the "Five Hour" / "Weekly" wording older bridges used — map onto the
 * canonical id and label the direct OAuth read emits, so a window a session
 * reports updates the same cached row rather than sitting beside it.
 */
function accountWindowsFromRateLimits(
  limits: NativeAgentRateLimitWindow[],
  agent: AgentPlatform,
): NativeAgentAccountUsageWindow[] {
  return limits.map((limit) => {
    const known = agent === "claude" ? claudePlanWindowFromLabel(limit.label) : undefined;
    const windowMinutes = limit.windowMinutes ?? known?.windowMinutes;
    return {
      window: known?.id ?? sessionWindowId(limit.label),
      label: known?.label ?? limit.label,
      ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
      ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    };
  });
}

function sessionWindowId(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "window"
  );
}

/**
 * Normalize a session usage payload and keep any account quota it carries.
 *
 * The settings plan-usage card reads the same windows straight from the
 * provider. A session that has just reported them makes that request
 * unnecessary for the next couple of minutes, so every provider read path
 * normalizes through here rather than letting the card poll on its own.
 * A provider built without `planUsage` only normalizes.
 */
export function contextUsageWithPlanUsage(
  planUsage: PlanUsageState | undefined,
  agent: AgentPlatform,
  value: unknown,
  reportingAccountId?: string,
): NativeAgentContextUsage | undefined {
  const usage = normalizeProviderContextUsage(value);
  const windows = usage?.account?.length
    ? usage.account
    : usage?.rateLimits?.length
      ? accountWindowsFromRateLimits(usage.rateLimits, agent)
      : undefined;
  if (
    planUsage &&
    windows &&
    ((agent !== "claude" && agent !== "codex") ||
      (reportingAccountId ?? "default") === (planUsage.activeAccount(agent) ?? "default"))
  ) {
    planUsage.cache.recordSessionWindows(agent, windows);
  }
  return usage;
}
