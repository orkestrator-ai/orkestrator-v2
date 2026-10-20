/**
 * Turn and thread boundaries.
 *
 * A turn's start is captured when the backend is about to hand the prompt to
 * the provider — inside the at-most-once dispatch window, before
 * `provider.send` — not when the message was queued and not by aliasing the
 * previous turn's end. An idle edit between turns is therefore preexisting
 * state for the next turn while still belonging to the thread's net result.
 *
 * Lifecycle (persisted in `change_turn_boundaries.lifecycle`):
 *
 *   preparing-start → start-ready | start-unavailable
 *   start-ready | start-unavailable → running   (dispatch accepted)
 *                                   → abandoned (dispatch never started)
 *   running → settling → capturing-end → finalized | end-unavailable
 *   settling → interrupted (known writers unresolved past the budget)
 *
 * The initial executed turn's valid start becomes its thread segment's
 * baseline. A failed initial capture leaves the segment baseline unknown; a
 * later successful turn never silently becomes the whole thread's start. A
 * different worktree lineage opens a new segment.
 */

import { randomUUID } from "node:crypto";
import {
  OwnerFenceError,
  type ChangeLedger,
  type SegmentRow,
  type SnapshotRow,
  type TurnBoundaryRow,
} from "./change-ledger.js";
import { threadIdFor, threadResourceKey, turnResourceKeys } from "./identities.js";
import type { ChangeMeasurementService } from "./measurement-service.js";
import type { ChangeTrackingPolicyRegistry } from "./policy-registry.js";
import type {
  CaptureOutcome,
  WorktreeChangeOwner,
  WorktreeRegistry,
  WorktreeTarget,
} from "./worktree-owner.js";

export interface TurnContext {
  environmentId: string;
  /** Logical session (tab) key; with the environment it names the thread. */
  logicalSessionKey: string;
  /** Dispatch request id; one per user turn. */
  requestId: string;
  provider: string;
  target: WorktreeTarget | null;
  /** Parent segment of a forked conversation (inherited by reference). */
  inheritedFrom?: string | null;
}

export type TurnStartResult =
  | { kind: "ready"; turnId: string; snapshotId: string; dispatchToken: string }
  | { kind: "degraded"; turnId: string; reason: string; dispatchToken: string }
  | { kind: "held"; turnId: string; reason: string }
  | { kind: "untracked"; reason: string };

export function turnIdFor(
  environmentId: string,
  logicalSessionKey: string,
  requestId: string,
): string {
  return `turn_${threadIdFor(environmentId, logicalSessionKey).slice(4)}_${requestId}`.slice(
    0,
    200,
  );
}

const TERMINAL = new Set(["finalized", "interrupted", "end-unavailable", "abandoned"]);

