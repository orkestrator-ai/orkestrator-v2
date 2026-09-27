import { containerOomEvents } from "./container-oom-events.js";
import {
  UNRESTRICTED_LIMITS,
  type ContainerResourceLimits,
  type ContainerUsageSample,
  type ContainerUsageSnapshot,
  type DockerCapacity,
  type EnvironmentResourcePolicy,
} from "@orkestrator/protocol/container-resources";
import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_OWNER,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { AppConfig, Environment } from "./models.js";
import {
  ContainerLifecycleError,
  currentRuntimeIdentity,
  runContainerOperation,
} from "./container-lifecycle-service.js";
import { parseDockerPsSize } from "./docker-cleanup-inventory.js";

/**
 * Resource budgets and usage telemetry (containers plan step 10).
 *
 * Budgets are opt-in: without a global default or an environment override a
 * runtime is unrestricted, exactly as before, because defaults have to come
 * from measurements rather than guesses. A requested budget is written into
 * the Docker specification and read back from `docker inspect`; the applied
 * value, not the request, is what is reported. Usage comes from one bounded,
 * deduplicated sampler over this installation's containers, and capacity from
 * the daemon (on Docker Desktop, its VM — never the backend host).
 */

const MIB = 1024 * 1024;

export function resolveResourceLimits(
  environment: Pick<Environment, "containerResourceLimits">,
  global: Pick<AppConfig["global"], "containerResourceLimits">,
): { limits: ContainerResourceLimits; source: EnvironmentResourcePolicy["source"] } {
  if (environment.containerResourceLimits) {
    return {
      limits: { ...UNRESTRICTED_LIMITS, ...environment.containerResourceLimits },
      source: "environment",
    };
  }
  if (global.containerResourceLimits) {
    return {
      limits: { ...UNRESTRICTED_LIMITS, ...global.containerResourceLimits },
      source: "global",
    };
  }
  return { limits: { ...UNRESTRICTED_LIMITS }, source: "none" };
}

/** Docker create/update arguments. Swap is disabled by pinning it to memory. */
/** `/dev/shm` for Chromium: 1 GiB, or half the memory limit when that is smaller. */
export const DEFAULT_SHARED_MEMORY_MIB = 1024;

export function sharedMemoryMiB(limits: ContainerResourceLimits): number {
  return limits.memoryMiB === null
    ? DEFAULT_SHARED_MEMORY_MIB
    : Math.min(DEFAULT_SHARED_MEMORY_MIB, Math.floor(limits.memoryMiB / 2));
}

export function resourceArguments(limits: ContainerResourceLimits): string[] {
  const args: string[] = [];
  if (limits.cpus !== null) args.push("--cpus", String(limits.cpus));
  if (limits.memoryMiB !== null) {
    args.push("--memory", `${limits.memoryMiB}m`, "--memory-swap", `${limits.memoryMiB}m`);
  }
  if (limits.pids !== null) args.push("--pids-limit", String(limits.pids));
  return args;
}

/**
 * Arguments that lift a limit on `docker update`. Docker cannot remove a
 * memory limit from an existing container; that applies on the next runtime,
 * and the read-back applied value says so.
 */
function clearingArguments(limits: ContainerResourceLimits): string[] {
  const args: string[] = [];
  if (limits.cpus === null) args.push("--cpus", "0");
  if (limits.pids === null) args.push("--pids-limit", "-1");
  return args;
}

export function parseAppliedLimits(line: string): ContainerResourceLimits | null {
  const [nano = "", memory = "", pids = ""] = line.trim().split("\t");
  const nanoCpus = Number(nano);
  const memoryBytes = Number(memory);
  const pidsLimit = pids === "<nil>" || pids === "" ? 0 : Number(pids);
  if (![nanoCpus, memoryBytes, pidsLimit].every(Number.isFinite)) return null;
  return {
    cpus: nanoCpus > 0 ? Math.round((nanoCpus / 1e9) * 100) / 100 : null,
    memoryMiB: memoryBytes > 0 ? Math.round(memoryBytes / MIB) : null,
    pids: pidsLimit > 0 ? pidsLimit : null,
  };
}

