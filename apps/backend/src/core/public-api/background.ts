import { boundedMessage, isPublicActionError } from "./errors.js";
import type { ExecuteOutcome, OperationHandle } from "./types.js";

/**
 * Run backend work whose ownership must not depend on the HTTP request.
 *
 * The task starts immediately. If it settles within `graceMs` the caller gets
 * the final outcome in the same response; otherwise the operation is left
 * `running` and a continuation — owned by the backend process, not by the
 * request — records the result when the task settles. A dropped client
 * connection therefore never cancels or loses the work.
 */
export async function runWithContinuation<T>(
  operation: OperationHandle,
  task: Promise<T>,
  options: {
    graceMs?: number;
    runningStage: string;
    onSuccess: (value: T) => Promise<ExecuteOutcome> | ExecuteOutcome;
    onFailure?: (error: unknown) => Promise<ExecuteOutcome> | ExecuteOutcome;
    runningResult?: Record<string, unknown>;
  },
): Promise<ExecuteOutcome> {
  const settle = async (value: { ok: true; value: T } | { ok: false; error: unknown }) => {
    if (value.ok) return options.onSuccess(value.value);
    if (options.onFailure) return options.onFailure(value.error);
    return {
      state: "failed" as const,
      error: {
        code: isPublicActionError(value.error) ? value.error.code : ("operation-failed" as const),
        message: boundedMessage(value.error),
      },
    };
  };
  const settled = task.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), options.graceMs ?? 2_000);
    timer.unref?.();
  });
  const first = await Promise.race([settled, grace]);
  clearTimeout(timer);
  if (first !== "pending") return settle(first);

  void settled
    .then(settle)
    .then(async (outcome) => {
      await operation.update({
        state: outcome.state,
        ...(outcome.stage
          ? { stage: outcome.stage }
          : outcome.state === "succeeded"
            ? { stage: "completed" }
            : {}),
        ...("result" in outcome && outcome.result ? { result: outcome.result } : {}),
        ...("error" in outcome ? { error: outcome.error } : {}),
        ...(outcome.resources ? { resources: outcome.resources } : {}),
        ...(outcome.dispatch ? { dispatch: outcome.dispatch } : {}),
        ...(outcome.execution ? { execution: outcome.execution } : {}),
      });
    })
    .catch((error: unknown) => {
      console.warn(
        `[public-api] Failed to record the outcome of ${operation.operationId}: ${boundedMessage(error)}`,
      );
    });
  return {
    state: "running",
    stage: options.runningStage,
    result: options.runningResult ?? {},
  };
}
