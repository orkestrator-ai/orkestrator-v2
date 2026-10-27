import { KeyedSingleFlight } from "../keyed-single-flight.js";
import type { OperationPatch } from "./types.js";

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
}
