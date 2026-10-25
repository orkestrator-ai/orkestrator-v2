import {
  HOST_UPDATE_IDLE_WAIT,
  isActiveHostUpdateJob,
  isHostVersion,
  isHostUpdateChannel,
  type HostUpdateChannel,
  type HostTask,
  type HostUpdateDrain,
  type HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import type { CommandContext } from "../commands-context.js";
import { HostMaintenanceError, type HostMaintenanceService } from "../host-maintenance.js";
import {
  startGhUpdate,
  startImageUpdate,
  startToolchainRepair,
} from "../host-maintenance-tasks.js";
import { PublicActionError } from "./errors.js";
import { invalid, onlyActionKeys, optionalString } from "./input.js";
import { registerReconciler, type ReconcileFunction } from "./reconciler.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * `host.*`: remote-initiated maintenance of the host running this backend.
 * Records live in `HostMaintenanceService`. An accepted update stays `running`
 * until the reconciler below finds its job finished, which for a successful
 * update is only after the host has restarted on the new version; dependency
 * tasks settle the same way from their task record.
 */

function maintenance(context: PublicActionContext): HostMaintenanceService {
  const service = context.command.hostMaintenance;
  if (!service) {
    throw new PublicActionError("capability-unavailable", "This backend cannot update its host");
  }
  return service;
}

/** Maps a service refusal to its public code; anything else propagates. */
function publicError(error: unknown): unknown {
  if (!(error instanceof HostMaintenanceError)) return error;
  if (error.code === "busy") return new PublicActionError("busy", error.message);
  if (error.code === "invalid-input") return invalid(error.message);
  if (error.code === "not-found") return new PublicActionError("not-found", error.message);
  return new PublicActionError("capability-unavailable", error.message);
}

function requireUpdater(service: HostMaintenanceService): void {
  const { updater } = service.snapshot();
  if (!updater.available) {
    throw new PublicActionError(
      "capability-unavailable",
      updater.reason ?? "The host cannot update itself",
    );
  }
}

const hostStatus: ReadActionHandler<Record<string, never>> = {
  kind: "read",
  action: "host.status",
  parse(input) {
    onlyActionKeys(input, "host.status");
    return {};
  },
  async run(_input, context) {
    return { result: await maintenance(context).detailedSnapshot() };
  },
};

const hostUpdateChannel: MutationActionHandler<{ channel: HostUpdateChannel }> = {
  kind: "mutation",
  action: "host.update.channel",
  parse(input) {
    onlyActionKeys(input, "host.update.channel");
    if (!isHostUpdateChannel(input.channel))
      throw invalid("channel must be stable, beta or unstable");
    const value = { channel: input.channel };
    return { value, scope: "host", intent: value };
  },
  async prepare(input, context) {
    const service = maintenance(context);
    return {
      async execute() {
        try {
          return { state: "succeeded", result: { host: service.setUpdateChannel(input.channel) } };
        } catch (error) {
          throw publicError(error);
        }
      },
    };
  },
};

const hostUpdateCheck: MutationActionHandler<Record<string, never>> = {
  kind: "mutation",
  action: "host.update.check",
  parse(input) {
    onlyActionKeys(input, "host.update.check");
    return { value: {}, scope: "host", intent: {} };
  },
  async prepare(_input, context) {
    const service = maintenance(context);
    requireUpdater(service);
    return {
      async execute() {
        let snapshot;
        try {
          snapshot = service.requestCheck();
        } catch (error) {
          throw publicError(error);
        }
        return {
          state: "succeeded",
          result: { checkRequestId: snapshot.checkRequest?.id ?? null, host: snapshot },
        };
      },
    };
  },
};

interface ApplyInput {
  version: string | null;
  drain: HostUpdateDrain;
  maxWaitSeconds: number | null;
}

const hostUpdateApply: MutationActionHandler<ApplyInput> = {
  kind: "mutation",
  action: "host.update.apply",
  parse(input) {
    onlyActionKeys(input, "host.update.apply");
    if (input.confirm !== true) {
      throw invalid("confirm must be true: installing restarts the host's Orkestrator app");
    }
    const version = optionalString(input, "version", 64) ?? null;
    if (version !== null && !isHostVersion(version)) {
      throw invalid("version must be a release version such as 2.22.0");
    }
    if (input.drain !== undefined && input.drain !== "now" && input.drain !== "when-idle") {
      throw invalid("drain must be now or when-idle");
    }
    const drain: HostUpdateDrain = input.drain === "when-idle" ? "when-idle" : "now";
    let maxWaitSeconds: number | null = null;
    if (input.maxWaitSeconds !== undefined) {
      if (
        !Number.isInteger(input.maxWaitSeconds) ||
        (input.maxWaitSeconds as number) < HOST_UPDATE_IDLE_WAIT.minSeconds ||
        (input.maxWaitSeconds as number) > HOST_UPDATE_IDLE_WAIT.maxSeconds
      ) {
        throw invalid(
          `maxWaitSeconds must be an integer from ${HOST_UPDATE_IDLE_WAIT.minSeconds} to ${HOST_UPDATE_IDLE_WAIT.maxSeconds}`,
        );
      }
      if (drain !== "when-idle") throw invalid("maxWaitSeconds needs drain when-idle");
      maxWaitSeconds = input.maxWaitSeconds as number;
    }
    return {
      value: { version, drain, maxWaitSeconds },
      scope: "host",
      intent: { version, drain, maxWaitSeconds },
    };
  },
  async prepare(input, context) {
    const service = maintenance(context);
    requireUpdater(service);
    const job = service.snapshot().job;
    if (job && isActiveHostUpdateJob(job)) {
      throw new PublicActionError("busy", `An update is already in progress (${job.state})`, {
        details: { jobId: job.id },
      });
    }
    return {
      async execute() {
        let created: HostUpdateJob;
        try {
          service.assertOutcomeCapacity();
          created = service.requestUpdate({
            requestedVersion: input.version,
            drain: input.drain,
            ...(input.maxWaitSeconds !== null ? { maxWaitSeconds: input.maxWaitSeconds } : {}),
          });
        } catch (error) {
          throw publicError(error);
        }
        service.retainOutcome(created.id);
        return {
          state: "running",
          stage: created.state,
          result: { jobId: created.id, fromVersion: created.fromVersion },
        };
      },
    };
  },
};

const hostUpdateCancel: MutationActionHandler<Record<string, never>> = {
  kind: "mutation",
  action: "host.update.cancel",
  parse(input) {
    onlyActionKeys(input, "host.update.cancel");
    return { value: {}, scope: "host", intent: {} };
  },
  async prepare(_input, context) {
    const service = maintenance(context);
    return {
      async execute() {
        try {
          const job = service.cancelUpdate();
          return { state: "succeeded", result: { jobId: job.id, state: job.state } };
        } catch (error) {
          throw publicError(error);
        }
      },
    };
  },
};

/** A mutation that starts a dependency task and settles when the task finishes. */
function taskHandler<I>(
  action: "host.toolchain.repair" | "host.image.update" | "host.gh.update",
  parse: (input: Record<string, unknown>) => I,
  start: (context: CommandContext, input: I) => HostTask,
): MutationActionHandler<I> {
  return {
    kind: "mutation",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      const value = parse(input);
      return { value, scope: "host", intent: value };
    },
    async prepare(input, context) {
      maintenance(context);
      return {
        async execute() {
          try {
            const service = maintenance(context);
            service.assertOutcomeCapacity();
            const task = start(context.command, input);
            service.retainOutcome(task.id);
            return { state: "running", stage: "running", result: { taskId: task.id } };
          } catch (error) {
            throw publicError(error);
          }
        },
      };
    },
  };
}

