import { KeyedSingleFlight } from "../keyed-single-flight.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import type { OperationPatch } from "./types.js";

/** Runs remembered as unable to change; past this the oldest is forgotten. */
export const MAX_SETTLED_RUNS = 10_000;

type SettledRecord = Pick<PublicOperationRecord, "operationId" | "updatedAt" | "state"> &
  Partial<Pick<PublicOperationRecord, "stopRequestedAt">>;

/**
 * The record revision an observation saw. `updatedAt` has millisecond
 * resolution, so the fields that could change a settled run's observation
 * (its state and a stop request) are part of it too.
 */
function settledVersion(record: SettledRecord): string {
  return `${record.updatedAt}|${record.state}|${record.stopRequestedAt ?? ""}`;
}

/**
 * The public API's in-flight operation reconciliations of one backend. Owned
 * by `BackendRuntime` as `publicApi` and reached through
 * `context.command.runtime` at call time. Concurrent observers of the same
 * operation share one evaluation, so N waiting clients cause at most one
 * provider status read or worker-state read.
 */
export class PublicApiReconciliations {
  private readonly runObservations = new KeyedSingleFlight<OperationPatch | null>();
  private readonly execReconciliations = new KeyedSingleFlight<OperationPatch | null>();
  /**
   * Runs whose last observation found their turn ended with a later turn in
   * the session, keyed by operation ID, holding the revision of the record
   * that observation saw. Such a run's observation cannot change while its
   * record and environment stay as they were (to-do 7562, task 4); the
   * periodic reconciler pass skips it. In memory only: a restart observes
   * everything again.
   */
  private readonly settledRuns = new Map<string, string>();

  observeRun(
    operationId: string,
    evaluate: () => Promise<OperationPatch | null>,
  ): Promise<OperationPatch | null> {
    return this.runObservations.run(operationId, evaluate);
  }

  reconcileExec(
    operationId: string,
    evaluate: () => Promise<OperationPatch | null>,
  ): Promise<OperationPatch | null> {
    return this.execReconciliations.run(operationId, evaluate);
  }

  /** Remember that the run, as of this record revision, cannot change. */
  markRunSettled(record: SettledRecord): void {
    this.settledRuns.delete(record.operationId);
    this.settledRuns.set(record.operationId, settledVersion(record));
    while (this.settledRuns.size > MAX_SETTLED_RUNS) {
      const oldest = this.settledRuns.keys().next().value;
      if (oldest === undefined) break;
      this.settledRuns.delete(oldest);
    }
  }

  forgetSettledRun(operationId: string): void {
    this.settledRuns.delete(operationId);
  }

  /** Whether the run was settled by an observation of this same record revision. */
  isRunSettled(record: SettledRecord): boolean {
    return this.settledRuns.get(record.operationId) === settledVersion(record);
  }

  /** Forget every remembered run that is no longer active. */
  retainSettledRuns(active: ReadonlySet<string>): void {
    for (const operationId of Array.from(this.settledRuns.keys())) {
      if (!active.has(operationId)) this.settledRuns.delete(operationId);
    }
  }

  get settledRunCount(): number {
    return this.settledRuns.size;
  }
}
