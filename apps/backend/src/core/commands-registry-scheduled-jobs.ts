import type { ScheduleOwner, ScheduleState } from "@orkestrator/protocol/scheduled-jobs";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type {
  ScheduleCreateInput,
  ScheduledJobService,
  ScheduleListFilter,
  ScheduleUpdateInput,
} from "./scheduled-jobs/index.js";

/**
 * Scheduled-job commands for the desktop and web UI, and for the
 * coordinator's schedule tools.
 *
 * The caller is the operator unless backend code attaches a different owner
 * under {@link SCHEDULE_ACTOR}. A symbol key cannot cross the gateway's JSON
 * boundary, so only in-process callers (the coordinator tools, acting for the
 * coordinator their credential authenticated) can act as anyone else.
 */
export const SCHEDULE_ACTOR: unique symbol = Symbol("orkestrator.schedule-actor");

export function withScheduleActor(
  args: Record<string, unknown>,
  actor: ScheduleOwner,
): Record<string, unknown> {
  return Object.assign({ ...args }, { [SCHEDULE_ACTOR]: actor });
}

function actorOf(args: Record<string, unknown>): ScheduleOwner {
  const actor = (args as { [SCHEDULE_ACTOR]?: ScheduleOwner })[SCHEDULE_ACTOR];
  return actor ?? { kind: "operator" };
}

function service(context: CommandContext): ScheduledJobService {
  if (!context.scheduledJobs) throw new Error("Scheduled jobs are unavailable");
  return context.scheduledJobs;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be a whole number`);
  }
  return value;
}

/** The trigger, naming and catch-up fields shared by create and update. */
export function scheduleTimingArgs(
  args: Record<string, unknown>,
): Omit<ScheduleUpdateInput, "action"> {
  const at = optionalString(args, "at");
  const cron = optionalString(args, "cron");
  const everySeconds = optionalInteger(args, "everySeconds");
  const startAt = optionalString(args, "startAt");
  const timeZone = optionalString(args, "timeZone");
  const name = optionalString(args, "name");
  const catchUpMinutes = optionalInteger(args, "catchUpMinutes");
  return {
    ...(at !== undefined ? { at } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(everySeconds !== undefined ? { everySeconds } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(catchUpMinutes !== undefined ? { catchUpMinutes } : {}),
  };
}

export function scheduleCreateArgs(args: Record<string, unknown>): ScheduleCreateInput {
  if (!args.action || typeof args.action !== "object") throw new Error("action is required");
  return {
    ...scheduleTimingArgs(args),
    ...(args.paused === true ? { paused: true } : {}),
    action: args.action as ScheduleCreateInput["action"],
  };
}

const STATES: readonly ScheduleState[] = ["active", "paused", "completed"];
const OWNER_KINDS: readonly ScheduleOwner["kind"][] = [
  "operator",
  "control-mcp",
  "agent",
  "coordinator",
];

export function scheduleListFilter(args: Record<string, unknown>): ScheduleListFilter {
  const projectId = optionalString(args, "projectId");
  const environmentId = optionalString(args, "environmentId");
  const state = optionalString(args, "state");
  const ownerKind = optionalString(args, "ownerKind");
  if (state && !STATES.includes(state as ScheduleState)) throw new Error("state is invalid");
  if (ownerKind && !OWNER_KINDS.includes(ownerKind as ScheduleOwner["kind"])) {
    throw new Error("ownerKind is invalid");
  }
  return {
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(state ? { state: state as ScheduleState } : {}),
    ...(ownerKind ? { ownerKind: ownerKind as ScheduleOwner["kind"] } : {}),
  };
}

export function registerScheduledJobCommands(register: CommandRegistrar): void {
  register("list_scheduled_jobs", (args, context) => ({
    schedules: service(context).list(actorOf(args), scheduleListFilter(args)),
    revision: Date.now(),
  }));
  register("get_scheduled_job", (args, context) =>
    service(context).get(actorOf(args), requiredString(args, "scheduleId")),
  );
  register("create_scheduled_job", async (args, context) => {
    const requestId = optionalString(args, "requestId");
    const { job, replayed } = await service(context).create(
      actorOf(args),
      scheduleCreateArgs(args),
      requestId,
    );
    return { schedule: job, replayed };
  });
  register("update_scheduled_job", async (args, context) => {
    const input: ScheduleUpdateInput = {
      ...scheduleTimingArgs(args),
      ...(args.action !== undefined
        ? { action: args.action as ScheduleUpdateInput["action"] }
        : {}),
      ...(optionalInteger(args, "expectedRevision") !== undefined
        ? { expectedRevision: optionalInteger(args, "expectedRevision") }
        : {}),
    };
    return service(context).update(actorOf(args), requiredString(args, "scheduleId"), input);
  });
  register("pause_scheduled_job", (args, context) =>
    service(context).pause(actorOf(args), requiredString(args, "scheduleId")),
  );
  register("resume_scheduled_job", (args, context) =>
    service(context).resume(actorOf(args), requiredString(args, "scheduleId")),
  );
  register("run_scheduled_job", (args, context) =>
    service(context).runNow(actorOf(args), requiredString(args, "scheduleId")),
  );
  register("delete_scheduled_job", (args, context) =>
    service(context).delete(actorOf(args), requiredString(args, "scheduleId")),
  );
}