export async function inspectAppliedLimits(
  containerId: string,
): Promise<ContainerResourceLimits | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "-f",
        "{{.HostConfig.NanoCpus}}\t{{.HostConfig.Memory}}\t{{.HostConfig.PidsLimit}}",
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    return parseAppliedLimits(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

const CAPACITY_TTL_MS = 60_000;
const DISK_TTL_MS = 5 * 60_000;
let capacityCache: { at: number; value: DockerCapacity } | null = null;
let diskCache: { at: number; value: DockerCapacity["disk"] } | null = null;

/** Test seam. */
export function resetResourceCaches(): void {
  capacityCache = null;
  diskCache = null;
  usageCache = null;
  inflight = null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseDockerInfo(text: string): Omit<DockerCapacity, "disk"> {
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    info = {};
  }
  const security = Array.isArray(info.SecurityOptions)
    ? info.SecurityOptions.filter((entry): entry is string => typeof entry === "string")
    : [];
  const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
  return {
    scope: "docker-daemon",
    cpus: number(info.NCPU),
    memoryBytes: number(info.MemTotal),
    operatingSystem:
      typeof info.OperatingSystem === "string" ? info.OperatingSystem.slice(0, 128) : null,
    rootless: security.some((entry) => /name=rootless/.test(entry)),
    cgroupVersion: typeof info.CgroupVersion === "string" ? info.CgroupVersion.slice(0, 8) : null,
    support: {
      cpuQuota: bool(info.CpuCfsQuota),
      memoryLimit: bool(info.MemoryLimit),
      pidsLimit: bool(info.PidsLimit),
    },
    logDrivers: (() => {
      const plugins = info.Plugins as { Log?: unknown } | undefined;
      return Array.isArray(plugins?.Log)
        ? plugins.Log.filter((entry): entry is string => typeof entry === "string").slice(0, 32)
        : [];
    })(),
  };
}

/** Docker's container stdout/stderr bound for new runtimes. */
export const CONTAINER_LOG_OPTIONS = { driver: "local", maxSize: "10m", maxFiles: 3 } as const;

/**
 * `--log-driver local` with size and file bounds when the daemon offers it.
 * An existing container keeps its driver until it is rebuilt; the daemon's
 * own configuration is never changed.
 */
export function logDriverArguments(logDrivers: readonly string[]): string[] {
  if (!logDrivers.includes(CONTAINER_LOG_OPTIONS.driver)) return [];
  return [
    "--log-driver",
    CONTAINER_LOG_OPTIONS.driver,
    "--log-opt",
    `max-size=${CONTAINER_LOG_OPTIONS.maxSize}`,
    "--log-opt",
    `max-file=${CONTAINER_LOG_OPTIONS.maxFiles}`,
  ];
}

/** `docker system df` sizes by type; shared image layers are counted once. */
export function parseSystemDf(text: string): DockerCapacity["disk"] {
  const disk: DockerCapacity["disk"] = {
    imagesBytes: null,
    containersBytes: null,
    volumesBytes: null,
    buildCacheBytes: null,
    measuredAt: new Date().toISOString(),
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const bytes = parseDockerPsSize(row.Size);
    switch (row.Type) {
      case "Images":
        disk.imagesBytes = bytes;
        break;
      case "Containers":
        disk.containersBytes = bytes;
        break;
      case "Local Volumes":
        disk.volumesBytes = bytes;
        break;
      case "Build Cache":
        disk.buildCacheBytes = bytes;
        break;
    }
  }
  return disk;
}

export async function dockerCapacity(options: { refresh?: boolean } = {}): Promise<DockerCapacity> {
  const now = Date.now();
  if (!options.refresh && capacityCache && now - capacityCache.at < CAPACITY_TTL_MS) {
    return { ...capacityCache.value, disk: await dockerDisk() };
  }
  let base: Omit<DockerCapacity, "disk">;
  try {
    const { stdout } = await runCommand("docker", ["info", "--format", "{{json .}}"], {
      timeoutMs: 15_000,
    });
    base = parseDockerInfo(stdout.trim());
  } catch {
    base = parseDockerInfo("{}");
  }
  const value = { ...base, disk: await dockerDisk() };
  capacityCache = { at: now, value };
  return value;
}

async function dockerDisk(): Promise<DockerCapacity["disk"]> {
  const now = Date.now();
  if (diskCache && now - diskCache.at < DISK_TTL_MS) return diskCache.value;
  try {
    const { stdout } = await runCommand("docker", ["system", "df", "--format", "{{json .}}"], {
      timeoutMs: 60_000,
    });
    diskCache = { at: now, value: parseSystemDf(stdout) };
  } catch {
    diskCache = {
      at: now,
      value: {
        imagesBytes: null,
        containersBytes: null,
        volumesBytes: null,
        buildCacheBytes: null,
        measuredAt: null,
      },
    };
  }
  return diskCache.value;
}

// ---------------------------------------------------------------------------
// Usage sampler
// ---------------------------------------------------------------------------

/** A visible surface treats older samples as stale. */
export const USAGE_STALE_MS = 15_000;
/** Callers within this window share one sample. */
const USAGE_MIN_INTERVAL_MS = 5_000;
const MAX_SAMPLED_CONTAINERS = 128;

let usageCache: { at: number; value: ContainerUsageSnapshot } | null = null;
let inflight: Promise<ContainerUsageSnapshot> | null = null;

/** `1.5GiB` / `512MiB` / `12kB` → bytes (binary for *iB, decimal otherwise). */
export function parseMemorySize(value: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtT]?i?B)\s*$/.exec(value);
  if (!match) return null;
  const unit = match[2]!.toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const factor = scale[unit];
  return factor === undefined ? null : Math.round(Number(match[1]) * factor);
}

