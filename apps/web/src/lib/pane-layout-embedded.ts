import {
  DESIGN_AGENT_DOCKS,
  isPaneLeaf,
  type DesignAgentDock,
  type DesignAgentPanelState,
  type PaneLeaf,
  type PaneNode,
  type TabInfo,
} from "@/types/paneLayout";

/**
 * Agent tabs embedded in a design canvas tab.
 *
 * An embedded agent tab stays an ordinary tab in its host's pane, so the
 * backend, agent mail, tab teardown and every tab lookup keep finding it. The
 * pane store only has to keep three facts true, which {@link
 * normalizeEmbeddedTabs} restores after every change:
 *
 * - an embedded tab lives in the same pane as its host, and follows it when
 *   the host is moved or split away;
 * - a pane never selects an embedded tab: it selects the host instead;
 * - a host shows at most one agent, and an embedded tab whose host is gone
 *   becomes an ordinary tab again rather than disappearing.
 */

/** Panel size bounds, as a percentage of the design tab along the dock axis. */
export const DESIGN_AGENT_PANEL_SIZE = Object.freeze({
  min: 15,
  max: 80,
  /** Default when docked left or right: room for the composer's controls. */
  horizontal: 40,
  /** Default when docked top or bottom. */
  vertical: 40,
});

export const DEFAULT_DESIGN_AGENT_PANEL: DesignAgentPanelState = Object.freeze({
  dock: "left",
  open: true,
});

export function isDesignAgentDock(value: unknown): value is DesignAgentDock {
  return typeof value === "string" && (DESIGN_AGENT_DOCKS as readonly string[]).includes(value);
}

export function isHorizontalDock(dock: DesignAgentDock): boolean {
  return dock === "left" || dock === "right";
}

export function clampDesignAgentPanelSize(size: number): number {
  return Math.min(DESIGN_AGENT_PANEL_SIZE.max, Math.max(DESIGN_AGENT_PANEL_SIZE.min, size));
}

/** The panel's size, or the default for its dock. */
export function designAgentPanelSize(panel: DesignAgentPanelState): number {
  if (typeof panel.size === "number" && Number.isFinite(panel.size))
    return clampDesignAgentPanelSize(panel.size);
  return isHorizontalDock(panel.dock)
    ? DESIGN_AGENT_PANEL_SIZE.horizontal
    : DESIGN_AGENT_PANEL_SIZE.vertical;
}

/** A restored panel state, or undefined (the default) when it is not one. */
export function sanitizeDesignAgentPanel(value: unknown): DesignAgentPanelState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!isDesignAgentDock(record.dock) || typeof record.open !== "boolean") return undefined;
  const size =
    typeof record.size === "number" && Number.isFinite(record.size)
      ? clampDesignAgentPanelSize(record.size)
      : undefined;
  return { dock: record.dock, open: record.open, ...(size === undefined ? {} : { size }) };
}

export function designAgentPanelOf(tab: TabInfo | undefined): DesignAgentPanelState {
  return tab?.designCanvasData?.agentPanel ?? DEFAULT_DESIGN_AGENT_PANEL;
}

/** Only design canvases host an agent, and only a non-design tab can be embedded. */
export function canHostEmbeddedTabs(tab: TabInfo): boolean {
  return tab.type === "design-canvas";
}

/** The agent tab shown inside `hostTabId`, if any. */
export function findEmbeddedTab(tabs: readonly TabInfo[], hostTabId: string): TabInfo | undefined {
  return tabs.find((tab) => tab.embeddedIn === hostTabId);
}

/** The tabs a tab bar shows: everything not embedded in another tab. */
export function visibleTabsOf(tabs: readonly TabInfo[]): TabInfo[] {
  return tabs.some((tab) => tab.embeddedIn) ? tabs.filter((tab) => !tab.embeddedIn) : [...tabs];
}

/** `tabIds` plus the tabs embedded in any of them, embedded ones first. */
export function withEmbeddedTabIds(tabs: readonly TabInfo[], tabIds: readonly string[]): string[] {
  const requested = new Set(tabIds);
  const embedded = tabs
    .filter((tab) => tab.embeddedIn && requested.has(tab.embeddedIn) && !requested.has(tab.id))
    .map((tab) => tab.id);
  return [...embedded, ...tabIds];
}

