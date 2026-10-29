import { randomBytes } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/public-api";
import { parseGraphLaunchRequest } from "@orkestrator/protocol/graphs/launch";
import { hostTimeZone } from "@orkestrator/protocol/schedule-time";
import {
  describeScheduleTrigger,
  nextScheduleSlot,
  normalizeScheduleTrigger,
  normalizeTimeZone,
  SCHEDULED_JOB_LIMITS,
  SCHEDULED_JOB_RECORD_VERSION,
  ScheduleInputError,
  scheduleActionEnvironmentIds,
  scheduleActionProjectId,
  scheduleOwnerKey,
  scheduleOwnerProjectId,
  summarizeScheduledJob,
  type ScheduleAction,
  type ScheduleFire,
  type ScheduleGraphLaunch,
  type ScheduleOwner,
  type ScheduleState,
  type ScheduleTriggerInput,
  type ScheduledJob,
  type ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import { requestDigest, ScheduleAuthorityError, type ScheduledJobExecutor } from "./executor.js";
import {
  claimDueFire,
  cloneJob,
  finishJobIfDone,
  heartbeatFire,
  nextAttentionAt,
  pauseJob,
  requestManualFire,
  resumeJob,
  settleFire,
  ScheduleStateError,
  touchJob,
  type FireResult,
} from "./model.js";
import type { ScheduledJobStore } from "./store.js";

/**
 * The backend's scheduler for scheduled jobs.
 *
 * Timing is entirely backend-owned. One timer is armed for the earliest
 * moment any schedule needs attention, capped at {@link SAFETY_TICK_MS} so a
 * schedule written by another backend sharing the data directory, a clock
 * change or a host sleep is noticed promptly. Each tick claims due fires one
 * schedule row at a time, in a storage transaction, then executes the claims
 * outside any transaction, with a heartbeat, and settles each outcome in a
 * second transaction.
 *
 * Only the backend holding the registry writer lease fires
 * (`isWriter`): the same single-writer guard container reconciliation uses.
 * Any backend may create and edit schedules; the writer picks the change up
 * within one safety tick.
 */

export const SAFETY_TICK_MS = 30_000;
const MAX_CONCURRENT_FIRES = 4;

export type ScheduleActor = ScheduleOwner;

export interface ScheduleCreateInput extends ScheduleTriggerInput {
  name?: string;
  timeZone?: string;
  catchUpMinutes?: number;
  paused?: boolean;
  action: ScheduleAction;
}

export interface ScheduleUpdateInput extends ScheduleTriggerInput {
  name?: string;
  timeZone?: string;
  catchUpMinutes?: number;
  action?: ScheduleAction;
  expectedRevision?: number;
}

export interface ScheduleListFilter {
  projectId?: string;
  environmentId?: string;
  state?: ScheduleState;
  ownerKind?: ScheduleOwner["kind"];
}

export class ScheduleNotFoundError extends Error {}
export class ScheduleConflictError extends Error {}

export interface ScheduledJobServiceOptions {
  store: ScheduledJobStore;
  executor: ScheduledJobExecutor;
  /** Whether this backend holds the single-writer lease and may fire. */
  isWriter?: () => boolean;
  now?: () => number;
  defaultTimeZone?: () => string;
  /** Human label of an owner, for lists. */
  ownerLabel?: (owner: ScheduleOwner) => Promise<string> | string;
  log?: (message: string, error?: unknown) => void;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class ScheduledJobService {
  private readonly token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopping = false;
  private ticking: Promise<void> | null = null;
  private rerun = false;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: ScheduledJobServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.wake();
  }

  /** Stops timers; fires already running finish (their claims stay valid). */
  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    await Promise.allSettled(this.inFlight.values());
  }

  /** Re-evaluates now, e.g. after a change or a host resume. */
  wake(): void {
    if (!this.started) return;
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ticking = this.tick()
      .catch((error: unknown) => this.options.log?.("[scheduled-jobs] Tick failed", error))
      .finally(() => {
        this.ticking = null;
        if (this.rerun) {
          this.rerun = false;
          this.wake();
        } else {
          this.arm();
        }
      });
  }

  /** One pass: claim and start everything due. Exposed for tests. */
  async tick(): Promise<void> {
    if (!(this.options.isWriter?.() ?? true)) return;
    const now = this.now();
    for (const job of this.options.store.list()) {
      if (this.inFlight.size >= MAX_CONCURRENT_FIRES) break;
      if (this.inFlight.has(job.id)) continue;
      const attention = nextAttentionAt(job);
      if (attention === null || attention > now) continue;
      let claimed: ScheduleFire | null = null;
      try {
        claimed = this.options.store.mutate(job.id, (current) => {
          if (!current) return { result: null };
          const claim = claimDueFire(current, now, this.token);
          return claim.job ? { result: claim.fire, value: claim.job } : { result: null };
        });
      } catch (error) {
        this.options.log?.(`[scheduled-jobs] Could not claim ${job.id}`, error);
        continue;
      }
      if (claimed) this.startFire(job.id, claimed);
    }
  }

  /** Resolves when every fire started so far has settled. Tests only. */
  async idle(): Promise<void> {
    while (this.ticking || this.inFlight.size > 0) {
      await this.ticking?.catch(() => undefined);
      await Promise.allSettled(this.inFlight.values());
    }
  }

  private arm(): void {
    if (!this.started) return;
    let delay = SAFETY_TICK_MS;
    const now = this.now();
    const canClaim =
      (this.options.isWriter?.() ?? true) && this.inFlight.size < MAX_CONCURRENT_FIRES;
    for (const job of canClaim ? this.options.store.list() : []) {
      if (this.inFlight.has(job.id)) continue;
      const attention = nextAttentionAt(job);
      if (attention !== null) delay = Math.min(delay, Math.max(0, attention - now));
    }
    this.timer = setTimeout(() => this.wake(), Math.max(delay, 50));
    (this.timer as { unref?: () => void }).unref?.();
  }

  private startFire(scheduleId: string, fire: ScheduleFire): void {
    const run = this.runFire(scheduleId, fire).finally(() => {
      this.inFlight.delete(scheduleId);
      this.wake();
    });
    this.inFlight.set(scheduleId, run);
  }

  private async runFire(scheduleId: string, fire: ScheduleFire): Promise<void> {
    const job = this.options.store.get(scheduleId);
    if (!job) return;
    const heartbeat = setInterval(() => {
      try {
        this.options.store.mutate(scheduleId, (current) => {
          const next = current && heartbeatFire(current, fire.fireId, this.token, this.now());
          return next ? { result: undefined, value: next } : { result: undefined };
        });
      } catch (error) {
        this.options.log?.(`[scheduled-jobs] Heartbeat failed for ${fire.fireId}`, error);
      }
    }, SCHEDULED_JOB_LIMITS.fireHeartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    let result: FireResult;
    try {
      result = await this.options.executor.execute(job, fire, (base) => {
        this.options.store.mutate(scheduleId, (current) => {
          const next = current && cloneJob(current);
          const held = next?.fires.find((item) => item.fireId === fire.fireId);
          if (!next || !held || held.state !== "running" || held.claimedBy !== this.token) {
            throw new Error("The launch fire claim was lost before dispatch");
          }
          held.outcome = { ...held.outcome, ...base };
          touchJob(next, this.now());
          return { result: undefined, value: next };
        });
      });
    } catch (error) {
      result = {
        ok: false,
        error: {
          code: "fire-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearInterval(heartbeat);
    }
    // A failure while this backend shuts down is usually the shutdown itself
    // (commands refuse new work). Leave the fire running: its heartbeat goes
    // stale and the next backend re-claims it under the same request key.
    if (!result.ok && this.stopping) return;
    try {
      this.options.store.mutate(scheduleId, (current) => {
        const next = current && settleFire(current, fire.fireId, this.token, result, this.now());
        return next ? { result: undefined, value: next } : { result: undefined };
      });
    } catch (error) {
      this.options.log?.(`[scheduled-jobs] Could not record the outcome of ${fire.fireId}`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Reads

  list(actor: ScheduleActor, filter: ScheduleListFilter = {}): ScheduledJobSummary[] {
    return this.options.store
      .list()
      .filter((job) => canSee(actor, job))
      .filter((job) => matches(job, filter))
      .sort((left, right) => sortKey(left).localeCompare(sortKey(right)))
      .map(summarizeScheduledJob);
  }

  get(actor: ScheduleActor, scheduleId: string): ScheduledJob {
    const job = this.options.store.get(scheduleId);
    if (!job || !canSee(actor, job)) throw new ScheduleNotFoundError("Schedule not found");
    const { createRequest: _createRequest, ...visible } = job;
    return visible as ScheduledJob;
  }

  // -------------------------------------------------------------------------
  // Mutations

  /** Refuses an action `owner` could not run, before anything is stored. */
  async validateFor(owner: ScheduleOwner, action: ScheduleAction): Promise<void> {
    await this.options.executor.validate(owner, action);
  }

  /**
   * Creates a schedule owned by `owner`. With `requestKey` the creation is
   * idempotent: the same key and intent return the same schedule, the same
   * key with a different intent is a conflict.
   */
  async create(
    owner: ScheduleOwner,
    input: ScheduleCreateInput,
    requestKey?: string,
  ): Promise<{ job: ScheduledJob; replayed: boolean }> {
    const now = this.now();
    const timeZone = normalizeTimeZone(input.timeZone, this.defaultTimeZone());
    const catchUpMinutes = normalizeCatchUp(input.catchUpMinutes);
    const action = normalizeAction(input.action);
    const ownerKey = scheduleOwnerKey(owner);
    const fingerprint = requestDigest(
      canonicalJson({
        name: input.name ?? null,
        at: input.at ?? null,
        cron: input.cron ?? null,
        everySeconds: input.everySeconds ?? null,
        startAt: input.startAt ?? null,
        timeZone: input.timeZone ?? null,
        catchUpMinutes: input.catchUpMinutes ?? null,
        paused: input.paused ?? false,
        action,
      }),
    );
    const id = requestKey
      ? `sch_${requestDigest("schedule", ownerKey, requestKey).slice(0, 20)}`
      : `sch_${randomBytes(10).toString("hex")}`;
    if (requestKey) {
      const prior = this.options.store.get(id);
      if (prior) return this.replay(prior, fingerprint);
    }
    const trigger = normalizeScheduleTrigger(input, timeZone, now);
    await this.options.executor.validate(owner, action);
    const ownerLabel = (await this.options.ownerLabel?.(owner)) ?? defaultOwnerLabel(owner);
    const nextFireAt = nextScheduleSlot(trigger, timeZone, now);
    const job: ScheduledJob = {
      version: SCHEDULED_JOB_RECORD_VERSION,
      id,
      name: (input.name?.trim() || defaultName(action)).slice(0, SCHEDULED_JOB_LIMITS.nameMaxChars),
      owner,
      ownerKey,
      ownerLabel,
      trigger,
      timeZone,
      action,
      catchUpMinutes,
      state: input.paused ? "paused" : "active",
      ...(input.paused ? { pausedReason: "user" as const } : {}),
      nextFireAt: nextFireAt === null ? null : iso(nextFireAt),
      fires: [],
      fireCount: 0,
      revision: 1,
      createdAt: iso(now),
      updatedAt: iso(now),
      ...(requestKey ? { createRequest: { key: requestKey, fingerprint } } : {}),
    };
    const outcome = this.options.store.mutate(id, (current) => {
      if (current) return { result: { job: current, inserted: false } };
      return { result: { job, inserted: true }, value: job };
    });
    this.wake();
    if (!outcome.inserted) return this.replay(outcome.job, fingerprint);
    return { job: this.strip(outcome.job), replayed: false };
  }

  private replay(
    prior: ScheduledJob,
    fingerprint: string,
  ): { job: ScheduledJob; replayed: boolean } {
    if (prior.createRequest && prior.createRequest.fingerprint !== fingerprint) {
      throw new ScheduleConflictError("requestId was already used to create a different schedule");
    }
    return { job: this.strip(prior), replayed: true };
  }

  async update(
    actor: ScheduleActor,
    scheduleId: string,
    input: ScheduleUpdateInput,
  ): Promise<ScheduledJob> {
    const existing = this.requireManageable(actor, scheduleId);
    const now = this.now();
    const action = input.action ? normalizeAction(input.action) : undefined;
    if (action) {
      if (scheduleOwnerKey(actor) !== existing.ownerKey) {
        throw new ScheduleAuthorityError(
          "Only the schedule's owner can change its action; it always runs as its owner",
        );
      }
      await this.options.executor.validate(existing.owner, action);
    }
    const retimed =
      input.at !== undefined || input.cron !== undefined || input.everySeconds !== undefined;
    const job = this.options.store.mutate(scheduleId, (current) => {
      if (!current) throw new ScheduleNotFoundError("Schedule not found");
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ScheduleConflictError(
          `The schedule changed (revision ${current.revision}); reload it and try again`,
        );
      }
      const next = cloneJob(current);
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new ScheduleInputError("name must not be empty");
        next.name = name.slice(0, SCHEDULED_JOB_LIMITS.nameMaxChars);
      }
      if (input.timeZone !== undefined)
        next.timeZone = normalizeTimeZone(input.timeZone, next.timeZone);
      if (input.catchUpMinutes !== undefined)
        next.catchUpMinutes = normalizeCatchUp(input.catchUpMinutes);
      if (action) next.action = action;
      if (retimed) {
        next.trigger = normalizeScheduleTrigger(input, next.timeZone, now);
      } else if (input.startAt !== undefined) {
        throw new ScheduleInputError("startAt goes with everySeconds");
      }
      if (retimed || input.timeZone !== undefined) {
        const slot = nextScheduleSlot(next.trigger, next.timeZone, now);
        next.nextFireAt = slot === null ? null : iso(slot);
        // A finished one-shot given a new time runs again.
        if (next.state === "completed" && slot !== null) next.state = "active";
      }
      finishJobIfDone(next);
      touchJob(next, now);
      return { result: next, value: next };
    });
    this.wake();
    return this.strip(job);
  }

  pause(actor: ScheduleActor, scheduleId: string): ScheduledJob {
    this.requireManageable(actor, scheduleId);
    const job = this.options.store.mutate(scheduleId, (current) => {
      if (!current) throw new ScheduleNotFoundError("Schedule not found");
      if (current.state === "paused") return { result: current };
      if (current.state === "completed") {
        throw new ScheduleStateError("This schedule has completed; there is nothing to pause");
      }
      const next = pauseJob(cloneJob(current), "user", undefined, this.now());
      return { result: next, value: next };
    });
    this.wake();
    return this.strip(job);
  }

  resume(actor: ScheduleActor, scheduleId: string): ScheduledJob {
    this.requireManageable(actor, scheduleId);
    const job = this.options.store.mutate(scheduleId, (current) => {
      if (!current) throw new ScheduleNotFoundError("Schedule not found");
      if (current.state === "active") return { result: current };
      const next = resumeJob(current, this.now());
      return { result: next, value: next };
    });
    this.wake();
    return this.strip(job);
  }

  /** Fires once now, outside the schedule; the regular slots are unchanged. */
  runNow(actor: ScheduleActor, scheduleId: string): { job: ScheduledJob; fire: ScheduleFire } {
    this.requireManageable(actor, scheduleId);
    const result = this.options.store.mutate(scheduleId, (current) => {
      if (!current) throw new ScheduleNotFoundError("Schedule not found");
      const request = requestManualFire(current, this.now());
      return request.job
        ? { result: { job: request.job, fire: request.fire }, value: request.job }
        : { result: { job: current, fire: request.fire } };
    });
    this.wake();
    return { job: this.strip(result.job), fire: result.fire };
  }

  delete(actor: ScheduleActor, scheduleId: string): { scheduleId: string; deleted: boolean } {
    const job = this.options.store.get(scheduleId);
    if (!job) return { scheduleId, deleted: false };
    if (!canManage(actor, job)) throw new ScheduleNotFoundError("Schedule not found");
    const deleted = this.options.store.mutate(scheduleId, (current) =>
      current ? { result: true, delete: true } : { result: false },
    );
    return { scheduleId, deleted };
  }

  // -------------------------------------------------------------------------
  // Lifecycle of what schedules point at

  /**
   * An environment was deleted: schedules its agents own are deleted with it
   * (their authority, mailbox and credential are gone, and environment
   * deletion removes everything environment-scoped), and other owners'
   * schedules that target it are paused for a person to review.
   */
  environmentDeleted(environmentId: string): { deleted: string[]; paused: string[] } {
    const deleted = this.options.store.deleteByOwner(`env:${environmentId}`);
    const paused = this.pauseWhere(
      (job) => scheduleActionEnvironmentIds(job.action).includes(environmentId),
      `Environment ${environmentId} was deleted`,
    );
    return { deleted, paused };
  }

  /**
   * A coordinator conversation closed. A side conversation's schedules go with
   * it. The main coordinator's schedules belong to the project's coordinator,
   * not to one conversation: they keep running as whichever conversation is
   * main next, the way its open delegations move over.
   */
  coordinatorConversationClosed(coordinatorId: string, conversationId: string): string[] {
    return this.options.store.deleteByOwner(`coordinator:${coordinatorId}:${conversationId}`);
  }

  /** A project was removed: its coordinator's schedules go; schedules aimed at it pause. */
  projectRemoved(projectId: string): { deleted: string[]; paused: string[] } {
    const deleted: string[] = [];
    for (const job of this.options.store.list()) {
      if (job.owner.kind === "coordinator" && job.owner.projectId === projectId) {
        if (
          this.options.store.mutate(job.id, (current) =>
            current ? { result: true, delete: true } : { result: false },
          )
        ) {
          deleted.push(job.id);
        }
      }
    }
    const paused = this.pauseWhere(
      (job) => scheduleActionProjectId(job.action) === projectId,
      `Project ${projectId} was removed`,
    );
    return { deleted, paused };
  }

  private pauseWhere(predicate: (job: ScheduledJob) => boolean, message: string): string[] {
    const paused: string[] = [];
    for (const job of this.options.store.list()) {
      if (job.state !== "active" || !predicate(job)) continue;
      const changed = this.options.store.mutate(job.id, (current) => {
        if (!current || current.state !== "active") return { result: false };
        return {
          result: true,
          value: pauseJob(cloneJob(current), "target-deleted", message, this.now()),
        };
      });
      if (changed) paused.push(job.id);
    }
    return paused;
  }

  // -------------------------------------------------------------------------

  private requireManageable(actor: ScheduleActor, scheduleId: string): ScheduledJob {
    const job = this.options.store.get(scheduleId);
    if (!job || !canManage(actor, job)) throw new ScheduleNotFoundError("Schedule not found");
    return job;
  }

  private strip(job: ScheduledJob): ScheduledJob {
    const { createRequest: _createRequest, ...visible } = job;
    return visible as ScheduledJob;
  }

  private defaultTimeZone(): string {
    return this.options.defaultTimeZone?.() ?? hostTimeZone();
  }
}

// ---------------------------------------------------------------------------
// Visibility: the operator sees and manages everything; every other owner only
// its own schedules. A main coordinator also manages its side agents'.

function canSee(actor: ScheduleActor, job: ScheduledJob): boolean {
  return canManage(actor, job);
}

function canManage(actor: ScheduleActor, job: ScheduledJob): boolean {
  if (actor.kind === "operator") return true;
  const owner = job.owner;
  switch (actor.kind) {
    case "control-mcp":
      return owner.kind === "control-mcp" && owner.credentialId === actor.credentialId;
    case "agent":
      // Sibling tabs already share the environment, its worktree and its user.
      return owner.kind === "agent" && owner.environmentId === actor.environmentId;
    case "coordinator":
      if (owner.kind !== "coordinator" || owner.coordinatorId !== actor.coordinatorId) return false;
      if (actor.role === "main") return true;
      return owner.role === "side" && owner.conversationId === actor.conversationId;
  }
}

function matches(job: ScheduledJob, filter: ScheduleListFilter): boolean {
  if (filter.state && job.state !== filter.state) return false;
  if (filter.ownerKind && job.owner.kind !== filter.ownerKind) return false;
  if (filter.projectId) {
    const projects = [scheduleOwnerProjectId(job.owner), scheduleActionProjectId(job.action)];
    if (!projects.includes(filter.projectId)) return false;
  }
  if (filter.environmentId) {
    const owned = job.owner.kind === "agent" && job.owner.environmentId === filter.environmentId;
    if (!owned && !scheduleActionEnvironmentIds(job.action).includes(filter.environmentId)) {
      return false;
    }
  }
  return true;
}

function sortKey(job: ScheduledJob): string {
  const rank = job.state === "active" ? "0" : job.state === "paused" ? "1" : "2";
  return `${rank}${job.nextFireAt ?? "9"}${job.createdAt}`;
}

function normalizeCatchUp(value: number | undefined): number {
  if (value === undefined) return SCHEDULED_JOB_LIMITS.defaultCatchUpMinutes;
  if (!Number.isInteger(value) || value < 0 || value > SCHEDULED_JOB_LIMITS.maxCatchUpMinutes) {
    throw new ScheduleInputError(
      `catchUpMinutes must be a whole number from 0 to ${SCHEDULED_JOB_LIMITS.maxCatchUpMinutes}`,
    );
  }
  return value;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new ScheduleInputError(`${field} is required`);
  if (value.length > max)
    throw new ScheduleInputError(`${field} must be at most ${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireText(value, field, max).trim();
}

function requireId(value: unknown, field: string): string {
  const text = requireText(value, field, 200).trim();
  if (!ID_PATTERN.test(text)) throw new ScheduleInputError(`${field} is not a valid id`);
  return text;
}

/** Validates the shape of an action; who may run it is the executor's question. */
export function normalizeAction(raw: unknown): ScheduleAction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScheduleInputError("action must be an object");
  }
  const action = raw as Record<string, unknown>;
  const mode = optionalText(action.mode, "mode", 10);
  if (mode !== undefined && mode !== "plan" && mode !== "build") {
    throw new ScheduleInputError("mode must be plan or build");
  }
  const nodeId = optionalText(action.nodeId, "nodeId", 200);
  switch (action.kind) {
    case "action": {
      const name = requireText(action.action, "action.action", 100).trim();
      if (!/^[a-z][a-z0-9_.-]*$/.test(name))
        throw new ScheduleInputError("action.action is not an action name");
      const input = action.input ?? {};
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new ScheduleInputError("action.input must be an object");
      }
      if (Buffer.byteLength(JSON.stringify(input)) > SCHEDULED_JOB_LIMITS.actionInputMaxBytes) {
        throw new ScheduleInputError("action.input is too large");
      }
      const cleaned = { ...(input as Record<string, unknown>) };
      // The fire supplies its own stable request key.
      delete cleaned.requestId;
      return { kind: "action", action: name, input: cleaned };
    }
    case "prompt":
      return {
        kind: "prompt",
        environmentId: requireId(action.environmentId, "action.environmentId"),
        tabId: requireId(action.tabId, "action.tabId"),
        prompt: requireText(action.prompt, "action.prompt", SCHEDULED_JOB_LIMITS.promptMaxChars),
        ...(mode ? { mode: mode as "plan" | "build" } : {}),
        ...(nodeId ? { nodeId } : {}),
      };
    case "launch": {
      const type = optionalText(action.type, "action.type", 20);
      if (type !== undefined && type !== "local" && type !== "container") {
        throw new ScheduleInputError("action.type must be local or container");
      }
      const baseBranch = optionalText(action.baseBranch, "action.baseBranch", 500);
      const baseCommit = optionalText(action.baseCommit, "action.baseCommit", 40);
      if (baseCommit && !/^[0-9a-f]{40}$/i.test(baseCommit)) {
        throw new ScheduleInputError("action.baseCommit must be a full 40-character commit");
      }
      if (baseCommit && !baseBranch)
        throw new ScheduleInputError("action.baseCommit needs action.baseBranch");
      const name = optionalText(action.name, "action.name", 200);
      const model = optionalText(action.model, "action.model", 500);
      const reasoning = optionalText(action.reasoning, "action.reasoning", 100);
      return {
        kind: "launch",
        projectId: requireId(action.projectId, "action.projectId"),
        agent: requireText(action.agent, "action.agent", 40).trim(),
        prompt: requireText(action.prompt, "action.prompt", SCHEDULED_JOB_LIMITS.promptMaxChars),
        ...(type ? { type: type as "local" | "container" } : {}),
        ...(name ? { name } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(mode ? { mode: mode as "plan" | "build" } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...(baseCommit ? { baseCommit: baseCommit.toLowerCase() } : {}),
        ...(nodeId ? { nodeId } : {}),
      };
    }
    case "graph": {
      const raw = action.request;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ScheduleInputError("action.request must be a graph launch request");
      }
      if (Buffer.byteLength(JSON.stringify(raw)) > SCHEDULED_JOB_LIMITS.actionInputMaxBytes) {
        throw new ScheduleInputError("action.request is too large");
      }
      // The fire supplies its own stable request key; a schedule never saves defaults.
      const {
        requestId: _requestId,
        saveDefaults: _saveDefaults,
        ...rest
      } = raw as Record<string, unknown>;
      let request: ScheduleGraphLaunch;
      try {
        request = parseGraphLaunchRequest(rest);
      } catch (error) {
        throw new ScheduleInputError(
          `action.request: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { kind: "graph", request };
    }
    default:
      throw new ScheduleInputError("action.kind must be action, prompt, launch or graph");
  }
}

function defaultName(action: ScheduleAction): string {
  switch (action.kind) {
    case "action": {
      const subject = action.input.subject;
      return typeof subject === "string" && subject.trim() ? subject.trim() : action.action;
    }
    case "prompt":
      return `Prompt ${action.tabId}`;
    case "launch":
      return `Launch ${action.agent}`;
    case "graph": {
      const ref = action.request.ref;
      return `Graph ${ref.scope === "project" ? ref.path : ref.id}`;
    }
  }
}

export function defaultOwnerLabel(owner: ScheduleOwner): string {
  switch (owner.kind) {
    case "operator":
      return "You";
    case "control-mcp":
      return `MCP: ${owner.label ?? owner.credentialId}`;
    case "agent":
      return `Agent ${owner.tabId} in ${owner.environmentId}`;
    case "coordinator":
      return owner.role === "main" ? "Coordinator" : "Coordinator side agent";
  }
}

/** One line for tool results and logs. */
export function describeSchedule(job: ScheduledJob | ScheduledJobSummary): string {
  return `${job.name} (${job.id}): ${describeScheduleTrigger(job.trigger, job.timeZone)}, ${job.state}${
    job.nextFireAt ? `, next ${job.nextFireAt}` : ""
  }`;
}
