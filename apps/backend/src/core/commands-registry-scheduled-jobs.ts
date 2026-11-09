import type {
  ScheduleOwner,
  SchedulerStatus,
  ScheduleState,
} from "@orkestrator/protocol/scheduled-jobs";
import {
  createScheduledJobCommand,
  deleteScheduledJobCommand,
  getScheduledJobCommand,
  listScheduledJobsCommand,
  pauseScheduledJobCommand,
  resumeScheduledJobCommand,
  runScheduledJobCommand,
  updateScheduledJobCommand,
} from "@orkestrator/protocol/contract/domains/system";
import type { CommandContext, CommandHandler, CommandInvocation } from "./commands-context.js";
import type { CommandRegistrar, DefinedCommandOptions } from "./commands-registry-types.js";
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
 *
 * The commands are defined (plan item 7009), and decoding the arguments keeps
 * only their declared string keys, so the actor is read from the raw
 * arguments before decoding ({@link scheduleActorRegistration}) and reaches
 * the handler on its invocation.
 */
export const SCHEDULE_ACTOR: unique symbol = Symbol("orkestrator.schedule-actor");

export function withScheduleActor(
  args: Record<string, unknown>,
  actor: ScheduleOwner,
): Record<string, unknown> {
  return Object.assign({ ...args }, { [SCHEDULE_ACTOR]: actor });
}

type ScheduleInvocation = CommandInvocation & { readonly [SCHEDULE_ACTOR]?: ScheduleOwner };

/** Moves an in-process caller's actor from the raw arguments onto the invocation. */
const scheduleActorRegistration: DefinedCommandOptions = {
  beforeDecode:
    (run: CommandHandler): CommandHandler =>
    (args, context, invocation) => {
      const actor = (args as { [SCHEDULE_ACTOR]?: ScheduleOwner })[SCHEDULE_ACTOR];
      if (actor === undefined) return run(args, context, invocation);
      const carried: ScheduleInvocation = { ...invocation, [SCHEDULE_ACTOR]: actor };
      return run(args, context, carried);
    },
};

function actorOf(invocation: CommandInvocation | undefined): ScheduleOwner {
  return (invocation as ScheduleInvocation | undefined)?.[SCHEDULE_ACTOR] ?? { kind: "operator" };
}

export const SCHEDULING_DISABLED_MESSAGE =
  "Scheduling is experimental and turned off. Turn it on in Settings → Experimental.";

/**
 * Scheduling is an experimental feature, off unless
 * `global.experimentalScheduling` is on. While it is off every schedule
 * command and public action is refused, the schedule tools are not offered
 * and nothing fires; stored schedules are kept.
 */
export async function schedulingEnabled(
  storage: Pick<CommandContext["storage"], "loadConfig">,
): Promise<boolean> {
  return (await storage.loadConfig()).global.experimentalScheduling === true;
}

async function service(context: CommandContext): Promise<ScheduledJobService> {
  if (!context.scheduledJobs) throw new Error("Scheduled jobs are unavailable");
  if (!(await schedulingEnabled(context.storage))) throw new Error(SCHEDULING_DISABLED_MESSAGE);
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

/**
 * Adds the project's environments to a project filter, so a schedule that
 * prompts or mails one of them is listed with the project (the project's
 * Scheduling tab, `schedule list --project`).
 */
export async function withProjectEnvironments(
  filter: ScheduleListFilter,
  storage: Pick<CommandContext["storage"], "loadEnvironments">,
): Promise<ScheduleListFilter> {
  if (!filter.projectId) return filter;
  const environments = await storage.loadEnvironments();
  return {
    ...filter,
    projectEnvironmentIds: new Set(
      environments
        .filter((environment) => environment.projectId === filter.projectId)
        .map((environment) => environment.id),
    ),
  };
}

/**
 * Whether this backend fires schedules. The scheduler fires only while the
 * registry writer lease is held (`isWriter` in `core/index.ts`), so the
 * lease's state is the answer. No writer at all means nothing guards the
 * directory, and the scheduler fires.
 */
export function schedulerStatus(
  writer: Pick<NonNullable<CommandContext["registryWriterLease"]>, "state"> | undefined,
): SchedulerStatus | undefined {
  switch (writer?.state() ?? "held") {
    case "held":
      return { firing: true };
    // A clean shutdown is not evidence that another backend reclaimed ownership.
    case "released":
      return undefined;
    case "lost":
      return { firing: false, reason: "writer-lease-lost" };
    case "busy":
      return { firing: false, reason: "another-backend" };
    case "schema-incompatible":
      return { firing: false, reason: "newer-data-directory" };
  }
}

export function registerScheduledJobCommands(register: CommandRegistrar): void {
  const options = scheduleActorRegistration;
  register(
    listScheduledJobsCommand,
    async (args, context, invocation) => ({
      schedules: (await service(context)).list(
        actorOf(invocation),
        await withProjectEnvironments(scheduleListFilter(args), context.storage),
      ),
      // Additive: a renderer that predates it ignores it and shows no notice.
      scheduler: schedulerStatus(context.registryWriterLease),
      revision: Date.now(),
    }),
    options,
  );
  register(
    getScheduledJobCommand,
    async (args, context, invocation) =>
      (await service(context)).get(actorOf(invocation), requiredString(args, "scheduleId")),
    options,
  );
  register(
    createScheduledJobCommand,
    async (args, context, invocation) => {
      const requestId = optionalString(args, "requestId");
      const { job, replayed } = await (
        await service(context)
      ).create(actorOf(invocation), scheduleCreateArgs(args), requestId);
      return { schedule: job, replayed };
    },
    options,
  );
  register(
    updateScheduledJobCommand,
    async (args, context, invocation) => {
      const input: ScheduleUpdateInput = {
        ...scheduleTimingArgs(args),
        ...(args.action !== undefined
          ? { action: args.action as ScheduleUpdateInput["action"] }
          : {}),
        ...(optionalInteger(args, "expectedRevision") !== undefined
          ? { expectedRevision: optionalInteger(args, "expectedRevision") }
          : {}),
      };
      return (await service(context)).update(
        actorOf(invocation),
        requiredString(args, "scheduleId"),
        input,
      );
    },
    options,
  );
  register(
    pauseScheduledJobCommand,
    async (args, context, invocation) =>
      (await service(context)).pause(actorOf(invocation), requiredString(args, "scheduleId")),
    options,
  );
  register(
    resumeScheduledJobCommand,
    async (args, context, invocation) =>
      (await service(context)).resume(actorOf(invocation), requiredString(args, "scheduleId")),
    options,
  );
  register(
    runScheduledJobCommand,
    async (args, context, invocation) =>
      (await service(context)).runNow(actorOf(invocation), requiredString(args, "scheduleId")),
    options,
  );
  register(
    deleteScheduledJobCommand,
    async (args, context, invocation) =>
      (await service(context)).delete(actorOf(invocation), requiredString(args, "scheduleId")),
    options,
  );
}
