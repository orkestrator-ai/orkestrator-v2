/**
 * Scheduled jobs: durable, backend-timed actions.
 *
 * A schedule says *when* (a one-shot time, a cron expression or an interval,
 * in an explicit time zone) and *what* (an internal action, a prompt to an
 * existing agent tab, or a new environment launch). The backend owns the
 * timing; nothing depends on an agent session staying alive. Each fire runs
 * with the authority of the schedule's owner, through the same surface the
 * owner used to create it. See `docs/architecture/scheduled-jobs.md`.
 */

import type { GraphLaunchRequest } from "./graphs/launch.js";
import { decodePublicSessionId } from "./public-api-resources.js";
import {
  nextCronFire,
  parseCronExpression,
  resolveOneShotTime,
  ScheduleTimeError,
  isValidTimeZone,
} from "./schedule-time.js";

export const SCHEDULED_JOB_RECORD_VERSION = 1;

export const SCHEDULED_JOB_LIMITS = Object.freeze({
  /** Schedules in one data directory. */
  maxSchedules: 1_000,
  /** Schedules one owner (an environment, a coordinator, a credential) may hold. */
  maxPerOwner: 50,
  /** Fires kept per schedule; pending and running fires are never dropped. */
  historyEntries: 20,
  nameMaxChars: 120,
  promptMaxChars: 100_000,
  /** Interval schedules fire at most once a minute. */
  minIntervalSeconds: 60,
  maxIntervalSeconds: 366 * 24 * 60 * 60,
  /** The catch-up window recorded per schedule, in minutes. */
  defaultCatchUpMinutes: 15,
  maxCatchUpMinutes: 7 * 24 * 60,
  /**
   * Lateness that always counts as on time, whatever the catch-up window:
   * timer slop, a busy event loop, a laptop lid closed for a few seconds.
   */
  onTimeToleranceMs: 60_000,
  /** One serialized action input, in bytes. */
  actionInputMaxBytes: 64 * 1024,
  /** A fire refused because its target was busy is retried for this long. */
  busyRetryWindowMs: 15 * 60_000,
  busyRetryDelayMs: 30_000,
  /** A running fire whose heartbeat is older than this was abandoned by its backend. */
  fireStaleMs: 90_000,
  fireHeartbeatMs: 20_000,
  /** Stale-claim interruptions of one fire before it is failed as interrupted. */
  maxFireAttempts: 3,
});

export type ScheduleTrigger =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string }
  | { kind: "interval"; everySeconds: number; anchorAt: string };

/**
 * Who created a schedule. A fire runs as this owner, re-checked at fire time:
 *
 * - `operator`: the desktop or web UI, the `orkestrator` CLI.
 * - `control-mcp`: one Control MCP operator credential (`control-mcp:<id>`).
 * - `agent`: an agent in an environment, through the agent tools MCP. The
 *   tab is the mailbox the agent acted as when it created the schedule.
 * - `coordinator`: a project coordinator. `role: "main"` schedules belong to
 *   the project's main coordinator and run as whichever conversation is main
 *   at fire time; `side` schedules belong to that side conversation.
 */
export type ScheduleOwner =
  | { kind: "operator" }
  | { kind: "control-mcp"; credentialId: string; label?: string }
  | { kind: "agent"; projectId: string; environmentId: string; tabId: string }
  | {
      kind: "coordinator";
      projectId: string;
      coordinatorId: string;
      conversationId: string;
      role: "main" | "side";
    };

/**
 * What a fire does.
 *
 * - `action`: one call on the owner's own surface. For the operator and
 *   Control MCP credentials `action` is a public action name
 *   (`mail.send`, `ticket.comment`…); for agents and coordinators it is one
 *   of their MCP tools (`send_message`, `start_environment`…). `mail.send` is
 *   accepted everywhere and means "send agent mail as the owner".
 * - `prompt`: a prompt into an existing agent tab (`session.prompt` /
 *   `send_prompt_to_tab`).
 * - `launch`: a new environment with an agent and an initial prompt
 *   (`environment.launch` / `launch_environment`). Without `baseCommit` the
 *   base branch's newest commit is resolved when the schedule fires.
 * - `graph`: a saved graph template launched (item 214) through the graph
 *   launch service as `requestedBy: "schedule"`. The operator's only (the
 *   app, the CLI); a coordinator schedules its own `launch_graph` tool with
 *   `kind: "action"`. Never authoring.
 */
export type ScheduleAction =
  | { kind: "action"; action: string; input: Record<string, unknown> }
  | {
      kind: "prompt";
      environmentId: string;
      tabId: string;
      prompt: string;
      mode?: "plan" | "build";
      nodeId?: string;
    }
  | {
      kind: "launch";
      projectId: string;
      prompt: string;
      agent: string;
      type?: "local" | "container";
      name?: string;
      model?: string;
      reasoning?: string;
      mode?: "plan" | "build";
      baseBranch?: string;
      baseCommit?: string;
      nodeId?: string;
    }
  | { kind: "graph"; request: ScheduleGraphLaunch };

