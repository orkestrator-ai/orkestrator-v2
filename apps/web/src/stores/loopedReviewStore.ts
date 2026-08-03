import { create } from "zustand";

/**
 * Looped reviews are owned by the backend. This module is the renderer's
 * read-through projection of them, and nothing more.
 *
 * The contract itself — every type, every guard — is re-exported from the
 * protocol package rather than restated here. A second hand-written copy of
 * `isLoopedReviewWorkflow` had already drifted from the authoritative one, and
 * because a snapshot the renderer rejects is dropped from the UI entirely, that
 * drift silently hid live workflows the backend was still advancing.
 */
export {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  LOOPED_REVIEW_DEFAULT_ALLOWANCE,
  LOOPED_REVIEW_MIN_ALLOWANCE,
  LOOPED_REVIEW_MAX_ALLOWANCE,
  REVIEW_WORKFLOW_FAILURE_KINDS,
  hasReviewFindings,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  isSafeLoopedReviewTargetBranch,
  nextReviewAllowance,
  normalizeReviewAllowance,
} from "@orkestrator/protocol/review-workflow";

export type {
  ActiveLoopedReviewPhase,
  ArchivedReviewPool,
  LoopedReviewAgent,
  LoopedReviewDispatch,
  LoopedReviewFailure,
  LoopedReviewFindingOutcome,
  LoopedReviewPass,
  LoopedReviewPhase,
  LoopedReviewReconciliation,
  LoopedReviewRound,
  LoopedReviewSession,
  LoopedReviewSessionPhase,
  LoopedReviewWorkflow,
  ReviewPackage,
  ReviewPackageCommandResult,
  ReviewPackageContext,
  ReviewPackageFile,
  ReviewWorkflowFailureKind,
  StartLoopedReviewInput,
} from "@orkestrator/protocol/review-workflow";

import type { LoopedReviewWorkflow } from "@orkestrator/protocol/review-workflow";

/** Legacy key retained only so upgrades/tests can remove the obsolete mirror. */
export const LOOPED_REVIEW_STORAGE_KEY = "orkestrator-looped-reviews";

interface LoopedReviewState {
  workflows: Map<string, LoopedReviewWorkflow>;
  /** Install an authoritative backend snapshot. */
  replaceWorkflow: (workflow: LoopedReviewWorkflow) => void;
  /** Remove a projection after the backend resource or environment is deleted. */
  removeWorkflow: (workflowId: string) => void;
}

/**
 * Read-through projection of backend-owned workflows.
 *
 * Deliberately exposes no phase mutation methods: renderer commands go to the
 * backend and resource-change hydration installs the resulting snapshot.
 */
export const useLoopedReviewStore = create<LoopedReviewState>()((set) => ({
  workflows: new Map(),

  replaceWorkflow: (workflow) =>
    set((state) => {
      const existing = state.workflows.get(workflow.id);
      if (existing && existing.backendRevision > workflow.backendRevision) return state;
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
