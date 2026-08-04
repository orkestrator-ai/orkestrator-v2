import { create } from "zustand";
import type { AgentActivityState, Environment } from "@/types";

export type { AgentActivityState } from "@/types";
export {
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  parseUsableAgentActivityTime,
} from "@orkestrator/protocol/agent-activity";

type ActivityEnvironment = Pick<
  Environment,
  "id" | "agentActivityState" | "agentActivityUpdatedAt"
>;

interface AgentActivityStoreState {
  /** Per-terminal presentation state; it is never an environment authority. */
  tabStates: Record<string, AgentActivityState>;
  /** Projection of backend environment snapshots, keyed only by environment id. */
  containerStates: Record<string, AgentActivityState>;
  containerStateUpdatedAt: Record<string, string>;
  /** Mount-derived UI bookkeeping retained for terminal views. */
  containerRefCounts: Record<string, number>;

  setTabState: (tabId: string, state: AgentActivityState) => void;
  removeTabState: (tabId: string) => void;
  replaceActivitySnapshot: (environments: readonly ActivityEnvironment[]) => void;
  removeContainerState: (environmentId: string) => void;
  incrementContainerRef: (containerId: string) => void;
  decrementContainerRef: (containerId: string) => void;
  getTabState: (tabId: string) => AgentActivityState;
  getContainerState: (environmentId: string) => AgentActivityState;
}

export const useAgentActivityStore = create<AgentActivityStoreState>()((set, get) => ({
  tabStates: {},
  containerStates: {},
  containerStateUpdatedAt: {},
  containerRefCounts: {},

  setTabState: (tabId, state) =>
    set((current) => ({
      tabStates: { ...current.tabStates, [tabId]: state },
    })),

  removeTabState: (tabId) =>
    set((current) => {
      const { [tabId]: _removed, ...tabStates } = current.tabStates;
      return { tabStates };
    }),

  replaceActivitySnapshot: (environments) => {
    const containerStates: Record<string, AgentActivityState> = {};
    const containerStateUpdatedAt: Record<string, string> = {};
    for (const environment of environments) {
      if (!environment.agentActivityState || !environment.agentActivityUpdatedAt) continue;
      containerStates[environment.id] = environment.agentActivityState;
      containerStateUpdatedAt[environment.id] = environment.agentActivityUpdatedAt;
    }
    set({ containerStates, containerStateUpdatedAt });
  },

  removeContainerState: (environmentId) =>
    set((current) => {
      const { [environmentId]: _state, ...containerStates } = current.containerStates;
      const { [environmentId]: _time, ...containerStateUpdatedAt } =
        current.containerStateUpdatedAt;
      return { containerStates, containerStateUpdatedAt };
    }),

  incrementContainerRef: (containerId) =>
    set((current) => ({
      containerRefCounts: {
        ...current.containerRefCounts,
        [containerId]: (current.containerRefCounts[containerId] ?? 0) + 1,
      },
    })),

  decrementContainerRef: (containerId) =>
    set((current) => {
      const count = Math.max(0, (current.containerRefCounts[containerId] ?? 0) - 1);
      if (count > 0) {
        return {
          containerRefCounts: { ...current.containerRefCounts, [containerId]: count },
        };
      }
      const { [containerId]: _removed, ...containerRefCounts } = current.containerRefCounts;
      return { containerRefCounts };
    }),

  getTabState: (tabId) => get().tabStates[tabId] ?? "idle",
  getContainerState: (environmentId) => get().containerStates[environmentId] ?? "idle",
}));
