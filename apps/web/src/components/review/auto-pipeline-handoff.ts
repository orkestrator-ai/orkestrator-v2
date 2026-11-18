import type { StoreApi } from "zustand/vanilla";
import type { PaneLayoutState } from "@/stores/paneLayoutStore";

/**
 * How long a started Auto-pipeline waits for its pipeline tab to reach this
 * window's layout. The backend adds the tab while it starts the pipeline, so it
 * normally arrives with or just after the confirmation's answer; past this the
 * Auto-pipeline tab stays open, saying the pipeline started.
 */
export const AUTO_PIPELINE_HANDOFF_TIMEOUT_MS = 60_000;

/** Pending handoffs, one per Auto-pipeline tab, each with its stop function. */
const pending = new Map<string, () => void>();

/**
 * Once an Auto-pipeline has started, selects the pipeline's tab and closes the
 * Auto-pipeline tab, leaving only the pipeline tab open.
 *
 * The backend adds the pipeline tab to the environment's layout, which can
 * reach this window after the Auto-pipeline tab learns the pipeline started,
 * so this waits for it (bounded). It runs outside the tab's component: closing
 * the tab unmounts it, and leaving the environment meanwhile does not cancel
 * the handoff. The pipeline tab takes focus only when the Auto-pipeline tab is
 * still the selected tab of its focused pane; a tab the user chose meanwhile keeps
 * focus. A user who closed the Auto-pipeline tab already is left alone.
 *
 * Returns a function that stops the wait; a second call for the same tab
 * while one is pending joins it.
 */
export function handOffAutoPipelineToBuildTab(options: {
  layouts: StoreApi<PaneLayoutState>;
  environmentId: string;
  autoPipelineTabId: string;
  pipelineId: string;
  timeoutMs?: number;
}): () => void {
  const { layouts, environmentId, autoPipelineTabId, pipelineId } = options;
  const key = `${environmentId}\u0000${autoPipelineTabId}`;
  const joined = pending.get(key);
  if (joined) return joined;

  /** Set while this handoff changes the layout, whose own updates re-enter the listener. */
  let applying = false;
  /** True once there is nothing left to wait for. */
  const attempt = (): boolean => {
    if (applying) return false;
    const store = layouts.getState();
    const autoPane = store.findPaneWithTab(autoPipelineTabId, environmentId);
    if (!autoPane) return true;
    const buildTab = store
      .getAllTabs(environmentId)
      .find((tab) => tab.type === "claude-build" && tab.buildTabData?.pipelineId === pipelineId);
    if (!buildTab) return false;
    const buildPane = store.findPaneWithTab(buildTab.id, environmentId);
    if (!buildPane) return false;
    applying = true;
    try {
      if (
        store.environments.get(environmentId)?.activePaneId === autoPane.id &&
        autoPane.activeTabId === autoPipelineTabId
      ) {
        store.setActivePane(buildPane.id, environmentId);
        store.setActiveTab(buildPane.id, buildTab.id, environmentId);
      }
      // Re-read: selecting the pipeline tab replaced the layout state.
      const owner = layouts.getState().findPaneWithTab(autoPipelineTabId, environmentId);
      if (owner) layouts.getState().removeTab(owner.id, autoPipelineTabId, environmentId);
    } finally {
      applying = false;
    }
    return true;
  };

  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.get(key) === stop) pending.delete(key);
  };
  if (attempt()) return stop;

  pending.set(key, stop);
  unsubscribe = layouts.subscribe(() => {
    if (attempt()) stop();
  });
  timer = setTimeout(stop, options.timeoutMs ?? AUTO_PIPELINE_HANDOFF_TIMEOUT_MS);
  return stop;
}

/** Stops every pending handoff. Tests call it in `afterEach`. */
export function disposeAutoPipelineHandoffs(): void {
  for (const stop of Array.from(pending.values())) stop();
}
