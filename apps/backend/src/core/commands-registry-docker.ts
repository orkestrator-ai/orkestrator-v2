import { initialContainerHostReachability } from "@orkestrator/protocol/container-host-reachability";
import { createSharedContainerLogReader } from "./container-log-snapshots.js";
import { detectDockerTopology, getImageStatus } from "./docker-image.js";
import { ensureEnvironmentImage } from "./host-maintenance-tasks.js";
import {
  classify,
  loadProtection,
  parseLabels,
  readContainerLabels,
  removeUnclaimedContainer,
} from "./docker-cleanup-inventory.js";
import { executeDockerCleanup, previewDockerCleanup } from "./docker-cleanup-preview.js";
import { dockerCapacity, sampleContainerUsage } from "./container-resources.js";
import { createLogger, type LogFields } from "@orkestrator/protocol/logger";
import {
  checkContainerHostReachabilityCommand,
  checkDockerCommand,
  closeContainerLogsCommand,
  dockerCleanupExecuteCommand,
  dockerCleanupPreviewCommand,
  dockerContainerStatusCommand,
  dockerRemoveContainerCommand,
  dockerStartContainerCommand,
  dockerStopContainerCommand,
  getContainerHostReachabilityCommand,
  getContainerLogsCommand,
  getContainerUsageCommand,
  getDockerCapacityCommand,
  getDockerImageStatusCommand,
  getDockerSystemStatsCommand,
  getDockerTopologyCommand,
  getOrkestratorContainersCommand,
  openContainerLogsCommand,
  propagateGithubTokenToContainersCommand,
  provisionEnvironmentCommand,
  readContainerLogsCommand,
  reattachContainerCommand,
} from "@orkestrator/protocol/contract/domains/docker";

const log = createLogger("docker");

type DockerAvailabilityDiagnostic = LogFields;
type DockerAvailabilityReporter = (diagnostic: DockerAvailabilityDiagnostic) => void;

/** Largest `get_container_logs` answer, in UTF-8 bytes. */
const CONTAINER_LOG_TAIL_MAX_BYTES = 512 * 1024;
export const CONTAINER_LOG_TRUNCATED_MARKER = "[earlier output truncated]\n";

/** Keeps the end of a log within `max` bytes and says when anything was cut. */
export function boundContainerLogTail(output: string, max = CONTAINER_LOG_TAIL_MAX_BYTES): string {
  if (Buffer.byteLength(output, "utf8") <= max) return output;
  const kept = Buffer.from(output, "utf8")
    .subarray(-(max - Buffer.byteLength(CONTAINER_LOG_TRUNCATED_MARKER)))
    .toString("utf8")
    // A cut inside a multibyte character decodes as replacement characters.
    .replace(/^\uFFFD+/, "");
  return CONTAINER_LOG_TRUNCATED_MARKER + kept;
}
import {
  createOperationId,
  emptyContainerLifecycle,
  ContainerLifecycleError,
  parseContainerMutationIdentity,
} from "@orkestrator/protocol/container-lifecycle";
import {
  advanceContainerOperation,
  nextRuntimeGeneration,
  probeContainer,
  runContainerOperation,
} from "./container-lifecycle-service.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type {
  DockerAvailability,
  DockerUnavailableReason,
} from "@orkestrator/protocol/docker-availability";
import { CommandFailedError, commandExists, runCommand } from "./shell.js";
import { stopRuntimeContainer } from "./egress-gateway.js";
import {
  DOCKER_IMAGE,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_ENVIRONMENT_NAME,
  DOCKER_LABEL_OWNER,
} from "./constants.js";
import { syncRuntimeGitHubCredential } from "./container-github-credential.js";
import { isDockerDaemonUnreachable } from "./docker-cli-errors.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import { resolveContainerGitHubToken } from "./github-credentials.js";
import { createEnvironment } from "./storage.js";
import {
  asString,
  asOptionalString,
  asNumber,
  findEnvironmentByContainerId,
  dockerLabelValue,
  dockerOwnerMatches,
  toClientEnvironment,
  getDockerStatus,
  ensureContainerProjectFilesAccess,
  createDockerContainer,
  enqueueEnvironmentLifecycleOperation,
  assertEnvironmentDeletionNotRequested,
  startAssignedContainerRuntimeTask,
  stopEnvironmentTask,
  resolveOperationImage,
} from "./commands-helpers.js";
import {
  startContainerWithAgentAccounts,
  syncContainerAgentAccountsOnStart,
} from "./agent-accounts-containers.js";

