import path from "node:path";
import { canonicalWorktreePath } from "@orkestrator/protocol/node/worktree-paths";
import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";

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

/** Counts one hold on `key` and returns its idempotent release. */
function hold<K>(counts: Map<K, number>, key: K): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(key) ?? 1) - 1;
    if (remaining) counts.set(key, remaining);
    else counts.delete(key);
  };
}

/**
 * One backend's admission fence for environments whose runtime is being
 * replaced or whose worktree is being moved, and for the file writes, worker
 * starts and agent submissions those operations must not race. Owned by
 * `EnvironmentOperations` as `fence` and reached through
 * `context.runtime.environments.fence` at call time.
 *
 * In memory on purpose: a replacement or move runs inside one lifecycle queue
 * task of this backend, and a refusal happens before anything is journaled.
 */
export class EnvironmentMutationFence {
  /**
   * Environments whose runtime is being replaced or reset. For the whole
   * operation — quiescing, copying, validating the candidate — no new agent
   * prompt is dispatched: it would reach a runtime about to stop, or none. The
   * refusal happens before anything is journaled, so the prompt definitely did
   * not run and can simply be sent again.
   */
  private readonly replacing = new Map<string, number>();
  /**
   * Environments whose local worktree is being moved to another folder. Held
   * from admission until the move settles, so a prompt can neither start an
   * agent in the old folder nor race the activity check that admitted the move.
   */
  private readonly moving = new Set<string>();
  private readonly closingTabs = new Map<string, number>();
  private readonly recoveryPending = new Set<string>();
  private readonly pendingMutations = new Map<string, number>();
  private readonly movingPaths = new Map<string, string[]>();
  private readonly pendingPathWrites = new Map<string, number>();
  private readonly pendingAgentWork = new Map<string, number>();

  isBeingReplaced(environmentId: string): boolean {
    return (this.replacing.get(environmentId) ?? 0) > 0;
  }

  async withReplacement<T>(environmentId: string, run: () => Promise<T>): Promise<T> {
    const release = hold(this.replacing, environmentId);
    try {
      return await run();
    } finally {
      release();
    }
  }

  /** Refuse new submissions throughout a coordinator close's safety read and durable removal. */
  beginTabClose(environmentId: string): () => void {
    this.assertAcceptsAgentWork(environmentId);
    if (this.pendingAgentWork.has(environmentId))
      throw new Error("An agent submission is in progress; retry closing after it finishes");
    return hold(this.closingTabs, environmentId);
  }

  /** Raw-path writers (including coordinator attachments) share move admission. */
  beginWorktreeMutation(worktreePath: string): () => void {
    const canonical = canonicalWorktreePath(worktreePath);
    for (const [id, paths] of this.movingPaths) {
      if (paths.some((moving) => overlaps(canonical, moving))) {
        if (this.recoveryPending.has(id))
          throw new Error(
            "Move recovery is pending. Restart Orkestrator before editing this worktree.",
          );
        throw new Error("Environment is being moved; retry the file write when the move finishes");
      }
    }
    return hold(this.pendingPathWrites, canonical);
  }

  bindMovePaths(environmentId: string, paths: readonly string[]): void {
    const canonical = paths.map(canonicalWorktreePath);
    for (const pending of this.pendingPathWrites.keys()) {
      if (canonical.some((moving) => overlaps(pending, moving)))
        throw new Error("A file mutation is in progress; retry the move when it finishes");
    }
    this.movingPaths.set(environmentId, canonical);
  }

  setMoveRecoveryPending(environmentId: string, pending: boolean): void {
    if (pending) this.recoveryPending.add(environmentId);
    else {
      this.recoveryPending.delete(environmentId);
      if (!this.moving.has(environmentId)) this.movingPaths.delete(environmentId);
    }
  }

  /** Held until a file write or worker start acknowledges, before any await. */
  beginMutation(environmentId: string): () => void {
    this.assertNotMoving(environmentId);
    return hold(this.pendingMutations, environmentId);
  }

  /** Synchronous admission, held through setup and dispatch acknowledgement. */
  beginAgentWork(environmentId: string): () => void {
    this.assertAcceptsAgentWork(environmentId);
    return hold(this.pendingAgentWork, environmentId);
  }

  isBeingMoved(environmentId: string): boolean {
    return this.moving.has(environmentId);
  }

  /** Reserves the move fence; false when a move of this environment is already admitted. */
  beginMove(environmentId: string): boolean {
    if (this.moving.has(environmentId)) return false;
    if (this.closingTabs.has(environmentId))
      throw new Error("A tab is being closed; retry the move later");
    if (this.pendingMutations.has(environmentId))
      throw new Error(
        "A file mutation or worker start is in progress; retry the move when it finishes",
      );
    if (this.pendingAgentWork.has(environmentId)) {
      throw new Error(
        "An agent submission is still in progress; wait for it to finish before moving",
      );
    }
    this.moving.add(environmentId);
    return true;
  }

  endMove(environmentId: string): void {
    this.moving.delete(environmentId);
    if (!this.recoveryPending.has(environmentId)) this.movingPaths.delete(environmentId);
  }

  assertNotMoving(environmentId: string | undefined): void {
    if (environmentId && this.recoveryPending.has(environmentId))
      throw new Error(
        "Move recovery is pending. Restart Orkestrator before editing or starting work in this environment.",
      );
    if (environmentId && this.moving.has(environmentId)) {
      throw new Error(`Environment is being moved: ${environmentId}`);
    }
  }

  assertAcceptsAgentWork(environmentId: string): void {
    if (this.closingTabs.has(environmentId))
      throw new Error("A worker tab is being closed; retry the prompt when closing finishes");
    if (this.recoveryPending.has(environmentId)) this.assertNotMoving(environmentId);
    if (this.moving.has(environmentId)) {
      throw new Error(
        "This environment is being moved to a new folder. The prompt was not sent; send it again when the move finishes.",
      );
    }
    if (this.isBeingReplaced(environmentId)) {
      throw new Error(
        formatContainerLifecycleError(
          "operation-in-progress",
          "This environment's container is being rebuilt. The prompt was not sent; send it again when the rebuild finishes.",
        ),
      );
    }
  }
}
