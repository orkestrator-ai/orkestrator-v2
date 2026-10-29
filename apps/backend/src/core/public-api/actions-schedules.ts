import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { decodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { ScheduleInputError, type ScheduleOwner } from "@orkestrator/protocol/scheduled-jobs";
import {
  SCHEDULING_DISABLED_MESSAGE,
  scheduleListFilter,
  schedulingEnabled,
  scheduleTimingArgs,
} from "../commands-registry-scheduled-jobs.js";
import {
  normalizeAction,
  ScheduleAuthorityError,
  ScheduleConflictError,
  ScheduledJobCapacityError,
  ScheduleNotFoundError,
  ScheduleStateError,
  type ScheduleCreateInput,
  type ScheduledJobService,
  type ScheduleUpdateInput,
} from "../scheduled-jobs/index.js";
import { PublicActionError } from "./errors.js";
import { invalid, onlyActionKeys, optionalInteger, requiredId } from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Scheduled jobs for the operator (CLI, app) and Control MCP credentials. A
 * schedule created here is owned by the caller's authority and fires under
 * it: `operator`, or `control-mcp:<id>` with that credential's capability rule
 * re-checked at every fire. A credential sees and manages only its own
 * schedules; the operator manages all of them.
 */

function actor(context: PublicActionContext): ScheduleOwner {
  if (context.authority === "operator") return { kind: "operator" };
  return { kind: "control-mcp", credentialId: context.authority.slice("control-mcp:".length) };
}

async function service(context: PublicActionContext): Promise<ScheduledJobService> {
  const scheduled = context.command.scheduledJobs;
  if (!scheduled)
    throw new PublicActionError("capability-unavailable", "Scheduled jobs are unavailable");
  if (!(await schedulingEnabled(context.command.storage)))
    throw new PublicActionError("capability-unavailable", SCHEDULING_DISABLED_MESSAGE);
  return scheduled;
}

function publicError(error: unknown): unknown {
  if (error instanceof ScheduleNotFoundError)
    return new PublicActionError("not-found", error.message);
  if (error instanceof ScheduleInputError || error instanceof ScheduleStateError) {
    return invalid(error.message);
  }
  if (error instanceof ScheduleAuthorityError) {
    return new PublicActionError("capability-unavailable", error.message);
  }
  if (error instanceof ScheduleConflictError) {
    return new PublicActionError("revision-conflict", error.message);
  }
  if (error instanceof ScheduledJobCapacityError) {
    return new PublicActionError("store-capacity", error.message);
  }
  return error;
}

async function guarded<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw publicError(error);
  }
}

/** The public action shape of `action`: a prompt names its session handle. */
function parseAction(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw invalid("action must be an object");
  const action = { ...(raw as Record<string, unknown>) };
  if (action.kind === "prompt") {
    const session = decodePublicSessionId(action.sessionId);
    if (!session) throw invalid("action.sessionId must be a session handle (ses_...)");
    delete action.sessionId;
    action.environmentId = session.environmentId;
    action.tabId = session.tabId;
  } else if (action.sessionId !== undefined) {
    throw invalid("action.sessionId goes with kind prompt");
  }
  try {
    return normalizeAction(action);
  } catch (error) {
    throw publicError(error);
  }
}

