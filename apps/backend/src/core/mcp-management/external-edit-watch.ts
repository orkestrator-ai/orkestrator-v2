/**
 * The external-edit rule (`external-edits.ts`) for operations no other pass
 * reads.
 *
 * The evidence pass re-reads the source of every operation it polls, and a
 * queued Codex reload and a re-apply read it before they act. An operation
 * whose waiting runtimes are none of those — OpenCode or container
 * `restart-required`, a `pending-next-turn` runtime with no provider session
 * to poll — would otherwise keep waiting for a change the file no longer holds
 * until the user applied again. This watch re-reads such an operation's source
 * on a slow cadence and retires or notes it the same way. A Codex runtime
 * whose app-server already reloaded the change is held (`heldRuntimes`): it
 * keeps the change until its next reload, so there is nothing to retire and
 * it is not watched.
 *
 * Bounded like the evidence pass: at most {@link EXTERNAL_EDIT_READS_PER_TICK}
 * source reads per tick, each operation at most once per
 * {@link EXTERNAL_EDIT_RECHECK_MS}, and none after {@link EVIDENCE_WINDOW_MS}
 * from when apply was planned. Pacing is in memory: after a backend restart
 * every watched operation is simply due again.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpRuntimeApplyEntry } from "@orkestrator/protocol/mcp-management";

import {
  EVIDENCE_WINDOW_MS,
  operationAwaitsEvidence,
  type CurrentSourceState,
} from "./evidence.js";
import {
  heldRuntimes,
  noteOnce,
  retireSuperseded,
  sourceDrift,
  STILL_TO_TAKE_EFFECT,
} from "./external-edits.js";
import type { StoredOperation } from "./operations-store.js";

export const EXTERNAL_EDIT_RECHECK_MS = 60_000;
export const EXTERNAL_EDIT_READS_PER_TICK = 4;

export interface ExternalEditWatchDeps {
  now: () => number;
  /** A provider whose apply is paused by the rollout gate is not watched. */
  blocked: (provider: AgentPlatform) => boolean;
  /** The saved source as it is now. */
  currentSource: (stored: StoredOperation) => Promise<CurrentSourceState | undefined>;
  /** Persist and publish an operation whose runtimes or message changed. */
  commit: (stored: StoredOperation) => Promise<void>;
}

export class ExternalEditWatch {
  private readonly nextCheck = new Map<string, number>();

  constructor(private readonly deps: ExternalEditWatchDeps) {}

  /** Whether any operation is still watched. Keeps the timer alive. */
  hasWork(operations: readonly StoredOperation[]): boolean {
    const nowMs = this.deps.now();
    return operations.some((stored) => this.watched(stored, nowMs));
  }

  /**
   * Saved operations inside the window with a runtime that could still take
   * the change, which neither the reload queue nor the evidence pass reads.
   */
  private watched(stored: StoredOperation, nowMs: number): boolean {
    const { snapshot, recovery } = stored;
    if (snapshot.phase !== "saved") return false;
    if (this.deps.blocked(snapshot.provider)) return false;
    const queuedAt = Date.parse(recovery.applyQueuedAt ?? "");
    if (!Number.isFinite(queuedAt) || nowMs - queuedAt > EVIDENCE_WINDOW_MS) return false;
    const runtimes = snapshot.apply.runtimes;
    if (runtimes.some((runtime) => runtime.state === "queued" || runtime.state === "applying")) {
      return false;
    }
    if (operationAwaitsEvidence(stored, nowMs)) return false;
    const held = heldRuntimes(stored);
    return runtimes.some(
      (runtime) => STILL_TO_TAKE_EFFECT.has(runtime.state) && !held.has(runtime.runtimeId),
    );
  }

  /** One bounded pass, least recently checked first. Only a failed persist propagates. */
  async check(operations: readonly StoredOperation[]): Promise<void> {
    const nowMs = this.deps.now();
    const watched = operations.filter((stored) => this.watched(stored, nowMs));
    const live = new Set(watched.map((stored) => stored.snapshot.operationId));
    for (const id of Array.from(this.nextCheck.keys())) {
      if (!live.has(id)) this.nextCheck.delete(id);
    }
    const due = watched
      .filter((stored) => (this.nextCheck.get(stored.snapshot.operationId) ?? 0) <= nowMs)
      .sort(
        (a, b) =>
          (this.nextCheck.get(a.snapshot.operationId) ?? 0) -
          (this.nextCheck.get(b.snapshot.operationId) ?? 0),
      )
      .slice(0, EXTERNAL_EDIT_READS_PER_TICK);
    for (const stored of due) {
      this.nextCheck.set(stored.snapshot.operationId, nowMs + EXTERNAL_EDIT_RECHECK_MS);
      const runtimes: McpRuntimeApplyEntry[] = stored.snapshot.apply.runtimes;
      const current = await this.deps.currentSource(stored).catch(() => undefined);
      // A request may have cancelled or replanned while the source was read.
      if (stored.snapshot.apply.runtimes !== runtimes) continue;
      const drift = sourceDrift(stored, current);
      let changed = false;
      if (drift.kind === "superseded") {
        const now = new Date(this.deps.now()).toISOString();
        changed = retireSuperseded(runtimes, drift, now, heldRuntimes(stored));
      } else if (drift.kind === "merged") {
        changed = noteOnce(stored.snapshot, drift.note);
      }
      if (changed) await this.deps.commit(stored);
    }
  }
}
