import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";

/**
 * Coordinator workflow associations held across every project. The limit is
 * shared on purpose: cleanup keeps it free of finished history, so it is only
 * reached when this many records are all still in use.
 */
export const MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS = 2_000;

/**
 * How many finished records one cleanup clears. A batch, so a store near the
 * limit does not rewrite itself on every launch.
 */
export const COORDINATOR_WORKFLOW_CLEANUP_BATCH = 200;

/**
 * Records younger than this are kept whatever their state, so a retried
 * request still finds its original record and replays it instead of
 * starting the same work twice.
 */
export const COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR =
  `Coordinator workflow store is full: all ${MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS} records are still in use ` +
  "(running, pending, waiting to wake a coordinator, following a pull request, tied to an " +
  "environment that still exists, or created in the last 24 hours). Delete finished worker " +
  "environments or wait for running work to finish, then try again.";

export interface CoordinatorWorkflowCleanupInput {
  workflows: readonly CoordinatorWorkflowAssociation[];
  /** Whether a local environment still exists. Remote (`nodeId`) environments are never looked up. */
  environmentExists: (environmentId: string) => boolean;
  now?: number;
  batch?: number;
  replayWindowMs?: number;
}

/**
 * The ids of the oldest finished records to clear, at most `batch` of them.
 *
 * A record is never chosen while anything still reads it as live:
 *
 * - a pending reservation (a launch is materializing it);
 * - a delegation that is running or whose coordinator wake was not delivered;
 * - a workflow or pull-request follow the coordinator was not yet told the
 *   end of (`terminalNotifiedAt` unset), which status wakes still observe;
 * - a review a live pull-request follow points at (`reviewAssociationId`);
 * - an environment's launch record (it carries `baseCommit`, and makes the
 *   coordinator the worker's creator for mail routing) while that environment
 *   exists, or for any remote environment, whose existence is unknown here;
 * - the newest delegation record per worker tab while the environment exists,
 *   which is what goal and tab actions read as the coordinator's ownership;
 * - anything created inside the replay window.
 */
export function selectCoordinatorWorkflowsToClear(
  input: CoordinatorWorkflowCleanupInput,
): Set<string> {
  const now = input.now ?? Date.now();
  const batch = input.batch ?? COORDINATOR_WORKFLOW_CLEANUP_BATCH;
  const replayWindowMs = input.replayWindowMs ?? COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS;
  const { workflows } = input;

  const reviewsFollowed = new Set<string>();
  // The newest delegation record per worker tab: later entries win.
  const newestDelegation = new Map<string, string>();
  for (const association of workflows) {
    const reviewId = association.pullRequest?.reviewAssociationId;
    if (association.kind === "pull-request" && !association.terminalNotifiedAt && reviewId) {
      reviewsFollowed.add(reviewId);
    }
    if (association.kind === "environment" && association.delegation) {
      newestDelegation.set(delegationTabKey(association), association.id);
    }
  }

  const candidates: Array<{ id: string; createdAt: number; index: number }> = [];
  workflows.forEach((association, index) => {
    const createdAt = Date.parse(association.createdAt);
    // An unreadable timestamp cannot prove the record is recent.
    if (Number.isFinite(createdAt) && now - createdAt < replayWindowMs) return;
    if (!isFinished(association)) return;
    if (reviewsFollowed.has(association.id)) return;
    if (association.kind === "environment") {
      const exists = association.nodeId ? true : input.environmentExists(association.resourceId);
      if (exists) {
        if (!association.delegation || association.baseCommit) return;
        if (newestDelegation.get(delegationTabKey(association)) === association.id) return;
      }
    }
    candidates.push({
      id: association.id,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      index,
    });
  });
  candidates.sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
  return new Set(candidates.slice(0, Math.max(0, batch)).map((candidate) => candidate.id));
}

/** Whether nothing about the record itself is still in progress. */
function isFinished(association: CoordinatorWorkflowAssociation): boolean {
  if (association.pending) return false;
  if (association.delegation) {
    return association.delegation.state !== "running" && Boolean(association.delegation.wokenAt);
  }
  // An environment record without a delegation has nothing to report.
  if (association.kind === "environment") return true;
  return Boolean(association.terminalNotifiedAt);
}

function delegationTabKey(association: CoordinatorWorkflowAssociation): string {
  return [
    association.coordinatorId,
    association.nodeId ?? "",
    association.resourceId,
    association.delegation?.workerTabId ?? "",
  ].join("\0");
}