function parseTiming(input: Record<string, unknown>) {
  try {
    return scheduleTimingArgs(input);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

const scheduleList: ReadActionHandler<{
  filter: ReturnType<typeof scheduleListFilter>;
  offset: number;
  limit: number;
}> = {
  kind: "read",
  action: "schedule.list",
  parse(input) {
    onlyActionKeys(input, "schedule.list");
    let filter;
    try {
      filter = scheduleListFilter(input);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    return {
      filter,
      offset: optionalInteger(input, "offset", 0, 100_000) ?? 0,
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems) ?? 100,
    };
  },
  async run(input, context) {
    const all = await guarded(async () =>
      (await service(context)).list(actor(context), input.filter),
    );
    return {
      result: {
        schedules: all.slice(input.offset, input.offset + input.limit),
        total: all.length,
        offset: input.offset,
      },
    };
  },
};

const scheduleGet: ReadActionHandler<{ scheduleId: string }> = {
  kind: "read",
  action: "schedule.get",
  parse(input) {
    onlyActionKeys(input, "schedule.get");
    return { scheduleId: requiredId(input, "scheduleId") };
  },
  async run(input, context) {
    return {
      result: {
        schedule: await guarded(async () =>
          (await service(context)).get(actor(context), input.scheduleId),
        ),
      },
    };
  },
};

const scheduleCreate: MutationActionHandler<ScheduleCreateInput> = {
  kind: "mutation",
  action: "schedule.create",
  parse(input) {
    onlyActionKeys(input, "schedule.create");
    if (input.paused !== undefined && typeof input.paused !== "boolean") {
      throw invalid("paused must be a boolean");
    }
    const value: ScheduleCreateInput = {
      ...parseTiming(input),
      ...(input.paused === true ? { paused: true } : {}),
      action: parseAction(input.action),
    };
    const given = [value.at, value.cron, value.everySeconds].filter((item) => item !== undefined);
    if (given.length !== 1) throw invalid("Give exactly one of at, cron and everySeconds");
    return { value, scope: "schedules", intent: value };
  },
  async prepare(input, context) {
    // Refused before admission when the caller could not run the action.
    const scheduled = await service(context);
    await guarded(() => scheduled.validateFor(actor(context), input.action));
    return {
      async execute(operation) {
        const { job } = await guarded(async () =>
          (await service(context)).create(actor(context), input, operation.operationId),
        );
        return {
          state: "succeeded",
          result: {
            scheduleId: job.id,
            name: job.name,
            state: job.state,
            nextFireAt: job.nextFireAt,
            timeZone: job.timeZone,
          },
        };
      },
    };
  },
};

function scheduleMutation(
  action: "schedule.pause" | "schedule.resume" | "schedule.run" | "schedule.delete",
  run: (
    service: ScheduledJobService,
    owner: ScheduleOwner,
    scheduleId: string,
  ) => Record<string, unknown>,
): MutationActionHandler<{ scheduleId: string }> {
  return {
    kind: "mutation",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      const scheduleId = requiredId(input, "scheduleId");
      return { value: { scheduleId }, scope: `schedule:${scheduleId}`, intent: { scheduleId } };
    },
    async prepare(input, context) {
      const scheduled = await service(context);
      if (action !== "schedule.delete") {
        await guarded(() => scheduled.get(actor(context), input.scheduleId));
      }
      return {
        async execute() {
          return {
            state: "succeeded",
            result: await guarded(async () =>
              run(await service(context), actor(context), input.scheduleId),
            ),
          };
        },
      };
    },
  };
}

const scheduleUpdate: MutationActionHandler<{ scheduleId: string; patch: ScheduleUpdateInput }> = {
  kind: "mutation",
  action: "schedule.update",
  parse(input) {
    onlyActionKeys(input, "schedule.update");
    const scheduleId = requiredId(input, "scheduleId");
    const patch: ScheduleUpdateInput = {
      ...parseTiming(input),
      ...(input.action !== undefined ? { action: parseAction(input.action) } : {}),
    };
    const expectedRevision = optionalInteger(input, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
    if (expectedRevision !== undefined) patch.expectedRevision = expectedRevision;
    const timing = [patch.at, patch.cron, patch.everySeconds].filter((item) => item !== undefined);
    if (timing.length > 1) throw invalid("Give at most one of at, cron and everySeconds");
    return {
      value: { scheduleId, patch },
      scope: `schedule:${scheduleId}`,
      intent: { scheduleId, patch },
    };
  },
  async prepare(input, context) {
    await guarded(async () => (await service(context)).get(actor(context), input.scheduleId));
    return {
      async execute() {
        const job = await guarded(async () =>
          (await service(context)).update(actor(context), input.scheduleId, input.patch),
        );
        return {
          state: "succeeded",
          result: {
            scheduleId: job.id,
            state: job.state,
            nextFireAt: job.nextFireAt,
            revision: job.revision,
          },
        };
      },
    };
  },
};

export const SCHEDULE_HANDLERS: PublicActionHandler[] = [
  scheduleList,
  scheduleGet,
  scheduleCreate,
  scheduleUpdate,
  scheduleMutation("schedule.pause", (scheduled, owner, id) => {
    const job = scheduled.pause(owner, id);
    return { scheduleId: job.id, state: job.state };
  }),
  scheduleMutation("schedule.resume", (scheduled, owner, id) => {
    const job = scheduled.resume(owner, id);
    return { scheduleId: job.id, state: job.state, nextFireAt: job.nextFireAt };
  }),
  scheduleMutation("schedule.run", (scheduled, owner, id) => {
    const { fire } = scheduled.runNow(owner, id);
    return { scheduleId: id, fireId: fire.fireId, state: fire.state };
  }),
  scheduleMutation("schedule.delete", (scheduled, owner, id) => scheduled.delete(owner, id)),
];
