import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";

/**
 * Renderer-local storage for which pane and tab this client has focused.
 *
 * Selection is deliberately canonicalised out of the shared backend record:
 * clicking a tab must not write a revision, and must not move another client's
 * focus. That leaves nothing to restore it from after a restart, which is what
 * this module supplies — the same durability as before, without putting
 * selection back on the wire.
 *
 * Everything here is best-effort. A browser that denies storage, a quota
 * failure, or a corrupt record costs the user their remembered selection and
 * nothing else, so every path falls back to the layout's own defaults rather
 * than surfacing an error.
 */

const STORAGE_KEY = "orkestrator.pane-selection.v1";

/** Bounds on the record, so an app that has opened many environments over its
 * lifetime cannot grow this without limit. Oldest-written entries are evicted
 * first. */
const MAX_ENVIRONMENTS = 64;
const MAX_SERIALIZED_BYTES = 64 * 1024;

export interface StoredPaneSelection {
  activePaneId: string;
  /** Pane id → the tab id selected in that pane. */
  activeTabIds: Record<string, string>;
}

interface StoredPaneSelectionEntry extends StoredPaneSelection {
  environmentId: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage itself throws when storage is blocked.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEntry(value: unknown): StoredPaneSelectionEntry | null {
  if (!isRecord(value)) return null;
  const { environmentId, activePaneId, activeTabIds } = value;
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    return null;
  }
  if (typeof activePaneId !== "string" || activePaneId.length === 0) return null;
  if (!isRecord(activeTabIds)) return null;
  const tabIds: Record<string, string> = {};
  for (const [paneId, tabId] of Object.entries(activeTabIds)) {
    if (typeof tabId === "string" && tabId.length > 0) tabIds[paneId] = tabId;
  }
  return { environmentId, activePaneId, activeTabIds: tabIds };
}

function readEntries(): StoredPaneSelectionEntry[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map(parseEntry)
      .filter((entry): entry is StoredPaneSelectionEntry => entry !== null);
  } catch {
    return [];
  }
}

function writeEntries(entries: StoredPaneSelectionEntry[]): void {
  const store = storage();
  if (!store) return;
  // Trim newest-last until both bounds hold. A single entry over the byte
  // budget is still written: the alternative is remembering nothing at all.
  let bounded = entries.slice(-MAX_ENVIRONMENTS);
  let serialized = JSON.stringify({ version: 1, entries: bounded });
  while (bounded.length > 1 && serialized.length > MAX_SERIALIZED_BYTES) {
    bounded = bounded.slice(1);
    serialized = JSON.stringify({ version: 1, entries: bounded });
  }
  try {
    store.setItem(STORAGE_KEY, serialized);
  } catch {
    // Quota or a denied write. Nothing to recover; selection simply is not
    // remembered for this session.
  }
}

function forEachLeaf(node: PaneNode, visit: (leaf: PaneNode) => void): void {
  if (node.kind === "leaf") {
    visit(node);
    return;
  }
  forEachLeaf(node.children[0], visit);
  forEachLeaf(node.children[1], visit);
}

export function paneSelectionOf(
  state: EnvironmentPaneState,
): StoredPaneSelection {
  const activeTabIds: Record<string, string> = {};
  forEachLeaf(state.root, (leaf) => {
    if (leaf.kind === "leaf" && leaf.activeTabId) {
      activeTabIds[leaf.id] = leaf.activeTabId;
    }
  });
  return { activePaneId: state.activePaneId, activeTabIds };
}

export function readStoredPaneSelection(
  environmentId: string,
): StoredPaneSelection | null {
  const entry = readEntries().find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (!entry) return null;
  return { activePaneId: entry.activePaneId, activeTabIds: entry.activeTabIds };
}

export function writeStoredPaneSelection(
  environmentId: string,
  selection: StoredPaneSelection,
): void {
  const entries = readEntries().filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  entries.push({ environmentId, ...selection });
  writeEntries(entries);
}

export function clearStoredPaneSelection(environmentId: string): void {
  const entries = readEntries();
  const remaining = entries.filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  if (remaining.length === entries.length) return;
  writeEntries(remaining);
}

/**
 * Re-applies a remembered selection over a freshly restored layout.
 *
 * A stored pane or tab that the restored layout no longer contains is ignored,
 * so a tab closed on another client between sessions cannot resurrect a
 * selection pointing at nothing.
 */
export function applyStoredPaneSelection(
  state: EnvironmentPaneState,
  environmentId: string,
  stored: StoredPaneSelection | null = readStoredPaneSelection(environmentId),
): EnvironmentPaneState {
  if (!stored) return state;

  const paneIds = new Set<string>();
  forEachLeaf(state.root, (leaf) => paneIds.add(leaf.id));

  const restoreSelection = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      const storedTabId = stored.activeTabIds[node.id];
      if (!storedTabId || !node.tabs.some((tab) => tab.id === storedTabId)) {
        return node;
      }
      return { ...node, activeTabId: storedTabId };
    }
    return {
      ...node,
      children: [
        restoreSelection(node.children[0]),
        restoreSelection(node.children[1]),
      ],
    };
  };

  return {
    ...state,
    root: restoreSelection(state.root),
    activePaneId: paneIds.has(stored.activePaneId)
      ? stored.activePaneId
      : state.activePaneId,
  };
}

/**
 * Mirrors selection into local storage as the user moves around.
 *
 * Only selection is compared, so this writes on a tab click but not on the
 * structural changes the backend record already covers.
 */
export function startPaneSelectionPersistence(): () => void {
  const lastWritten = new Map<string, string>();

  const capture = (
    environmentId: string,
    state: EnvironmentPaneState,
  ): void => {
    const selection = paneSelectionOf(state);
    const serialized = JSON.stringify(selection);
    if (lastWritten.get(environmentId) === serialized) return;
    lastWritten.set(environmentId, serialized);
    writeStoredPaneSelection(environmentId, selection);
  };

  const initial = usePaneLayoutStore.getState();
  for (const [environmentId, environment] of initial.environments) {
    if (initial.hydration.get(environmentId) !== "done") continue;
    lastWritten.set(
      environmentId,
      JSON.stringify(paneSelectionOf(environment)),
    );
  }

  return usePaneLayoutStore.subscribe((state, previous) => {
    for (const [environmentId, environment] of state.environments) {
      if (state.hydration.get(environmentId) !== "done") continue;
      if (environment === previous.environments.get(environmentId)) continue;
      capture(environmentId, environment);
    }
    for (const environmentId of previous.environments.keys()) {
      if (!state.environments.has(environmentId)) {
        lastWritten.delete(environmentId);
      }
    }
  });
}