const lastDockerAvailabilityDiagnosticByLogger = new WeakMap<DockerAvailabilityReporter, string>();

function logDockerAvailabilityWarning(
  logWarning: DockerAvailabilityReporter,
  diagnostic: DockerAvailabilityDiagnostic,
): void {
  const key = JSON.stringify(diagnostic);
  if (lastDockerAvailabilityDiagnosticByLogger.get(logWarning) === key) return;
  lastDockerAvailabilityDiagnosticByLogger.set(logWarning, key);
  logWarning(diagnostic);
}

const reportDockerAvailability: DockerAvailabilityReporter = (diagnostic) => {
  log.warn("availability.probe-failed", diagnostic);
};

export function dockerUnavailableReason(error: unknown): DockerUnavailableReason {
  if (error instanceof CommandFailedError && error.timedOut) return "timed-out";

  const message = error instanceof Error ? error.message : String(error);
  if (
    /(?:permission denied|access (?:is )?denied).*?(?:docker daemon socket|unix:\/\/|docker\.sock)|(?:docker daemon socket|unix:\/\/|docker\.sock).*?(?:permission denied|access (?:is )?denied)|dial unix .*connect: permission denied/i.test(
      message,
    )
  ) {
    return "permission-denied";
  }
  return isDockerDaemonUnreachable(message) ? "daemon-unavailable" : "unknown";
}

export async function checkDockerAvailability(
  dependencies: {
    commandExists?: (command: string) => Promise<boolean>;
    runCommand?: typeof runCommand;
    logWarning?: DockerAvailabilityReporter;
  } = {},
): Promise<DockerAvailability> {
  const hasCommand = dependencies.commandExists ?? commandExists;
  const run = dependencies.runCommand ?? runCommand;
  const logWarning = dependencies.logWarning ?? reportDockerAvailability;
  if (!(await hasCommand("docker"))) {
    logDockerAvailabilityWarning(logWarning, { reason: "not-installed", commandExists: false });
    return { available: false, reason: "not-installed" };
  }
  try {
    await run("docker", ["info"], { timeoutMs: 10_000 });
    lastDockerAvailabilityDiagnosticByLogger.delete(logWarning);
    return { available: true, reason: null };
  } catch (error) {
    const reason = dockerUnavailableReason(error);
    const commandFailure = error instanceof CommandFailedError ? error : null;
    // Error messages and custom names can contain daemon endpoints, usernames,
    // or credentials. Keep the persistent diagnostic to fixed-shape metadata.
    const errorType = commandFailure
      ? "CommandFailedError"
      : error instanceof Error
        ? "Error"
        : typeof error;
    logDockerAvailabilityWarning(logWarning, {
      reason,
      commandExists: true,
      errorType,
      timedOut: commandFailure?.timedOut ?? false,
      executableMissing: commandFailure?.executableMissing ?? false,
      exitCode: commandFailure?.exitCode ?? null,
      signal: commandFailure?.signal ?? null,
      dockerHostSet: Boolean(process.env.DOCKER_HOST?.trim()),
      dockerContextSet: Boolean(process.env.DOCKER_CONTEXT?.trim()),
      dockerConfigSet: Boolean(process.env.DOCKER_CONFIG?.trim()),
    });
    return { available: false, reason };
  }
}

