import { environmentIsReadyForSetupHandoff as isReadyForSetupHandoff } from "@orkestrator/protocol/tab-initial-prompt";
import type {
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
} from "@orkestrator/protocol/pane-layout-merge";
import type { Environment, PersistedPaneLayout } from "./models.js";
import { isRecord } from "./storage-shared-core.js";

export const MAX_PANE_LAYOUT_ROOT_BYTES = 256 * 1024;
export const MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES = 64 * 1024;
export const MAX_PANE_LAYOUT_SELECTION_ENTRIES = 1_024;

export function assertPaneLayoutRootWithinBounds(root: unknown): void {
  let serializedRoot: string | undefined;
  try {
    serializedRoot = JSON.stringify(root);
  } catch {
    throw new Error("Pane layout root must be JSON serializable");
  }
  if (serializedRoot === undefined) {
    throw new Error("Pane layout root must be JSON serializable");
  }
  if (Buffer.byteLength(serializedRoot, "utf8") > MAX_PANE_LAYOUT_ROOT_BYTES) {
    throw new Error("Pane layout root exceeds the 256 KB limit");
  }
}

export function assertPaneLayoutSelectionIntentWithinBounds(
  selectionIntent: PaneLayoutSelectionIntent | undefined,
): void {
  if (!selectionIntent) return;
  const entries = Object.entries(selectionIntent.activeTabIds ?? {});
  if (entries.length > MAX_PANE_LAYOUT_SELECTION_ENTRIES) {
    throw new Error("Pane layout selection intent exceeds the 1024 entry limit");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(selectionIntent);
  } catch {
    throw new Error("Pane layout selection intent must be JSON serializable");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES
  ) {
    throw new Error("Pane layout selection intent exceeds the 64 KB limit");
  }
}

/**
 * Refuses a renderer-supplied layout that belongs to a dead container.
 *
 * A local environment has no container, so its layouts always carry `null`;
 * everything else must name the container the environment is running now.
 */
export function assertPaneLayoutGeneration(
  environment: Environment,
  containerId: string | null,
  source: "write" | "intent",
): void {
  const currentContainerId =
    environment.environmentType === "local" ? null : environment.containerId;
  if (containerId !== currentContainerId) {
    throw new Error(
      `Pane layout ${source} targets stale environment generation: expected ${currentContainerId ?? "local"}, received ${containerId ?? "local"}`,
    );
  }
}

export type MutablePaneLayoutLeaf = {
  kind: "leaf";
  id: string;
  tabs: Array<Record<string, unknown>>;
  activeTabId: string | null;
};

