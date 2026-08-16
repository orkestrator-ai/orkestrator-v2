import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { os, DOCKER_IMAGE, DOCKER_LABEL_APP, DOCKER_LABEL_APP_VALUE, DOCKER_LABEL_ENVIRONMENT_ID, DOCKER_LABEL_ENVIRONMENT_NAME, DOCKER_LABEL_OWNER, dockerOwnerNamespace, createEnvironment, commandExists, runCommand, spawnCommand } from "./commands-dependencies.js";
import { asString, asOptionalString, asBoolean, asNumber, findEnvironmentByContainerId, dockerLabelValue, dockerOwnerMatches, countPrunedDockerResources, parseDockerByteSize, toClientEnvironment, getDockerStatus, getHostPort, resolveContainerGitHubToken, syncContainerGitHubCredential, syncContainerClaudeCredentialBestEffort, ensureContainerProjectFilesAccess, createDockerContainer } from "./commands-helpers.js";

export function registerDockerCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { commands } = dependencies;
  register("check_docker", () => commandExists("docker").then(async (exists) => exists && runCommand("docker", ["info"], { timeoutMs: 10_000 }).then(() => true, () => false)));
  register("docker_version", async () => (await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 })).stdout.trim());
  register("check_base_image", (_args, context) => runCommand("docker", ["image", "inspect", context.dockerImage ?? DOCKER_IMAGE], { timeoutMs: 10_000 }).then(() => true, () => false));
  register("provision_environment", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(asString(environmentId, "environmentId"));
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
      await syncContainerGitHubCredential(
        id,
        await resolveContainerGitHubToken(config.global),
      );
    }
    if (context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("claude")) {
      await syncContainerClaudeCredentialBestEffort(id, config.global);
    }
  });
  register("docker_stop_container", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    await runCommand("docker", ["stop", id], { timeoutMs: 60_000 });
  });
  register("docker_remove_container", async ({ containerId }) => {
    const id = asString(containerId, "containerId");
    await runCommand("docker", ["rm", "-f", id], { timeoutMs: 60_000 });
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
    const { stdout } = await runCommand("docker", [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Labels}}",
    ], { timeoutMs: 10_000 });
    return stdout.split("\n").filter(Boolean).flatMap((line) => {
      const [id = "", name = "", labels = ""] = line.split("\t");
      if (!dockerOwnerMatches(labels, dockerOwner, context.strictDockerOwner)) return [];
      return [[id, name]];
    });
  });
  register("get_container_host_port", ({ containerId, containerPort }) => getHostPort(asString(containerId, "containerId"), asNumber(containerPort, "containerPort")));
  register("get_container_logs", async ({ containerId, tail }) => (await runCommand("docker", ["logs", "--tail", asOptionalString(tail) ?? "200", asString(containerId, "containerId")], { timeoutMs: 30_000 })).stdout);
  register("stream_container_logs", ({ containerId }, { emit }) => {
    const id = asString(containerId, "containerId");
    const child = spawnCommand("docker", ["logs", "-f", id]);
    child.stdout.on("data", (data) => emit("container-log", { containerId: id, line: data.toString() }));
    child.stderr.on("data", (data) => emit("container-log", { containerId: id, line: data.toString() }));
  });
  register("docker_system_prune", async ({ pruneVolumes }, context) => {
    const { storage } = context;
    // The ordinary cleanup action is intentionally owner-scoped. Docker cannot
    // safely filter image/network/volume prune by container ownership, so those
    // resource classes remain untouched even when an older renderer sends the
    // legacy pruneVolumes flag.
    if (pruneVolumes !== undefined) asBoolean(pruneVolumes);
    const dockerOwner = dockerOwnerNamespace(storage.getDataDir());
    const pruneContainers = (filters: string[]) => runCommand("docker", [
      "container", "prune", "-f", ...filters.flatMap((filter) => ["--filter", filter]),
    ], { timeoutMs: 120_000 });
    // Containers created before ownership labels existed carry no owner label,
    // yet the listings adopt them as this installation's. A second pass scoped
    // to this app's label minus the owner label removes exactly those legacy
    // containers, so cleanup matches what the UI reports as owned.
    const owned = await pruneContainers([`label=${DOCKER_LABEL_OWNER}=${dockerOwner}`]);
    const legacy = context.strictDockerOwner
      ? { stdout: "" }
      : await pruneContainers([
          `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
          `label!=${DOCKER_LABEL_OWNER}`,
        ]);
    const reclaimedText = (stdout: string) => /Total reclaimed space:\s*([^\n]+)/.exec(stdout)?.[1] ?? "0B";
    return {
      containersDeleted: countPrunedDockerResources(owned.stdout) + countPrunedDockerResources(legacy.stdout),
      imagesDeleted: 0,
      networksDeleted: 0,
      volumesDeleted: 0,
      spaceReclaimed: parseDockerByteSize(reclaimedText(owned.stdout)) + parseDockerByteSize(reclaimedText(legacy.stdout)),
    };
  });
  register("get_docker_system_stats", async (_args, context) => {
    const ownerFilter = context.strictDockerOwner
      ? ["--filter", `label=${DOCKER_LABEL_OWNER}=${dockerOwnerNamespace(context.storage.getDataDir())}`]
      : [];
    const containers = await runCommand("docker", ["ps", "-a", "-q", ...ownerFilter], { timeoutMs: 10_000 }).then((r) => r.stdout.split("\n").filter(Boolean).length, () => 0);
    const running = await runCommand("docker", ["ps", "-q", ...ownerFilter], { timeoutMs: 10_000 }).then((r) => r.stdout.split("\n").filter(Boolean).length, () => 0);
    const images = await runCommand("docker", ["images", "-q", ...(context.strictDockerOwner ? [context.dockerImage ?? DOCKER_IMAGE] : [])], { timeoutMs: 10_000 }).then((r) => new Set(r.stdout.split("\n").filter(Boolean)).size, () => 0);
    return { memoryUsed: 0, memoryTotal: os.totalmem(), cpus: os.cpus().length, cpuUsagePercent: 0, diskUsed: 0, diskTotal: 0, containersRunning: running, containersTotal: containers, imagesTotal: images };
  });
  register("get_orkestrator_containers", async ({}, context) => {
    const { storage } = context;
    const environments = await storage.loadEnvironments();
    const dockerOwner = dockerOwnerNamespace(storage.getDataDir());
    const { stdout } = await runCommand("docker", ["ps", "-a", "--no-trunc", "--filter", `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`, "--format", "{{json .}}"], { timeoutMs: 20_000 });
    const environmentsById = new Map(environments.map((entry) => [entry.id, entry]));
    return stdout.split("\n").filter(Boolean).flatMap((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = typeof row.ID === "string" ? row.ID : "";
      const env = findEnvironmentByContainerId(environments, id);
      if (!dockerOwnerMatches(row.Labels, dockerOwner, context.strictDockerOwner)) {
        return [];
      }
      const labelledEnvironmentId = dockerLabelValue(row.Labels, DOCKER_LABEL_ENVIRONMENT_ID);
      return [{
        id,
        // Docker cannot relabel a running container, so the name label is the
        // name at creation time and goes stale on rename. Resolve through the
        // environment id first — that survives both a rename and a container id
        // that drifted from the record — and fall back to the label only for a
        // true orphan, whose environment no longer exists to ask.
        name: env?.name
          ?? (labelledEnvironmentId ? environmentsById.get(labelledEnvironmentId)?.name : undefined)
          ?? dockerLabelValue(row.Labels, DOCKER_LABEL_ENVIRONMENT_NAME)
          ?? (typeof row.Names === "string" ? row.Names : ""),
        status: typeof row.Status === "string" ? row.Status : "",
        state: typeof row.State === "string" ? row.State : "",
        image: typeof row.Image === "string" ? row.Image : "",
        created: 0,
        environmentId: env?.id ?? null,
        projectId: env?.projectId ?? null,
        isAssigned: !!env,
        cpuPercent: null,
      }];
    });
  });
  register("cleanup_orphaned_containers", async (_args, context) => {
    const { storage } = context;
    const environments = await storage.loadEnvironments();
    const containers = await commands.get("list_docker_containers")?.({}, context) as string[][];
    let removed = 0;
    for (const [containerId] of containers) {
      if (containerId && !findEnvironmentByContainerId(environments, containerId)) {
        await runCommand("docker", ["rm", "-f", containerId], { timeoutMs: 60_000 }).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  });
  register("reattach_container", async ({ projectId, containerId, name }, context) => {
    const { storage } = context;
    const env = createEnvironment(asString(projectId, "projectId"), { name: asOptionalString(name) ?? `reattached-${String(containerId).slice(0, 8)}` });
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
      if (!env.containerId || await getDockerStatus(env.containerId).catch(() => "stopped") !== "running") continue;
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