export class TurnBoundaryService {
  private readonly lastProvisional = new Map<string, number>();
  private readonly provisionalRunning = new Set<string>();

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      registry: WorktreeRegistry;
      measurements: ChangeMeasurementService;
      policies: ChangeTrackingPolicyRegistry;
      onPublished?: (resourceKeys: string[]) => void;
    },
  ) {}

  private snapshotRow(id: string | null): SnapshotRow | null {
    return id ? this.deps.ledger.snapshot(id) : null;
  }

  /**
   * Capture the fresh start of a turn before dispatch. Never throws: a
   * failure is recorded before the provider runs, so a later disk read can
   * never invent a pre-turn baseline.
   */
  async prepareTurnStart(context: TurnContext): Promise<TurnStartResult> {
    const { ledger, policies } = this.deps;
    if (!context.target) return { kind: "untracked", reason: "no-worktree" };
    const identity = await this.deps.registry.resolve(context.target).catch(() => null);
    if (!identity) return { kind: "untracked", reason: "worktree-unresolved" };
    const owner = this.deps.registry.owner(identity);
    const threadId = threadIdFor(context.environmentId, context.logicalSessionKey);
    const turnId = turnIdFor(context.environmentId, context.logicalSessionKey, context.requestId);
    const existing = ledger.turn(turnId);
    if (existing?.dispatch_token && existing.lifecycle !== "abandoned") {
      // A retried dispatch of the same request reuses its recorded boundary.
      return existing.start_snapshot_id
        ? {
            kind: "ready",
            turnId,
            snapshotId: existing.start_snapshot_id,
            dispatchToken: existing.dispatch_token,
          }
        : {
            kind: "degraded",
            turnId,
            reason: existing.reason ?? "start-unavailable",
            dispatchToken: existing.dispatch_token,
          };
    }
    const segment = this.ensureSegment(
      threadId,
      context.environmentId,
      identity.worktreeId,
      turnId,
      context.inheritedFrom ?? null,
    );
    const ordinal = ledger.nextTurnOrdinal(threadId);
    if (!existing) {
      ledger.transaction(() =>
        ledger.insertTurn({
          turn_id: turnId,
          segment_id: segment.segment_id,
          thread_id: threadId,
          environment_id: context.environmentId,
          worktree_id: identity.worktreeId,
          lifecycle: "preparing-start",
          start_attempt_id: null,
          start_snapshot_id: null,
          end_snapshot_id: null,
          before_quality: "unknown",
          after_quality: "unknown",
          terminal_evidence: null,
          dispatch_token: null,
          dispatch_receipt: null,
          reason: null,
          started_at: new Date().toISOString(),
          finished_at: null,
          ordinal,
        }),
      );
    }
    if (existing?.lifecycle === "abandoned") {
      ledger.transaction(() => {
        ledger.removeReferences("turn", turnId);
        ledger.updateTurn(turnId, {
          lifecycle: "preparing-start",
          start_snapshot_id: null,
          end_snapshot_id: null,
          dispatch_token: null,
          dispatch_receipt: null,
          reason: null,
          finished_at: null,
          started_at: new Date().toISOString(),
        });
      });
    }
    const release = owner.retain();
    let outcome: CaptureOutcome;
    try {
      outcome = await owner.capture({
        purpose: "turn-start",
        deadlineMs: policies.policy.foregroundBoundaryDeadlineMs,
        boundaryKey:
          existing?.lifecycle === "abandoned"
            ? `turn-start:${turnId}:${randomUUID()}`
            : `turn-start:${turnId}`,
      });
    } finally {
      release();
    }
    const dispatchToken = `dt_${randomUUID()}`;
    if (outcome.kind === "published") {
      const published = outcome;
      try {
        ledger.transaction(() => {
          // The dispatch token is issued only under the fence that captured
          // the start: a holder replaced since then cannot authorize it.
          owner.assertCurrent();
          ledger.updateTurn(turnId, {
            lifecycle: "start-ready",
            start_snapshot_id: published.snapshotId,
            before_quality: "fresh-before",
            dispatch_token: dispatchToken,
          });
          ledger.addReference({
            ownerKind: "turn",
            ownerId: turnId,
            snapshotId: published.snapshotId,
            reason: "turn-start",
          });
          this.stageSegmentBaseline(segment, turnId, published.snapshotId, null);
        });
        return { kind: "ready", turnId, snapshotId: published.snapshotId, dispatchToken };
      } catch (error) {
        if (!(error instanceof OwnerFenceError)) throw error;
        outcome = {
          kind: "unavailable",
          reason: "owner-replaced",
          boundarySeq: published.boundarySeq,
        };
      }
    }
    if (policies.policy.strictCheckpoints) {
      ledger.transaction(() =>
        ledger.updateTurn(turnId, { lifecycle: "start-unavailable", reason: outcome.reason }),
      );
      return { kind: "held", turnId, reason: outcome.reason };
    }
    ledger.transaction(() => {
      ledger.updateTurn(turnId, {
        lifecycle: "start-unavailable",
        before_quality: "unknown",
        reason: outcome.reason,
        dispatch_token: dispatchToken,
      });
      this.stageSegmentBaseline(segment, turnId, null, outcome.reason);
    });
    return { kind: "degraded", turnId, reason: outcome.reason, dispatchToken };
  }

  /**
   * The current open segment for the thread, or a new one when the thread
   * moved to a different worktree lineage. Unrelated roots are never compared
   * as one continuous history.
   */
  private ensureSegment(
    threadId: string,
    environmentId: string,
    worktreeId: string,
    turnId: string,
    inheritedFrom: string | null,
  ): SegmentRow {
    const { ledger } = this.deps;
    return ledger.transaction(() => {
      const current = ledger.currentSegment(threadId);
      if (current && current.worktree_id === worktreeId) {
        if (current.baseline_state === "pending" && !current.initial_turn_id) {
          ledger.updateSegment(current.segment_id, { initial_turn_id: turnId });
          return { ...current, initial_turn_id: turnId };
        }
        return current;
      }
      const parent = !current && inheritedFrom ? ledger.segment(inheritedFrom) : null;
      if (current)
        ledger.updateSegment(current.segment_id, { closed_at: new Date().toISOString() });
      const row: SegmentRow = {
        segment_id: `seg_${randomUUID()}`,
        thread_id: threadId,
        environment_id: environmentId,
        worktree_id: worktreeId,
        initial_turn_id: turnId,
        baseline_snapshot_id: null,
        baseline_state: "pending",
        baseline_reason: current ? "worktree-lineage-changed" : null,
        latest_live_snapshot_id: null,
        final_snapshot_id: null,
        inherited_prefix_id: parent?.segment_id ?? null,
        created_at: new Date().toISOString(),
        closed_at: null,
      };
      ledger.insertSegment(row);
      // The child keeps the parent's history alive by its own references, so
      // deleting the parent never removes bodies the child still shows.
      for (const snapshotId of [
        parent?.baseline_snapshot_id,
        parent?.final_snapshot_id,
        parent?.latest_live_snapshot_id,
      ]) {
        if (snapshotId)
          ledger.addReference({
            ownerKind: "segment",
            ownerId: row.segment_id,
            snapshotId,
            reason: "fork-inherited",
          });
      }
      return row;
    });
  }

  /** Stage (never overwrite) the segment baseline from its initial turn. Inside a transaction. */
  private stageSegmentBaseline(
    segment: SegmentRow,
    turnId: string,
    snapshotId: string | null,
    reason: string | null,
  ): void {
    const { ledger } = this.deps;
    const current = ledger.segment(segment.segment_id);
    if (!current || current.initial_turn_id !== turnId || current.baseline_state !== "pending")
      return;
    if (snapshotId) {
      ledger.updateSegment(segment.segment_id, {
        baseline_snapshot_id: snapshotId,
        baseline_state: "staged",
      });
    } else {
      ledger.updateSegment(segment.segment_id, {
        baseline_state: "unknown",
        baseline_reason: reason ?? "start-unavailable",
      });
    }
  }

  /** Record the dispatch outcome. Only an accepted dispatch activates a staged baseline. */
  markDispatched(turnId: string, outcome: "accepted" | "rejected" | "uncertain"): void {
    const { ledger } = this.deps;
    ledger.transaction(() => {
      const turn = ledger.turn(turnId);
      if (!turn || TERMINAL.has(turn.lifecycle)) return;
      if (outcome === "rejected") {
        ledger.updateTurn(turnId, {
          lifecycle: "abandoned",
          reason: "dispatch-rejected",
          finished_at: new Date().toISOString(),
        });
        const segment = ledger.segment(turn.segment_id);
        if (segment?.initial_turn_id === turnId && segment.baseline_state === "staged") {
          // An unused staged boundary cannot establish thread history.
          ledger.updateSegment(segment.segment_id, {
            baseline_state: "pending",
            baseline_snapshot_id: null,
            initial_turn_id: null,
          });
        }
        return;
      }
      ledger.updateTurn(turnId, {
        lifecycle: "running",
        dispatch_receipt: outcome,
        ...(outcome === "uncertain" ? { reason: "dispatch-uncertain" } : {}),
      });
      const segment = ledger.segment(turn.segment_id);
      if (segment && segment.baseline_state === "staged" && segment.initial_turn_id === turnId) {
        ledger.updateSegment(segment.segment_id, { baseline_state: "active" });
        if (segment.baseline_snapshot_id) {
          ledger.addReference({
            ownerKind: "segment",
            ownerId: segment.segment_id,
            snapshotId: segment.baseline_snapshot_id,
            reason: "thread-baseline",
          });
        }
      } else if (segment && segment.baseline_state === "pending" && !segment.initial_turn_id) {
        // A rejected initial dispatch released the slot; this turn becomes it.
        ledger.updateSegment(segment.segment_id, {
          initial_turn_id: turnId,
          baseline_snapshot_id: turn.start_snapshot_id,
          baseline_state: turn.start_snapshot_id ? "active" : "unknown",
          baseline_reason: turn.start_snapshot_id ? null : (turn.reason ?? "start-unavailable"),
        });
      }
    });
  }

  /** Latest running turn of a thread, for provider evidence association. */
  activeTurn(environmentId: string, logicalSessionKey: string): TurnBoundaryRow | null {
    const turn = this.deps.ledger.latestTurnForThread(
      threadIdFor(environmentId, logicalSessionKey),
    );
    return turn && !TERMINAL.has(turn.lifecycle) ? turn : null;
  }

  /**
   * Finalize after the provider reports the turn settled: capture the end
   * within the finalization budget and publish turn-net and thread-net.
   * `writersSettled` is false when known background writers may still run;
   * the result is then interrupted/provisional, never silently final.
   */
  async finalizeTurn(input: {
    environmentId: string;
    logicalSessionKey: string;
    requestId?: string | null;
    turnId?: string;
    writersSettled: boolean;
    terminalEvidence: string;
  }): Promise<string[]> {
    const { ledger, policies } = this.deps;
    const threadId = threadIdFor(input.environmentId, input.logicalSessionKey);
    const turn = input.turnId
      ? ledger.turn(input.turnId)
      : input.requestId
        ? ledger.turn(turnIdFor(input.environmentId, input.logicalSessionKey, input.requestId))
        : ledger.latestTurnForThread(threadId);
    if (!turn || TERMINAL.has(turn.lifecycle) || turn.lifecycle === "capturing-end") return [];
    ledger.transaction(() =>
      ledger.updateTurn(turn.turn_id, {
        lifecycle: "capturing-end",
        terminal_evidence: input.terminalEvidence,
      }),
    );
    const owner = this.deps.registry.ownerById(turn.worktree_id);
    if (!owner) {
      ledger.transaction(() =>
        ledger.updateTurn(turn.turn_id, {
          lifecycle: "end-unavailable",
          reason: "worktree-removed",
          finished_at: new Date().toISOString(),
        }),
      );
      return this.publishTurn(turn.turn_id, null, input.writersSettled);
    }
    const release = owner.retain();
    let outcome: CaptureOutcome;
    try {
      outcome = await owner.capture({
        purpose: "turn-end",
        deadlineMs: policies.policy.finalizationDeadlineMs,
        boundaryKey: `turn-end:${turn.turn_id}`,
      });
    } finally {
      release();
    }
    if (outcome.kind === "published") {
      ledger.transaction(() => {
        ledger.updateTurn(turn.turn_id, {
          lifecycle: input.writersSettled ? "finalized" : "interrupted",
          end_snapshot_id: outcome.snapshotId,
          after_quality: input.writersSettled ? "after-terminal" : "running-observation",
          finished_at: new Date().toISOString(),
          ...(input.writersSettled ? {} : { reason: "writers-unresolved" }),
        });
        ledger.addReference({
          ownerKind: "turn",
          ownerId: turn.turn_id,
          snapshotId: outcome.snapshotId,
          reason: "turn-end",
        });
        ledger.updateSegment(turn.segment_id, {
          final_snapshot_id: outcome.snapshotId,
          latest_live_snapshot_id: outcome.snapshotId,
        });
        ledger.addReference({
          ownerKind: "segment",
          ownerId: turn.segment_id,
          snapshotId: outcome.snapshotId,
          reason: "thread-latest",
        });
      });
      return this.publishTurn(turn.turn_id, outcome.snapshotId, input.writersSettled);
    }
    ledger.transaction(() =>
      ledger.updateTurn(turn.turn_id, {
        lifecycle: "end-unavailable",
        after_quality: "unknown",
        reason: outcome.reason,
        finished_at: new Date().toISOString(),
      }),
    );
    return this.publishTurn(turn.turn_id, null, input.writersSettled);
  }

  /**
   * Later settlement of an interrupted turn (acceptance H13). Called once
   * every known writer of the turn has reported terminal through a
   * capability that can observe it. Captures a later observation and appends
   * a superseding final measurement whose after boundary is
   * `later-recovery`; the interrupted measurement and the turn's retained
   * end endpoint stay unchanged. Skipped while a newer turn of the thread or
   * any other turn on the worktree is active, whose writes it would absorb.
   */
  async settleInterrupted(turnId: string): Promise<string[]> {
    const { ledger, policies } = this.deps;
    const turn = ledger.turn(turnId);
    if (!turn || turn.lifecycle !== "interrupted" || turn.reason !== "writers-unresolved")
      return [];
    if (ledger.latestTurnForThread(turn.thread_id)?.turn_id !== turnId) return [];
    if (ledger.activeTurns().some((other) => other.worktree_id === turn.worktree_id)) return [];
    const owner = this.deps.registry.ownerById(turn.worktree_id);
    if (!owner) return [];
    const release = owner.retain();
    let outcome: CaptureOutcome;
    try {
      outcome = await owner.capture({
        purpose: "turn-end",
        deadlineMs: policies.policy.finalizationDeadlineMs,
        boundaryKey: `turn-settle:${turnId}`,
      });
    } finally {
      release();
    }
    if (outcome.kind !== "published") return [];
    const snapshotId = outcome.snapshotId;
    const settled = ledger.transaction(() => {
      // Re-check inside the transaction: a concurrent settlement wins once.
      if (ledger.turn(turnId)?.reason !== "writers-unresolved") return false;
      ledger.updateTurn(turnId, { reason: "writers-settled-later" });
      ledger.addReference({
        ownerKind: "turn",
        ownerId: turnId,
        snapshotId,
        reason: "turn-settled",
      });
      ledger.updateSegment(turn.segment_id, {
        final_snapshot_id: snapshotId,
        latest_live_snapshot_id: snapshotId,
      });
      ledger.addReference({
        ownerKind: "segment",
        ownerId: turn.segment_id,
        snapshotId,
        reason: "thread-latest",
      });
      return true;
    });
    return settled ? this.publishTurn(turnId, snapshotId, true, false, true) : [];
  }

  /** Publish turn-net and thread-net for a turn's current endpoints. */
  private async publishTurn(
    turnId: string,
    endSnapshotId: string | null,
    writersSettled: boolean,
    provisional = false,
    /** A later settlement observation, not the turn's own end capture. */
    later = false,
  ): Promise<string[]> {
    const { ledger, measurements } = this.deps;
    const turn = ledger.turn(turnId);
    if (!turn) return [];
    const worktree = ledger.worktree(turn.worktree_id);
    const incarnation = worktree?.incarnation ?? "unknown";
    const owner = this.deps.registry.ownerById(turn.worktree_id);
    const fence = owner ? { assert: () => owner.assertCurrent(), value: owner.ownerFence() } : null;
    const overlap =
      ledger.openWindows(turn.worktree_id).length > 0
        ? ("known-overlap" as const)
        : ("unknown" as const);
    const finality = provisional
      ? ("provisional" as const)
      : writersSettled
        ? ("final" as const)
        : ("interrupted" as const);
    const keys = turnResourceKeys(turnId, null);
    const advanced: string[] = [];
    const turnOutcome = await measurements.measureSnapshots({
      scope: "turn-net",
      owner: { kind: "turn", id: turnId },
      logicalOwner: {
        environmentId: turn.environment_id,
        threadId: turn.thread_id,
        threadSegmentId: turn.segment_id,
        turnId,
      },
      worktreeId: turn.worktree_id,
      incarnation,
      before: this.snapshotRow(turn.start_snapshot_id),
      after: this.snapshotRow(endSnapshotId),
      baselineVersion: null,
      boundary: {
        before: turn.start_snapshot_id ? "fresh-before" : "unknown",
        after: endSnapshotId
          ? later
            ? "later-recovery"
            : provisional
              ? "running-observation"
              : writersSettled
                ? "after-terminal"
                : "running-observation"
          : "unknown",
      },
      finality,
      overlap,
      reasons: turn.reason ? [turn.reason] : [],
      resourceKey: keys.turnNet,
      ownerFence: fence,
    });
    if (turnOutcome.revision !== null) advanced.push(keys.turnNet);
    const segment = ledger.segment(turn.segment_id);
    if (segment) {
      const threadKey = threadResourceKey(segment.segment_id);
      const baseline =
        segment.baseline_state === "active" ? this.snapshotRow(segment.baseline_snapshot_id) : null;
      const threadOutcome = await measurements.measureSnapshots({
        scope: "thread-net",
        owner: { kind: "segment", id: segment.segment_id },
        logicalOwner: {
          environmentId: segment.environment_id,
          threadId: segment.thread_id,
          threadSegmentId: segment.segment_id,
        },
        worktreeId: segment.worktree_id,
        incarnation,
        before: baseline,
        after: this.snapshotRow(endSnapshotId),
        baselineVersion: baseline ? `segment:${segment.segment_id}@${baseline.id}` : null,
        boundary: {
          before: baseline ? "fresh-before" : "unknown",
          after: endSnapshotId
            ? later
              ? "later-recovery"
              : provisional || !writersSettled
                ? "running-observation"
                : "after-terminal"
            : "unknown",
        },
        finality: provisional ? "provisional" : finality,
        overlap,
        reasons: baseline ? [] : [segment.baseline_reason ?? "baseline-unavailable"],
        resourceKey: threadKey,
        ownerFence: fence,
      });
      if (threadOutcome.revision !== null) advanced.push(threadKey);
    }
    this.deps.onPublished?.(advanced);
    return advanced;
  }

  /**
   * Dirty-driven provisional net for a running turn: at most one capture per
   * spacing interval per worktree, no capture when nothing changed. One
   * capture serves every running turn on the physical worktree, including
   * those of other environments aliasing it, each against its own start.
   */
  async provisional(
    environmentId: string,
    owner: WorktreeChangeOwner,
    nowMs = Date.now(),
  ): Promise<string[]> {
    const turns = this.deps.ledger
      .activeTurns()
      .filter(
        (turn) =>
          turn.lifecycle === "running" &&
          (turn.environment_id === environmentId || turn.worktree_id === owner.identity.worktreeId),
      );
    if (turns.length === 0) return [];
    const spacing =
      owner.identity.runtimeKind === "container"
        ? this.deps.policies.policy.provisionalSpacingRemoteMs
        : this.deps.policies.policy.provisionalSpacingLocalMs;
    const key = owner.identity.worktreeId;
    if (this.provisionalRunning.has(key) || nowMs - (this.lastProvisional.get(key) ?? 0) < spacing)
      return [];
    this.provisionalRunning.add(key);
    this.lastProvisional.set(key, nowMs);
    try {
      const outcome = await owner.capture({
        purpose: "provisional",
        deadlineMs: this.deps.policies.policy.foregroundBoundaryDeadlineMs,
      });
      if (outcome.kind !== "published") return [];
      const advanced: string[] = [];
      for (const turn of turns) {
        this.deps.ledger.transaction(() => {
          this.deps.ledger.updateSegment(turn.segment_id, {
            latest_live_snapshot_id: outcome.snapshotId,
          });
          this.deps.ledger.addReference({
            ownerKind: "segment",
            ownerId: turn.segment_id,
            snapshotId: outcome.snapshotId,
            reason: "thread-latest",
          });
          this.deps.ledger.removeReferences("segment-live", turn.segment_id);
          this.deps.ledger.addReference({
            ownerKind: "segment-live",
            ownerId: turn.segment_id,
            snapshotId: outcome.snapshotId,
            reason: "live",
          });
        });
        advanced.push(...(await this.publishTurn(turn.turn_id, outcome.snapshotId, false, true)));
      }
      return advanced;
    } finally {
      this.provisionalRunning.delete(key);
    }
  }

  /**
   * After a restart: abandoned start preparations become unavailable, and
   * reserved captures are abandoned. Running turns keep their original start
   * and are finalized by the next observed settle.
   */
  reconcileAfterRestart(): void {
    const { ledger } = this.deps;
    ledger.transaction(() => {
      for (const attempt of ledger.pendingCaptures()) {
        ledger.finishCapture(attempt.id, "abandoned", { errorCode: "backend-restart" });
      }
      for (const turn of ledger.activeTurns()) {
        if (turn.lifecycle === "preparing-start") {
          ledger.updateTurn(turn.turn_id, {
            lifecycle: "start-unavailable",
            reason: "backend-restart",
          });
        } else if (turn.lifecycle === "capturing-end") {
          ledger.updateTurn(turn.turn_id, {
            lifecycle: "running",
            reason: "end-capture-interrupted",
          });
        }
      }
      for (const window of ledger.allOpenWindows()) {
        ledger.updateWindow(window.window_id, {
          lifecycle: "abandoned",
          reason: "backend-restart",
        });
      }
    });
  }
}