export function parseStatsLine(line: string): {
  id: string;
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  pids: number | null;
} | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id =
    typeof row.ID === "string" ? row.ID : typeof row.Container === "string" ? row.Container : "";
  if (!id) return null;
  const cpu = typeof row.CPUPerc === "string" ? Number(row.CPUPerc.replace("%", "")) : Number.NaN;
  const [used = "", limit = ""] =
    typeof row.MemUsage === "string" ? row.MemUsage.split("/").map((part) => part.trim()) : [];
  const pids = typeof row.PIDs === "string" ? Number(row.PIDs) : Number.NaN;
  return {
    id,
    // Docker reports 100% per core; do not clamp a multi-core figure.
    cpuCores: Number.isFinite(cpu) ? Math.round((cpu / 100) * 100) / 100 : null,
    memoryBytes: parseMemorySize(used),
    memoryLimitBytes: parseMemorySize(limit),
    pids: Number.isFinite(pids) ? pids : null,
  };
}

async function sampleNow(
  context: Pick<CommandContext, "storage">,
): Promise<ContainerUsageSnapshot> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const sampledAt = new Date().toISOString();
  let listing: string;
  try {
    ({ stdout: listing } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--filter",
        `label=${DOCKER_LABEL_OWNER}=${owner}`,
        "--format",
        `{{.ID}}\t{{.State}}\t{{.Label "${DOCKER_LABEL_ENVIRONMENT_ID}"}}`,
      ],
      { timeoutMs: 15_000 },
    ));
  } catch {
    return {
      scope: "installation",
      sampledAt: null,
      stale: true,
      containers: [],
      error: "docker-unavailable",
    };
  }
  const rows = listing
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts[0])
    .slice(0, MAX_SAMPLED_CONTAINERS);
  const samples = new Map<string, ContainerUsageSample>();
  for (const [id = "", state = "", environmentId = ""] of rows) {
    samples.set(id, {
      containerId: id,
      environmentId: environmentId || null,
      state,
      cpuCores: null,
      memoryBytes: null,
      memoryLimitBytes: null,
      pids: null,
      oomKilled: null,
      oomEvents: containerOomEvents(id),
      exitCode: null,
    });
  }
  const running = rows.filter((parts) => parts[1] === "running").map((parts) => parts[0]!);
  if (running.length > 0) {
    try {
      const { stdout } = await runCommand(
        "docker",
        ["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", ...running],
        { timeoutMs: 20_000 },
      );
      for (const line of stdout.split("\n")) {
        const parsed = parseStatsLine(line);
        if (!parsed) continue;
        const sample = [...samples.values()].find((entry) =>
          entry.containerId.startsWith(parsed.id),
        );
        if (!sample) continue;
        sample.cpuCores = parsed.cpuCores;
        sample.memoryBytes = parsed.memoryBytes;
        sample.memoryLimitBytes = parsed.memoryLimitBytes;
        sample.pids = parsed.pids;
      }
    } catch {
      // Usage stays unknown (null) rather than becoming zero.
    }
  }
  const ids = [...samples.keys()];
  if (ids.length > 0) {
    try {
      const { stdout } = await runCommand(
        "docker",
        ["inspect", "-f", "{{.Id}}\t{{.State.OOMKilled}}\t{{.State.ExitCode}}", ...ids],
        { timeoutMs: 15_000 },
      );
      for (const line of stdout.split("\n")) {
        const [id = "", oom = "", exit = ""] = line.trim().split("\t");
        const sample = samples.get(id);
        if (!sample) continue;
        sample.oomKilled = oom === "true" ? true : oom === "false" ? false : null;
        const code = Number(exit);
        sample.exitCode = sample.state === "running" || !Number.isFinite(code) ? null : code;
      }
    } catch {
      // OOM evidence stays unknown.
    }
  }
  return {
    scope: "installation",
    sampledAt,
    stale: false,
    containers: [...samples.values()],
    error: null,
  };
}

/**
 * One sample shared by every caller within the minimum interval; concurrent
 * callers wait on the same subprocesses. Staleness is computed on read.
 */
