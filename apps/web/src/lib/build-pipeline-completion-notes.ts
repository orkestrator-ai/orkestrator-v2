/**
 * Opens a build pipeline's notes in a tab of their own when the run finishes.
 *
 * The trigger is a completion this renderer observed: a pipeline the store
 * held in an earlier phase arrives as `complete`. A run already complete when
 * it was first loaded opens nothing, so a reload or a newly opened window
 * never pulls the user onto old notes. The intent is kept outside React, so it
 * holds while the pipeline's environment is not on screen, and it waits for
 * that environment's layout to be installed before adding the tab.
 */
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import { openKeyInformationTab } from "@/components/build-pipeline/key-information-open-tab";
import type { StoreApi } from "zustand/vanilla";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedService } from "@/lib/node-scope/scoped-service";
import { appCommandScope } from "@/lib/node-scope-slots";
import { buildPipelineStore, type BuildPipelineState } from "@/stores/buildPipelineStore";
import { getAllLeaves, paneLayoutStore, type PaneLayoutState } from "@/stores/paneLayoutStore";

const MAX_PENDING_NOTES = 64;

/** The pane holding the pipeline's own tab, so the notes open beside it. */
function pipelinePaneId(
  panes: StoreApi<PaneLayoutState>,
  environmentId: string,
  pipelineId: string,
): string | undefined {
  const root = panes.getState().environments.get(environmentId)?.root;
  if (!root) return undefined;
  return getAllLeaves(root).find((leaf) =>
    leaf.tabs.some(
      (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
    ),
  )?.id;
}

function openNotes(
  scope: NodeScope,
  paneLayouts: StoreApi<PaneLayoutState>,
  environmentId: string,
  pipelineId: string,
): void {
  const store = paneLayouts.getState();
  const paneId =
    pipelinePaneId(paneLayouts, environmentId, pipelineId) ?? store.getActivePaneId(environmentId);
  openKeyInformationTab({
    scope,
    environmentId,
    activePaneId: paneId,
    allTabs: store.getAllTabs(environmentId),
    maxTabs: MAX_TABS_PER_ENVIRONMENT,
    target: { environmentId, pipelineId, view: "notes" },
    addTab: (pane, tab, environment) => {
      const panes = paneLayouts.getState();
      panes.addTab(pane, tab, environment);
      panes.setActivePane(pane, environment);
    },
    // A full layout keeps the pipeline tab, where the Notes step is selected.
    onTabLimit: () => {},
  });
}

/** `pendingNotes`: completions still waiting for their environment's layout, by pipeline. */
function reconcile(
  scope: NodeScope,
  pipelines: StoreApi<BuildPipelineState>,
  paneLayouts: StoreApi<PaneLayoutState>,
  pendingNotes: Map<string, string>,
): void {
  const panes = paneLayouts.getState();
  for (const [pipelineId, environmentId] of Array.from(pendingNotes)) {
    const pipeline = pipelines.getState().pipelines.get(pipelineId);
    if (pipeline?.phase !== "complete" || pipeline.environmentId !== environmentId) {
      pendingNotes.delete(pipelineId);
      continue;
    }
    if (panes.hydration.get(environmentId) !== "done") continue;
    if (!panes.environments.get(environmentId)) continue;
    pendingNotes.delete(pipelineId);
    openNotes(scope, paneLayouts, environmentId, pipelineId);
  }
}

/**
 * Starts watching `scope`'s pipelines for completions and opens their notes in
 * `scope`'s own pane layout; returns the stop function. Each watcher keeps its
 * own pending completions, so a stopped one leaves nothing behind.
 */
export function startBuildPipelineCompletionNotes(
  scope: NodeScope = appCommandScope(),
): () => void {
  const pipelines = scope.store(buildPipelineStore);
  const paneLayouts = scope.store(paneLayoutStore);
  const pendingNotes = new Map<string, string>();
  const offPipelines = pipelines.subscribe((state, previous) => {
    if (state.pipelines === previous.pipelines) return;
    for (const [pipelineId, environmentId] of Array.from(pendingNotes)) {
      const pipeline = state.pipelines.get(pipelineId);
      if (pipeline?.phase !== "complete" || pipeline.environmentId !== environmentId) {
        pendingNotes.delete(pipelineId);
      }
    }
    let added = false;
    for (const [pipelineId, pipeline] of state.pipelines) {
      const before = previous.pipelines.get(pipelineId);
      if (!before || before === pipeline) continue;
      if (pipeline.phase !== "complete" || before.phase === "complete") continue;
      if (!pipeline.environmentId) continue;
      pendingNotes.delete(pipelineId);
      pendingNotes.set(pipelineId, pipeline.environmentId);
      added = true;
    }
    while (pendingNotes.size > MAX_PENDING_NOTES) {
      pendingNotes.delete(pendingNotes.keys().next().value!);
    }
    if (added) reconcile(scope, pipelines, paneLayouts, pendingNotes);
  });
  const offPanes = paneLayouts.subscribe((state, previous) => {
    if (pendingNotes.size === 0) return;
    if (state.hydration === previous.hydration && state.environments === previous.environments) {
      return;
    }
    reconcile(scope, pipelines, paneLayouts, pendingNotes);
  });
  return () => {
    offPipelines();
    offPanes();
    pendingNotes.clear();
  };
}

/**
 * Completion notes as a scoped service (plan items 3014, 3011, 3013). It
 * watches its own scope's pipelines and opens the notes in that scope's pane
 * layout, so it runs on every warm scope.
 */
export const buildPipelineCompletionNotesService = defineScopedService(
  "build-pipeline-completion-notes",
  (scope) => ({ stop: startBuildPipelineCompletionNotes(scope) }),
);
