import {
  hydrateBuildPipeline,
  isBuildPipelineKnownUnavailable,
} from "@/lib/build-pipeline-persistence";
import {
  hydrateMultiReviewWorkflow,
  isMultiReviewWorkflowKnownUnavailable,
} from "@/lib/multi-review-persistence";
import {
  preserveClientPaneSelection,
  preserveRendererLocalPaneFields,
  reconcilePersistedLayout,
} from "@/lib/pane-layout-restore";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { environmentStore } from "@/stores/environmentStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { paneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import {
  getNativeAgentData,
  LEGACY_PANE_LAYOUT_VERSION,
  type PaneLeaf,
  type PaneNode,
  type PersistedPaneLayout,
} from "@/types/paneLayout";
import {
  applyStoredPaneSelection,
  armWindowBuildPipelineActivation,
  armWindowStartupAgentActivation,
  clearWindowBuildPipelineActivation,
  clearWindowBuildPipelineHandoffResolutions,
  clearWindowStartupAgentActivation,
  consumeWindowBuildPipelineActivation,
  consumeWindowStartupAgentActivation,
  getWindowBuildPipelineActivation,
  hasWindowBuildPipelineHandoffResolved,
  hasWindowStartupAgentActivation,
  markWindowBuildPipelineHandoffResolved,
  readWindowPaneSelection,
  wasWindowBuildPipelineSetupReadyAtArm,
} from "@/lib/pane-selection-storage";
import {
  environmentIsReadyForSetupHandoff,
  paneSelectionIsSetupHandoffSource,
  STARTUP_AGENT_TAB_ID,
} from "@/lib/startup-agent-handoff";

/**
 * The one way a backend-owned pane snapshot becomes renderer state.
 *
 * Both writers of authoritative layouts — the change-feed refresh and the
 * install that follows a rebased save — go through here. `reconcilePersistedLayout`
 * is what drops a tab whose build pipeline or Multi Review this client cannot
 * back, so a path that skips it can graft another client's tab into the tree
 * with nothing behind it.
 */

/**
 * Depth bound is one more than `MAX_SPLIT_DEPTH`, so it never truncates a tree
 * the restore path would accept; it only stops a hostile or corrupt record from
 * driving unbounded recursion.
 */
const MAX_DEPENDENCY_SCAN_DEPTH = 10;
const MAX_PENDING_TAB_ACTIVATIONS = 64;

/**
 * One node's activation bookkeeping (plan item 3013). Environment and tab ids
 * are only unique on their node, so each node scope keeps its own; every
 * export below takes an optional trailing scope, the app's command scope when
 * omitted.
 */
interface PaneActivationSlot {
  // Backend-owned jobs publish their tabs through pane-layout reconciliation,
  // and the backend never moves selection for a launch a user started: that
  // the tab was launched here is the one thing this renderer knows and the
  // backend does not. Keep only the latest request per environment, so a later
  // foreground action supersedes an earlier one.
  readonly pendingTabActivations: Map<string, string>;
  readonly completionNotesHandoffs: Map<string, string>;
  readonly startupAgentActivationCommits: WeakMap<EnvironmentPaneState, string>;
  readonly buildPipelineActivationCommits: WeakMap<
    EnvironmentPaneState,
    { environmentId: string; pipelineId: string }
  >;
}

const paneActivations = defineScopedSlot<PaneActivationSlot>("pane-layout-activations", () => ({
  pendingTabActivations: new Map(),
  completionNotesHandoffs: new Map(),
  startupAgentActivationCommits: new WeakMap(),
  buildPipelineActivationCommits: new WeakMap(),
}));

/** Window-local acknowledgement shared by the live observer and layout arrival. */
export function markCompletionNotesHandled(
  environmentId: string,
  pipelineId: string,
  scope: NodeScope,
): void {
  const handled = paneActivations(scope).completionNotesHandoffs;
  handled.delete(pipelineId);
  handled.set(pipelineId, environmentId);
  boundActivationMap(handled);
}

export function clearCompletionNotesHandled(pipelineId: string, scope: NodeScope): void {
  paneActivations(scope).completionNotesHandoffs.delete(pipelineId);
}

export function hasCompletionNotesHandled(
  environmentId: string,
  pipelineId: string,
  scope: NodeScope,
): boolean {
  return paneActivations(scope).completionNotesHandoffs.get(pipelineId) === environmentId;
}

