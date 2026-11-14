/**
 * Environments deleted before purges were recorded (to-do 5821 task 5).
 *
 * `ChangeTrackingService.environmentDeleted` records a durable purge when an
 * environment is deleted. An environment deleted by an older build, or whose
 * delete never reached that step, has no entry: age-based retention takes its
 * finished work, but its open segments keep their baselines pinned and its
 * boundary rows stay, because nothing says the environment is gone.
 *
 * This compares the environment ids the ledger names with the environment
 * store, once after startup, and requests the ordinary purge for each id the
 * store does not hold. It deletes history on an inference, so it only acts on
 * a strict owner read that succeeded (`loadEnvironmentIdsForCleanup` throws on
 * a missing, corrupt or incomplete store instead of answering empty), and it
 * reads the ledger first: an environment created while the store is being read
 * has no ledger rows yet, so it cannot be mistaken for a deleted one.
 */

import { COORDINATOR_RUNTIME_PREFIX } from "@orkestrator/protocol/coordinator";

export interface DeletedEnvironmentReconcileDeps {
  /** Environment ids the ledger's rows name. */
  ledgerEnvironmentIds: () => string[];
  /** Every environment the store holds; throws rather than answer incompletely. */
  liveEnvironmentIds: () => Promise<ReadonlySet<string>>;
  /** Whether a purge is already recorded for this id. */
  purgePending: (environmentId: string) => boolean;
  /** Records the purge, as a delete does. */
  requestPurge: (environmentId: string) => void;
  /** Checked after the store read, so shutdown is not followed by new purges. */
  stopped: () => boolean;
}

export type DeletedEnvironmentReconcileResult =
  { kind: "reconciled"; ledgerEnvironments: number; requested: string[] } | { kind: "stopped" };

/**
 * Coordinator conversations run under a runtime id the environment store never
 * holds, so their absence from it says nothing about whether they still exist.
 */
function storeOwnsId(environmentId: string): boolean {
  return !environmentId.startsWith(COORDINATOR_RUNTIME_PREFIX);
}

export async function reconcileDeletedEnvironments(
  deps: DeletedEnvironmentReconcileDeps,
): Promise<DeletedEnvironmentReconcileResult> {
  if (deps.stopped()) return { kind: "stopped" };
  const candidates = deps
    .ledgerEnvironmentIds()
    .filter((id) => storeOwnsId(id) && !deps.purgePending(id));
  if (candidates.length === 0) {
    return { kind: "reconciled", ledgerEnvironments: 0, requested: [] };
  }
  // A failed or incomplete read throws to the caller, which purges nothing.
  const live = await deps.liveEnvironmentIds();
  if (deps.stopped()) return { kind: "stopped" };
  const requested: string[] = [];
  for (const environmentId of candidates) {
    if (live.has(environmentId) || deps.purgePending(environmentId)) continue;
    deps.requestPurge(environmentId);
    requested.push(environmentId);
  }
  return { kind: "reconciled", ledgerEnvironments: candidates.length, requested };
}
