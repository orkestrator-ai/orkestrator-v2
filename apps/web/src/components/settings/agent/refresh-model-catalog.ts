import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import * as backend from "@/lib/backend";
import { hydrateAgentModelCatalogCache } from "@/lib/agent-model-catalog-cache";

export const MODEL_CATALOG_REFRESHED_EVENT = "orkestrator:model-catalog-refreshed";

type GlobalCatalogAgent = Exclude<AgentPlatform, "opencode">;
type RefreshResult = { agent: AgentPlatform; modelCount: number };

type RefreshDependencies = {
  refreshGlobal(agent: GlobalCatalogAgent): Promise<RefreshResult>;
  refreshOpenCode(projectId: string): Promise<RefreshResult>;
  hydrate(): Promise<void>;
  dispatch(event: Event): boolean;
};

const defaultDependencies: RefreshDependencies = {
  refreshGlobal: (agent) => backend.refreshHostAgentModelCatalog(agent),
  refreshOpenCode: (projectId) => backend.refreshHostAgentModelCatalog("opencode", projectId),
  hydrate: hydrateAgentModelCatalogCache,
  dispatch: (event) => window.dispatchEvent(event),
};

/** Pick a durable OpenCode cache scope even when Global Settings has no active repository. */
export function resolveSettingsCatalogProjectId(
  selectedProjectId: string | null,
  projectIds: readonly string[],
): string | null {
  if (selectedProjectId && (projectIds.length === 0 || projectIds.includes(selectedProjectId))) {
    return selectedProjectId;
  }
  return projectIds[0] ?? null;
}

/** Run the settings refresh and publish cache invalidation only after persistence succeeds. */
export async function refreshSettingsModelCatalog(
  platform: AgentPlatform,
  projectId: string | null,
  dependencies: RefreshDependencies = defaultDependencies,
): Promise<RefreshResult> {
  let result: RefreshResult;
  if (platform === "opencode") {
    if (!projectId) {
      throw new Error("Select a repository before refreshing its OpenCode model catalogue");
    }
    result = await dependencies.refreshOpenCode(projectId);
  } else {
    result = await dependencies.refreshGlobal(platform);
  }
  await dependencies.hydrate();
  dependencies.dispatch(new Event(MODEL_CATALOG_REFRESHED_EVENT));
  return result;
}
