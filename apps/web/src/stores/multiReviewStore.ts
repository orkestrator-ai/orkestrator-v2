import { create } from "zustand";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";

interface MultiReviewState {
  workflows: Map<string, MultiReviewWorkflow>;
  replaceWorkflow: (workflow: MultiReviewWorkflow) => void;
  removeWorkflow: (workflowId: string) => void;
}

/** Read-only projection of backend-owned Multi Review workflows. */
export const useMultiReviewStore = create<MultiReviewState>()((set) => ({
  workflows: new Map(),
  replaceWorkflow: (workflow) =>
    set((state) => {
      const current = state.workflows.get(workflow.id);
      if (current && current.backendRevision > workflow.backendRevision) return state;
      const workflows = new Map(state.workflows);
      workflows.set(workflow.id, workflow);
      return { workflows };
    }),
  removeWorkflow: (workflowId) =>
    set((state) => {
      if (!state.workflows.has(workflowId)) return state;
      const workflows = new Map(state.workflows);
      workflows.delete(workflowId);
      return { workflows };
    }),
}));