function environmentById(scope: NodeScope, environmentId: string) {
  return scope.store(environmentStore).getState().getEnvironmentById(environmentId);
}

function boundActivationMap<T>(map: Map<string, T>): void {
  while (map.size > MAX_PENDING_TAB_ACTIVATIONS) {
    const oldestEnvironmentId = map.keys().next().value;
    if (typeof oldestEnvironmentId !== "string") break;
    map.delete(oldestEnvironmentId);
  }
}

function activateTabInState(
  state: EnvironmentPaneState,
  tabId: string,
): EnvironmentPaneState | null {
  const visit = (node: EnvironmentPaneState["root"]): string | null => {
    if (node.kind === "leaf") {
      return node.tabs.some((tab) => tab.id === tabId) ? node.id : null;
    }
    return visit(node.children[0]) ?? visit(node.children[1]);
  };
  const paneId = visit(state.root);
  if (!paneId) return null;

  const select = (node: EnvironmentPaneState["root"]): EnvironmentPaneState["root"] => {
    if (node.kind === "leaf") {
      return node.id === paneId ? { ...node, activeTabId: tabId } : node;
    }
    return {
      ...node,
      children: [select(node.children[0]), select(node.children[1])],
    };
  };
  return { ...state, root: select(state.root), activePaneId: paneId };
}

function findLeaf(root: PaneNode, predicate: (leaf: PaneLeaf) => boolean): PaneLeaf | null {
  if (root.kind === "leaf") return predicate(root) ? root : null;
  return findLeaf(root.children[0], predicate) ?? findLeaf(root.children[1], predicate);
}

/**
 * The backend selects a setup terminal it has just published only when the user
 * has no tab of their own open, so a window follows that selection when it sees
 * the tab for the first time.
 */
function applySetupTabArrival(
  authoritative: EnvironmentPaneState,
  selected: EnvironmentPaneState,
  current: EnvironmentPaneState,
): EnvironmentPaneState {
  const leaf = findLeaf(authoritative.root, (candidate) =>
    candidate.tabs.some((tab) => tab.isSetupTab === true && tab.id === candidate.activeTabId),
  );
  if (!leaf?.activeTabId) return selected;
  const tabId = leaf.activeTabId;
  if (findLeaf(current.root, (candidate) => candidate.tabs.some((tab) => tab.id === tabId))) {
    return selected;
  }
  return activateTabInState(selected, tabId) ?? selected;
}

/**
 * A finished build pipeline's notes tab, which the backend publishes and selects
 * when the run completes (`ensureBuildPipelineNotesTab`), takes focus in a
 * window the first time that window sees that completion publication. Manual
 * Notes openings have no completion marker and preserve isolated selection.
 * Arrival happens once per window,
 * so a user who then returns to another tab is not pulled back.
 */
function applyCompletionNotesArrival(
  authoritative: EnvironmentPaneState,
  selected: EnvironmentPaneState,
  current: EnvironmentPaneState,
  scope: NodeScope,
): EnvironmentPaneState {
  const leaf = findLeaf(
    authoritative.root,
    (candidate) => candidate.id === authoritative.activePaneId,
  );
  const tab = leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
  if (
    tab?.type !== "key-information" ||
    tab.keyInformationTabData?.view !== "notes" ||
    tab.keyInformationTabData.completionPublished !== true
  ) {
    return selected;
  }
  const data = tab.keyInformationTabData;
  if (hasCompletionNotesHandled(data.environmentId, data.pipelineId, scope)) {
    return selected;
  }
  if (
    findLeaf(current.root, (candidate) =>
      candidate.tabs.some(
        (previous) =>
          previous.id === tab.id && previous.keyInformationTabData?.completionPublished === true,
      ),
    )
  ) {
    return selected;
  }
  return activateTabInState(selected, tab.id) ?? selected;
}

/**
 * Let the post-setup layout revision perform the one setup-to-agent focus
 * handoff requested by this Electron window.
 *
 * Native tabs arrive after setup and can hand off on that arrival. For a tab
 * already present, a provider session or setup-ready environment establishes
 * readiness, and this window must still hold its one-shot activation request.
 * Installing the decision retires that request, including when the user has
 * chosen another tab.
 */