function withoutEmbedding(tab: TabInfo): TabInfo {
  const { embeddedIn: _embeddedIn, ...rest } = tab;
  return rest;
}

function leavesOf(node: PaneNode): PaneLeaf[] {
  if (isPaneLeaf(node)) return [node];
  return [...leavesOf(node.children[0]), ...leavesOf(node.children[1])];
}

function mapLeaves(node: PaneNode, map: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (isPaneLeaf(node)) return map(node);
  const first = mapLeaves(node.children[0], map);
  const second = mapLeaves(node.children[1], map);
  if (first === node.children[0] && second === node.children[1]) return node;
  return { ...node, children: [first, second] };
}

/** Removes `leafId` from the tree, replacing its parent split with the sibling. */
function collapseLeaf(node: PaneNode, leafId: string): PaneNode {
  if (isPaneLeaf(node)) return node;
  const [first, second] = node.children;
  if (first.id === leafId) return second;
  if (second.id === leafId) return first;
  const nextFirst = collapseLeaf(first, leafId);
  const nextSecond = collapseLeaf(second, leafId);
  if (nextFirst === first && nextSecond === second) return node;
  return { ...node, children: [nextFirst, nextSecond] };
}

/**
 * Restores the embedding invariants (see the module comment). Returns `state`
 * itself when nothing needed to change, so callers can compare identities.
 */
export function normalizeEmbeddedTabs<T extends { root: PaneNode; activePaneId: string }>(
  state: T,
): T {
  const leaves = leavesOf(state.root);
  if (!leaves.some((leaf) => leaf.tabs.some((tab) => tab.embeddedIn !== undefined))) return state;

  const hostLeaf = new Map<string, string>();
  for (const leaf of leaves)
    for (const tab of leaf.tabs) if (canHostEmbeddedTabs(tab)) hostLeaf.set(tab.id, leaf.id);

  const claimedHosts = new Set<string>();
  const arriving = new Map<string, TabInfo[]>();
  const kept = new Map<string, TabInfo[]>();
  let changed = false;
  for (const leaf of leaves) {
    const tabs: TabInfo[] = [];
    for (const tab of leaf.tabs) {
      const host = tab.embeddedIn;
      if (host === undefined) {
        tabs.push(tab);
        continue;
      }
      const target = hostLeaf.get(host);
      if (target === undefined || canHostEmbeddedTabs(tab) || claimedHosts.has(host)) {
        // Orphaned, nested or a second agent for one host: an ordinary tab again.
        tabs.push(withoutEmbedding(tab));
        changed = true;
        continue;
      }
      claimedHosts.add(host);
      if (target === leaf.id) tabs.push(tab);
      else {
        arriving.set(target, [...(arriving.get(target) ?? []), tab]);
        changed = true;
      }
    }
    kept.set(leaf.id, tabs);
  }

  const emptied = new Set<string>();
  let root = mapLeaves(state.root, (leaf) => {
    const base = kept.get(leaf.id) ?? leaf.tabs;
    const tabs = arriving.has(leaf.id) ? [...base, ...arriving.get(leaf.id)!] : base;
    let activeTabId = leaf.activeTabId;
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (active?.embeddedIn) activeTabId = active.embeddedIn;
    else if (activeTabId !== null && !active)
      activeTabId = tabs.filter((tab) => !tab.embeddedIn).at(-1)?.id ?? null;
    if (leaf.tabs.length > 0 && tabs.length === 0) emptied.add(leaf.id);
    if (tabs.length === leaf.tabs.length && tabs.every((tab, i) => tab === leaf.tabs[i])) {
      if (activeTabId === leaf.activeTabId) return leaf;
    }
    changed = true;
    return { ...leaf, tabs, activeTabId };
  });
  if (!changed) return state;

  let activePaneId = state.activePaneId;
  for (const leafId of emptied) {
    if (root.id === leafId) continue;
    root = collapseLeaf(root, leafId);
    if (activePaneId === leafId) {
      const movedTo = Array.from(arriving.keys())[0];
      activePaneId = movedTo ?? leavesOf(root)[0]!.id;
    }
  }
  return { ...state, root, activePaneId };
}
