import {
  MAX_TABS_PER_ENVIRONMENT,
  PANE_LAYOUT_VERSION,
  isPaneLayoutRevisionConflict,
} from "@orkestrator/protocol/pane-layout";
import type { PaneLayoutMergeInput } from "@orkestrator/protocol/pane-layout-merge";
import type { CoordinatorTabEditOperation } from "@orkestrator/protocol/coordinator-surfaces";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import { isRecord } from "./storage-shared-core.js";
import {
  assertPaneLayoutRootWithinBounds,
  paneLayoutLeaves,
  type MutablePaneLayoutLeaf,
} from "./storage-shared-pane-layout.js";

/**
 * Backend edits to a worker's pane layout on a coordinator's behalf: open or
 * navigate a browser tab, open a looped-review tab, and focus, close or move
 * any tab. The authoritative layout is edited directly, as
 * `openMultiReviewTab` does, so the edit lands whether or not the worker is
 * on screen; a renderer that has it loaded follows the `pane-layout`
 * announcement. Each write is a compare-and-set that recomputes the edit on
 * the latest tree after a conflict, so a concurrent renderer save is merged
 * rather than overwritten.
 */

export interface WorkerTabUi {
  status: "opened";
  tabId: string;
  paneId: string;
  layoutRevision: number;
}

type Tab = Record<string, unknown>;

/** The worker must be running and set up before a tab can open in it. */
function assertWorkerReady(environment: Environment): void {
  if (
    environment.status !== "running" ||
    !(
      environment.setupPhase === "ready" ||
      environment.setupScriptsComplete === true ||
      environment.setupOverride === true
    )
  ) {
    throw new Error("Start the worker environment and let setup finish first");
  }
}

async function editLayout<T>(
  storage: StorageService,
  environmentId: string,
  options: { requireReady: boolean },
  edit: (
    desired: PaneLayoutMergeInput,
    panes: MutablePaneLayoutLeaf[],
    environment: Environment,
  ) => { result: T; changed: boolean } | Promise<{ result: T; changed: boolean }>,
): Promise<{ result: T; layoutRevision: number }> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const environment = await storage.getEnvironment(environmentId);
    if (
      !environment ||
      environment.deletionRequestedAt ||
      environment.lifecycleOperation === "deleting"
    )
      throw new Error("The worker environment is unavailable");
    if (options.requireReady) assertWorkerReady(environment);
    const containerId = environment.environmentType === "local" ? null : environment.containerId;
    if (environment.environmentType !== "local" && !containerId)
      throw new Error("The worker container is unavailable");
    const previous = await storage.getPaneLayout(environment.id);
    if (previous && previous.version !== PANE_LAYOUT_VERSION)
      throw new Error("Reopen the environment to migrate its saved pane layout first");
    if (previous && previous.containerId !== containerId)
      throw new Error(
        "The pane layout belongs to an earlier container; reopen the environment first",
      );
    const desired: PaneLayoutMergeInput = previous
      ? (structuredClone(previous) as PaneLayoutMergeInput)
      : {
          version: PANE_LAYOUT_VERSION,
          containerId: containerId ?? null,
          activePaneId: "default",
          root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        };
    assertPaneLayoutRootWithinBounds(desired.root);
    const panes = paneLayoutLeaves(desired.root);
    if (panes.length === 0) throw new Error("The saved layout has no pane");
    const { result, changed } = await edit(desired, panes, environment);
    if (!changed) return { result, layoutRevision: previous?.revision ?? 0 };
    desired.version = PANE_LAYOUT_VERSION;
    assertPaneLayoutRootWithinBounds(desired.root);
    try {
      const saved = await storage.savePaneLayout(environment.id, desired, previous?.revision ?? 0);
      return { result, layoutRevision: saved.revision };
    } catch (error) {
      if (!isPaneLayoutRevisionConflict(error)) throw error;
    }
  }
  throw new Error("The layout kept changing; retry this same action request");
}

function findTab(panes: MutablePaneLayoutLeaf[], match: (tab: Tab) => boolean) {
  for (const pane of panes) {
    const tab = pane.tabs.find(match);
    if (tab) return { pane, tab };
  }
  return null;
}

function tabCount(panes: MutablePaneLayoutLeaf[]): number {
  return panes.reduce((sum, pane) => sum + pane.tabs.length, 0);
}

function select(
  desired: PaneLayoutMergeInput,
  pane: MutablePaneLayoutLeaf,
  tabId: string,
): boolean {
  const changed = pane.activeTabId !== tabId || desired.activePaneId !== pane.id;
  pane.activeTabId = tabId;
  desired.activePaneId = pane.id;
  return changed;
}

/** Create a tab in the active pane, or focus the one `match` finds. */
async function openTab(
  storage: StorageService,
  environmentId: string,
  match: (tab: Tab) => boolean,
  create: (environment: Environment) => Tab,
  update?: (tab: Tab) => boolean,
): Promise<WorkerTabUi> {
  const { result, layoutRevision } = await editLayout(
    storage,
    environmentId,
    { requireReady: true },
    (desired, panes, environment) => {
      const existing = findTab(panes, match);
      if (existing) {
        const updated = update?.(existing.tab) ?? false;
        const selected = select(desired, existing.pane, existing.tab.id as string);
        return {
          result: { tabId: existing.tab.id as string, paneId: existing.pane.id },
          changed: updated || selected,
        };
      }
      if (tabCount(panes) >= MAX_TABS_PER_ENVIRONMENT)
        throw new Error(
          `Close a tab in the worker first (maximum ${MAX_TABS_PER_ENVIRONMENT} tabs)`,
        );
      const tab = create(environment);
      if (findTab(panes, (candidate) => candidate.id === tab.id))
        throw new Error("The reserved tab ID is already in use");
      const pane = panes.find((candidate) => candidate.id === desired.activePaneId) ?? panes[0]!;
      pane.tabs.push(tab);
      select(desired, pane, tab.id as string);
      return { result: { tabId: tab.id as string, paneId: pane.id }, changed: true };
    },
  );
  return { status: "opened", ...result, layoutRevision };
}

