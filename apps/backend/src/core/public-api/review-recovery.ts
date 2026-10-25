import { createHash } from "node:crypto";
import { isMultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { registerReconciler, type ReconcileFunction } from "./reconciler.js";

export function reviewLaunchId(operationId: string): string {
  return `public-${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

const reconcileReview: ReconcileFunction = async (record, context) => {
  if (record.generation === context.generation) return null;
  if (record.result && ["review-success-saved", "review-partial-saved"].includes(record.stage)) {
    return {
      state: record.stage === "review-success-saved" ? "succeeded" : "partial",
      stage: "completed",
      result: record.result,
      ...(record.error ? { error: record.error } : {}),
    };
  }
  const workflowId =
    record.action === "review.launch"
      ? reviewLaunchId(record.operationId)
      : (record.resolved?.workflowId ??
        (record.scope.startsWith("review:") ? record.scope.slice(7) : undefined));
  const saved =
    typeof workflowId === "string"
      ? await context.command.storage.getMultiReviewWorkflow(workflowId)
      : null;
  if (saved && isMultiReviewWorkflow(saved.snapshot)) {
    const workflow = saved.snapshot;
    if (record.action === "review.cancel" && workflow.phase === "cancelled") {
      return {
        state: "succeeded",
        stage: "completed",
        result: { workflowId: workflow.id, phase: workflow.phase },
      };
    }
    if (record.action === "review.launch") {
      // The workflow proves creation, but cannot prove that its UI opened.
      return {
        state: "partial",
        stage: "completed",
        resources: { environmentId: workflow.environmentId, projectId: workflow.projectId },
        result: {
          workflowId: workflow.id,
          environmentId: workflow.environmentId,
          phase: workflow.phase,
          outcome: "partial",
          ui: "unavailable",
        },
        error: {
          code: "partial-failure",
          message:
            "The review was saved before the backend restarted; inspect it and use review.open to open its tab",
        },
      };
    }
  }
  // A pre-existing tab or interactive workflow cannot prove this particular
  // surface request completed. Never dispatch it again during recovery.
  return {
    state: "interrupted",
    error: {
      code: "run-interrupted",
      message:
        "The backend restarted during this review action; its effect is not confirmed. Inspect the saved review before issuing a new request",
    },
  };
};

for (const action of ["review.launch", "review.open", "review.address", "review.cancel"] as const) {
  registerReconciler(action, reconcileReview);
}