export async function sampleContainerUsage(
  context: Pick<CommandContext, "storage">,
): Promise<ContainerUsageSnapshot> {
  const now = Date.now();
  if (usageCache && now - usageCache.at < USAGE_MIN_INTERVAL_MS) {
    return { ...usageCache.value, stale: now - usageCache.at > USAGE_STALE_MS };
  }
  if (!inflight) {
    inflight = sampleNow(context)
      .then((value) => {
        if (value.sampledAt) usageCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const value = await inflight;
  if (value.sampledAt) return value;
  // Docker unavailable: the last good sample, marked stale, beats nothing.
  return usageCache ? { ...usageCache.value, stale: true, error: value.error } : value;
}

// ---------------------------------------------------------------------------
// Policy view and live update
// ---------------------------------------------------------------------------

function unsupportedAxes(
  limits: ContainerResourceLimits,
  capacity: Pick<DockerCapacity, "support" | "rootless">,
): Array<keyof ContainerResourceLimits> {
  const out: Array<keyof ContainerResourceLimits> = [];
  if (limits.cpus !== null && capacity.support.cpuQuota === false) out.push("cpus");
  if (limits.memoryMiB !== null && capacity.support.memoryLimit === false) out.push("memoryMiB");
  if (limits.pids !== null && capacity.support.pidsLimit === false) out.push("pids");
  return out;
}

export async function environmentResourcePolicy(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
): Promise<EnvironmentResourcePolicy> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const config = await context.storage.loadConfig();
  const { limits, source } = resolveResourceLimits(environment, config.global);
  const capacity = await dockerCapacity();
  return {
    environmentId,
    requested: limits,
    source,
    applied:
      environment.containerId && environment.environmentType === "containerized"
        ? await inspectAppliedLimits(environment.containerId)
        : null,
    unsupported: unsupportedAxes(limits, capacity),
    daemonRootless: capacity.rootless,
  };
}

export interface ResourceUpdateRequest {
  environmentId: string;
  /** `undefined` clears the override (inherit the global default). */
  limits: ContainerResourceLimits | undefined;
  /** Apply to the current runtime now (`docker update`). */
  applyNow: boolean;
  /** Allow a memory limit below the runtime's current use. */
  allowBelowUsage?: boolean;
}

/**
 * Stores an environment's budget and, when asked, applies it to the current
 * runtime through `docker update` as one lifecycle operation. The applied
 * value is read back; a failed update leaves the reported applied value
 * unchanged. A memory limit below current use is refused unless allowed,
 * because the kernel would reclaim or kill processes to meet it.
 */
export async function updateEnvironmentResources(
  request: ResourceUpdateRequest,
  context: CommandContext,
): Promise<EnvironmentResourcePolicy> {
  const environment = await context.storage.getEnvironment(request.environmentId);
  if (!environment) throw new Error(`Environment not found: ${request.environmentId}`);
  const config = await context.storage.loadConfig();
  const next = resolveResourceLimits(
    { containerResourceLimits: request.limits },
    config.global,
  ).limits;
  const capacity = await dockerCapacity();
  if (next.cpus !== null && capacity.cpus !== null && next.cpus > capacity.cpus) {
    throw new ContainerLifecycleError(
      "resource-exhausted",
      `Docker has ${capacity.cpus} CPUs; a limit of ${next.cpus} cannot be met.`,
    );
  }
  if (
    next.memoryMiB !== null &&
    capacity.memoryBytes !== null &&
    next.memoryMiB * MIB > capacity.memoryBytes
  ) {
    throw new ContainerLifecycleError(
      "resource-exhausted",
      `Docker has ${Math.floor(capacity.memoryBytes / MIB)} MiB of memory; the limit exceeds it.`,
    );
  }
  const containerId =
    request.applyNow && environment.environmentType === "containerized"
      ? environment.containerId
      : null;
  if (containerId && next.memoryMiB !== null && !request.allowBelowUsage) {
    const usage = (await sampleContainerUsage(context)).containers.find(
      (sample) => sample.containerId === containerId,
    );
    if (usage?.memoryBytes && usage.memoryBytes > next.memoryMiB * MIB * 0.9) {
      throw new ContainerLifecycleError(
        "confirmation-required",
        "The container is using nearly that much memory now. Lowering the limit could stop its processes; stop it first or confirm.",
      );
    }
  }
  if (!containerId) {
    await context.storage.updateEnvironment(environment.id, {
      containerResourceLimits: request.limits,
    });
    return environmentResourcePolicy(environment.id, context);
  }
  await runContainerOperation(
    context,
    environment.id,
    "update-resources",
    {},
    () =>
      runCommand(
        "docker",
        ["update", ...resourceArguments(next), ...clearingArguments(next), containerId],
        { timeoutMs: 30_000 },
      ),
    { source: currentRuntimeIdentity(environment, context) },
  );
  // Stored only after Docker accepted it; the applied value is read back.
  await context.storage.updateEnvironment(environment.id, {
    containerResourceLimits: request.limits,
  });
  return environmentResourcePolicy(environment.id, context);
}