/**
 * A scheduled graph launch: a launch request without its idempotency key
 * (each fire supplies `sched:<fireId>`) and without saving defaults.
 */
export type ScheduleGraphLaunch = Omit<GraphLaunchRequest, "requestId" | "saveDefaults">;

export type ScheduleState = "active" | "paused" | "completed";

/**
 * Why a schedule is paused: by a person, because what it targets was
 * deleted, or because its owner's authority could not be re-established at
 * fire time (a revoked credential, a closed side conversation).
 */
export type SchedulePauseReason = "user" | "target-deleted" | "authority-lost";

export type ScheduleFireState = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type ScheduleFireKind = "scheduled" | "catch-up" | "manual";

export interface ScheduleFireOutcome {
  /** Public operation (`run get`) when the fire went through a public action. */
  operationId?: string;
  messageId?: string;
  environmentId?: string;
  sessionId?: string;
  runId?: string;
  /** The base a launch resolved at fire time. */
  baseBranch?: string;
  baseCommit?: string;
  /** A short, content-free description of what happened. */
  summary?: string;
}

export interface ScheduleFire {
  /** Stable: `<scheduleId>@<slot epoch ms>` or `<scheduleId>@run-<n>`. */
  fireId: string;
  kind: ScheduleFireKind;
  /** The slot this fire stands for (the request time for a manual run). */
  scheduledFor: string;
  state: ScheduleFireState;
  attempts: number;
  /** Stale claims observed; busy refusals do not consume the recovery budget. */
  interruptions?: number;
  /** Earlier slots coalesced into this fire, or skipped with it. */
  missed?: number;
  /** Opaque token of the backend process executing this fire. */
  claimedBy?: string;
  heartbeatAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** A pending fire waiting out a busy target. */
  retryAt?: string;
  error?: { code: string; message: string };
  outcome?: ScheduleFireOutcome;
}

export interface ScheduledJob {
  version: typeof SCHEDULED_JOB_RECORD_VERSION;
  id: string;
  name: string;
  owner: ScheduleOwner;
  /** {@link scheduleOwnerKey} of `owner`: the indexed row owner. */
  ownerKey: string;
  /** Human label of the owner, as of creation. */
  ownerLabel: string;
  trigger: ScheduleTrigger;
  timeZone: string;
  action: ScheduleAction;
  /** Missed fires later than this are skipped instead of run late. */
  catchUpMinutes: number;
  state: ScheduleState;
  pausedReason?: SchedulePauseReason;
  pausedMessage?: string;
  /** The next slot, null when nothing is due again (completed or paused one-shot). */
  nextFireAt: string | null;
  /** Bounded, oldest first. */
  fires: ScheduleFire[];
  /** Fires ever started, manual runs included. */
  fireCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** sha256 of the creator's request key and intent; replays return the schedule. */
  createRequest?: { key: string; fingerprint: string };
}

/** The list projection: the schedule without its full history. */
export interface ScheduledJobSummary extends Omit<ScheduledJob, "fires" | "createRequest"> {
  lastFire: ScheduleFire | null;
  activeFire: ScheduleFire | null;
}

export function summarizeScheduledJob(job: ScheduledJob): ScheduledJobSummary {
  const { fires, createRequest: _createRequest, ...rest } = job;
  const settled = [...fires]
    .reverse()
    .find((fire) => fire.state !== "pending" && fire.state !== "running");
  const active = fires.find((fire) => fire.state === "pending" || fire.state === "running");
  return { ...rest, lastFire: settled ?? null, activeFire: active ?? null };
}

/** Owner key: the indexed row owner, used to list and delete one owner's schedules. */
export function scheduleOwnerKey(owner: ScheduleOwner): string {
  switch (owner.kind) {
    case "operator":
      return "operator";
    case "control-mcp":
      return `control-mcp:${owner.credentialId}`;
    case "agent":
      return `env:${owner.environmentId}`;
    case "coordinator":
      return owner.role === "main"
        ? `coordinator:${owner.coordinatorId}`
        : `coordinator:${owner.coordinatorId}:${owner.conversationId}`;
  }
}

export function scheduleOwnerProjectId(owner: ScheduleOwner): string | undefined {
  return owner.kind === "agent" || owner.kind === "coordinator" ? owner.projectId : undefined;
}

/** Project a schedule's action targets, when it names one. */
export function scheduleActionProjectId(action: ScheduleAction): string | undefined {
  if (action.kind === "launch") return action.projectId;
  if (action.kind === "graph") return action.request.projectId;
  if (action.kind === "action" && typeof action.input.projectId === "string") {
    return action.input.projectId;
  }
  return undefined;
}