export function registerDockerCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  void dependencies;
  register(checkDockerCommand, async (_args, context) => {
    const availability = await checkDockerAvailability();
    // Node summaries relay the answer this machine's own window last saw.
    context.runtime.dockerAvailability.record(availability);
    return availability;
  });
  register(getDockerImageStatusCommand, (_args, context) => getImageStatus(context));
  // Can agents in containers reach the agent tools server? The startup check
  // result, or a fresh check on request ("Check again").
  register(
    getContainerHostReachabilityCommand,
    (_args, context) =>
      context.containerHostReachability?.snapshot() ?? initialContainerHostReachability(),
  );
  register(
    checkContainerHostReachabilityCommand,
    async (_args, context) =>
      (await context.containerHostReachability?.check("manual")) ??
      initialContainerHostReachability(),
  );
  register(getDockerTopologyCommand, ({ refresh }) =>
    detectDockerTopology({ refresh: refresh === true }),
  );
  register(provisionEnvironmentCommand, async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    const identity = parseContainerMutationIdentity(args);
    // Idempotent and serialized: a repeated or concurrent request returns the
    // container the first one created instead of creating another.
    return enqueueEnvironmentLifecycleOperation(id, context, async () => {
      const environment = await context.storage.getEnvironment(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);
      assertEnvironmentDeletionNotRequested(environment, environment.id);
      if (environment.containerId) return environment.containerId;
      await ensureEnvironmentImage(context);
      context.runtime.environments.assertNotDeleting(id);
      const current = await context.storage.getEnvironment(id);
      if (!current) throw new Error(`Environment not found: ${id}`);
      assertEnvironmentDeletionNotRequested(current, id);
      context.runtime.environments.assertNotDeleting(id);
      const outcome = await runContainerOperation(context, id, "create", identity, async (op) => {
        const runtimeGeneration = nextRuntimeGeneration(environment);
        const image = await resolveOperationImage(context);
        await advanceContainerOperation(context, id, op.operationId, {
          phase: "creating",
          details: { generation: runtimeGeneration, ...image },
        });
        const containerId = await createDockerContainer(environment, context, {
          operationId: op.operationId,
          runtimeGeneration,
          imageId: image.imageId,
        });
        await advanceContainerOperation(context, id, op.operationId, {
          phase: "created",
          runtime: {
            containerId,
            runtimeGeneration,
            owner: dockerOwnerNamespace(context.storage.getDataDir()),
            ...image,
            createdByOperationId: op.operationId,
          },
          environment: { containerId },
        });
        return containerId;
      });
      if ("result" in outcome) return outcome.result;
      return (await context.storage.getEnvironment(id))?.containerId ?? null;
    });
  });
  register(dockerStartContainerCommand, async ({ containerId }, context) => {
    const { storage } = context;
    const id = asString(containerId, "containerId");
    const assigned = findEnvironmentByContainerId(await storage.loadEnvironments(), id);
    if (assigned) {
      // An environment's runtime starts through the lifecycle authority.
      await startAssignedContainerRuntimeTask(assigned.id, context);
    } else {
      await startContainerWithAgentAccounts(context, null, id);
      await ensureContainerProjectFilesAccess(id);
    }
    const config = await storage.loadConfig();
    if (context.runtimeFlavor !== "agent-test") {
      await syncRuntimeGitHubCredential(
        assigned ?? null,
        id,
        await resolveContainerGitHubToken(config.global, context.runtime.gitHubCli),
        context,
      );
    }
    await syncContainerAgentAccountsOnStart(context, assigned ?? null, id, config.global);
  });
  register(dockerStopContainerCommand, async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const assigned = findEnvironmentByContainerId(await context.storage.loadEnvironments(), id);
    if (assigned) {
      // Stopping an environment's runtime is the environment's stop.
      await stopEnvironmentTask(assigned.id, context, () => undefined);
      return;
    }
    await stopRuntimeContainer(id);
  });
  register(dockerRemoveContainerCommand, async ({ containerId }, context) => {
    // A supplied id is not a request to discard an environment's workspace.
    // Raw removal is limited to containers nothing claims; an assigned runtime
    // is reset only through `recreate_environment` with an explicit discard,
    // and deleted only through environment deletion.
    const id = asString(containerId, "containerId");
    const outcome = await removeUnclaimedContainer(id, context);
    if (outcome.outcome === "skipped") {
      throw new ContainerLifecycleError(
        outcome.reason === "foreign-owner" ? "not-owned" : "preservation-required",
        outcome.reason === "foreign-owner"
          ? "This container is not owned by this Orkestrator installation."
          : "This container belongs to an environment. Reset or delete the environment instead.",
      );
    }
    if (outcome.outcome === "failed") {
      throw new ContainerLifecycleError("removal-failed", "Docker did not remove the container.");
    }
  });
  register(dockerContainerStatusCommand, async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    return getDockerStatus(id);
  });
  // Initialization views in every client poll this once a second; equivalent
  // tails join and share a short-lived snapshot (container-log-snapshots.ts).
  const readContainerLogs = createSharedContainerLogReader({
    read: async (containerId, tail) =>
      (await runCommand("docker", ["logs", "--tail", tail, containerId], { timeoutMs: 30_000 }))
        .stdout,
  });
  register(getContainerLogsCommand, async ({ containerId, tail }) => {
    // Bounded at the source (line count) and again on the result (bytes), so
    // one enormous line cannot defeat a line-only limit.
    const requested = Number.parseInt(asOptionalString(tail) ?? "200", 10);
    const lines = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 2_000) : 200;
    const output = await readContainerLogs(asString(containerId, "containerId"), String(lines));
    return boundContainerLogTail(output);
  });
  // Follow subscriptions: one shared `docker logs -f` per container, a bounded
  // replay ring, leases and an explicit gap when a client falls behind.
  register(openContainerLogsCommand, ({ containerId }, context) =>
    context.runtime.containerLogs.open(asString(containerId, "containerId")),
  );
  register(readContainerLogsCommand, ({ subscriptionId, sourceId, cursor }, context) =>
    context.runtime.containerLogs.read(
      asString(subscriptionId, "subscriptionId"),
      asString(sourceId, "sourceId"),
      asNumber(cursor, "cursor"),
    ),
  );
  register(closeContainerLogsCommand, ({ subscriptionId }, context) => {
    // Releases the observer only; the container and its processes continue.
    context.runtime.containerLogs.close(asString(subscriptionId, "subscriptionId"));
  });
  register(getDockerSystemStatsCommand, async (_args, context) => {
    // Capacity is the daemon's (on Docker Desktop, its VM), usage is the sum
    // over this installation's containers, and anything Docker would not say
    // is reported unknown — not as the backend host's values or zero.
    const [capacity, usage] = await Promise.all([dockerCapacity(), sampleContainerUsage(context)]);
    const running = usage.containers.filter((sample) => sample.state === "running");
    const measured = running.filter((sample) => sample.cpuCores !== null);
    const cpuCoresUsed = measured.reduce((sum, sample) => sum + (sample.cpuCores ?? 0), 0);
    const memoryMeasured = running.filter((sample) => sample.memoryBytes !== null);
    // Unknown is null, never zero: nothing running measures as 0, nothing
    // measured does not.
    const memoryUsed =
      running.length === 0
        ? 0
        : memoryMeasured.length > 0
          ? memoryMeasured.reduce((sum, sample) => sum + (sample.memoryBytes ?? 0), 0)
          : null;
    const images = await runCommand(
      "docker",
      ["images", "-q", ...(context.strictDockerOwner ? [context.dockerImage ?? DOCKER_IMAGE] : [])],
      { timeoutMs: 10_000 },
    ).then(
      (r) => new Set(r.stdout.split("\n").filter(Boolean)).size,
      () => null,
    );
    const diskParts = [
      capacity.disk.imagesBytes,
      capacity.disk.containersBytes,
      capacity.disk.volumesBytes,
      capacity.disk.buildCacheBytes,
    ];
    return {
      memoryUsed,
      memoryTotal: capacity.memoryBytes,
      cpus: capacity.cpus,
      // Normalized to the daemon's CPUs for the 0–100 gauge; `cpuCoresUsed`
      // carries the unnormalized figure.
      cpuUsagePercent:
        running.length === 0
          ? 0
          : capacity.cpus && measured.length > 0
            ? Math.round((cpuCoresUsed / capacity.cpus) * 1000) / 10
            : null,
      diskUsed: diskParts.some((part) => part === null)
        ? null
        : diskParts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
      // Docker reports what it uses, not how much it may use.
      diskTotal: null,
      containersRunning: running.length,
      containersTotal: usage.containers.length,
      imagesTotal: images,
      // Additive, scoped fields. Older renderers ignore them.
      scope: { capacity: "docker-daemon", usage: "installation", disk: "docker-daemon" } as const,
      sampledAt: usage.sampledAt,
      stale: usage.stale,
      cpuCoresUsed:
        running.length === 0
          ? 0
          : measured.length > 0
            ? Math.round(cpuCoresUsed * 100) / 100
            : null,
      memoryTotalKnown: capacity.memoryBytes !== null,
      diskKnown: !diskParts.some((part) => part === null),
      diskBreakdown: capacity.disk,
    };
  });
  register(getDockerCapacityCommand, ({ refresh }) =>
    dockerCapacity({ refresh: refresh === true }),
  );
  register(getContainerUsageCommand, (_args, context) => sampleContainerUsage(context));
  register(getOrkestratorContainersCommand, async (_args, context) => {
    const { storage } = context;
    const protection = await loadProtection(context);
    const environments = protection.environments;
    const dockerOwner = dockerOwnerNamespace(storage.getDataDir());
    const { stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--format",
        "{{json .}}",
      ],
      { timeoutMs: 20_000 },
    );
    const environmentsById = new Map(environments.map((entry) => [entry.id, entry]));
    // One shared sample; unknown stays null rather than zero.
    const usage = await sampleContainerUsage(context).catch(() => null);
    const usageById = new Map(
      (usage?.containers ?? []).map((sample) => [sample.containerId, sample]),
    );
    const lines = stdout.split("\n").filter(Boolean);
    const createdById = new Map<string, number>();
    const ids = lines
      .map((line) => (JSON.parse(line) as Record<string, unknown>).ID)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, 200);
    if (ids.length > 0) {
      await runCommand("docker", ["inspect", "-f", "{{.Id}}\t{{.Created}}", ...ids], {
        timeoutMs: 15_000,
      }).then(
        (result) => {
          for (const entry of result.stdout.split("\n")) {
            const [id = "", created = ""] = entry.trim().split("\t");
            const at = Date.parse(created);
            if (id && Number.isFinite(at)) createdById.set(id, Math.floor(at / 1000));
          }
        },
        () => undefined,
      );
    }
    return lines.flatMap((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = typeof row.ID === "string" ? row.ID : "";
      const env = findEnvironmentByContainerId(environments, id);
      if (!dockerOwnerMatches(row.Labels, dockerOwner, context.strictDockerOwner)) {
        return [];
      }
      const labelledEnvironmentId = dockerLabelValue(row.Labels, DOCKER_LABEL_ENVIRONMENT_ID);
      return [
        {
          id,
          // Docker cannot relabel a running container, so the name label is the
          // name at creation time and goes stale on rename. Resolve through the
          // environment id first — that survives both a rename and a container id
          // that drifted from the record — and fall back to the label only for a
          // true orphan, whose environment no longer exists to ask.
          name:
            env?.name ??
            (labelledEnvironmentId
              ? environmentsById.get(labelledEnvironmentId)?.name
              : undefined) ??
            dockerLabelValue(row.Labels, DOCKER_LABEL_ENVIRONMENT_NAME) ??
            (typeof row.Names === "string" ? row.Names : ""),
          status: typeof row.Status === "string" ? row.Status : "",
          state: typeof row.State === "string" ? row.State : "",
          image: typeof row.Image === "string" ? row.Image : "",
          created: createdById.get(id) ?? null,
          environmentId: env?.id ?? null,
          projectId: env?.projectId ?? null,
          isAssigned: !!env,
          // The same classification cleanup applies, so the listing never
          // offers to delete a container cleanup would refuse.
          cleanupExclusion: classify(
            {
              id,
              state: typeof row.State === "string" ? row.State.toLowerCase() : "",
              labels: parseLabels(row.Labels),
            },
            protection,
            dockerOwner,
            { includeRunning: true, strictDockerOwner: Boolean(context.strictDockerOwner) },
          ),
          // Docker's per-core percentage (can exceed 100); null when unknown.
          cpuPercent:
            usageById.get(id)?.cpuCores != null
              ? Math.round(usageById.get(id)!.cpuCores! * 1000) / 10
              : null,
          memoryBytes: usageById.get(id)?.memoryBytes ?? null,
          oomKilled: usageById.get(id)?.oomKilled ?? null,
          oomEvents: usageById.get(id)?.oomEvents ?? null,
        },
      ];
    });
  });
  register(dockerCleanupPreviewCommand, (_args, context) => previewDockerCleanup(context));
  register(dockerCleanupExecuteCommand, async (args, context) => {
    const strings = (value: unknown, name: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`Expected ${name} to be a list of ids`);
      }
      if (value.length > 1_000) throw new Error(`Too many ${name}`);
      return value as string[];
    };
    return executeDockerCleanup(
      {
        selectionToken: asString(args.selectionToken, "selectionToken"),
        containerIds: strings(args.containerIds, "containerIds"),
        volumeNames: strings(args.volumeNames, "volumeNames"),
        networkNames: strings(args.networkNames, "networkNames"),
      },
      context,
    );
  });
  register(reattachContainerCommand, async ({ projectId, containerId, name }, context) => {
    const { storage } = context;
    const id = asString(containerId, "containerId");
    const project = asString(projectId, "projectId");
    // Explicit adoption of a reviewed container. It must be this app's, owned
    // by this registry (or a pre-label container outside strict profiles), not
    // already the runtime of an environment, and not labelled as a different
    // live environment's runtime.
    const probe = await probeContainer(id);
    if (probe.kind === "missing") throw new Error(`Container not found: ${id}`);
    if (probe.kind !== "present") {
      throw new ContainerLifecycleError(
        "daemon-unavailable",
        "Docker could not confirm this container's identity. Retry once Docker is reachable.",
      );
    }
    const owner = dockerOwnerNamespace(storage.getDataDir());
    const ownerLabel = probe.labels[DOCKER_LABEL_OWNER];
    if (
      probe.labels[DOCKER_LABEL_APP] !== DOCKER_LABEL_APP_VALUE ||
      (ownerLabel !== undefined && ownerLabel !== owner) ||
      (ownerLabel === undefined && context.strictDockerOwner)
    ) {
      throw new ContainerLifecycleError(
        "not-owned",
        "Refusing Docker operation on a container not owned by this development profile",
      );
    }
    const environments = await storage.loadEnvironments();
    if (
      findEnvironmentByContainerId(environments, id) ||
      findEnvironmentByContainerId(environments, probe.containerId)
    ) {
      throw new ContainerLifecycleError(
        "operation-in-progress",
        "This container is already attached to an environment.",
      );
    }
    const labelledEnvironmentId = (await readContainerLabels(id))[DOCKER_LABEL_ENVIRONMENT_ID];
    if (
      labelledEnvironmentId &&
      environments.some((environment) => environment.id === labelledEnvironmentId)
    ) {
      throw new ContainerLifecycleError(
        "operation-in-progress",
        "This container belongs to an existing environment.",
      );
    }
    const env = createEnvironment(project, {
      name: asOptionalString(name) ?? `reattached-${id.slice(0, 8)}`,
    });
    // The full id, so the persisted association is exact.
    env.containerId = probe.containerId;
    env.status = await getDockerStatus(env.containerId).catch(() => "stopped");
    const adoptedAt = new Date().toISOString();
    const operationId = createOperationId();
    env.containerLifecycle = {
      ...emptyContainerLifecycle(),
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: {
        containerId: probe.containerId,
        runtimeGeneration: 1,
        owner,
        createdByOperationId: operationId,
      },
      outcomes: [{ operationId, kind: "adopt", status: "succeeded", completedAt: adoptedAt }],
    };
    return toClientEnvironment(await storage.addEnvironment(env));
  });
  register(propagateGithubTokenToContainersCommand, async (_args, context) => {
    const { storage, runtime } = context;
    const config = await storage.loadConfig();
    const githubToken = await resolveContainerGitHubToken(config.global, runtime.gitHubCli);
    const environments = await storage.loadEnvironments();
    const updated: string[] = [];
    const failed: [string, string][] = [];
    for (const env of environments) {
      if (
        !env.containerId ||
        (await getDockerStatus(env.containerId).catch(() => "stopped")) !== "running"
      )
        continue;
      try {
        const containerId = env.containerId;
        await runtime.prMonitor.viewerPermissions.rotateScope(`container:${containerId}`, () =>
          syncRuntimeGitHubCredential(env, containerId, githubToken, context),
        );
        updated.push(env.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push([env.id, message]);
      }
    }
    return { updated, failed };
  });
}
