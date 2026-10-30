import {
  classifyUsageLimitError,
  exhaustedUsageWindows,
  usageWindowView,
  type UsageWindowView,
} from "@orkestrator/protocol/agent-usage-limits";
import {
  PLAN_USAGE_PLATFORMS,
  type PlanUsagePlatform,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import { sharedPlanUsageCache } from "./plan-usage-cache.js";

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
 * limit; any later turn that completes clears it. A turn the backend did not
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
  planUsage?: (platform: PlanUsagePlatform) => PlanUsageSnapshot | undefined;
  now?: () => number;
}

const MAX_ERROR_CHARS = 300;

function tabIdFromLogicalKey(environmentId: string, logicalSessionKey: string): string | null {
  const prefix = `env-${environmentId}:`;
  if (!logicalSessionKey.startsWith(prefix)) return null;
  return logicalSessionKey.slice(prefix.length) || null;
}

function cachedPlanUsage(platform: PlanUsagePlatform): PlanUsageSnapshot | undefined {
  return sharedPlanUsageCache.peek(platform) ?? sharedPlanUsageCache.lastOk(platform);
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
    const match = classifyUsageLimitError(last.error);
    if (!match) continue;
    limitedTabs.push({
      environmentId: environment.id,
      environmentName: environment.name,
      tabId: tabIdFromLogicalKey(environment.id, session.logicalSessionKey),
      agent: session.agent,
      observedAt: last.observedAt,
      error: (last.error ?? "").slice(0, MAX_ERROR_CHARS),
      ...(match.resetHint ? { resetHint: match.resetHint } : {}),
    });
  }
  limitedTabs.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const read = sources.planUsage ?? cachedPlanUsage;
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
