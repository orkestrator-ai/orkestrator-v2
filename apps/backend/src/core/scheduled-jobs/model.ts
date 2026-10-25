import { parseCronExpression, previousCronFire } from "@orkestrator/protocol/schedule-time";
import {
  SCHEDULED_JOB_LIMITS,
  SCHEDULED_JOB_RECORD_VERSION,
  isScheduleFireSettled,
  nextScheduleSlot,
  type ScheduleFire,
  type ScheduleFireOutcome,
  type SchedulePauseReason,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";

/**
 * Pure state transitions of one scheduled job. Every function here runs inside
 * a single-row storage transaction (`updateStoreRow`), so it must be
 * synchronous and must not look at anything but its arguments. The service
 * owns timers and execution; this module owns what a fire means.
 */

/** Slots walked when coalescing missed fires; beyond this the count is a lower bound. */
const MAX_MISSED_WALK = 500;

const iso = (ms: number) => new Date(ms).toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts a stored row; anything that does not look like a current record is ignored. */
export function parseScheduledJob(value: unknown): ScheduledJob | null {
  if (!isRecord(value)) return null;
  if (value.version !== SCHEDULED_JOB_RECORD_VERSION) return null;
  if (typeof value.id !== "string" || !isRecord(value.owner) || !isRecord(value.trigger)) {
    return null;
  }
  if (!isRecord(value.action) || !Array.isArray(value.fires)) return null;
  if (typeof value.timeZone !== "string" || typeof value.state !== "string") return null;
  return value as unknown as ScheduledJob;
}

export function cloneJob(job: ScheduledJob): ScheduledJob {
  return structuredClone(job);
}

/** Drops the oldest settled fires beyond the bound; active fires always stay. */
export function trimFires(fires: ScheduleFire[]): ScheduleFire[] {
  const limit = SCHEDULED_JOB_LIMITS.historyEntries;
  if (fires.length <= limit) return fires;
  let excess = fires.length - limit;
  return fires.filter((fire) => {
    if (excess > 0 && isScheduleFireSettled(fire)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function activeFire(job: ScheduledJob): ScheduleFire | undefined {
  return job.fires.find((fire) => fire.state === "running" || fire.state === "pending");
}

function finishIfDone(job: ScheduledJob): void {
  if (job.state === "active" && job.nextFireAt === null && !activeFire(job)) {
    job.state = "completed";
  }
}

function touch(job: ScheduledJob, nowMs: number): void {
  job.revision += 1;
  job.updatedAt = iso(nowMs);
  job.fires = trimFires(job.fires);
}

export interface ClaimResult {
  /** The changed job, or null when nothing changed. */
  job: ScheduledJob | null;
  /** The fire this backend now executes, if any. */
  fire: ScheduleFire | null;
}

/**
 * Decides what is due for `job` at `nowMs` and claims at most one fire for
 * the backend identified by `token`:
 *
 * 1. A running fire whose heartbeat went stale was abandoned by a backend
 *    that stopped; it is re-claimed (its request key makes the re-dispatch
 *    idempotent) or failed as interrupted after too many attempts. A fresh
 *    running fire blocks everything else: one fire per schedule at a time.
 * 2. A pending fire (a manual run, or a retry after a busy target) whose time
 *    has come is claimed.
 * 3. An active schedule whose next slot has passed fires once. When several
 *    slots were missed they are coalesced into the latest one. If even that
 *    is later than the catch-up window (never less than the on-time
 *    tolerance) it is recorded as skipped instead. Either way the next slot
 *    moves strictly past `nowMs`, so missed ticks are never replayed.
 */
export function claimDueFire(job: ScheduledJob, nowMs: number, token: string): ClaimResult {
  const next = cloneJob(job);
  const running = next.fires.find((fire) => fire.state === "running");
  if (running) {
    const heartbeat = Date.parse(running.heartbeatAt ?? running.startedAt ?? running.scheduledFor);
    if (nowMs - heartbeat < SCHEDULED_JOB_LIMITS.fireStaleMs) return { job: null, fire: null };
    running.interruptions = (running.interruptions ?? 0) + 1;
    if (running.interruptions >= SCHEDULED_JOB_LIMITS.maxFireAttempts) {
      running.state = "failed";
      running.finishedAt = iso(nowMs);
      running.error = {
        code: "interrupted",
        message: `The backend running this fire stopped ${running.interruptions} times before it finished`,
      };
      delete running.claimedBy;
      finishIfDone(next);
      touch(next, nowMs);
      return { job: next, fire: null };
    }
    running.claimedBy = token;
    running.heartbeatAt = iso(nowMs);
    running.attempts += 1;
    touch(next, nowMs);
    return { job: next, fire: running };
  }

  const pending = next.fires.find(
    (fire) => fire.state === "pending" && Date.parse(fire.retryAt ?? fire.scheduledFor) <= nowMs,
  );
  if (pending) {
    pending.state = "running";
    pending.claimedBy = token;
    pending.heartbeatAt = iso(nowMs);
    pending.startedAt ??= iso(nowMs);
    pending.attempts += 1;
    delete pending.retryAt;
    touch(next, nowMs);
    return { job: next, fire: pending };
  }

  if (activeFire(next)) return { job: null, fire: null };

  if (next.state !== "active" || next.nextFireAt === null) return { job: null, fire: null };
  const slot = Date.parse(next.nextFireAt);
  if (!Number.isFinite(slot) || slot > nowMs) return { job: null, fire: null };

  let latest = slot;
  let missed = 0;
  let following = nextScheduleSlot(next.trigger, next.timeZone, slot);
  let walked = 0;
  while (following !== null && following <= nowMs && walked < MAX_MISSED_WALK) {
    latest = following;
    missed += 1;
    walked += 1;
    following = nextScheduleSlot(next.trigger, next.timeZone, following);
  }
  if (following !== null && following <= nowMs) {
    // Keep the selected slot current even when the missed count is bounded.
    if (next.trigger.kind === "interval") {
      const period = next.trigger.everySeconds * 1000;
      missed = Math.floor((nowMs - slot) / period);
      latest = slot + missed * period;
    } else if (next.trigger.kind === "cron") {
      latest =
        previousCronFire(parseCronExpression(next.trigger.expression), next.timeZone, nowMs) ??
        latest;
    }
    following = nextScheduleSlot(next.trigger, next.timeZone, nowMs);
  }
  next.nextFireAt = following === null ? null : iso(following);

  const lateness = nowMs - latest;
  const window = Math.max(next.catchUpMinutes * 60_000, SCHEDULED_JOB_LIMITS.onTimeToleranceMs);
  const fireId = `${next.id}@${latest}`;
  if (next.fires.some((fire) => fire.fireId === fireId)) {
    finishIfDone(next);
    touch(next, nowMs);
    return { job: next, fire: null };
  }
  if (lateness > window) {
    next.fires.push({
      fireId,
      kind: "scheduled",
      scheduledFor: iso(latest),
      state: "skipped",
      attempts: 0,
      finishedAt: iso(nowMs),
      ...(missed > 0 ? { missed } : {}),
      error: {
        code: "missed",
        message: `Missed by ${Math.round(lateness / 60_000)} min, beyond the ${next.catchUpMinutes} min catch-up window`,
      },
    });
    finishIfDone(next);
    touch(next, nowMs);
    return { job: next, fire: null };
  }
  const fire: ScheduleFire = {
    fireId,
    kind: lateness > SCHEDULED_JOB_LIMITS.onTimeToleranceMs ? "catch-up" : "scheduled",
    scheduledFor: iso(latest),
    state: "running",
    attempts: 1,
    claimedBy: token,
    heartbeatAt: iso(nowMs),
    startedAt: iso(nowMs),
    ...(missed > 0 ? { missed } : {}),
  };
  next.fires.push(fire);
  next.fireCount += 1;
  touch(next, nowMs);
  return { job: next, fire };
}

/** Refreshes the heartbeat of a fire this backend still holds. */
export function heartbeatFire(
  job: ScheduledJob,
  fireId: string,
  token: string,
  nowMs: number,
): ScheduledJob | null {
  const next = cloneJob(job);
  const fire = next.fires.find((item) => item.fireId === fireId);
  if (!fire || fire.state !== "running" || fire.claimedBy !== token) return null;
  fire.heartbeatAt = iso(nowMs);
  // A heartbeat is bookkeeping, not a change anyone watches: no revision bump.
  return next;
}

export type FireResult =
  | { ok: true; outcome: ScheduleFireOutcome }
  | {
      ok: false;
      error: { code: string; message: string };
      /** The target was busy or not ready; try again shortly. */
      retry?: boolean;
      /** Stop the schedule: its target or its owner's authority is gone. */
      pause?: SchedulePauseReason;
      outcome?: ScheduleFireOutcome;
    };

/**
 * Records a fire's outcome if this backend still holds it. A retryable
 * refusal returns the fire to pending until the busy window closes.
 */
export function settleFire(
  job: ScheduledJob,
  fireId: string,
  token: string,
  result: FireResult,
  nowMs: number,
): ScheduledJob | null {
  const next = cloneJob(job);
  const fire = next.fires.find((item) => item.fireId === fireId);
  if (!fire || fire.state !== "running" || fire.claimedBy !== token) return null;
  delete fire.claimedBy;
  delete fire.heartbeatAt;
  if (result.ok) {
    fire.state = "succeeded";
    fire.finishedAt = iso(nowMs);
    delete fire.error;
    fire.outcome = { ...fire.outcome, ...result.outcome };
  } else {
    const retryAt = nowMs + SCHEDULED_JOB_LIMITS.busyRetryDelayMs;
    const deadline =
      Date.parse(fire.startedAt ?? fire.scheduledFor) + SCHEDULED_JOB_LIMITS.busyRetryWindowMs;
    fire.error = result.error;
    if (result.outcome) fire.outcome = { ...fire.outcome, ...result.outcome };
    if (result.retry && retryAt <= deadline && next.state !== "paused") {
      fire.state = "pending";
      fire.retryAt = iso(retryAt);
    } else {
      fire.state = "failed";
      fire.finishedAt = iso(nowMs);
    }
    if (result.pause) pauseJob(next, result.pause, result.error.message, nowMs, false);
  }
  finishIfDone(next);
  touch(next, nowMs);
  return next;
}

/** Pauses; pending fires are skipped so nothing waits behind the pause. */
export function pauseJob(
  job: ScheduledJob,
  reason: SchedulePauseReason,
  message: string | undefined,
  nowMs: number,
  bump = true,
): ScheduledJob {
  if (job.state === "completed" && reason !== "user") return job;
  job.state = "paused";
  job.pausedReason = reason;
  if (message) job.pausedMessage = message.slice(0, 500);
  else delete job.pausedMessage;
  for (const fire of job.fires) {
    if (fire.state === "pending") {
      fire.state = "skipped";
      fire.finishedAt = iso(nowMs);
      fire.error = { code: "paused", message: "The schedule was paused before this fire ran" };
      delete fire.retryAt;
    }
  }
  if (bump) touch(job, nowMs);
  return job;
}

export class ScheduleStateError extends Error {}

/** Resumes from the next slot after now: time spent paused is never caught up. */
export function resumeJob(job: ScheduledJob, nowMs: number): ScheduledJob {
  const next = cloneJob(job);
  const slot = nextScheduleSlot(next.trigger, next.timeZone, nowMs);
  if (slot === null) {
    throw new ScheduleStateError(
      "This schedule has no future fire time; give it a new time with schedule.update",
    );
  }
  next.state = "active";
  delete next.pausedReason;
  delete next.pausedMessage;
  next.nextFireAt = iso(slot);
  touch(next, nowMs);
  return next;
}

/** Queues one manual fire; a manual fire already waiting is reused, not stacked. */
export function requestManualFire(
  job: ScheduledJob,
  nowMs: number,
): { job: ScheduledJob | null; fire: ScheduleFire } {
  const waiting = job.fires.find((fire) => fire.kind === "manual" && fire.state === "pending");
  if (waiting) return { job: null, fire: waiting };
  const next = cloneJob(job);
  next.fireCount += 1;
  const fire: ScheduleFire = {
    fireId: `${next.id}@run-${next.fireCount}`,
    kind: "manual",
    scheduledFor: iso(nowMs),
    state: "pending",
    attempts: 0,
  };
  next.fires.push(fire);
  touch(next, nowMs);
  return { job: next, fire };
}

/** When this job next needs the scheduler's attention, or null when never. */
export function nextAttentionAt(job: ScheduledJob): number | null {
  let earliest: number | null = null;
  const consider = (value: number) => {
    if (Number.isFinite(value) && (earliest === null || value < earliest)) earliest = value;
  };
  for (const fire of job.fires) {
    if (fire.state === "pending") consider(Date.parse(fire.retryAt ?? fire.scheduledFor));
    if (fire.state === "running") {
      consider(
        Date.parse(fire.heartbeatAt ?? fire.startedAt ?? fire.scheduledFor) +
          SCHEDULED_JOB_LIMITS.fireStaleMs,
      );
    }
  }
  if (!activeFire(job) && job.state === "active" && job.nextFireAt)
    consider(Date.parse(job.nextFireAt));
  return earliest;
}

/** Marks a job changed after an edit by its owner or the operator. */
export function touchJob(job: ScheduledJob, nowMs: number): void {
  touch(job, nowMs);
}

export function finishJobIfDone(job: ScheduledJob): void {
  finishIfDone(job);
}
