import { createSharedContainerLogReader } from "./container-log-snapshots.js";
import {
  classify,
  listContainerCleanupInventory,
  loadProtection,
  parseLabels,
  removeCleanupCandidates,
  removeUnclaimedContainer,
} from "./docker-cleanup-inventory.js";
import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
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
  register("check_base_image", (_args, context) =>
    runCommand("docker", ["image", "inspect", context.dockerImage ?? DOCKER_IMAGE], {
      timeoutMs: 10_000,
    }).then(
      () => true,
      () => false,
    ),
  );
  register("provision_environment", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(
      asString(environmentId, "environmentId"),
    );
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const containerId = await createDockerContainer(environment, context);
    await context.storage.updateEnvironment(environment.id, { containerId });
    return containerId;
  });
  register("docker_start_container", async ({ containerId }, context) => {
    const { storage } = context;
    const id = asString(containerId, "containerId");
    await runCommand("docker", ["start", id], { timeoutMs: 60_000 });
    await ensureContainerProjectFilesAccess(id);
    const config = await storage.loadConfig();
    if (context.runtimeFlavor !== "agent-test") {
      await syncContainerGitHubCredential(id, await resolveContainerGitHubToken(config.global));
    }
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude")) {
      await syncContainerClaudeCredentialBestEffort(id, config.global);
    }
  });
  register("docker_stop_container", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
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
    const env = createEnvironment(asString(projectId, "projectId"), {
      name: asOptionalString(name) ?? `reattached-${String(containerId).slice(0, 8)}`,
    });
    env.containerId = asString(containerId, "containerId");
    env.status = await getDockerStatus(env.containerId).catch(() => "stopped");
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
