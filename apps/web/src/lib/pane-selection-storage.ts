import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";

/**
 * Renderer-local pane presentation state.
 *
 * Shared selection is backend-owned, while Electron keeps a connection-scoped
 * window selection and one-shot presentation intents here. The legacy helpers
 * remain only to read/apply v1 records during migration and clean them up.
 *
 * Everything is best-effort. A browser that denies storage, a quota failure,
 * or a corrupt record costs the user remembered presentation state and nothing
 * else, so every path falls back without surfacing an error.
 */

const STORAGE_KEY = "orkestrator.pane-selection.v1";
const WINDOW_STORAGE_KEY = "orkestrator.window-pane-selection.v1";
const WINDOW_STARTUP_AGENT_ACTIVATION_KEY = "orkestrator.window-startup-agent-activation.v1";

/** Bounds on the record, so an app that has opened many environments over its
 * lifetime cannot grow this without limit. Oldest-written entries are evicted
 * first. */
const MAX_ENVIRONMENTS = 64;
const MAX_SERIALIZED_BYTES = 64 * 1024;

function readStartupAgentActivations(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(desktopConnectionStorageKey(WINDOW_STARTUP_AGENT_ACTIVATION_KEY));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.environmentIds)) return [];
    return parsed.environmentIds.filter(
      (environmentId): environmentId is string =>
        typeof environmentId === "string" && environmentId.length > 0,
    );
  } catch {
    return [];
  }
}

function writeStartupAgentActivations(environmentIds: string[]): void {
  const store = storage();
  if (!store) return;
  const bounded = Array.from(new Set(environmentIds)).slice(-MAX_ENVIRONMENTS);
  try {
    store.setItem(
      desktopConnectionStorageKey(WINDOW_STARTUP_AGENT_ACTIVATION_KEY),
      JSON.stringify({ version: 1, environmentIds: bounded }),
    );
  } catch {
    // Best-effort window presentation state. The backend launch remains
    // authoritative even when this client cannot remember to focus its tab.
  }
}

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

function readEntries(storageKey = STORAGE_KEY): StoredPaneSelectionEntry[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null;
  try {
    raw = store.getItem(storageKey);
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

function writeEntries(entries: StoredPaneSelectionEntry[], storageKey = STORAGE_KEY): void {
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
    store.setItem(storageKey, serialized);
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

export function readStoredPaneSelection(environmentId: string): StoredPaneSelection | null {
  const entry = readEntries().find((candidate) => candidate.environmentId === environmentId);
  if (!entry) return null;
  return { activePaneId: entry.activePaneId, activeTabIds: entry.activeTabIds };
}

export function clearStoredPaneSelection(environmentId: string): void {
  const entries = readEntries();
  const remaining = entries.filter((candidate) => candidate.environmentId !== environmentId);
  if (remaining.length === entries.length) return;
  writeEntries(remaining);
}

export function readWindowPaneSelection(environmentId: string): StoredPaneSelection | null {
  const entry = readEntries(desktopConnectionStorageKey(WINDOW_STORAGE_KEY)).find(
    (candidate) => candidate.environmentId === environmentId,
  );
  return entry ? { activePaneId: entry.activePaneId, activeTabIds: entry.activeTabIds } : null;
}

export function writeWindowPaneSelection(environmentId: string, state: EnvironmentPaneState): void {
  const activeTabIds: Record<string, string> = {};
  forEachLeaf(state.root, (leaf) => {
    if (leaf.kind === "leaf" && leaf.activeTabId) activeTabIds[leaf.id] = leaf.activeTabId;
  });
  const storageKey = desktopConnectionStorageKey(WINDOW_STORAGE_KEY);
  const entries = readEntries(storageKey).filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  entries.push({ environmentId, activePaneId: state.activePaneId, activeTabIds });
  writeEntries(entries, storageKey);
}

/**
 * Remember that this Electron window initiated an environment whose startup
 * agent should take over from setup once its provider session is ready.
 *
 * This is connection-scoped and persisted because setup continues while the
 * environment is inactive and can outlive a renderer reload. Browser clients
 * adopt the backend's shared selection and never arm this intent.
 */
export function armWindowStartupAgentActivation(environmentId: string): void {
  if (!environmentId) return;
  const environmentIds = readStartupAgentActivations().filter(
    (candidate) => candidate !== environmentId,
  );
  environmentIds.push(environmentId);
  writeStartupAgentActivations(environmentIds);
}

/** Consume the one-shot activation once the provider-bound tab is observable. */
export function consumeWindowStartupAgentActivation(environmentId: string): boolean {
  const environmentIds = readStartupAgentActivations();
  if (!environmentIds.includes(environmentId)) return false;
  writeStartupAgentActivations(environmentIds.filter((candidate) => candidate !== environmentId));
  return true;
}

/** Drop an activation whose environment failed to start or was deleted. */
export function clearWindowStartupAgentActivation(environmentId: string): void {
  const environmentIds = readStartupAgentActivations();
  if (!environmentIds.includes(environmentId)) return;
  writeStartupAgentActivations(environmentIds.filter((candidate) => candidate !== environmentId));
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
      children: [restoreSelection(node.children[0]), restoreSelection(node.children[1])],
    };
  };

  return {
    ...state,
    root: restoreSelection(state.root),
    activePaneId: paneIds.has(stored.activePaneId) ? stored.activePaneId : state.activePaneId,
  };
}
