import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import type { PaneNode } from "@/types/paneLayout";
import { COMMAND_STORAGE_NODE, nodeStorageKey, type StorageNode } from "@/lib/persistence-keys";

/**
 * Renderer-local pane presentation state.
 *
 * Shared selection is backend-owned, while Electron keeps a connection-scoped
 * window selection and one-shot presentation intents here. The legacy helpers
 * remain only to read/apply v1 records during migration and clean them up.
 *
 * Every record is a node's (`storageNode`, the command node by default until
 * the pane layout store is scoped in plan item 3013): environment ids are
 * only unique on their node. The un-namespaced v1 record was the command
 * node's, so a leaf never reads it.
 *
 * Everything is best-effort. A browser that denies storage, a quota failure,
 * or a corrupt record costs the user remembered presentation state and nothing
 * else, so every path falls back without surfacing an error.
 */

const STORAGE_KEY = "orkestrator.pane-selection.v1";
const WINDOW_STORAGE_KEY = "orkestrator.window-pane-selection.v1";
const WINDOW_STARTUP_AGENT_ACTIVATION_KEY = "orkestrator.window-startup-agent-activation.v1";
const WINDOW_BUILD_PIPELINE_ACTIVATION_KEY = "orkestrator.window-build-pipeline-activation.v1";
const WINDOW_BUILD_PIPELINE_HANDOFF_KEY = "orkestrator.window-build-pipeline-handoff.v1";

/** Bounds on the record, so an app that has opened many environments over its
 * lifetime cannot grow this without limit. Oldest-written entries are evicted
 * first. */
const MAX_ENVIRONMENTS = 64;
const MAX_SERIALIZED_BYTES = 64 * 1024;

function readStartupAgentActivations(storageNode: StorageNode): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(nodeStorageKey(WINDOW_STARTUP_AGENT_ACTIVATION_KEY, storageNode));
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

function writeStartupAgentActivations(environmentIds: string[], storageNode: StorageNode): void {
  const store = storage();
  if (!store) return;
  const bounded = Array.from(new Set(environmentIds)).slice(-MAX_ENVIRONMENTS);
  try {
    store.setItem(
      nodeStorageKey(WINDOW_STARTUP_AGENT_ACTIVATION_KEY, storageNode),
      JSON.stringify({ version: 1, environmentIds: bounded }),
    );
  } catch {
    // Best-effort window presentation state. The backend launch remains
    // authoritative even when this client cannot remember to focus its tab.
  }
}

interface BuildPipelineActivation {
  environmentId: string;
  pipelineId: string;
  /** True when the environment was already setup-ready at the moment this window armed. */
  setupReadyAtArm: boolean;
}

function parseBuildPipelineActivation(value: unknown): BuildPipelineActivation | null {
  if (!isRecord(value)) return null;
  const { environmentId, pipelineId, setupReadyAtArm } = value;
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  if (typeof pipelineId !== "string" || pipelineId.length === 0) return null;
  return {
    environmentId,
    pipelineId,
    setupReadyAtArm: setupReadyAtArm === true,
  };
}

function readBuildPipelineActivations(storageNode: StorageNode): BuildPipelineActivation[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(nodeStorageKey(WINDOW_BUILD_PIPELINE_ACTIVATION_KEY, storageNode));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map(parseBuildPipelineActivation)
      .filter((entry): entry is BuildPipelineActivation => entry !== null);
  } catch {
    return [];
  }
}

function writeBuildPipelineActivations(
  entries: BuildPipelineActivation[],
  storageNode: StorageNode,
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      nodeStorageKey(WINDOW_BUILD_PIPELINE_ACTIVATION_KEY, storageNode),
      JSON.stringify({ version: 1, entries: entries.slice(-MAX_ENVIRONMENTS) }),
    );
  } catch {
    // Best-effort window presentation state. The pipeline keeps running even
    // when this client cannot remember to focus its tab after setup.
  }
}

/** Oldest resolved pipeline ids are evicted first once an environment exceeds this. */
const MAX_RESOLVED_PIPELINES_PER_ENVIRONMENT = 32;

interface BuildPipelineHandoffResolution {
  environmentId: string;
  pipelineIds: string[];
}

function parseBuildPipelineHandoffResolution(
  value: unknown,
): BuildPipelineHandoffResolution | null {
  if (!isRecord(value)) return null;
  const { environmentId } = value;
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  const pipelineIds: string[] = [];
  if (Array.isArray(value.pipelineIds)) {
    for (const pipelineId of value.pipelineIds) {
      if (typeof pipelineId === "string" && pipelineId.length > 0) {
        pipelineIds.push(pipelineId);
      }
    }
  }
  if (pipelineIds.length === 0) return null;
  return { environmentId, pipelineIds };
}

