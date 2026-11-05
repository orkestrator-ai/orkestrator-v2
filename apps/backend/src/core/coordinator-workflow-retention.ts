import {
  COORDINATOR_REQUEST_ID_REUSED_ERROR,
  type CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";

/**
 * Coordinator workflow associations held across every project. The limit is
 * shared on purpose: cleanup reclaims eligible history while protecting live
 * work, replay receipts and resources whose state cannot be established.
 *
 * Why not per project as well: every project's records live in one store that
 * is rewritten whole on each change, so its total size is what each write
 * costs, and a per-project limit does not bound that total. A second, lower
 * limit would also refuse a user whose one busy project needs the room while
 * the store has plenty. The cost is that one project holding many live or
 * remote records can still fill the store for every other; the coordinator is
 * told when a refusal costs it a wake (`send_message`'s warning), and the
 * panel says when the store is near its limit or full (`workflowStore`).
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

/**
 * Records still in use at which the snapshot reports `near-limit`: from here a
 * cleanup at the limit frees less than one batch, so the store refuses new
 * work within fewer than {@link COORDINATOR_WORKFLOW_CLEANUP_BATCH} launches
 * unless something finishes or is deleted. Below it, a cleanup at the limit
 * always frees a whole batch and no one needs to act.
 */
export const COORDINATOR_WORKFLOW_NEAR_LIMIT =
  MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - COORDINATOR_WORKFLOW_CLEANUP_BATCH;

export const COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR =
  `Coordinator workflow store is full: all ${MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS} records are still in use ` +
  "(running, pending, waiting to wake a coordinator, following a pull request, tied to an " +
  "environment that still exists, or protected by recent requests or unknown resource state). Delete finished worker " +
  "environments or wait for running work to finish, then try again.";

export interface CoordinatorWorkflowCleanupInput {
  workflows: readonly CoordinatorWorkflowAssociation[];
  /** Whether a local environment still exists. Remote (`nodeId`) environments are never looked up. */
  environmentExists: (environmentId: string) => boolean;
  resourceState?: (
    association: CoordinatorWorkflowAssociation,
  ) => "active" | "finished" | "missing" | "unknown";
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
 * - an unreported pull-request follow, or workflow without authoritative
 *   evidence that its resource is gone or its terminal grace period elapsed;
 * - a review a live pull-request follow points at (`reviewAssociationId`);
 * - an environment's launch record (it carries `baseCommit`, and makes the
 *   coordinator the worker's creator for mail routing) while that environment
 *   exists, or for any remote environment, whose existence is unknown here;
 * - the newest delegation record per worker tab while the environment exists,
 *   which is what goal and tab actions read as the coordinator's ownership;
 * - a record holding a live worker outcome watch (`workerOutcome` not yet
 *   ended), which is what tells the coordinator its worker merged or was
 *   deleted; the watch ends with that, and then the record can go;
 * - anything created inside the replay window, or with a recent/undated alias.
 * A record whose node was released (`nodeRelease`: forgotten or handed over)
 * counts as local work whose environment is gone, so it becomes clearable once
 * its replay window has passed.
 * Current resource state overrides historical notifications: active and unknown
 * resources stay protected; confirmed missing or expired terminal local work
 * can be reclaimed without notification delivery.
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
    if (association.nodeRelease && !association.nodeRelease.notifiedAt) return;
    // A leaf's late provisioning is learned on the next authority lookup.
    // Retain that creation intent until the actual environment is known.
    // A released node's records are local history now: nothing there can be read or reach here.
    const remote = Boolean(association.nodeId) && !association.nodeRelease;
    if (
      remote &&
      association.createsEnvironment &&
      !association.createdEnvironmentId &&
      !association.environmentCreationSettledAt
    )
      return;
    // Creation provenance remains authoritative after the workflow itself is
    // pruned. Remote existence is unknown, so retain it conservatively.
    if (
      association.createdEnvironmentId &&
      (remote || input.environmentExists(association.createdEnvironmentId))
    )
      return;
    const createdAt = Date.parse(association.createdAt);
    // An unreadable timestamp cannot prove the record is recent.
    if (Number.isFinite(createdAt) && now - createdAt < replayWindowMs) return;
    // Legacy aliases have no known arrival time: retain rather than invent an expiry.
    if (
      association.requestAliases?.some((alias) => {
        const receivedAt = Date.parse(alias.receivedAt ?? "");
        return !Number.isFinite(receivedAt) || now - receivedAt < replayWindowMs;
      })
    )
      return;
    if (association.pending || (association.delegation && !isFinished(association))) return;
    const state = input.resourceState?.(association);
    if (
      state === "active" ||
      (state === "unknown" &&
        ["multi-review", "build-pipeline", "graph-run", "feature-plan"].includes(association.kind))
    )
      return;
    if (!isFinished(association) && state !== "missing" && state !== "finished") return;
    if (
      association.environmentCreationSettledAt &&
      now - Date.parse(association.environmentCreationSettledAt) < replayWindowMs
    )
      return;
    if (reviewsFollowed.has(association.id)) return;
    if (association.workerOutcome && !association.workerOutcome.ended) return;
    if (association.kind === "environment") {
      const exists = association.nodeId ? remote : input.environmentExists(association.resourceId);
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
  return Boolean(association.terminalNotifiedAt || association.environmentCreationSettledAt);
}

function delegationTabKey(association: CoordinatorWorkflowAssociation): string {
  return [
    association.coordinatorId,
    association.nodeId ?? "",
    association.resourceId,
    association.delegation?.workerTabId ?? "",
  ].join("\0");
}

/**
 * The alias on this record that recorded `requestId`, if one did. The one
 * lookup every idempotency check uses, so they cannot disagree about whether a
 * request already started work: a malformed alias that names the request still
 * matches (and carries no payload hash, so a retry is refused as reused rather
 * than run again).
 */
export function coordinatorRequestAlias(
  association: Pick<CoordinatorWorkflowAssociation, "requestAliases">,
  requestId: string,
): { requestId: string; payloadHash?: string; receivedAt?: string } | undefined {
  if (!Array.isArray(association.requestAliases)) return undefined;
  const alias = association.requestAliases.find(
    (item) => Boolean(item) && typeof item.requestId === "string" && item.requestId === requestId,
  );
  if (!alias) return undefined;
  return typeof alias.payloadHash === "string"
    ? alias
    : { requestId: alias.requestId, ...(alias.receivedAt ? { receivedAt: alias.receivedAt } : {}) };
}

/**
 * Whether this record answers `requestId`, as its own request or an alias, and
 * the payload hash that request was admitted with.
 */
export function coordinatorRequestMatch(
  association: Pick<CoordinatorWorkflowAssociation, "requestId" | "payloadHash" | "requestAliases">,
  requestId: string,
): { payloadHash: string | undefined } | undefined {
  if (association.requestId === requestId) return { payloadHash: association.payloadHash };
  const alias = coordinatorRequestAlias(association, requestId);
  return alias ? { payloadHash: alias.payloadHash } : undefined;
}

/** The store's state for the panel, from how many records are still in use. */
export function coordinatorWorkflowStoreState(inUse: number): "ok" | "near-limit" | "full" {
  if (inUse >= MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS) return "full";
  return inUse >= COORDINATOR_WORKFLOW_NEAR_LIMIT ? "near-limit" : "ok";
}

/**
 * What a coordinator is told when its message went out but opened no
 * delegation: that no wake will come, and why. It is a warning on a sent
 * message, never a failed send, so it says the message arrived and not to
 * resend it. A full workflow store names what frees room.
 */
export function coordinatorDelegationNotOpenedNote(
  error: unknown,
  outcome: "sent" | "delivered",
): string {
  const reason =
    error instanceof Error && error.message === COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR
      ? `the coordinator workflow store is full, so no record could be kept for this request. ${error.message}`
      : error instanceof Error && error.message !== COORDINATOR_REQUEST_ID_REUSED_ERROR
        ? error.message
        : "the delegation request ID may already belong to another worker.";
  return (
    `The message was ${outcome}, but no delegation was opened, so you will not be woken when the worker answers. ` +
    `Why: ${reason} Do not resend the message under a new ID; read the worker's state yourself when you need its answer.`
  );
}