export function paneLayoutLeaves(root: unknown): MutablePaneLayoutLeaf[] {
  const leaves: MutablePaneLayoutLeaf[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (
      node.kind === "leaf" &&
      typeof node.id === "string" &&
      Array.isArray(node.tabs) &&
      node.tabs.every(isRecord) &&
      (node.activeTabId === null || typeof node.activeTabId === "string")
    ) {
      leaves.push(node as MutablePaneLayoutLeaf);
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return leaves;
}

/** The renderer's own predicate, from the shared startup-tab contract. */
export function environmentIsReadyForSetupHandoff(environment: Environment): boolean {
  return isReadyForSetupHandoff(environment);
}

/**
 * True when this leaf is still showing the setup terminal (or has no valid
 * selection). A user who already clicked a non-setup tab is left alone.
 *
 * A pane that cannot be resolved fails closed. The alternative — treating an
 * unknown pane as "still on setup" — silently re-activates the startup tab for
 * any layout shape this predicate cannot read, which is the one direction that
 * takes the selection away from the user.
 */
export function selectedTabIsSetupHandoffSource(
  leaf: { tabs: Array<Record<string, unknown>>; activeTabId: string | null } | undefined,
): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}

/**
 * Keeps a completed setup handoff focused on the surface that follows setup.
 *
 * The renderer adds and selects its setup tab in one optimistic mutation. A
 * very short setup can finish before that mutation reaches the backend, after
 * which the pipeline selects the build tab. Letting the stale mutation rebase
 * normally would add the obsolete setup tab and let its explicit focus intent
 * override the newer backend-owned build selection.
 *
 * A longer setup has a second version of the same race: the setup tab is already
 * durable, but a selection write based on that pre-handoff layout is still in
 * flight when the build or startup-agent tab becomes authoritative. In that
 * case the merge base still has setup selected. Preserve the newer post-setup
 * target until a client has observed it; a later deliberate click on setup is
 * based on the post-handoff layout and remains allowed.
 */
export function suppressLateSetupTabAdditions(
  layout: PaneLayoutMergeInput,
  previous: PersistedPaneLayout | undefined,
  base: PaneLayoutMergeInput,
): PaneLayoutMergeInput {
  const previousLeaves = paneLayoutLeaves(previous?.root);
  const baseLeavesById = new Map(paneLayoutLeaves(base.root).map((leaf) => [leaf.id, leaf]));
  const durableSetupTabIds = new Set(
    previousLeaves.flatMap((leaf) =>
      leaf.tabs.flatMap((tab) =>
        tab.isSetupTab === true && typeof tab.id === "string" ? [tab.id] : [],
      ),
    ),
  );
  const root = JSON.parse(JSON.stringify(layout.root)) as PaneLayoutMergeInput["root"];
  const nextLeaves = paneLayoutLeaves(root);
  const previousLeavesById = new Map(previousLeaves.map((leaf) => [leaf.id, leaf]));
  const previousTabsById = new Map(
    previousLeaves.flatMap((leaf) =>
      leaf.tabs.flatMap((tab) => (typeof tab.id === "string" ? [[tab.id, tab] as const] : [])),
    ),
  );
  let changed = false;
  let removedGlobalFocus = false;

  for (const leaf of nextLeaves) {
    const removedIds = new Set(
      leaf.tabs.flatMap((tab) =>
        tab.isSetupTab === true && typeof tab.id === "string" && !durableSetupTabIds.has(tab.id)
          ? [tab.id]
          : [],
      ),
    );
    if (removedIds.size === 0) continue;
    changed = true;
    const removedActiveTab = leaf.activeTabId !== null && removedIds.has(leaf.activeTabId);
    leaf.tabs = leaf.tabs.flatMap((tab) => {
      if (typeof tab.id !== "string" || !removedIds.has(tab.id)) return [tab];
      const previousTab = previousTabsById.get(tab.id);
      return previousTab
        ? [JSON.parse(JSON.stringify(previousTab)) as Record<string, unknown>]
        : [];
    });
    if (!removedActiveTab) continue;

    removedGlobalFocus ||= layout.activePaneId === leaf.id;
    const remainingIds = new Set(
      leaf.tabs.flatMap((tab) => (typeof tab.id === "string" ? [tab.id] : [])),
    );
    const previousActiveTabId = previousLeavesById.get(leaf.id)?.activeTabId;
    const buildTabId = leaf.tabs.find(
      (tab) => tab.type === "claude-build" && typeof tab.id === "string",
    )?.id;
    const firstTabId = leaf.tabs.find((tab) => typeof tab.id === "string")?.id;
    leaf.activeTabId =
      previousActiveTabId && remainingIds.has(previousActiveTabId)
        ? previousActiveTabId
        : typeof buildTabId === "string"
          ? buildTabId
          : typeof firstTabId === "string"
            ? firstTabId
            : null;
  }

  const nextLeavesById = new Map(nextLeaves.map((leaf) => [leaf.id, leaf]));
  for (const previousLeaf of previousLeaves) {
    const nextLeaf = nextLeavesById.get(previousLeaf.id);
    const baseLeaf = baseLeavesById.get(previousLeaf.id);
    if (!nextLeaf || !baseLeaf || !nextLeaf.activeTabId) continue;
    const selected = nextLeaf.tabs.find((tab) => tab.id === nextLeaf.activeTabId);
    if (selected?.isSetupTab !== true) continue;
    if (baseLeaf.activeTabId !== nextLeaf.activeTabId) continue;
    if (!previousLeaf.activeTabId || previousLeaf.activeTabId === nextLeaf.activeTabId) {
      continue;
    }
    const handoffTarget = nextLeaf.tabs.find(
      (tab) => tab.id === previousLeaf.activeTabId && tab.isSetupTab !== true,
    );
    if (!handoffTarget) continue;
    nextLeaf.activeTabId = previousLeaf.activeTabId;
    changed = true;
    removedGlobalFocus ||= layout.activePaneId === nextLeaf.id;
  }

  if (!changed) return layout;
  const remainingPaneIds = new Set(nextLeaves.map((leaf) => leaf.id));
  return {
    ...layout,
    root,
    activePaneId:
      removedGlobalFocus && previous && remainingPaneIds.has(previous.activePaneId)
        ? previous.activePaneId
        : layout.activePaneId,
  };
}
