/**
 * Background recovery of turn ends whose capture timed out (#2047).
 *
 * A turn's end capture has `finalizationDeadlineMs` (30 s). A turn that wrote
 * tens of thousands of files can run past it on a busy host, and then ends as
 * `end-unavailable` with no after endpoint: no restorable measurement, for
 * exactly the turns a user most wants to undo. This scheduler retries the
 * capture after the turn ended, without holding it, with a longer deadline,
 * a bounded number of times. A publish appends a superseding `later-recovery`
 * measurement ({@link TurnBoundaryService.recoverEnd}).
 *
 * A turn is retried only while its known writers have settled (a turn whose
 * writers were unresolved is offered again when they settle) and while no
 * other turn on the worktree has run since it ended. A new turn's start
 * cancels a running retry, so the retry never delays it.
 *
 * Every timer and running attempt stops on {@link stop}, which the service
 * calls on shutdown. With manual scheduling (tests) nothing is scheduled;
 * callers drive {@link attempt} themselves.
 */

import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ChangeLedger } from "./change-ledger.js";
import type { ChangeTrackingPolicyRegistry } from "./policy-registry.js";
import type { EndRecoveryResult, TurnBoundaryService } from "./turn-boundaries.js";

const log = createLogger("change-tracking");

/** Turns a restart re-offers, newest first. Older ones keep their unavailable end. */
const RESUME_LIMIT = 32;

export interface TurnEndRecoveryDeps {
  ledger: ChangeLedger;
  turns: TurnBoundaryService;
  policies: ChangeTrackingPolicyRegistry;
  /** Whether every known writer of the turn has reported terminal. */
  writersSettled: (turnId: string) => boolean;
  /** An environment being deleted: its turns are not recovered. */
  environmentDeleted: (environmentId: string) => boolean;
  /** Resource keys a recovery advanced. */
  onRecovered: (keys: string[]) => void;
  /** False in tests that drive work explicitly. */
  automatic: boolean;
}

interface Pending {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TurnEndRecoveryScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly idleWaiters: Array<() => void> = [];
  private stopped = false;

  constructor(private readonly deps: TurnEndRecoveryDeps) {}

  /**
   * Offer a turn for a background retry. Called when a turn ends and again
   * when its writers settle later; a turn not eligible, or already offered,
   * is ignored.
   */
  offer(turnId: string): void {
    if (!this.deps.automatic || this.stopped || this.pending.has(turnId)) return;
    if (!this.deps.turns.endRecoveryEligible(turnId)) return;
    const entry: Pending = { attempts: 0, timer: null };
    this.pending.set(turnId, entry);
    this.arm(turnId, entry);
  }

  /** After a restart: re-offer the newest turns a previous process left unrecovered. */
  resume(): void {
    if (!this.deps.automatic || this.stopped) return;
    for (const turn of this.deps.ledger.turnsAwaitingEndRecovery(RESUME_LIMIT))
      this.offer(turn.turn_id);
  }

  /**
   * One attempt now. Public so tests and manual scheduling can drive it; the
   * scheduler's own retries go through the same path.
   */
  async attempt(turnId: string): Promise<EndRecoveryResult> {
    const turn = this.deps.ledger.turn(turnId);
    if (!turn) return { kind: "done", reason: "not-eligible" };
    if (this.deps.environmentDeleted(turn.environment_id))
      return { kind: "done", reason: "environment-deleted" };
    // Offered again by the service once the last writer reports terminal.
    if (!this.deps.writersSettled(turnId)) return { kind: "done", reason: "writers-unresolved" };
    const result = await this.deps.turns.recoverEnd(turnId);
    if (result.kind === "recovered") this.deps.onRecovered(result.keys);
    return result;
  }

  /** Restore invalidates uncaptured endpoints before its first asynchronous write. */
  cancelForRestore(worktreeId: string): void {
    this.deps.ledger.transaction(() => this.deps.ledger.invalidateEndRecoveries(worktreeId));
    this.deps.turns.cancelEndRecovery(worktreeId);
    for (const [turnId, entry] of Array.from(this.pending)) {
      if (this.deps.ledger.turn(turnId)?.worktree_id !== worktreeId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(turnId);
    }
    this.settleIdle();
  }

  /** Resolves once nothing is scheduled or running. */
  idle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Cancel every timer and running attempt. Called by the owner on shutdown. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
    this.deps.turns.cancelAllEndRecoveries();
    this.settleIdle();
  }

  private arm(turnId: string, entry: Pending): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.run(turnId, entry);
    }, this.deps.policies.policy.endRecoveryDelayMs);
    entry.timer.unref?.();
  }

  private async run(turnId: string, entry: Pending): Promise<void> {
    let result: EndRecoveryResult;
    try {
      result = await this.attempt(turnId);
    } catch (error) {
      log.warn("turn.end-recovery-failed", { error: formatLogError(error) });
      result = { kind: "retry", reason: "error" };
    }
    if (this.stopped || this.pending.get(turnId) !== entry) return;
    entry.attempts += 1;
    if (result.kind === "retry") {
      if (entry.attempts < this.deps.policies.policy.endRecoveryAttempts) {
        this.arm(turnId, entry);
        return;
      }
      this.deps.turns.endRecoveryExhausted(turnId);
    }
    log.info("turn.end-recovery", {
      outcome: result.kind === "retry" ? "exhausted" : result.kind,
      reason: result.kind === "recovered" ? null : result.reason,
      attempts: entry.attempts,
    });
    this.pending.delete(turnId);
    this.settleIdle();
  }

  private settleIdle(): void {
    if (this.pending.size > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