function mergeBuildPipelineHandoffResolutions(
  entries: BuildPipelineHandoffResolution[],
): BuildPipelineHandoffResolution[] {
  const pipelineIdsByEnvironment = new Map<string, string[]>();
  for (const entry of entries) {
    const existing = pipelineIdsByEnvironment.get(entry.environmentId) ?? [];
    for (const pipelineId of entry.pipelineIds) {
      if (!existing.includes(pipelineId)) existing.push(pipelineId);
    }
    pipelineIdsByEnvironment.set(
      entry.environmentId,
      existing.slice(-MAX_RESOLVED_PIPELINES_PER_ENVIRONMENT),
    );
  }
  return [...pipelineIdsByEnvironment.entries()].map(([environmentId, pipelineIds]) => ({
    environmentId,
    pipelineIds,
  }));
}

function readBuildPipelineHandoffResolutions(
  storageNode: StorageNode,
): BuildPipelineHandoffResolution[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(nodeStorageKey(WINDOW_BUILD_PIPELINE_HANDOFF_KEY, storageNode));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return [];
    return mergeBuildPipelineHandoffResolutions(
      parsed.entries
        .map(parseBuildPipelineHandoffResolution)
        .filter((entry): entry is BuildPipelineHandoffResolution => entry !== null),
    );
  } catch {
    return [];
  }
}

function writeBuildPipelineHandoffResolutions(
  entries: BuildPipelineHandoffResolution[],
  storageNode: StorageNode,
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(
      nodeStorageKey(WINDOW_BUILD_PIPELINE_HANDOFF_KEY, storageNode),
      JSON.stringify({ version: 1, entries: entries.slice(-MAX_ENVIRONMENTS) }),
    );
  } catch {
    // Best-effort window presentation state. Losing it costs at most one
    // repeated focus change after setup, never the pipeline itself.
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

export function readStoredPaneSelection(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): StoredPaneSelection | null {
  if (storageNode.role !== "command") return null;
  const entry = readEntries().find((candidate) => candidate.environmentId === environmentId);
  if (!entry) return null;
  return { activePaneId: entry.activePaneId, activeTabIds: entry.activeTabIds };
}

export function clearStoredPaneSelection(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  if (storageNode.role !== "command") return;
  const entries = readEntries();
  const remaining = entries.filter((candidate) => candidate.environmentId !== environmentId);
  if (remaining.length === entries.length) return;
  writeEntries(remaining);
}

export function readWindowPaneSelection(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): StoredPaneSelection | null {
  const entry = readEntries(nodeStorageKey(WINDOW_STORAGE_KEY, storageNode)).find(
    (candidate) => candidate.environmentId === environmentId,
  );
  return entry ? { activePaneId: entry.activePaneId, activeTabIds: entry.activeTabIds } : null;
}

export function writeWindowPaneSelection(
  environmentId: string,
  state: EnvironmentPaneState,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  const activeTabIds: Record<string, string> = {};
  forEachLeaf(state.root, (leaf) => {
    if (leaf.kind === "leaf" && leaf.activeTabId) activeTabIds[leaf.id] = leaf.activeTabId;
  });
  const storageKey = nodeStorageKey(WINDOW_STORAGE_KEY, storageNode);
  const entries = readEntries(storageKey).filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  entries.push({ environmentId, activePaneId: state.activePaneId, activeTabIds });
  writeEntries(entries, storageKey);
}

/**
 * Remember that this Electron window initiated an environment whose startup
 * agent should take over from setup once setup is complete.
 *
 * This is connection-scoped and persisted because setup continues while the
 * environment is inactive and can outlive a renderer reload. Browser clients
 * adopt the backend's shared selection and never arm this intent.
 */
export function armWindowStartupAgentActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  if (!environmentId) return;
  const environmentIds = readStartupAgentActivations(storageNode).filter(
    (candidate) => candidate !== environmentId,
  );
  environmentIds.push(environmentId);
  writeStartupAgentActivations(environmentIds, storageNode);
}

/** Check a one-shot activation without retiring it before a layout is installed. */
export function hasWindowStartupAgentActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): boolean {
  return readStartupAgentActivations(storageNode).includes(environmentId);
}

/** Consume the one-shot activation once the provider-bound tab is observable. */
export function consumeWindowStartupAgentActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): boolean {
  const environmentIds = readStartupAgentActivations(storageNode);
  if (!environmentIds.includes(environmentId)) return false;
  writeStartupAgentActivations(
    environmentIds.filter((candidate) => candidate !== environmentId),
    storageNode,
  );
  return true;
}

