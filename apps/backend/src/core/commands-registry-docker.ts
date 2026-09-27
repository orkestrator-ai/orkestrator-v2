import { createSharedContainerLogReader } from "./container-log-snapshots.js";
import { detectDockerTopology, getImageStatus } from "./docker-image.js";
import {
  classify,
  listContainerCleanupInventory,
  loadProtection,
  parseLabels,
  readContainerLabels,
  removeCleanupCandidates,
  removeUnclaimedContainer,
} from "./docker-cleanup-inventory.js";
import {
  createOperationId,
  emptyContainerLifecycle,
  formatContainerLifecycleError,
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
import {
  CommandFailedError,
  os,
  DOCKER_IMAGE,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_ENVIRONMENT_NAME,
  DOCKER_LABEL_OWNER,
  dockerOwnerNamespace,
  createEnvironment,
  commandExists,
  runCommand,
  spawnCommand,
} from "./commands-dependencies.js";
import {
  asString,
  asOptionalString,
  asBoolean,
  asNumber,
  findEnvironmentByContainerId,
  dockerLabelValue,
  dockerOwnerMatches,
  toClientEnvironment,
  getDockerStatus,
  getHostPort,
  resolveContainerGitHubToken,
  syncContainerGitHubCredential,
  syncContainerClaudeCredentialBestEffort,
  ensureContainerProjectFilesAccess,
  createDockerContainer,
  enqueueEnvironmentLifecycleOperation,
  assertEnvironmentDeletionNotRequested,
  startAssignedContainerRuntimeTask,
  stopEnvironmentTask,
  resolveOperationImage,
} from "./commands-helpers.js";

const lastDockerAvailabilityDiagnosticByLogger = new WeakMap<(message: string) => void, string>();

function logDockerAvailabilityWarning(
  logWarning: (message: string) => void,
  diagnostic: string,
): void {
  if (lastDockerAvailabilityDiagnosticByLogger.get(logWarning) === diagnostic) return;
  lastDockerAvailabilityDiagnosticByLogger.set(logWarning, diagnostic);
  logWarning(diagnostic);
}

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
  if (
    /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|failed to connect to the docker api|connect: no such file or directory/i.test(
      message,
    )
  ) {
    return "daemon-unavailable";
  }
  return "unknown";
}

export async function checkDockerAvailability(
  dependencies: {
    commandExists?: (command: string) => Promise<boolean>;
    runCommand?: typeof runCommand;
    logWarning?: (message: string) => void;
  } = {},
): Promise<DockerAvailability> {
  const hasCommand = dependencies.commandExists ?? commandExists;
  const run = dependencies.runCommand ?? runCommand;
  const logWarning = dependencies.logWarning ?? console.warn;
  if (!(await hasCommand("docker"))) {
    logDockerAvailabilityWarning(
      logWarning,
      "[Docker] Availability probe failed: reason=not-installed commandExists=false",
    );
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
    logDockerAvailabilityWarning(
      logWarning,
      [
        "[Docker] Availability probe failed:",
        `reason=${reason}`,
        "commandExists=true",
        `errorType=${errorType}`,
        `timedOut=${commandFailure?.timedOut ?? false}`,
        `executableMissing=${commandFailure?.executableMissing ?? false}`,
        `exitCode=${commandFailure?.exitCode ?? "unknown"}`,
        `signal=${commandFailure?.signal ?? "none"}`,
        `dockerHostSet=${Boolean(process.env.DOCKER_HOST?.trim())}`,
        `dockerContextSet=${Boolean(process.env.DOCKER_CONTEXT?.trim())}`,
        `dockerConfigSet=${Boolean(process.env.DOCKER_CONFIG?.trim())}`,
      ].join(" "),
    );
    return { available: false, reason };
  }
}

