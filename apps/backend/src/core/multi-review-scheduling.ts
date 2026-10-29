import type {
  MultiReviewFixSession,
  MultiReviewPhase,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { WorkflowDiscoveryResult } from "./workflow-supervisor.js";

/**
 * Supervision rules for Multi Review, shared by the keyed driver and the
 * `WorkflowDueScheduler` rollback so both classify a record, and jitter its
 * passes, from exactly the same code.
 */

export function reviewSession(workflow: MultiReviewWorkflow): MultiReviewFixSession | undefined {
  return (
    workflow.reviewSession ??
    (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession)
  );
}

export function isSupervisedPhase(phase: MultiReviewPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "reviewing" ||
    phase === "consolidating" ||
    phase === "fixing" ||
    phase === "cancelling"
  );
}

export function needsPausedStopReconciliation(workflow: MultiReviewWorkflow): boolean {
  if (workflow.phase !== "paused" || !workflow.pausedStep) return false;
  const session = workflow.pausedStep === "fix" ? workflow.fixSession : reviewSession(workflow);
  return (
    (workflow.pausedStep === "prepare" &&
      (workflow.validationRun?.status === "planned" ||
        workflow.validationRun?.status === "running")) ||
    session?.status === "running"
  );
}

/**
 * How soon a workflow needs its next supervision pass.
 *
 * `fast` covers every state that is about to issue a request or is settling a
 * boundary — admission, dispatch journals, result consumption, cancellation.
 * `observe` covers work that is simply running at the provider: reviews last
 * minutes, so reading their status every second bought nothing but load.
 */
export function supervisionDemand(
  workflow: MultiReviewWorkflow,
  dispatchesAddressPrompts: boolean,
): "none" | "fast" | "observe" {
  // A graph-engine review only projects its run until the run settles (item
  // 301); its run's own changes wake it, so observing is the safety net.
  if (isGraphEngineProjection(workflow)) return workflow.phase === "cancelling" ? "fast" : "observe";
  if ((workflow.pendingResultConsumptions?.length ?? 0) > 0) return "fast";
  if (workflow.phase === "cancelling") return "fast";
  if (workflow.phase === "interactive" && workflow.addressPromptPending === true) {
    return dispatchesAddressPrompts ? "fast" : "none";
  }
  if (needsAutoPrLaunch(workflow)) return "fast";
  if (needsPausedStopReconciliation(workflow)) return "observe";
  if (needsInteractiveFixObservation(workflow)) return "observe";
  if (!isSupervisedPhase(workflow.phase)) return "none";
  if (workflow.phase === "reviewing") {
    return workflow.reviewers.some(
      (reviewer) =>
        reviewer.status === "pending" ||
        (reviewer.status === "running" && reviewer.dispatchState !== "sent"),
    )
      ? "fast"
      : "observe";
  }
  if (workflow.phase === "preparing" && workflow.validationRun) {
    return workflow.validationRun.status === "planned" ? "fast" : "observe";
  }
  return workflow.activeRequest?.state === "sent" ? "observe" : "fast";
}

/**
 * A graph-engine review whose run has not settled yet (item 301): the
 * service projects the run onto it and runs none of its own steps. Once the
 * run settles the record is an ordinary settled review.
 */
export function isGraphEngineProjection(workflow: MultiReviewWorkflow): boolean {
  return workflow.engine === "graph" && workflow.graphRun?.settled !== true;
}

/** The initial interactive Fix turn is observed until its durable runtime settles. */
export function needsInteractiveFixObservation(workflow: MultiReviewWorkflow): boolean {
  return (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    (workflow.fixSession?.status === "running" || workflow.fixSession?.status === "idle") &&
    workflow.stepRuntimes?.fix?.completedAt === undefined
  );
}

/** A successful Fix recorded an automatic PR launch the supervisor has not delivered yet. */
export function needsAutoPrLaunch(workflow: MultiReviewWorkflow): boolean {
  return workflow.autoPrLaunch?.state === "pending";
}

/**
 * What a Multi Review still owes the backend (step 08, task 1).
 *
 * | Obligation | Record state | Why it is runnable |
 * | --- | --- | --- |
 * | `result-consumption` | `pendingResultConsumptions` non-empty, any phase | Durable consumption outbox. |
 * | `cancelling` | `cancelling` | Abort every running session and settle within the cancellation deadline. |
 * | `address-handoff` | `interactive` with `addressPromptPending` (and a dispatcher) | Durable interactive Fix handoff; retried with backoff until acknowledged. |
 * | `pr-handoff` | `autoPrLaunch.state` is `pending` | Deliver a proven Fix's PR launch, or retire a stale intent. |
 * | `paused-stop` | `paused` whose validation or session stop is not yet confirmed | Retry the stop. |
 * | `interactive-fix` | `interactive` Fix turn running/idle before its runtime settles | Observe interactive Fix completion and final usage. |
 * | `reviewers` | `reviewing` | Reviewer fan-out (its own concurrency budget), idle-result grace and final-usage probes. |
 * | `step` | `preparing`, `consolidating`, `fixing` | The single-session step, parked dispatch reconciliation, structured-output deadlines. |
 * | `graph-run` | graph engine, run not settled (item 301) | Project the graph run onto the record. |
 *
 * Everything else (`interactive` without pending work, `paused`, terminal
 * phases) owes nothing until a command advances it.
 */
export type MultiReviewObligation =
  | "result-consumption"
  | "cancelling"
  | "address-handoff"
  | "pr-handoff"
  | "paused-stop"
  | "interactive-fix"
  | "reviewers"
  | "step"
  | "graph-run";

export function multiReviewObligation(
  workflow: MultiReviewWorkflow,
  dispatchesAddressPrompts: boolean,
): MultiReviewObligation | null {
  if (supervisionDemand(workflow, dispatchesAddressPrompts) === "none") return null;
  if (isGraphEngineProjection(workflow)) return "graph-run";
  if ((workflow.pendingResultConsumptions?.length ?? 0) > 0) return "result-consumption";
  if (workflow.phase === "cancelling") return "cancelling";
  if (workflow.phase === "interactive" && workflow.addressPromptPending === true) {
    return "address-handoff";
  }
  if (needsAutoPrLaunch(workflow)) return "pr-handoff";
  if (needsPausedStopReconciliation(workflow)) return "paused-stop";
  if (needsInteractiveFixObservation(workflow)) return "interactive-fix";
  return workflow.phase === "reviewing" ? "reviewers" : "step";
}

/** Discovery entries from an authoritative listing (already validated). */
export function multiReviewDiscovery(
  records: readonly { id: string; snapshot: unknown }[],
  isWorkflow: (value: unknown) => value is MultiReviewWorkflow,
  dispatchesAddressPrompts: boolean,
): WorkflowDiscoveryResult<MultiReviewObligation> {
  const entries: WorkflowDiscoveryResult<MultiReviewObligation>["entries"] = [];
  for (const record of records) {
    if (!isWorkflow(record.snapshot)) continue;
    const obligation = multiReviewObligation(record.snapshot, dispatchesAddressPrompts);
    if (!obligation) continue;
    entries.push({ key: record.id, obligation, target: record.snapshot.environmentId });
  }
  return { entries, scanned: records.length, complete: true };
}

/**
 * Stable per-workflow jitter in `[0, spreadMs)`, so workflows restored together
 * after a restart do not all poll their providers in the same instant. The
 * identifier is only hashed locally; it never leaves this function.
 */
export function stableJitterMs(workflowId: string, spreadMs: number): number {
  if (spreadMs <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < workflowId.length; index++) {
    hash ^= workflowId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.floor(spreadMs);
}
