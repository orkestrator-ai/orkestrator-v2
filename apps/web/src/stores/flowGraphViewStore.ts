import { create } from "zustand";

/**
 * View state of each workflow flow graph (Multi Review, the build pipeline),
 * kept between visits: zoom and pan, whether the graph is collapsed, and
 * which of a pipeline's previous attempts (superseded runs) are expanded.
 *
 * This is view state, not workflow state: it lives only in the renderer and is
 * never sent to the backend. A view entry remembers the viewport width it was
 * taken at, because the layout depends on that width; a graph shown at another
 * width starts from 100% again.
 */

export interface FlowGraphViewEntry {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  /** The measured viewport width, or null where it could not be measured. */
  width: number | null;
}

/** Workflows whose view is remembered; the least recently changed go first. */
export const MAX_REMEMBERED_FLOW_VIEWS = 50;

interface FlowGraphViewState {
  views: Map<string, FlowGraphViewEntry>;
  /** Workflows whose graph is collapsed, oldest first. Absent means expanded. */
  collapsed: Set<string>;
  /**
   * Previous attempts shown step by step, keyed `{workflowId}\0{attemptId}`,
   * oldest first. Absent means the attempt is one collapsed node.
   */
  expandedAttempts: Set<string>;
  saveView: (workflowId: string, view: FlowGraphViewEntry) => void;
  clearView: (workflowId: string) => void;
  setCollapsed: (workflowId: string, collapsed: boolean) => void;
  setAttemptExpanded: (workflowId: string, attemptId: string, expanded: boolean) => void;
}

/** The {@link FlowGraphViewState.expandedAttempts} key of one previous attempt. */
export function flowAttemptKey(workflowId: string, attemptId: string): string {
  return `${workflowId}\u0000${attemptId}`;
}

/** Adds or removes `key`, keeping at most {@link MAX_REMEMBERED_FLOW_VIEWS}, oldest dropped. */
function toggled(current: Set<string>, key: string, present: boolean): Set<string> {
  const next = new Set(current);
  if (present) {
    next.add(key);
    for (const entry of Array.from(next)) {
      if (next.size <= MAX_REMEMBERED_FLOW_VIEWS) break;
      next.delete(entry);
    }
  } else {
    next.delete(key);
  }
  return next;
}

export const useFlowGraphViewStore = create<FlowGraphViewState>()((set) => ({
  views: new Map(),
  collapsed: new Set(),
  expandedAttempts: new Set(),
  saveView: (workflowId, view) =>
    set((state) => {
      const current = state.views.get(workflowId);
      if (
        current &&
        current.zoom === view.zoom &&
        current.scrollLeft === view.scrollLeft &&
        current.scrollTop === view.scrollTop &&
        current.width === view.width
      ) {
        return state;
      }
      const views = new Map(state.views);
      // Re-inserting moves the entry to the end, so the oldest is first.
      views.delete(workflowId);
      views.set(workflowId, view);
      for (const key of Array.from(views.keys())) {
        if (views.size <= MAX_REMEMBERED_FLOW_VIEWS) break;
        views.delete(key);
      }
      return { views };
    }),
  clearView: (workflowId) =>
    set((state) => {
      if (!state.views.has(workflowId)) return state;
      const views = new Map(state.views);
      views.delete(workflowId);
      return { views };
    }),
  setCollapsed: (workflowId, collapsed) =>
    set((state) => {
      if (state.collapsed.has(workflowId) === collapsed) return state;
      return { collapsed: toggled(state.collapsed, workflowId, collapsed) };
    }),
  setAttemptExpanded: (workflowId, attemptId, expanded) =>
    set((state) => {
      const key = flowAttemptKey(workflowId, attemptId);
      if (state.expandedAttempts.has(key) === expanded) return state;
      return { expandedAttempts: toggled(state.expandedAttempts, key, expanded) };
    }),
}));