function applyStartupAgentSetupHandoff(
  scope: NodeScope,
  environmentId: string,
  authoritative: EnvironmentPaneState,
  selected: EnvironmentPaneState,
  current: EnvironmentPaneState,
): { state: EnvironmentPaneState; retireActivationAfterInstall: boolean } {
  const authoritativeLeaf = findLeaf(authoritative.root, (leaf) =>
    leaf.tabs.some((tab) => tab.id === STARTUP_AGENT_TAB_ID),
  );
  const authoritativeTab = authoritativeLeaf?.tabs.find((tab) => tab.id === STARTUP_AGENT_TAB_ID);
  const providerSessionId = authoritativeTab
    ? getNativeAgentData(authoritativeTab)?.sessionId
    : undefined;
  const setupReady = environmentIsReadyForSetupHandoff(environmentById(scope, environmentId));
  // The tab lands once setup has finished, so its arrival in this window is the
  // handoff whichever client started the launch, and it can only happen once.
  const arrived =
    Boolean(authoritativeLeaf) &&
    !findLeaf(current.root, (leaf) => leaf.tabs.some((tab) => tab.id === STARTUP_AGENT_TAB_ID));
  if (
    !arrived &&
    ((!providerSessionId && !setupReady) || !hasWindowStartupAgentActivation(environmentId, scope))
  ) {
    return { state: selected, retireActivationAfterInstall: false };
  }

  const targetLeaf = authoritativeLeaf
    ? findLeaf(selected.root, (leaf) => leaf.id === authoritativeLeaf.id)
    : null;
  const focusedLeaf = findLeaf(selected.root, (leaf) => leaf.id === selected.activePaneId);
  if (
    authoritativeLeaf?.activeTabId !== STARTUP_AGENT_TAB_ID ||
    !paneSelectionIsSetupHandoffSource(targetLeaf) ||
    (focusedLeaf !== targetLeaf && !paneSelectionIsSetupHandoffSource(focusedLeaf))
  ) {
    // Setup-readiness alone must not burn the one-shot. The renderer can see
    // setupPhase ready before the backend publishes the revision that selects
    // the startup agent. Retire only on a published handoff fact: a provider
    // session (prompted launch) or an authoritative startup-agent selection
    // (prompt-less `activateOnSetupHandoff`).
    const handoffPublished =
      Boolean(providerSessionId) || authoritativeLeaf?.activeTabId === STARTUP_AGENT_TAB_ID;
    return { state: selected, retireActivationAfterInstall: handoffPublished };
  }
  return {
    state: activateTabInState(selected, STARTUP_AGENT_TAB_ID) ?? selected,
    retireActivationAfterInstall: true,
  };
}

/** True when a leaf is still on the automatic startup-agent setup destination. */
function paneSelectionIsStartupAgentHandoffSource(leaf: PaneLeaf | null): boolean {
  return leaf?.activeTabId === STARTUP_AGENT_TAB_ID;
}

/** True when this window is still on the setup surface the pipeline should replace. */
function paneSelectionAllowsSetupHandoff(
  selected: EnvironmentPaneState,
  targetLeafId: string,
): boolean {
  const targetLeaf = findLeaf(selected.root, (leaf) => leaf.id === targetLeafId);
  const focusedLeaf = findLeaf(selected.root, (leaf) => leaf.id === selected.activePaneId);
  return (
    paneSelectionIsSetupHandoffSource(targetLeaf) &&
    (focusedLeaf === targetLeaf || paneSelectionIsSetupHandoffSource(focusedLeaf))
  );
}

/**
 * True when the pipeline tab may take focus.
 *
 * A rebuild into an already-ready environment has no long setup to protect, so
 * Start Build activates unconditionally. During a live setup, stay on the
 * setup surface — or, when this window armed the pipeline, the startup-agent
 * tab the automatic setup handoff just chose — and decline a later steal from
 * a tab the user picked. Unarmed windows following a backend-published
 * pipeline only move off the setup surface; a user-chosen startup-agent tab
 * is left alone.
 */
