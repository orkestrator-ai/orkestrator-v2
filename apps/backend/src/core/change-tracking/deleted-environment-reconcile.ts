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
 *
 * The ledger is read in pages to its end, with a fresh store read after each
 * page that has candidates, so the ordering holds page by page and no number
 * of live or excluded ids can keep a later orphan from being reached.
 */

import { BUG_REPORT_RUNTIME_PREFIX } from "@orkestrator/protocol/bug-report";
import { COORDINATOR_RUNTIME_PREFIX } from "@orkestrator/protocol/coordinator";
import type { LedgerEnvironmentIdPage } from "./ledger-retirement.js";

export interface DeletedEnvironmentReconcileDeps {
  /** One page of the environment ids the ledger's rows name, above `after`. */
  ledgerEnvironmentIds: (after: string) => LedgerEnvironmentIdPage;
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
 * Runtimes the environment store never holds: coordinator conversations and
 * bug reports run under synthetic runtime ids, so their absence from the store
 * says nothing about whether they still exist. A new synthetic runtime prefix
 * belongs here.
 */
const SYNTHETIC_RUNTIME_PREFIXES: readonly string[] = [
  COORDINATOR_RUNTIME_PREFIX,
  BUG_REPORT_RUNTIME_PREFIX,
];

export function storeOwnsId(environmentId: string): boolean {
  return !SYNTHETIC_RUNTIME_PREFIXES.some((prefix) => environmentId.startsWith(prefix));
}

export async function reconcileDeletedEnvironments(
  deps: DeletedEnvironmentReconcileDeps,
): Promise<DeletedEnvironmentReconcileResult> {
  let ledgerEnvironments = 0;
  const requested: string[] = [];
  let after: string | null = "";
  while (after !== null) {
    if (deps.stopped()) return { kind: "stopped" };
    const page = deps.ledgerEnvironmentIds(after);
    after = page.next;
    const candidates = page.ids.filter((id) => storeOwnsId(id) && !deps.purgePending(id));
    if (candidates.length === 0) continue;
    ledgerEnvironments += candidates.length;
    // Read after this page, so an environment created since cannot be in it.
    // A failed or incomplete read throws to the caller, which purges nothing more.
    const live = await deps.liveEnvironmentIds();
    if (deps.stopped()) return { kind: "stopped" };
    for (const environmentId of candidates) {
      if (live.has(environmentId) || deps.purgePending(environmentId)) continue;
      deps.requestPurge(environmentId);
      requested.push(environmentId);
    }
  }
  return { kind: "reconciled", ledgerEnvironments, requested };
}
