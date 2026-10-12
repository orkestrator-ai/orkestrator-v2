import path from "node:path";
import { canonicalWorktreePath } from "@orkestrator/protocol/worktree-paths";
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
const recoveryPending = new Set<string>();
const pendingMutations = new Map<string, number>();
const movingPaths = new Map<string, string[]>();
const pendingPathWrites = new Map<string, number>();

function overlaps(a: string, b: string): boolean {
  const inside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  return inside(a, b) || inside(b, a);
}

/** Raw-path writers (including coordinator attachments) share move admission. */
export function beginWorktreeMutation(worktreePath: string): () => void {
  const canonical = canonicalWorktreePath(worktreePath);
  for (const [id, paths] of movingPaths) {
    if (paths.some((moving) => overlaps(canonical, moving))) {
      if (recoveryPending.has(id))
        throw new Error(
          "Move recovery is pending. Restart Orkestrator before editing this worktree.",
        );
      throw new Error("Environment is being moved; retry the file write when the move finishes");
    }
  }
  pendingPathWrites.set(canonical, (pendingPathWrites.get(canonical) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingPathWrites.get(canonical) ?? 1) - 1;
    if (remaining) pendingPathWrites.set(canonical, remaining);
    else pendingPathWrites.delete(canonical);
  };
}

export function bindEnvironmentMovePaths(environmentId: string, paths: readonly string[]): void {
  const canonical = paths.map(canonicalWorktreePath);
  for (const pending of pendingPathWrites.keys()) {
    if (canonical.some((moving) => overlaps(pending, moving)))
      throw new Error("A file mutation is in progress; retry the move when it finishes");
  }
  movingPaths.set(environmentId, canonical);
}

export function setEnvironmentMoveRecoveryPending(environmentId: string, pending: boolean): void {
  if (pending) recoveryPending.add(environmentId);
  else {
    recoveryPending.delete(environmentId);
    if (!movingEnvironments.has(environmentId)) movingPaths.delete(environmentId);
  }
}

/** Held until a file write or worker start acknowledges, before any await. */
export function beginEnvironmentMutation(environmentId: string): () => void {
  assertEnvironmentNotMoving(environmentId);
  pendingMutations.set(environmentId, (pendingMutations.get(environmentId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingMutations.get(environmentId) ?? 1) - 1;
    if (remaining) pendingMutations.set(environmentId, remaining);
    else pendingMutations.delete(environmentId);
  };
}

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
  if (pendingMutations.has(environmentId))
    throw new Error(
      "A file mutation or worker start is in progress; retry the move when it finishes",
    );
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
  if (!recoveryPending.has(environmentId)) movingPaths.delete(environmentId);
}

export function assertEnvironmentNotMoving(environmentId: string | undefined): void {
  if (environmentId && recoveryPending.has(environmentId))
    throw new Error(
      "Move recovery is pending. Restart Orkestrator before editing or starting work in this environment.",
    );
  if (environmentId && movingEnvironments.has(environmentId)) {
    throw new Error(`Environment is being moved: ${environmentId}`);
  }
}

export function assertEnvironmentAcceptsAgentWork(environmentId: string): void {
  if (recoveryPending.has(environmentId)) assertEnvironmentNotMoving(environmentId);
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
