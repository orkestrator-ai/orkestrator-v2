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
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";

const MAX_PENDING_NOTES = 64;

/** Completions still waiting for their environment's layout, by pipeline. */
const pendingNotes = new Map<string, string>();

/** The pane holding the pipeline's own tab, so the notes open beside it. */
function pipelinePaneId(environmentId: string, pipelineId: string): string | undefined {
  const root = usePaneLayoutStore.getState().environments.get(environmentId)?.root;
  if (!root) return undefined;
  return getAllLeaves(root).find((leaf) =>
    leaf.tabs.some(
      (tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId,
    ),
  )?.id;
}

function openNotes(environmentId: string, pipelineId: string): void {
  const store = usePaneLayoutStore.getState();
  const paneId = pipelinePaneId(environmentId, pipelineId) ?? store.getActivePaneId(environmentId);
  openKeyInformationTab({
    environmentId,
    activePaneId: paneId,
    allTabs: store.getAllTabs(environmentId),
    maxTabs: MAX_TABS_PER_ENVIRONMENT,
    target: { environmentId, pipelineId, view: "notes" },
    addTab: (pane, tab, environment) => {
      const panes = usePaneLayoutStore.getState();
      panes.addTab(pane, tab, environment);
      panes.setActivePane(pane, environment);
    },
    // A full layout keeps the pipeline tab, where the Notes step is selected.
    onTabLimit: () => {},
  });
}

function reconcile(): void {
  const panes = usePaneLayoutStore.getState();
  for (const [pipelineId, environmentId] of Array.from(pendingNotes)) {
    const pipeline = useBuildPipelineStore.getState().pipelines.get(pipelineId);
    if (pipeline?.phase !== "complete" || pipeline.environmentId !== environmentId) {
      pendingNotes.delete(pipelineId);
      continue;
    }
    if (panes.hydration.get(environmentId) !== "done") continue;
    if (!panes.environments.get(environmentId)) continue;
    pendingNotes.delete(pipelineId);
    openNotes(environmentId, pipelineId);
  }
}

/** Starts watching for completions; returns the stop function. */
export function startBuildPipelineCompletionNotes(): () => void {
  const offPipelines = useBuildPipelineStore.subscribe((state, previous) => {
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
    if (added) reconcile();
  });
  const offPanes = usePaneLayoutStore.subscribe((state, previous) => {
    if (pendingNotes.size === 0) return;
    if (state.hydration === previous.hydration && state.environments === previous.environments) {
      return;
    }
    reconcile();
  });
  return () => {
    offPipelines();
    offPanes();
    pendingNotes.clear();
  };
}