/**
 * Open a browser tab at `url`, or navigate the existing browser tab `tabId`
 * there. `navigationRequestId` names this write, so a renderer's concurrent
 * navigation and this one merge as two distinct writes.
 */
export function openWorkerBrowserTab(
  storage: StorageService,
  input: {
    environmentId: string;
    /** Navigate this existing browser tab instead of opening a new one. */
    tabId?: string;
    /** The ID a new tab gets; stable per request so a retry finds it. */
    newTabId: string;
    url: string;
    navigationRequestId: string;
    title?: string;
  },
): Promise<WorkerTabUi> {
  const targetId = input.tabId ?? input.newTabId;
  return openTab(
    storage,
    input.environmentId,
    (tab) => {
      if (tab.id !== targetId) return false;
      if (tab.type !== "browser") throw new Error("That tab is not a browser tab");
      return true;
    },
    () => {
      if (input.tabId) throw new Error(`Tab not found: ${input.tabId}`);
      return {
        id: input.newTabId,
        type: "browser",
        displayTitle: input.title ?? "Browser",
        browserData: {
          url: input.url,
          navigationRequestId: input.navigationRequestId,
          history: [input.url],
          historyIndex: 0,
        },
      };
    },
    (tab) => {
      const data = isRecord(tab.browserData) ? tab.browserData : {};
      if (data.navigationRequestId === input.navigationRequestId) return false;
      tab.browserData = {
        ...data,
        url: input.url,
        navigationRequestId: input.navigationRequestId,
        history: [input.url],
        historyIndex: 0,
      };
      return true;
    },
  );
}

/** Open or focus a looped review's tab, as the Looped review button does. */
export function openLoopedReviewTab(
  storage: StorageService,
  input: { environmentId: string; workflowId: string },
): Promise<WorkerTabUi> {
  return openTab(
    storage,
    input.environmentId,
    (tab) =>
      tab.type === "looped-review" &&
      isRecord(tab.loopedReviewTabData) &&
      tab.loopedReviewTabData.workflowId === input.workflowId,
    (environment) => ({
      id: `looped-review:${input.workflowId}`,
      type: "looped-review",
      displayTitle: "Looped Review",
      loopedReviewTabData: {
        environmentId: environment.id,
        workflowId: input.workflowId,
        isLocal: environment.environmentType === "local",
      },
    }),
  );
}

export interface WorkerTabEditResult {
  operation: CoordinatorTabEditOperation;
  tabId: string;
  /** Where the tab is now; absent once it is closed. */
  paneId?: string;
  /** The closed tab as it was, so its resources can be torn down. */
  closed?: Tab;
  /** False when the layout already matched the request. */
  changed: boolean;
  layoutRevision: number;
}

/**
 * Focus, close or move one tab. Closing a tab that is already gone and
 * moving a tab to the pane it is in succeed without a write, so a retry
 * after an ambiguous answer is harmless.
 */
export async function editWorkerTab(
  storage: StorageService,
  input: {
    environmentId: string;
    tabId: string;
    operation: CoordinatorTabEditOperation;
    toPaneId?: string;
    /** Refuses the close (throws) after reading the tab, before any write. */
    beforeClose?: (tab: Tab) => void | Promise<void>;
  },
): Promise<WorkerTabEditResult> {
  const { result, layoutRevision } = await editLayout<Omit<WorkerTabEditResult, "layoutRevision">>(
    storage,
    input.environmentId,
    { requireReady: false },
    async (desired, panes) => {
      const found = findTab(panes, (tab) => tab.id === input.tabId);
      if (!found) {
        if (input.operation === "close")
          return {
            result: { operation: input.operation, tabId: input.tabId, changed: false },
            changed: false,
          };
        throw new Error(`Tab not found: ${input.tabId}`);
      }
      const { pane, tab } = found;
      if (input.operation === "focus") {
        const changed = select(desired, pane, input.tabId);
        return {
          result: { operation: input.operation, tabId: input.tabId, paneId: pane.id, changed },
          changed,
        };
      }
      if (input.operation === "close") {
        await input.beforeClose?.(tab);
        pane.tabs = pane.tabs.filter((candidate) => candidate !== tab);
        if (pane.activeTabId === input.tabId) {
          const fallback = pane.tabs.at(-1)?.id;
          pane.activeTabId = typeof fallback === "string" ? fallback : null;
        }
        return {
          result: {
            operation: input.operation,
            tabId: input.tabId,
            closed: structuredClone(tab),
            changed: true,
          },
          changed: true,
        };
      }
      const destination = panes.find((candidate) => candidate.id === input.toPaneId);
      if (!destination) throw new Error(`Pane not found: ${input.toPaneId ?? "(none)"}`);
      if (destination === pane) {
        const changed = select(desired, pane, input.tabId);
        return {
          result: { operation: input.operation, tabId: input.tabId, paneId: pane.id, changed },
          changed,
        };
      }
      pane.tabs = pane.tabs.filter((candidate) => candidate !== tab);
      if (pane.activeTabId === input.tabId) {
        const fallback = pane.tabs.at(-1)?.id;
        pane.activeTabId = typeof fallback === "string" ? fallback : null;
      }
      destination.tabs.push(tab);
      select(desired, destination, input.tabId);
      return {
        result: {
          operation: input.operation,
          tabId: input.tabId,
          paneId: destination.id,
          changed: true,
        },
        changed: true,
      };
    },
  );
  return { ...result, layoutRevision };
}