/** Environments a schedule's action targets, used to pause it when one is deleted. */
export function scheduleActionEnvironmentIds(action: ScheduleAction): string[] {
  if (action.kind === "prompt") return [action.environmentId];
  if (action.kind === "graph") {
    return action.request.environment.kind === "existing"
      ? [action.request.environment.environmentId]
      : [];
  }
  if (action.kind !== "action") return [];
  const ids: string[] = [];
  for (const key of ["environmentId", "toEnvironmentId"]) {
    const value = action.input[key];
    if (typeof value === "string" && value) ids.push(value);
  }
  const session = decodePublicSessionId(action.input.sessionId);
  if (session) ids.push(session.environmentId);
  return ids;
}

// ---------------------------------------------------------------------------
// Trigger input

export interface ScheduleTriggerInput {
  /** One-shot: `HH:MM`, `YYYY-MM-DDTHH:MM`, an ISO time with an offset, or `+15m`. */
  at?: string;
  /** Five-field cron expression or a macro such as `@daily`. */
  cron?: string;
  /** Fixed interval in seconds (at least 60). */
  everySeconds?: number;
  /** First interval slot; defaults to now + interval. Same forms as `at`. */
  startAt?: string;
}

export class ScheduleInputError extends Error {}

/** Normalizes a trigger, resolving one-shot and interval times against `nowMs`. */
export function normalizeScheduleTrigger(
  input: ScheduleTriggerInput,
  timeZone: string,
  nowMs: number,
): ScheduleTrigger {
  const given = [
    input.at !== undefined,
    input.cron !== undefined,
    input.everySeconds !== undefined,
  ];
  if (given.filter(Boolean).length !== 1) {
    throw new ScheduleInputError("Give exactly one of at, cron or everySeconds");
  }
  try {
    if (input.at !== undefined) {
      const at = resolveOneShotTime(input.at, timeZone, nowMs);
      if (at <= nowMs) throw new ScheduleInputError("at must be in the future");
      return { kind: "once", at: new Date(at).toISOString() };
    }
    if (input.cron !== undefined) {
      const cron = parseCronExpression(input.cron);
      if (nextCronFire(cron, timeZone, nowMs) === null) {
        throw new ScheduleInputError("That cron expression never fires");
      }
      return { kind: "cron", expression: cron.source };
    }
    const everySeconds = input.everySeconds!;
    if (
      !Number.isInteger(everySeconds) ||
      everySeconds < SCHEDULED_JOB_LIMITS.minIntervalSeconds ||
      everySeconds > SCHEDULED_JOB_LIMITS.maxIntervalSeconds
    ) {
      throw new ScheduleInputError(
        `everySeconds must be a whole number from ${SCHEDULED_JOB_LIMITS.minIntervalSeconds} to ${SCHEDULED_JOB_LIMITS.maxIntervalSeconds}`,
      );
    }
    const anchor =
      input.startAt !== undefined
        ? resolveOneShotTime(input.startAt, timeZone, nowMs)
        : nowMs + everySeconds * 1000;
    return { kind: "interval", everySeconds, anchorAt: new Date(anchor).toISOString() };
  } catch (error) {
    if (error instanceof ScheduleTimeError) throw new ScheduleInputError(error.message);
    throw error;
  }
}

export function normalizeTimeZone(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (!isValidTimeZone(value)) throw new ScheduleInputError(`Unknown time zone "${String(value)}"`);
  return value;
}

/** The first slot strictly after `afterMs`, or null when there is none. */
export function nextScheduleSlot(
  trigger: ScheduleTrigger,
  timeZone: string,
  afterMs: number,
): number | null {
  switch (trigger.kind) {
    case "once": {
      const at = Date.parse(trigger.at);
      return at > afterMs ? at : null;
    }
    case "cron":
      return nextCronFire(parseCronExpression(trigger.expression), timeZone, afterMs);
    case "interval": {
      const anchor = Date.parse(trigger.anchorAt);
      const every = trigger.everySeconds * 1000;
      if (anchor > afterMs) return anchor;
      const steps = Math.floor((afterMs - anchor) / every) + 1;
      return anchor + steps * every;
    }
  }
}

/** Plain-language description of a trigger, for lists and tool results. */
export function describeScheduleTrigger(trigger: ScheduleTrigger, timeZone: string): string {
  switch (trigger.kind) {
    case "once":
      return `once at ${trigger.at}`;
    case "cron":
      return `cron "${trigger.expression}" (${timeZone})`;
    case "interval": {
      const seconds = trigger.everySeconds;
      const text =
        seconds % 86_400 === 0
          ? `${seconds / 86_400}d`
          : seconds % 3_600 === 0
            ? `${seconds / 3_600}h`
            : seconds % 60 === 0
              ? `${seconds / 60}m`
              : `${seconds}s`;
      return `every ${text}`;
    }
  }
}

export function isScheduleFireSettled(fire: ScheduleFire): boolean {
  return fire.state === "succeeded" || fire.state === "failed" || fire.state === "skipped";
}
