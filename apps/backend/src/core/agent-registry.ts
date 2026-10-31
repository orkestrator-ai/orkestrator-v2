import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { resolveTabDisplayName } from "@orkestrator/protocol/agent-mail";
import {
  summarizeAgentRegistry,
  type AgentRegistryEntry,
  type AgentRegistrySnapshot,
  type AgentTabState,
} from "@orkestrator/protocol/agent-registry";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NativeAgentGoalSummary } from "@orkestrator/protocol/native-agent-goal";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { paneLayoutLeaves } from "./storage-shared.js";
import type { CoordinatorsStorage, StorageService } from "./storage.js";

/** Live activity readers. In-memory only: a snapshot never waits on a provider. */
export interface AgentRegistrySources {
  /** Native SDK sessions, by the turn view (a turn with only background work left reads idle). */
  native?: (
    environmentId: string,
    agent: AgentPlatform,
    logicalSessionKey: string,
  ) => AgentActivityState | "unknown";
  /** Claude under tmux; undefined when no session exists for the tab. */
  tmux?: (environmentId: string, tabId: string) => AgentActivityState | undefined;
  /** A native tab's goal, from its session record. */
  goal?: (
    environmentId: string,
    agent: AgentPlatform,
    logicalSessionKey: string,
  ) => Promise<NativeAgentGoalSummary | undefined>;
}

const WORKFLOW_TAB_TYPES = new Set(["claude-build", "multi-review"]);

function tabKind(tab: Record<string, unknown>): AgentRegistryEntry["kind"] | null {
  if (tab.isReviewTab === true || WORKFLOW_TAB_TYPES.has(String(tab.type))) return null;
  if (tab.type === "agent-native") return "native";
  if (tab.type === "claude-tmux") return "tmux";
  if (isAgentPlatform(tab.type)) return "terminal";
  return null;
}

function tabPlatform(tab: Record<string, unknown>): AgentPlatform | null {
  if (tab.type === "claude-tmux") return "claude";
  if (isAgentPlatform(tab.type)) return tab.type;
  const data = tab.nativeAgentData;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const platform = (data as Record<string, unknown>).platform;
  return isAgentPlatform(platform) ? platform : null;
}

function sessionHandle(
  kind: AgentRegistryEntry["kind"],
  agent: AgentPlatform | null,
  environmentId: string,
  tabId: string,
): { sessionId?: string } {
  if (kind !== "native" || !agent) return {};
  try {
    return { sessionId: encodePublicSessionId(environmentId, tabId) };
  } catch {
    // An id outside the handle's alphabet has no handle; the entry still lists.
    return {};
  }
}

/**
 * Every agent tab in the app, and what each is doing.
 *
 * Membership comes from the same authoritative records the rest of the backend
 * uses — committed pane layouts for environment tabs, the coordinator store
 * for coordinator conversations — and state from the in-memory activity the
 * native observer and the tmux hooks already maintain, so a snapshot is cheap
 * and never blocks on a provider. Environments that are not visible in the
 * renderer are covered exactly like the active one.
 */
export class AgentRegistry {
  constructor(
    private readonly storage: Pick<
      StorageService,
      "loadProjects" | "loadEnvironments" | "loadPaneLayoutsForReconciliation"
    > & { coordinators: Pick<CoordinatorsStorage, "listCoordinatorWorkspaces"> },
    private readonly sources: AgentRegistrySources = {},
  ) {}

  async snapshot(
    filter: { projectId?: string; environmentId?: string } = {},
  ): Promise<AgentRegistrySnapshot> {
    const [projects, environments, layouts, coordinators] = await Promise.all([
      this.storage.loadProjects(),
      this.storage.loadEnvironments(),
      this.storage.loadPaneLayoutsForReconciliation(),
      this.storage.coordinators.listCoordinatorWorkspaces(),
    ]);
    const projectIds = new Set(projects.map((project) => project.id));
    const entries: AgentRegistryEntry[] = [];
    for (const environment of environments) {
      if (environment.deletionRequestedAt || !projectIds.has(environment.projectId)) continue;
      if (filter.projectId && environment.projectId !== filter.projectId) continue;
      if (filter.environmentId && environment.id !== filter.environmentId) continue;
      const layout = layouts.layouts[environment.id];
      if (!layout) continue;
      const running = environment.status === "running";
      let tabOrdinal = 0;
      for (const leaf of paneLayoutLeaves(layout.root)) {
        for (const tab of leaf.tabs as Array<Record<string, unknown>>) {
          tabOrdinal += 1;
          const kind = tabKind(tab);
          if (!kind || typeof tab.id !== "string") continue;
          const agent = tabPlatform(tab);
          const logicalSessionKey = `env-${environment.id}:${tab.id}`;
          const goal =
            kind === "native" && agent
              ? await this.sources.goal?.(environment.id, agent, logicalSessionKey)
              : undefined;
          entries.push({
            projectId: environment.projectId,
            environmentId: environment.id,
            environmentName: environment.name,
            tabId: tab.id,
            ownerKind: "environment",
            kind,
            agent,
            ...sessionHandle(kind, agent, environment.id, tab.id),
            displayName: resolveTabDisplayName({
              tabType: String(tab.type),
              tabOrdinal,
              agent,
              displayTitle: typeof tab.displayTitle === "string" ? tab.displayTitle : null,
            }),
            tabOrdinal,
            state: running
              ? this.observe(kind, environment.id, tab.id, agent, logicalSessionKey)
              : "stopped",
            ...(goal ? { goal } : {}),
          });
        }
      }
    }
    for (const workspace of coordinators) {
      if (filter.projectId && workspace.projectId !== filter.projectId) continue;
      const ready = workspace.lifecycleState === "ready";
      for (const conversation of workspace.conversations) {
        if (conversation.closedAt) continue;
        const environmentId = coordinatorRuntimeId(workspace.id, conversation.id);
        if (filter.environmentId && filter.environmentId !== environmentId) continue;
        const agent = conversation.agent ?? null;
        entries.push({
          projectId: workspace.projectId,
          environmentId,
          environmentName: "Coordinator",
          tabId: conversation.tabId,
          ownerKind: "coordinator",
          kind: "native",
          agent,
          ...sessionHandle("native", agent, environmentId, conversation.tabId),
          displayName: conversation.title,
          tabOrdinal: conversation.role === "side" ? (conversation.sideOrdinal ?? 0) + 1 : 1,
          state: ready
            ? this.observe(
                "native",
                environmentId,
                conversation.tabId,
                agent,
                conversation.logicalSessionKey,
              )
            : "stopped",
          ...(conversation.role ? { coordinatorRole: conversation.role } : {}),
        });
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      entries,
      environments: summarizeAgentRegistry(entries),
    };
  }

  private observe(
    kind: AgentRegistryEntry["kind"],
    environmentId: string,
    tabId: string,
    agent: AgentPlatform | null,
    logicalSessionKey: string,
  ): AgentTabState {
    if (kind === "native") {
      if (!agent || !this.sources.native) return "unknown";
      return this.sources.native(environmentId, agent, logicalSessionKey);
    }
    if (kind === "tmux") return this.sources.tmux?.(environmentId, tabId) ?? "unknown";
    // A terminal CLI reports no per-tab activity.
    return "unknown";
  }
}