export function registerDockerCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  void dependencies;
  register("check_docker", () => checkDockerAvailability());
  register("docker_version", async () =>
    (
      await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeoutMs: 10_000,
      })
    ).stdout.trim(),
  );
  register("get_docker_image_status", (_args, context) => getImageStatus(context));
  register("get_docker_topology", ({ refresh }) =>
    detectDockerTopology({ refresh: refresh === true }),
  );
  // Legacy boolean adapter: presence only. It never implies compatibility;
  // capability gates use `get_docker_image_status`.
  register("check_base_image", (_args, context) =>
    runCommand("docker", ["image", "inspect", context.dockerImage ?? DOCKER_IMAGE], {
      timeoutMs: 10_000,
    }).then(
      () => true,
      () => false,
    ),
  );
  register("provision_environment", async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    const identity = parseContainerMutationIdentity(args);
    // Idempotent and serialized: a repeated or concurrent request returns the
    // container the first one created instead of creating another.
    return enqueueEnvironmentLifecycleOperation(id, context, async () => {
      const environment = await context.storage.getEnvironment(id);
      if (!environment) throw new Error(`Environment not found: ${id}`);
      assertEnvironmentDeletionNotRequested(environment, environment.id);
      if (environment.containerId) return environment.containerId;
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
  register("docker_start_container", async ({ containerId }, context) => {
    const { storage } = context;
    const id = asString(containerId, "containerId");
    const assigned = findEnvironmentByContainerId(await storage.loadEnvironments(), id);
    if (assigned) {
      // An environment's runtime starts through the lifecycle authority.
      await startAssignedContainerRuntimeTask(assigned.id, context);
    } else {
      await runCommand("docker", ["start", id], { timeoutMs: 60_000 });
      await ensureContainerProjectFilesAccess(id);
    }
    const config = await storage.loadConfig();
    if (context.runtimeFlavor !== "agent-test") {
      await syncContainerGitHubCredential(id, await resolveContainerGitHubToken(config.global));
    }
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude")) {
      await syncContainerClaudeCredentialBestEffort(id, config.global);
    }
  });
  register("docker_stop_container", async ({ containerId }, context) => {
    const id = asString(containerId, "containerId");
    const assigned = findEnvironmentByContainerId(await context.storage.loadEnvironments(), id);
    if (assigned) {
      // Stopping an environment's runtime is the environment's stop.
      await stopEnvironmentTask(assigned.id, context, () => undefined);
      return;
    }
    await runCommand("docker", ["stop", id], { timeoutMs: 60_000 });
  });
  register("docker_remove_container", async ({ containerId }, context) => {
    // A supplied id is not a request to discard an environment's workspace.
    // Raw removal is limited to containers nothing claims; an assigned runtime
    // is reset only through `recreate_environment` with an explicit discard,
    // and deleted only through environment deletion.
    const id = asString(containerId, "containerId");
    const outcome = await removeUnclaimedContainer(id, context);
    if (outcome.outcome === "skipped") {
      throw new Error(
        formatContainerLifecycleError(
          outcome.reason === "foreign-owner" ? "not-owned" : "preservation-required",
          outcome.reason === "foreign-owner"
            ? "This container is not owned by this Orkestrator installation."
            : "This container belongs to an environment. Reset or delete the environment instead.",
        ),
      );
    }
    if (outcome.outcome === "failed") {
      throw new Error(
        formatContainerLifecycleError("removal-failed", "Docker did not remove the container."),
      );
    }
  });
  register("docker_container_status", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    return getDockerStatus(id);
  });
  register("list_docker_containers", async (_args, context) => {
    const { storage } = context;
    const dockerOwner = dockerOwnerNamespace(storage.getDataDir());
    // Ownership is filtered here rather than by a second `--filter label=` so an
    // unlabelled pre-upgrade container is still reachable. See dockerOwnerMatches.
    const { stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Labels}}",
      ],
      { timeoutMs: 10_000 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [id = "", name = "", labels = ""] = line.split("\t");
        if (!dockerOwnerMatches(labels, dockerOwner, context.strictDockerOwner)) return [];
        return [[id, name]];
      });
  });
  register("get_container_host_port", ({ containerId, containerPort }) =>
    getHostPort(asString(containerId, "containerId"), asNumber(containerPort, "containerPort")),
  );
  // Initialization views in every client poll this once a second; equivalent
  // tails join and share a short-lived snapshot (container-log-snapshots.ts).
  const readContainerLogs = createSharedContainerLogReader({
    read: async (containerId, tail) =>
      (await runCommand("docker", ["logs", "--tail", tail, containerId], { timeoutMs: 30_000 }))
        .stdout,
  });
  register("get_container_logs", ({ containerId, tail }) =>
    readContainerLogs(asString(containerId, "containerId"), asOptionalString(tail) ?? "200"),
  );
  register("stream_container_logs", ({ containerId }, { emit }) => {
    const id = asString(containerId, "containerId");
    const child = spawnCommand("docker", ["logs", "-f", id]);
    child.stdout.on("data", (data) =>
      emit("container-log", { containerId: id, line: data.toString() }),
    );
    child.stderr.on("data", (data) =>
      emit("container-log", { containerId: id, line: data.toString() }),
    );
  });
  register("docker_system_prune", async ({ pruneVolumes }, context) => {
    // Ordinary cleanup removes only stopped containers that nothing claims:
    // not assigned to an environment, not labelled for a live environment, not
    // owed to a pending deletion and not part of an in-flight operation. A
    // stopped environment's container is still the only copy of its workspace,
    // so being stopped never makes it eligible. Images, networks and volumes
    // are left alone, even when an older renderer sends the legacy
    // pruneVolumes flag.
    if (pruneVolumes !== undefined) asBoolean(pruneVolumes);
    const inventory = await listContainerCleanupInventory(context, {
      includeRunning: false,
      measureSize: true,
    });
    const result = await removeCleanupCandidates(
      inventory.filter((row) => row.exclusion === null),
      context,
      { includeRunning: false },
    );
    return {
      containersDeleted: result.removed,
      containersSkipped: result.skipped,
      containersFailed: result.failed,
      containersProtected: inventory.filter((row) => row.exclusion !== null).length,
      imagesDeleted: 0,
      networksDeleted: 0,
      volumesDeleted: 0,
      spaceReclaimed: result.reclaimedBytes,
    };
  });
  register("get_docker_system_stats", async (_args, context) => {
    const ownerFilter = context.strictDockerOwner
      ? [
          "--filter",
          `label=${DOCKER_LABEL_OWNER}=${dockerOwnerNamespace(context.storage.getDataDir())}`,
        ]
      : [];
    const containers = await runCommand("docker", ["ps", "-a", "-q", ...ownerFilter], {
      timeoutMs: 10_000,
    }).then(
      (r) => r.stdout.split("\n").filter(Boolean).length,
      () => 0,
    );
    const running = await runCommand("docker", ["ps", "-q", ...ownerFilter], {
      timeoutMs: 10_000,
    }).then(
      (r) => r.stdout.split("\n").filter(Boolean).length,
      () => 0,
    );
    const images = await runCommand(
      "docker",
      ["images", "-q", ...(context.strictDockerOwner ? [context.dockerImage ?? DOCKER_IMAGE] : [])],
      { timeoutMs: 10_000 },
    ).then(
      (r) => new Set(r.stdout.split("\n").filter(Boolean)).size,
      () => 0,
    );
    return {
      memoryUsed: 0,
      memoryTotal: os.totalmem(),
      cpus: os.cpus().length,
      cpuUsagePercent: 0,
      diskUsed: 0,
      diskTotal: 0,
      containersRunning: running,
      containersTotal: containers,
      imagesTotal: images,
    };
  });
  register("get_orkestrator_containers", async (_args, context) => {
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
    return stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
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
            created: 0,
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
            cpuPercent: null,
          },
        ];
      });
  });
  register("cleanup_orphaned_containers", async (_args, context) => {
    // Orphans are containers nothing claims, whatever their state. Assignment,
    // a live environment label, a pending deletion or an in-flight operation
    // is rechecked for each one immediately before it is removed.
    const inventory = await listContainerCleanupInventory(context, { includeRunning: true });
    const result = await removeCleanupCandidates(
      inventory.filter((row) => row.exclusion === null),
      context,
      { includeRunning: true },
    );
    return {
      removed: result.removed,
      alreadyAbsent: result.alreadyAbsent,
      skipped: result.skipped,
      failed: result.failed,
    };
  });
  register("reattach_container", async ({ projectId, containerId, name }, context) => {
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
      throw new Error(
        formatContainerLifecycleError(
          "daemon-unavailable",
          "Docker could not confirm this container's identity. Retry once Docker is reachable.",
        ),
      );
    }
    const owner = dockerOwnerNamespace(storage.getDataDir());
    const ownerLabel = probe.labels[DOCKER_LABEL_OWNER];
    if (
      probe.labels[DOCKER_LABEL_APP] !== DOCKER_LABEL_APP_VALUE ||
      (ownerLabel !== undefined && ownerLabel !== owner) ||
      (ownerLabel === undefined && context.strictDockerOwner)
    ) {
      throw new Error(
        formatContainerLifecycleError(
          "not-owned",
          "Refusing Docker operation on a container not owned by this development profile",
        ),
      );
    }
    const environments = await storage.loadEnvironments();
    if (
      findEnvironmentByContainerId(environments, id) ||
      findEnvironmentByContainerId(environments, probe.containerId)
    ) {
      throw new Error(
        formatContainerLifecycleError(
          "operation-in-progress",
          "This container is already attached to an environment.",
        ),
      );
    }
    const labelledEnvironmentId = (await readContainerLabels(id))[DOCKER_LABEL_ENVIRONMENT_ID];
    if (
      labelledEnvironmentId &&
      environments.some((environment) => environment.id === labelledEnvironmentId)
    ) {
      throw new Error(
        formatContainerLifecycleError(
          "operation-in-progress",
          "This container belongs to an existing environment.",
        ),
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
  register("propagate_github_token_to_containers", async (_args, { storage }) => {
    const config = await storage.loadConfig();
    const githubToken = await resolveContainerGitHubToken(config.global);
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
        await syncContainerGitHubCredential(env.containerId, githubToken);
        updated.push(env.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push([env.id, message]);
      }
    }
    return { updated, failed };
  });
}