function paneSelectionAllowsPipelineHandoff(
  scope: NodeScope,
  selected: EnvironmentPaneState,
  targetLeafId: string,
  environmentId: string,
  fromArmedOneShot: boolean,
): boolean {
  if (wasWindowBuildPipelineSetupReadyAtArm(environmentId, scope)) return true;
  if (paneSelectionAllowsSetupHandoff(selected, targetLeafId)) return true;
  if (!fromArmedOneShot) return false;
  const targetLeaf = findLeaf(selected.root, (leaf) => leaf.id === targetLeafId);
  const focusedLeaf = findLeaf(selected.root, (leaf) => leaf.id === selected.activePaneId);
  return (
    paneSelectionIsStartupAgentHandoffSource(targetLeaf) &&
    (focusedLeaf === targetLeaf || paneSelectionIsStartupAgentHandoffSource(focusedLeaf))
  );
}

/**
 * The build pipeline whose tab the backend made authoritative in this snapshot.
 *
 * A window that did not initiate the pipeline has no renderer-local one-shot, so
 * the authoritative selection itself is the only signal it can follow. Reading
 * it from the focused pane the handoff policy also inspects keeps an open but
 * unselected build tab from stealing focus.
 */
function authoritativeActiveBuildPipelineId(state: EnvironmentPaneState): string | null {
  const activeLeaf = findLeaf(state.root, (leaf) => leaf.id === state.activePaneId);
  if (!activeLeaf) return null;
  const activeTab = activeLeaf.tabs.find((tab) => tab.id === activeLeaf.activeTabId);
  const pipelineId =
    activeTab?.type === "claude-build" ? activeTab.buildTabData?.pipelineId : undefined;
  return typeof pipelineId === "string" && pipelineId.trim().length > 0 ? pipelineId : null;
}

/**
 * The pipeline this window should still hand off to without a local one-shot.
 *
 * Only a pipeline this window has not already resolved qualifies, so a user who
 * deliberately returns to the setup terminal after the backend moved focus is
 * not yanked back on every reconcile.
 */
function unhandledBackendBuildPipelineId(
  scope: NodeScope,
  environmentId: string,
  authoritative: EnvironmentPaneState,
): string | null {
  const pipelineId = authoritativeActiveBuildPipelineId(authoritative);
  if (!pipelineId) return null;
  if (hasWindowBuildPipelineHandoffResolved(environmentId, pipelineId, scope)) return null;
  return pipelineId;
}

