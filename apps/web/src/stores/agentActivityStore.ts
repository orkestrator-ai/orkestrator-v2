import { create } from "zustand";
import type { AgentActivityState, Environment } from "@/types";

export type { AgentActivityState } from "@/types";
export { parseUsableAgentActivityTime } from "@orkestrator/protocol/agent-activity";

type ActivityEnvironment = Pick<
  Environment,
  "id" | "agentActivityState" | "agentActivityUpdatedAt"
>;

interface AgentActivityStoreState {
  /** Ephemeral per-tab presentation state projected from backend events. */
  tabStates: Record<string, AgentActivityState>;
  /** Projection of backend environment snapshots, keyed only by environment id. */
  containerStates: Record<string, AgentActivityState>;
  containerStateUpdatedAt: Record<string, string>;
  setTabState: (tabId: string, state: AgentActivityState) => void;
  removeTabState: (tabId: string) => void;
  getTabState: (tabId: string) => AgentActivityState;
  replaceActivitySnapshot: (environments: readonly ActivityEnvironment[]) => void;
  removeContainerState: (environmentId: string) => void;
  getContainerState: (environmentId: string) => AgentActivityState;
}

export const useAgentActivityStore = create<AgentActivityStoreState>()((set, get) => ({
  tabStates: {},
  containerStates: {},
  containerStateUpdatedAt: {},

  setTabState: (tabId, state) =>
    set((current) => ({ tabStates: { ...current.tabStates, [tabId]: state } })),

  removeTabState: (tabId) =>
    set((current) => {
      const { [tabId]: _removed, ...tabStates } = current.tabStates;
      return { tabStates };
    }),

  getTabState: (tabId) => get().tabStates[tabId] ?? "idle",

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

  getContainerState: (environmentId) => get().containerStates[environmentId] ?? "idle",
}));
