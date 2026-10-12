import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";

/**
 * Environments whose runtime is being replaced or reset. For the whole
 * operation — quiescing, copying, validating the candidate — no new agent
 * prompt is dispatched: it would reach a runtime about to stop, or none. The
 * refusal happens before anything is journaled, so the prompt definitely did
 * not run and can simply be sent again. In memory on purpose: the operation
 * runs inside one lifecycle queue task of this backend.
 */
const replacingEnvironments = new Map<string, number>();

export function isEnvironmentBeingReplaced(environmentId: string): boolean {
  return (replacingEnvironments.get(environmentId) ?? 0) > 0;
}

/**
 * Environments whose local worktree is being moved to another folder. Held
 * from admission until the move settles, so a prompt can neither start an
 * agent in the old folder nor race the activity check that admitted the move.
 */
const movingEnvironments = new Set<string>();
const pendingAgentWork = new Map<string, number>();

/** Synchronous admission, held through setup and dispatch acknowledgement. */
export function beginEnvironmentAgentWork(environmentId: string): () => void {
  assertEnvironmentAcceptsAgentWork(environmentId);
  pendingAgentWork.set(environmentId, (pendingAgentWork.get(environmentId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingAgentWork.get(environmentId) ?? 1) - 1;
    if (remaining) pendingAgentWork.set(environmentId, remaining);
    else pendingAgentWork.delete(environmentId);
  };
}

export function isEnvironmentBeingMoved(environmentId: string): boolean {
  return movingEnvironments.has(environmentId);
}

/** Reserves the move fence; false when a move of this environment is already admitted. */
export function beginEnvironmentMove(environmentId: string): boolean {
  if (movingEnvironments.has(environmentId)) return false;
  if (pendingAgentWork.has(environmentId)) {
    throw new Error(
      "An agent submission is still in progress; wait for it to finish before moving",
    );
  }
  movingEnvironments.add(environmentId);
  return true;
}

export function endEnvironmentMove(environmentId: string): void {
  movingEnvironments.delete(environmentId);
}

export function assertEnvironmentNotMoving(environmentId: string | undefined): void {
  if (environmentId && movingEnvironments.has(environmentId)) {
    throw new Error(`Environment is being moved: ${environmentId}`);
  }
}

export function assertEnvironmentAcceptsAgentWork(environmentId: string): void {
  if (movingEnvironments.has(environmentId)) {
    throw new Error(
      "This environment is being moved to a new folder. The prompt was not sent; send it again when the move finishes.",
    );
  }
  if (isEnvironmentBeingReplaced(environmentId)) {
    throw new Error(
      formatContainerLifecycleError(
        "operation-in-progress",
        "This environment's container is being rebuilt. The prompt was not sent; send it again when the rebuild finishes.",
      ),
    );
  }
}

export async function withEnvironmentReplacement<T>(
  environmentId: string,
  run: () => Promise<T>,
): Promise<T> {
  replacingEnvironments.set(environmentId, (replacingEnvironments.get(environmentId) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = (replacingEnvironments.get(environmentId) ?? 1) - 1;
    if (remaining > 0) replacingEnvironments.set(environmentId, remaining);
    else replacingEnvironments.delete(environmentId);
  }
}