/** Apply this Electron window's setup-to-pipeline handoff for one pipeline. */
function applyBuildPipelineSetupHandoff(
  scope: NodeScope,
  environmentId: string,
  authoritative: EnvironmentPaneState,
  selected: EnvironmentPaneState,
  pipelineId: string | null,
  fromArmedOneShot: boolean,
): { state: EnvironmentPaneState; pipelineId: string | null } {
  if (!pipelineId || !environmentIsReadyForSetupHandoff(environmentById(scope, environmentId))) {
    return { state: selected, pipelineId: null };
  }

  const authoritativeLeaf = findLeaf(authoritative.root, (leaf) =>
    leaf.tabs.some(
      (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
    ),
  );
  const targetTab = authoritativeLeaf?.tabs.find(
    (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
  );
  if (!targetTab || authoritativeLeaf?.activeTabId !== targetTab.id) {
    return { state: selected, pipelineId: null };
  }

  // A published backend selection must not yank focus from a tab or pane the
  // user chose during a long setup. Retire the one-shot in that declined case
  // so a later reconcile cannot. Rebuilds and the automatic startup-agent
  // landing are not user choices and still activate when this window armed.
  if (
    !paneSelectionAllowsPipelineHandoff(
      scope,
      selected,
      authoritativeLeaf.id,
      environmentId,
      fromArmedOneShot,
    )
  ) {
    return { state: selected, pipelineId };
  }

  const activated = activateTabInState(selected, targetTab.id);
  return activated ? { state: activated, pipelineId } : { state: selected, pipelineId: null };
}

/** Consume the armed one-shot and remember that this window resolved the pipeline. */
function retireBuildPipelineHandoff(
  scope: NodeScope,
  environmentId: string,
  pipelineId: string,
): void {
  consumeWindowBuildPipelineActivation(environmentId, pipelineId, scope);
  markWindowBuildPipelineHandoffResolved(environmentId, pipelineId, scope);
}

/** Arm the post-setup focus handoff in the Electron window that created the environment. */
export function armStartupAgentTabActivation(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (!window.orkestrator?.isolatedViewState) return;
  armWindowStartupAgentActivation(environmentId, scope);
}

/** Cancel a handoff whose start failed or whose environment was deleted. */
export function clearStartupAgentTabActivation(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (!window.orkestrator?.isolatedViewState) return;
  clearWindowStartupAgentActivation(environmentId, scope);
}

/** Arm the post-setup pipeline focus handoff in the Electron window that launched it. */
export function armBuildPipelineTabActivation(
  environmentId: string,
  pipelineId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (!window.orkestrator?.isolatedViewState) return;
  const setupReadyAtArm = environmentIsReadyForSetupHandoff(environmentById(scope, environmentId));
  armWindowBuildPipelineActivation(environmentId, pipelineId, setupReadyAtArm, scope);

  // The setup-complete event can win the race with the start response for a
  // no-op or very short setup. If the requested tab is already present in a
  // ready environment, finish the handoff immediately instead of waiting for
  // another authoritative frame that may never arrive. Rebuilds into an
  // already-ready environment also take this path and must activate even when
  // the window is still on a previous build or agent tab.
  if (!setupReadyAtArm) return;
  const panes = scope.store(paneLayoutStore);
  const store = panes.getState();
  const state = store.environments.get(environmentId);
  if (!state) return;
  const targetLeaf = findLeaf(state.root, (leaf) =>
    leaf.tabs.some(
      (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
    ),
  );
  const targetTab = targetLeaf?.tabs.find(
    (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
  );
  if (!targetLeaf || !targetTab) return;
  store.setActiveTab(targetLeaf.id, targetTab.id, environmentId);
  const installed = panes.getState().environments.get(environmentId);
  const installedLeaf = installed
    ? findLeaf(installed.root, (leaf) => leaf.id === targetLeaf.id)
    : null;
  // setActiveTab is a silent no-op for an unknown pane or tab. Leave the
  // one-shot armed so a later authoritative frame can still finish the handoff.
  if (installedLeaf?.activeTabId !== targetTab.id) return;
  retireBuildPipelineHandoff(scope, environmentId, pipelineId);
}

/** Cancel a pending pipeline handoff. Does not forget resolved follow records. */
export function clearBuildPipelineTabActivation(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (!window.orkestrator?.isolatedViewState) return;
  clearWindowBuildPipelineActivation(environmentId, scope);
}

/** Forget resolved pipeline follows when their environment is deleted. */
export function clearBuildPipelineHandoffResolutions(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  if (!window.orkestrator?.isolatedViewState) return;
  clearWindowBuildPipelineHandoffResolutions(environmentId, scope);
}

/**
 * Retire a setup handoff only after the reconciled state carrying its decision
 * has actually been installed. A discarded reconciliation intentionally leaves
 * the persisted intent available for the retry.
 */
export function commitStartupAgentSetupHandoff(
  environmentId: string,
  state: EnvironmentPaneState,
  scope: NodeScope = appCommandScope(),
): void {
  const { startupAgentActivationCommits } = paneActivations(scope);
  if (startupAgentActivationCommits.get(state) !== environmentId) return;
  startupAgentActivationCommits.delete(state);
  consumeWindowStartupAgentActivation(environmentId, scope);
}

/** Retire a pipeline handoff only after its activated layout is installed. */
export function commitBuildPipelineSetupHandoff(
  environmentId: string,
  state: EnvironmentPaneState,
  scope: NodeScope = appCommandScope(),
): void {
  const { buildPipelineActivationCommits } = paneActivations(scope);
  const commit = buildPipelineActivationCommits.get(state);
  if (!commit || commit.environmentId !== environmentId) return;
  buildPipelineActivationCommits.delete(state);
  // Remember the decision regardless of whether an armed one-shot drove it. The
  // armed one-shot is consumed here, so without this a later authoritative frame
  // still selecting this pipeline would re-derive it and yank a user who had
  // deliberately returned to the setup terminal.
  retireBuildPipelineHandoff(scope, commit.environmentId, commit.pipelineId);
}

/**
 * Focus a backend-created tab in the client that launched it, now if the layout
 * already holds it and otherwise when it arrives. An ordinary selection, so it
 * persists the way a click does.
 */
export function requestPaneTabActivation(
  environmentId: string,
  tabId: string,
  scope: NodeScope = appCommandScope(),
): void {
  const { pendingTabActivations } = paneActivations(scope);
  pendingTabActivations.delete(environmentId);
  const store = scope.store(paneLayoutStore).getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (pane) {
    store.setActiveTab(pane.id, tabId, environmentId);
    return;
  }
  pendingTabActivations.set(environmentId, tabId);
  boundActivationMap(pendingTabActivations);
}

/** Withdraw a tab that was still due to take focus when it arrives. */
export function cancelPaneTabActivation(
  environmentId: string,
  tabId?: string,
  scope: NodeScope = appCommandScope(),
): void {
  const { pendingTabActivations } = paneActivations(scope);
  if (tabId && pendingTabActivations.get(environmentId) !== tabId) return;
  pendingTabActivations.delete(environmentId);
}

/** Focus the requested tab if the installed layout now holds it. */
export function flushPaneTabActivation(
  environmentId: string,
  scope: NodeScope = appCommandScope(),
): void {
  const { pendingTabActivations } = paneActivations(scope);
  const tabId = pendingTabActivations.get(environmentId);
  if (!tabId) return;
  const store = scope.store(paneLayoutStore).getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (!pane) return;
  pendingTabActivations.delete(environmentId);
  store.setActiveTab(pane.id, tabId, environmentId);
}

export function collectPaneDependencyIds(root: unknown): {
  pipelineIds: Set<string>;
} {
  const pipelineIds = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPENDENCY_SCAN_DEPTH ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === "leaf" && Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
        const candidate = tab as Record<string, unknown>;
        const build = candidate.buildTabData;
        if (build && typeof build === "object" && !Array.isArray(build)) {
          const pipelineId = (build as Record<string, unknown>).pipelineId;
          if (typeof pipelineId === "string" && pipelineId.trim()) {
            pipelineIds.add(pipelineId);
          }
        }
        const brief = candidate.keyInformationTabData;
        if (brief && typeof brief === "object" && !Array.isArray(brief)) {
          const pipelineId = (brief as Record<string, unknown>).pipelineId;
          if (typeof pipelineId === "string" && pipelineId.trim()) {
            pipelineIds.add(pipelineId);
          }
        }
        const multi = candidate.multiReviewTabData;
        if (multi && typeof multi === "object" && !Array.isArray(multi)) {
          const data = multi as Record<string, unknown>;
          if (
            typeof data.pipelinePass === "string" &&
            data.pipelinePass.trim() &&
            typeof data.workflowId === "string" &&
            data.workflowId.trim()
          ) {
            pipelineIds.add(data.workflowId);
          }
        }
      }
      return;
    }
    if (record.kind === "split" && Array.isArray(record.children)) {
      record.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(root, 0);
  return { pipelineIds };
}

function collectMultiReviewIds(root: unknown): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (
      depth > MAX_DEPENDENCY_SCAN_DEPTH ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return;
    const record = value as Record<string, unknown>;
    if (record.kind === "leaf" && Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
        const data = (tab as Record<string, unknown>).multiReviewTabData;
        if (!data || typeof data !== "object" || Array.isArray(data)) continue;
        if ((data as Record<string, unknown>).pipelinePass !== undefined) continue;
        const id = (data as Record<string, unknown>).workflowId;
        if (typeof id === "string" && id.trim()) ids.add(id);
      }
      return;
    }
    if (record.kind === "split" && Array.isArray(record.children)) {
      record.children.forEach((child) => visit(child, depth + 1));
    }
  };
  visit(root, 0);
  return ids;
}

/** Most dependency reads one layout refresh runs at once. */
export const PANE_DEPENDENCY_READ_CONCURRENCY = 4;

/**
 * Loads any build pipeline or Multi Review a snapshot references but this
 * client has never seen, so `reconcilePersistedLayout` does not drop the tab
 * that carries it. Already-present records are not refetched, and neither are
 * records a point read already found missing: a tab left pointing at a deleted
 * pipeline or review would otherwise cost one read per window on every layout
 * change. A change event for such a record still reads it. The reads run a
 * few at a time rather than all at once, so a layout with many tabs does not
 * open one connection per tab.
 */
export async function hydratePaneLayoutDependencies(
  root: unknown,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const { pipelineIds } = collectPaneDependencyIds(root);
  const multiReviewIds = collectMultiReviewIds(root);
  const pipelines = scope.store(buildPipelineStore).getState().pipelines;
  const workflows = scope.store(multiReviewStore).getState().workflows;
  const reads: Array<() => Promise<unknown>> = [
    ...[...pipelineIds]
      .filter(
        (pipelineId) =>
          !pipelines.has(pipelineId) && !isBuildPipelineKnownUnavailable(pipelineId, scope),
      )
      .map((pipelineId) => () => hydrateBuildPipeline(pipelineId, undefined, {}, scope)),
    ...[...multiReviewIds]
      .filter(
        (workflowId) =>
          !workflows.has(workflowId) && !isMultiReviewWorkflowKnownUnavailable(workflowId, scope),
      )
      .map((workflowId) => () => hydrateMultiReviewWorkflow(workflowId, scope)),
  ];
  if (reads.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < reads.length) {
      const read = reads[next++]!;
      await read();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PANE_DEPENDENCY_READ_CONCURRENCY, reads.length) }, () =>
      worker(),
    ),
  );
}

