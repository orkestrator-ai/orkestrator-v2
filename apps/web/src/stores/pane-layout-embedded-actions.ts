import {
  getNativeAgentData,
  isPaneLeaf,
  type DesignAgentPanelState,
  type PaneNode,
  type TabInfo,
} from "@/types/paneLayout";
import type { EnvironmentPaneState, PaneLayoutState } from "./paneLayoutStore";
import {
  canHostEmbeddedTabs,
  designAgentPanelOf,
  findEmbeddedTab,
  normalizeEmbeddedTabs,
  sanitizeDesignAgentPanel,
} from "./pane-layout-embedded";

/** Pane store actions for agent tabs shown inside a design canvas tab. */
export interface EmbeddedTabActions {
  /**
   * Shows agent tab `tabId` inside design tab `hostTabId`, or with `null`
   * makes it an ordinary tab again (and selects it). Refused, returning false,
   * when either tab is missing, the tab is not an agent, or the design already
   * shows another agent.
   */
  setTabEmbedding: (tabId: string, hostTabId: string | null, environmentId: string) => boolean;
  /** Changes where a design tab's agent panel is docked, its size or whether it shows. */
  updateDesignAgentPanel: (
    tabId: string,
    patch: Partial<DesignAgentPanelState>,
    environmentId: string,
  ) => void;
}

type SetLayout = (partial: Partial<PaneLayoutState>) => void;
type GetLayout = () => PaneLayoutState;

/**
 * Wraps the pane store's state creator: every change it publishes keeps
 * embedded agent tabs with their design (see `normalizeEmbeddedTabs`), and the
 * embedding actions are added to the store.
 */
export function withEmbeddedTabs(
  create: (set: SetLayout, get: GetLayout) => Omit<PaneLayoutState, keyof EmbeddedTabActions>,
): (set: SetLayout, get: GetLayout) => PaneLayoutState {
  return (rawSet, get) => {
    const set: SetLayout = (partial) => rawSet(normalizeEnvironmentsPartial(partial));
    return { ...create(set, get), ...embeddedTabActions(get, set) };
  };
}

/** Applies {@link normalizeEmbeddedTabs} to every environment a store update writes. */
export function normalizeEnvironmentsPartial(
  partial: Partial<PaneLayoutState>,
): Partial<PaneLayoutState> {
  const environments = partial.environments;
  if (!environments) return partial;
  let next: Map<string, EnvironmentPaneState> | null = null;
  for (const [environmentId, state] of environments) {
    const normalized = normalizeEmbeddedTabs(state);
    if (normalized === state) continue;
    next ??= new Map(environments);
    next.set(environmentId, normalized);
  }
  return next ? { ...partial, environments: next } : partial;
}

function mapTabs(node: PaneNode, map: (tab: TabInfo) => TabInfo): PaneNode {
  if (isPaneLeaf(node)) {
    const tabs = node.tabs.map(map);
    return tabs.every((tab, index) => tab === node.tabs[index]) ? node : { ...node, tabs };
  }
  const first = mapTabs(node.children[0], map);
  const second = mapTabs(node.children[1], map);
  if (first === node.children[0] && second === node.children[1]) return node;
  return { ...node, children: [first, second] };
}

function allTabs(node: PaneNode): TabInfo[] {
  if (isPaneLeaf(node)) return node.tabs;
  return [...allTabs(node.children[0]), ...allTabs(node.children[1])];
}

export function embeddedTabActions(get: () => PaneLayoutState, set: SetLayout): EmbeddedTabActions {
  const writeRoot = (environmentId: string, env: EnvironmentPaneState, root: PaneNode) => {
    if (root === env.root) return;
    const environments = new Map(get().environments);
    environments.set(environmentId, { ...env, root });
    set({ environments });
  };
  return {
    setTabEmbedding: (tabId, hostTabId, environmentId) => {
      const env = get().environments.get(environmentId);
      if (!env) return false;
      const tabs = allTabs(env.root);
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return false;
      if (hostTabId === null) {
        if (!tab.embeddedIn) return true;
        const { embeddedIn: _embeddedIn, ...detached } = tab;
        writeRoot(
          environmentId,
          env,
          mapTabs(env.root, (candidate) => (candidate.id === tabId ? detached : candidate)),
        );
        const pane = get().findPaneWithTab(tabId, environmentId);
        if (pane) get().setActiveTab(pane.id, tabId, environmentId);
        return true;
      }
      const host = tabs.find((candidate) => candidate.id === hostTabId);
      if (!host || !canHostEmbeddedTabs(host) || !getNativeAgentData(tab)) return false;
      const current = findEmbeddedTab(tabs, hostTabId);
      if (current) return current.id === tabId;
      writeRoot(
        environmentId,
        env,
        mapTabs(env.root, (candidate) =>
          candidate.id === tabId ? { ...candidate, embeddedIn: hostTabId } : candidate,
        ),
      );
      return get().findPaneWithTab(tabId, environmentId) !== null;
    },

    updateDesignAgentPanel: (tabId, patch, environmentId) => {
      const env = get().environments.get(environmentId);
      if (!env) return;
      writeRoot(
        environmentId,
        env,
        mapTabs(env.root, (tab) => {
          if (tab.id !== tabId || !tab.designCanvasData) return tab;
          const current = designAgentPanelOf(tab);
          const next = sanitizeDesignAgentPanel({ ...current, ...patch });
          if (
            !next ||
            (next.dock === current.dock && next.open === current.open && next.size === current.size)
          )
            return tab;
          return { ...tab, designCanvasData: { ...tab.designCanvasData, agentPanel: next } };
        }),
      );
    },
  };
}
