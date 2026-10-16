import { create } from "zustand";

/**
 * Zoom and pan of each Multi Review flow graph, kept between visits.
 *
 * This is view state, not workflow state: it lives only in the renderer and is
 * never sent to the backend. An entry remembers the viewport width it was
 * taken at, because the layout depends on that width; a graph shown at another
 * width starts from 100% again.
 */

export interface MultiReviewFlowViewEntry {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  /** The measured viewport width, or null where it could not be measured. */
  width: number | null;
}

/** Workflows whose view is remembered; the least recently changed go first. */
export const MAX_REMEMBERED_FLOW_VIEWS = 50;

interface MultiReviewFlowViewState {
  views: Map<string, MultiReviewFlowViewEntry>;
  saveView: (workflowId: string, view: MultiReviewFlowViewEntry) => void;
  clearView: (workflowId: string) => void;
}

export const useMultiReviewFlowViewStore = create<MultiReviewFlowViewState>()((set) => ({
  views: new Map(),
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
}));