/** Drop an activation whose environment failed to start or was deleted. */
export function clearWindowStartupAgentActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  const environmentIds = readStartupAgentActivations(storageNode);
  if (!environmentIds.includes(environmentId)) return;
  writeStartupAgentActivations(
    environmentIds.filter((candidate) => candidate !== environmentId),
    storageNode,
  );
}

/** Remember the pipeline tab that should replace setup in the launching window. */
export function armWindowBuildPipelineActivation(
  environmentId: string,
  pipelineId: string,
  setupReadyAtArm = false,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  if (!environmentId || !pipelineId) return;
  const entries = readBuildPipelineActivations(storageNode).filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  entries.push({ environmentId, pipelineId, setupReadyAtArm });
  writeBuildPipelineActivations(entries, storageNode);
}

/** Read the one pending pipeline handoff for an environment without retiring it. */
export function getWindowBuildPipelineActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): string | null {
  return (
    readBuildPipelineActivations(storageNode).find(
      (candidate) => candidate.environmentId === environmentId,
    )?.pipelineId ?? null
  );
}

/**
 * True when this window armed after setup had already finished, so there is no
 * long setup whose user-chosen tab we must protect. A rebuild into an existing
 * environment is this case: the user just clicked Start Build.
 */
export function wasWindowBuildPipelineSetupReadyAtArm(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): boolean {
  return (
    readBuildPipelineActivations(storageNode).find(
      (candidate) => candidate.environmentId === environmentId,
    )?.setupReadyAtArm === true
  );
}

/** Consume a handoff only after the requested pipeline tab is installed and selected. */
export function consumeWindowBuildPipelineActivation(
  environmentId: string,
  pipelineId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): boolean {
  const entries = readBuildPipelineActivations(storageNode);
  if (
    !entries.some(
      (candidate) =>
        candidate.environmentId === environmentId && candidate.pipelineId === pipelineId,
    )
  ) {
    return false;
  }
  writeBuildPipelineActivations(
    entries.filter((candidate) => candidate.environmentId !== environmentId),
    storageNode,
  );
  return true;
}

/** Drop a pipeline handoff when its environment is deleted. */
export function clearWindowBuildPipelineActivation(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  const entries = readBuildPipelineActivations(storageNode);
  const remaining = entries.filter((candidate) => candidate.environmentId !== environmentId);
  if (remaining.length === entries.length) return;
  writeBuildPipelineActivations(remaining, storageNode);
}

/**
 * Record that this window already resolved a backend-published build tab.
 *
 * A window that never armed a one-shot — the pipeline was started by an agent,
 * a coordinator, another window or the web client — otherwise has no way to
 * distinguish "the backend just handed selection to this pipeline" from "the
 * user deliberately chose the setup terminal again". Remembering a bounded
 * list of resolved pipeline ids lets each pipeline's follow fire exactly once,
 * while a later pipeline into the same environment still takes focus.
 */
export function markWindowBuildPipelineHandoffResolved(
  environmentId: string,
  pipelineId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  if (!environmentId || !pipelineId) return;
  const entries = readBuildPipelineHandoffResolutions(storageNode);
  const existing = entries.find((candidate) => candidate.environmentId === environmentId);
  const others = entries.filter((candidate) => candidate.environmentId !== environmentId);
  const pipelineIds = existing
    ? existing.pipelineIds.filter((candidate) => candidate !== pipelineId)
    : [];
  pipelineIds.push(pipelineId);
  others.push({
    environmentId,
    pipelineIds: pipelineIds.slice(-MAX_RESOLVED_PIPELINES_PER_ENVIRONMENT),
  });
  writeBuildPipelineHandoffResolutions(others, storageNode);
}

/** Whether this window already resolved the backend handoff for this pipeline. */
export function hasWindowBuildPipelineHandoffResolved(
  environmentId: string,
  pipelineId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): boolean {
  return readBuildPipelineHandoffResolutions(storageNode).some(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.pipelineIds.includes(pipelineId),
  );
}

/** Drop remembered handoff resolutions when their environment is deleted. */
export function clearWindowBuildPipelineHandoffResolutions(
  environmentId: string,
  storageNode: StorageNode = COMMAND_STORAGE_NODE,
): void {
  const entries = readBuildPipelineHandoffResolutions(storageNode);
  const remaining = entries.filter((candidate) => candidate.environmentId !== environmentId);
  if (remaining.length === entries.length) return;
  writeBuildPipelineHandoffResolutions(remaining, storageNode);
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
