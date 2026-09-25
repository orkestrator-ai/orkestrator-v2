import {
  isLoopedReviewActivePhase,
  isLoopedReviewWorkflow,
  legacyLoopedReviewAdoption,
  type LoopedReviewWorkflow,
} from "@orkestrator/protocol/review-workflow";
import type { PersistedLoopedReviewWorkflow } from "./models.js";
import type { WorkflowDiscoveryResult } from "./workflow-supervisor.js";

/**
 * What a looped review still owes the backend (step 08, task 1).
 *
 * | Obligation | Record state | Why it is runnable |
 * | --- | --- | --- |
 * | `result-consumption` | `pendingResultConsumptions` non-empty, **any phase** | Durable consumption outbox for accepted tool results, including after a terminal transition. |
 * | `cancelling` | `cancelling` | Abort the provider turn, close result slots, finalize within the cancellation deadline. |
 * | `dispatch` | active, `dispatch.state` `prepared` | Send the prepared turn (fenced by the controller lease). |
 * | `dispatch-reconciliation` | active, `dispatch.state` `dispatching` | Ambiguous send: stays parked on its request id until the provider positively reconciles it; never resent blindly. |
 * | `await-result` | active, `dispatch.state` `sent` | Structured-result, missing-result grace and stall deadlines. |
 * | `advance` | active with no dispatch | Start the current phase's turn (pending interactions are enforced first). |
 * | `legacy-adoption` | a renderer-era (v1) record adoption accepts | Adopted into a backend-owned record by discovery. |
 *
 * `paused`, `failed`, `completed` and `cancelled` owe nothing unless a result
 * consumption is pending; resume/retry/cancel are commands that advance.
 */
export type LoopedReviewObligation =
  | "result-consumption"
  | "cancelling"
  | "dispatch"
  | "dispatch-reconciliation"
  | "await-result"
  | "advance"
  | "legacy-adoption";

/**
 * Classifies a snapshot. `valid` says whether it already passed full
 * validation (the caller caches that by revision, because validating a
 * snapshot walks every retained review package).
 */
export function loopedReviewObligation(
  snapshot: unknown,
  valid: boolean,
): LoopedReviewObligation | null {
  if (!valid) return legacyLoopedReviewAdoption(snapshot) ? "legacy-adoption" : null;
  const workflow = snapshot as LoopedReviewWorkflow;
  if ((workflow.pendingResultConsumptions?.length ?? 0) > 0) return "result-consumption";
  if (workflow.phase === "cancelling") return "cancelling";
  if (!isLoopedReviewActivePhase(workflow.phase)) return null;
  const dispatch = workflow.dispatch;
  if (!dispatch) return "advance";
  if (dispatch.state === "prepared") return "dispatch";
  if (dispatch.state === "dispatching") return "dispatch-reconciliation";
  return "await-result";
}

/**
 * Authoritative discovery over the looped-review store. Full validation is
 * cached by revision (`validatedRevisions`, rebuilt each pass so deleted
 * workflows cannot accumulate). A renderer-era record is adopted here, as the
 * previous tick did, and classified from its adopted form; a record that is
 * neither valid nor adoptable is skipped without hiding any other.
 */
export async function discoverLoopedReviews(input: {
  list(): Promise<PersistedLoopedReviewWorkflow[]>;
  read(workflowId: string): Promise<PersistedLoopedReviewWorkflow | null>;
  adopt(record: PersistedLoopedReviewWorkflow): Promise<void>;
  validatedRevisions: Map<string, number>;
}): Promise<{
  result: WorkflowDiscoveryResult<LoopedReviewObligation>;
  validated: Map<string, number>;
}> {
  const records = await input.list();
  const validated = new Map<string, number>();
  const entries: WorkflowDiscoveryResult<LoopedReviewObligation>["entries"] = [];
  for (let record of records) {
    let valid =
      input.validatedRevisions.get(record.id) === record.revision ||
      isLoopedReviewWorkflow(record.snapshot);
    if (!valid && legacyLoopedReviewAdoption(record.snapshot)) {
      await input.adopt(record).catch(() => undefined);
      const adopted = await input.read(record.id).catch(() => null);
      if (!adopted) continue;
      record = adopted;
      valid = isLoopedReviewWorkflow(record.snapshot);
    }
    if (!valid) continue;
    validated.set(record.id, record.revision);
    const obligation = loopedReviewObligation(record.snapshot, true);
    if (!obligation) continue;
    entries.push({ key: record.id, obligation, target: record.environmentId });
  }
  return { result: { entries, scanned: records.length, complete: true }, validated };
}
