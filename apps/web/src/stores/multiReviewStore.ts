import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { canonicalMultiReview } from "@orkestrator/protocol/workflow-vocabulary";

export interface MultiReviewState {
  workflows: Map<string, MultiReviewWorkflow>;
  replaceWorkflow: (workflow: MultiReviewWorkflow) => void;
  removeWorkflow: (workflowId: string) => void;
}

/**
 * Read-only projection of backend-owned Multi Review workflows, per node: a
 * workflow belongs to the node that runs it (plan item 3003).
 */
export const multiReviewStore = defineScopedStore<MultiReviewState>(
  "multi-review",
  () => (set) => ({
    workflows: new Map(),
    replaceWorkflow: (incoming) =>
      set((state) => {
        const workflow = canonicalMultiReview(incoming);
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
  }),
);

/** Reads the nearest node scope's workflows; other code uses `scope.store(multiReviewStore)`. */
export const useMultiReviewStore = scopedStoreHook(multiReviewStore);
