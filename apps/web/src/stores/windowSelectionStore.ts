/**
 * The window's one node-qualified selection (report §5.1, plan item 3006):
 * `{ nodeId, projectId, environmentId }`, held by the `WindowScope`
 * (`windowScope.selection`), so a window scope in a test has its own and the
 * command scope's proven id (plan item 2011) carries it along.
 *
 * Its node is the node the window shows: the command node's own workspace,
 * or another node's, shown in the window's tree on its scope. Each node scope's `uiStore` projects it: `selectedProjectId` there
 * is the selection's project while it is on that node and null otherwise,
 * and selecting in a node's `uiStore` moves the selection to that node.
 * `remoteWorkspaceStore`'s `active` is derived from it.
 *
 * The selection survives a reload of the window (session storage, the
 * command node's selection only: another node's selection is that node's
 * own, kept in its scope's `uiStore`).
 */

import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
} from "@orkestrator/protocol/federation";
import { COMMAND_STORAGE_NODE, desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import { defineScopedService } from "@/lib/node-scope/scoped-service";
import { windowScopeOf, type NodeSelection, type WindowScope } from "@/lib/node-scope/window-scope";
import { useMachineViewStore } from "./machineViewStore";

export type { NodeSelection } from "@/lib/node-scope/window-scope";

/** The open scope of `selection`'s node in `windowScope`, or `null` (nothing selected, or a node not open yet). */
export function selectionScope(
  windowScope: WindowScope,
  selection: NodeSelection | null = windowScope.selection.get(),
): NodeScope | null {
  return selection ? windowScope.get(selection.nodeId) : null;
}

/** Whether `selection` is on `windowScope`'s command node (`null`: nothing selected, which is the command node's). */
export function isCommandNodeSelection(
  windowScope: WindowScope,
  selection: NodeSelection | null,
): boolean {
  return selection === null || selectionScope(windowScope, selection)?.role === "command";
}

/**
 * The selection when it is on `scope`'s node, else `null`. The node test
 * goes through the window's registry, so a selection captured under the
 * command scope's provisional id still matches after the id is proven.
 */
export function selectionOnScope(
  scope: NodeScope,
  selection: NodeSelection | null = windowScopeOf(scope)?.selection.get() ?? null,
): NodeSelection | null {
  if (!selection) return null;
  const windowScope = windowScopeOf(scope);
  const owner = windowScope ? windowScope.get(selection.nodeId) : null;
  return owner === scope || (!windowScope && selection.nodeId === scope.nodeId) ? selection : null;
}

/** The nearest window scope's selection, re-rendering when it changes. */
export function useWindowSelection(): NodeSelection | null {
  const { windowScope } = useScopesWithCommandFallback();
  return useSignal(windowScope.selection);
}

/**
 * Recents and highlights for a selection the window made on another node:
 * records the environment and project as recently used by node-qualified
 * key, ends the search's highlight of another project, and ends a repository
 * heading's highlight unless the selection continues it (that project's
 * home).
 */
export function noteNodeSelectionRecents(selection: NodeSelection): void {
  const views = useMachineViewStore.getState();
  const backendId = selection.nodeId;
  const selectedProjectKey = selection.projectId
    ? projectKey(projectRef(backendId, selection.projectId))
    : null;
  views.recordRecent([
    ...(selection.environmentId
      ? [environmentKey(environmentRef(backendId, selection.environmentId))]
      : []),
    ...(selectedProjectKey ? [selectedProjectKey] : []),
  ]);
  if (selection.environmentId || views.revealedProject?.key !== selectedProjectKey) {
    views.revealProject(null);
  }
  if (!selection.projectHome || views.openedRepository?.projectKey !== selectedProjectKey) {
    views.noteRepositoryOpened(null);
  }
}

const SELECTION_STORAGE_KEY = "orkestrator.window-selection.v1";
/** Ids are bounded: a record over this is corrupt and ignored. */
const MAX_STORED_ID_LENGTH = 256;

interface StoredWindowSelection {
  version: 1;
  projectId: string | null;
  environmentId: string | null;
}

function storedId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STORED_ID_LENGTH
    ? value
    : undefined;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.sessionStorage ?? null);
  } catch {
    return null;
  }
}

/** The key this window keeps its command node's selection under. */
function selectionStorageKey(): string {
  return desktopConnectionStorageKey(SELECTION_STORAGE_KEY, COMMAND_STORAGE_NODE);
}

/** The command node's selection the window kept before a reload, if any. */
export function readStoredWindowSelection(
  storage: Storage | null = sessionStore(),
): Pick<NodeSelection, "projectId" | "environmentId"> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(selectionStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWindowSelection> | null;
    if (!parsed || parsed.version !== 1) return null;
    const projectId = storedId(parsed.projectId);
    const environmentId = storedId(parsed.environmentId);
    if (projectId === undefined || environmentId === undefined) return null;
    if (projectId === null && environmentId === null) return null;
    return { projectId, environmentId };
  } catch {
    return null;
  }
}

function writeStoredWindowSelection(
  windowScope: WindowScope,
  selection: NodeSelection | null,
  storage: Storage | null,
): void {
  if (!storage) return;
  try {
    const onCommandNode =
      selection !== null && selectionScope(windowScope, selection)?.role === "command";
    if (!onCommandNode || (selection.projectId === null && selection.environmentId === null)) {
      storage.removeItem(selectionStorageKey());
      return;
    }
    const record: StoredWindowSelection = {
      version: 1,
      projectId: selection.projectId,
      environmentId: selection.environmentId,
    };
    storage.setItem(selectionStorageKey(), JSON.stringify(record));
  } catch {
    // Best-effort: a full or denied session storage costs the reload its
    // selection and nothing else.
  }
}

/**
 * Restores the command node's selection kept before a reload, unless the
 * window already selected something, then keeps the stored copy current.
 * Returns the stop.
 */
export function bindWindowSelectionPersistence(
  windowScope: WindowScope,
  options: { restore: boolean; storage?: Storage | null } = { restore: true },
): () => void {
  const storage = options.storage === undefined ? sessionStore() : options.storage;
  if (options.restore && windowScope.selection.get() === null) {
    const stored = readStoredWindowSelection(storage);
    if (stored) {
      windowScope.select({ nodeId: windowScope.commandScope().nodeId, ...stored });
    }
  }
  return windowScope.selection.subscribe((selection) =>
    writeStoredWindowSelection(windowScope, selection, storage),
  );
}

/** A reload is a new document: only the first window scope of a page restores. */
let restoredThisDocument = false;

/**
 * Keeps the window's selection across a reload. Window-level: it runs on the
 * command scope only, which lives exactly as long as the window.
 */
export const windowSelectionPersistenceService = defineScopedService(
  "window-selection-persistence",
  (scope) => {
    const windowScope = windowScopeOf(scope);
    if (scope.role !== "command" || !windowScope) {
      throw new Error("The window selection is window-level; it is kept by the command scope.");
    }
    const restore = !restoredThisDocument;
    restoredThisDocument = true;
    return { stop: bindWindowSelectionPersistence(windowScope, { restore }) };
  },
);
