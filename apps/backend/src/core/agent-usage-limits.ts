import {
  classifyUsageLimitError,
  exhaustedUsageWindows,
  usageLimitFailure,
  usageWindowView,
  type TurnFailureKind,
  type UsageWindowView,
} from "@orkestrator/protocol/agent-usage-limits";
import {
  PLAN_USAGE_PLATFORMS,
  stalePlanUsageSnapshot,
  type PlanUsagePlatform,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import type { PlanUsageCache } from "./plan-usage/index.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";

/**
 * Which agent tabs of a project stopped on a provider usage limit, and which
 * provider accounts this machine last saw used up. Answers from what the
 * backend already holds: each session's persisted last turn outcome (the
 * bounded provider error the backend records for every dispatched prompt)
 * and the plan-usage cache. No bridge, provider or transcript read, so a
 * coordinator can ask across all its environments for the cost of one
 * storage listing.
 *
 * A tab counts as limited while its newest recorded turn failed with a usage
 * limit; any later turn that completes clears it. The outcome's `failureKind`
 * says so when the bridge reported the provider's own signal; an outcome
 * without it (an older bridge, a provider with no signal, a record from before
 * the field) is classified by its error text. A turn the backend did not
 * dispatch (one typed into a terminal CLI) is not recorded, so a tab can be
 * limited without being listed: `get_tab_state` reads the live state.
 */

export interface UsageLimitedTab {
  environmentId: string;
  environmentName: string;
  tabId: string | null;
  agent: string;
  observedAt: string;
  /** The provider's error, bounded. */
  error: string;
  resetHint?: string;
  /**
   * `provider`: the provider's own structured signal said so. `text`: only
   * the error's wording did.
   */
  signal: "provider" | "text";
}

export interface UsageLimitedAccount {
  platform: PlanUsagePlatform;
  /** When the reading was taken, and whether it is an old reading served after a failed read. */
  fetchedAt: string;
  stale: boolean;
  exhaustedWindows: UsageWindowView[];
  windows: UsageWindowView[];
}

export interface ProjectUsageLimits {
  checkedAt: string;
  limitedTabs: UsageLimitedTab[];
  /** The active account of each platform this machine has a reading for. */
  activeAccounts: UsageLimitedAccount[];
}

export interface UsageLimitSources {
  storage: {
    getEnvironmentsByProject(projectId: string): Promise<Environment[]>;
    listNativeAgentSessions(): Promise<PersistedNativeAgentSession[]>;
  };
  /** The active account's cached plan usage; never a provider read. */
  planUsage: (platform: PlanUsagePlatform) => PlanUsageSnapshot | undefined;
  now?: () => number;
}

const MAX_ERROR_CHARS = 300;

function tabIdFromLogicalKey(environmentId: string, logicalSessionKey: string): string | null {
  const prefix = `env-${environmentId}:`;
  if (!logicalSessionKey.startsWith(prefix)) return null;
  return logicalSessionKey.slice(prefix.length) || null;
}

/**
 * The `failureKind` to record for a failed turn: the bridge's structured kind
 * when it reported one. Text-only failures keep their provenance at read time. A Claude or
 * Codex limit known from text alone is counted, since those bridges send the
 * code (`usage-limit.text-classified`, docs/architecture/version-compatibility.md).
 */
export function turnOutcomeFailureKind(
  agent: string,
  error: string | undefined,
  reported: TurnFailureKind | undefined,
): TurnFailureKind | undefined {
  if (reported) return reported;
  if (!classifyUsageLimitError(error)) return undefined;
  if (agent === "claude" || agent === "codex") {
    compatibilityPathUsage.record("usage-limit.text-classified");
  }
  return undefined;
}

/** `UsageLimitSources.planUsage` over a backend's cache. */
export function cachedPlanUsage(
  cache: Pick<PlanUsageCache, "peek" | "lastOk">,
): UsageLimitSources["planUsage"] {
  return (platform) => {
    const current = cache.peek(platform);
    if (current) return current;
    const last = cache.lastOk(platform);
    return last ? stalePlanUsageSnapshot(last, Date.now()) : undefined;
  };
}

export async function readProjectUsageLimits(
  sources: UsageLimitSources,
  projectId: string,
): Promise<ProjectUsageLimits> {
  const now = (sources.now ?? Date.now)();
  const environments = new Map(
    (await sources.storage.getEnvironmentsByProject(projectId)).map((environment) => [
      environment.id,
      environment,
    ]),
  );
  const limitedTabs: UsageLimitedTab[] = [];
  for (const session of await sources.storage.listNativeAgentSessions()) {
    const environment = environments.get(session.environmentId);
    if (!environment || session.owner?.kind === "coordinator") continue;
    // Outcomes are appended as they are observed.
    const last = session.turnOutcomes?.at(-1);
    if (!last || last.outcome !== "failed") continue;
    const match = usageLimitFailure(last);
    if (!match) continue;
    limitedTabs.push({
      environmentId: environment.id,
      environmentName: environment.name,
      tabId: tabIdFromLogicalKey(environment.id, session.logicalSessionKey),
      agent: session.agent,
      observedAt: last.observedAt,
      error: (last.error ?? "").slice(0, MAX_ERROR_CHARS),
      ...(match.resetHint ? { resetHint: match.resetHint } : {}),
      signal: match.signal,
    });
  }
  limitedTabs.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const read = sources.planUsage;
  const activeAccounts: UsageLimitedAccount[] = [];
  for (const platform of PLAN_USAGE_PLATFORMS) {
    const snapshot = read(platform);
    if (!snapshot || snapshot.status !== "ok") continue;
    activeAccounts.push({
      platform,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale === true,
      exhaustedWindows: exhaustedUsageWindows(snapshot.windows, now),
      windows: snapshot.windows.map((window) => usageWindowView(window, now)),
    });
  }
  return { checkedAt: new Date(now).toISOString(), limitedTabs, activeAccounts };
}