const hostToolchainRepair = taskHandler(
  "host.toolchain.repair",
  () => ({}),
  (context) => startToolchainRepair(context),
);
const hostImageUpdate = taskHandler(
  "host.image.update",
  () => ({}),
  (context) => startImageUpdate(context),
);
const hostGhUpdate = taskHandler(
  "host.gh.update",
  (input) => {
    if (input.channel !== "pinned" && input.channel !== "latest") {
      throw invalid("channel must be pinned or latest");
    }
    return { channel: input.channel as "pinned" | "latest" };
  },
  (context, input: { channel: "pinned" | "latest" }) =>
    startGhUpdate(context, input.channel, { pinned: context.pinnedGitHubCli }),
);

registerReconciler("host.update.apply", async (record, context) => {
  const jobId = typeof record.result?.jobId === "string" ? record.result.jobId : null;
  const service = context.command.hostMaintenance;
  if (!jobId || !service) {
    return {
      state: "interrupted",
      error: { code: "run-interrupted", message: "The update job record is gone" },
    };
  }
  const job = service.job(jobId);
  if (!job) {
    return {
      state: "interrupted",
      error: { code: "run-interrupted", message: "A newer update replaced this one" },
    };
  }
  const result = {
    jobId: job.id,
    fromVersion: job.fromVersion,
    version: job.targetVersion,
  };
  if (job.state === "succeeded") return { state: "succeeded", stage: "completed", result };
  if (job.state === "failed") {
    return {
      state: "failed",
      stage: "failed",
      result,
      error: { code: "operation-failed", message: job.error ?? "The update failed" },
    };
  }
  if (job.state === "postponed") {
    return {
      state: "failed",
      stage: "postponed",
      result,
      error: {
        code: "operation-failed",
        message:
          "Postponed by someone at the host; the update installs the next time the app quits",
      },
    };
  }
  if (job.state === "cancelled") {
    return {
      state: "cancelled",
      stage: "cancelled",
      result,
      error: { code: "run-cancelled", message: "The update was cancelled before the restart" },
    };
  }
  if (record.stage === job.state && (record.result?.version ?? null) === job.targetVersion) {
    return null;
  }
  return { stage: job.state, result };
});

const reconcileTask: ReconcileFunction = async (record, context) => {
  const taskId = typeof record.result?.taskId === "string" ? record.result.taskId : null;
  const task = taskId ? context.command.hostMaintenance?.task(taskId) : null;
  if (!task) {
    return {
      state: "interrupted",
      error: { code: "run-interrupted", message: "The task record is gone" },
    };
  }
  if (task.state === "succeeded") {
    return {
      state: "succeeded",
      stage: "completed",
      result: { taskId: task.id, ...task.result },
    };
  }
  if (task.state === "failed") {
    return {
      state: "failed",
      stage: "failed",
      error: { code: "operation-failed", message: task.error ?? "The task failed" },
    };
  }
  return null;
};

for (const action of ["host.toolchain.repair", "host.image.update", "host.gh.update"] as const) {
  registerReconciler(action, reconcileTask);
}

export const HOST_HANDLERS: PublicActionHandler[] = [
  hostStatus,
  hostUpdateChannel,
  hostUpdateCheck,
  hostUpdateApply,
  hostUpdateCancel,
  hostToolchainRepair,
  hostImageUpdate,
  hostGhUpdate,
];