/**
 * Validates a backend snapshot against this client's environment and stores,
 * then preserves renderer-local fields. Electron windows keep pane and tab
 * selection in their isolated renderer partition; browser clients continue to
 * adopt the backend selection.
 *
 * Returns null when the snapshot cannot be trusted for this client: the
 * environment is gone, its container generation moved on, or the record itself
 * failed reconciliation.
 */
export function reconcileAuthoritativePaneLayout(
  environmentId: string,
  saved: PersistedPaneLayout,
  current: EnvironmentPaneState,
  scope: NodeScope = appCommandScope(),
): EnvironmentPaneState | null {
  const environment = environmentById(scope, environmentId);
  if (!environment) return null;

  const isLocal = environment.environmentType === "local";
  const containerId = isLocal ? null : environment.containerId;
  if (current.containerId !== containerId) return null;

  const restored = reconcilePersistedLayout(saved, {
    environmentId,
    containerId,
    isLocal,
    worktreePath: environment.worktreePath,
    hasBuildPipeline: (pipelineId) =>
      scope.store(buildPipelineStore).getState().pipelines.has(pipelineId),
    hasMultiReview: (workflowId) =>
      scope.store(multiReviewStore).getState().workflows.has(workflowId),
  });
  if (!restored) return null;

  if (window.orkestrator?.isolatedViewState) {
    const selected = applyCompletionNotesArrival(
      restored,
      applySetupTabArrival(
        restored,
        applyStoredPaneSelection(
          preserveClientPaneSelection(restored, current),
          environmentId,
          readWindowPaneSelection(environmentId, scope),
        ),
        current,
      ),
      current,
      scope,
    );
    // Apply the pipeline handoff first so a Start Build during setup wins over
    // the automatic startup-agent landing in the same reconcile frame. A window
    // that did not launch the pipeline has no one-shot, so fall back to the
    // build tab the backend itself made authoritative. An armed window keeps
    // following the pipeline it started, even when the backend selects another.
    const armedPipelineId = getWindowBuildPipelineActivation(environmentId, scope);
    const buildHandoff = applyBuildPipelineSetupHandoff(
      scope,
      environmentId,
      restored,
      selected,
      armedPipelineId ?? unhandledBackendBuildPipelineId(scope, environmentId, restored),
      armedPipelineId !== null,
    );
    const startupHandoff = applyStartupAgentSetupHandoff(
      scope,
      environmentId,
      restored,
      buildHandoff.state,
      current,
    );
    const reconciled = startupHandoff.state;
    const { startupAgentActivationCommits, buildPipelineActivationCommits } =
      paneActivations(scope);
    if (startupHandoff.retireActivationAfterInstall) {
      startupAgentActivationCommits.set(reconciled, environmentId);
    }
    if (buildHandoff.pipelineId) {
      buildPipelineActivationCommits.set(reconciled, {
        environmentId,
        pipelineId: buildHandoff.pipelineId,
      });
    }
    return reconciled;
  }

  // V1 stored canonical first-pane/first-tab placeholders, not real focus.
  // Until its migration write succeeds, keep this renderer's selection while
  // still adopting structural changes and renderer-local connection fields.
  return saved.version === LEGACY_PANE_LAYOUT_VERSION
    ? preserveClientPaneSelection(restored, current)
    : preserveRendererLocalPaneFields(restored, current);
}
