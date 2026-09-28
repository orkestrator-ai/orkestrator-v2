/**
 * Container resource budgets and usage telemetry (containers plan step 10).
 *
 * Every measurement carries its scope and time. An unknown value is `null`,
 * never zero, and a requested limit is kept apart from the value Docker
 * reports as applied.
 */

/** A limit of `null` is explicitly unrestricted. */
export interface ContainerResourceLimits {
  /** CPU cores (fractional). */
  cpus: number | null;
  /** Memory in MiB; swap is disabled (swap limit equals memory). */
  memoryMiB: number | null;
  /** Maximum processes/threads in the container. */
  pids: number | null;
}

export const UNRESTRICTED_LIMITS: ContainerResourceLimits = {
  cpus: null,
  memoryMiB: null,
  pids: null,
};

export const RESOURCE_LIMIT_BOUNDS = {
  cpus: { min: 0.25, max: 512 },
  memoryMiB: { min: 512, max: 4 * 1024 * 1024 },
  pids: { min: 256, max: 4_194_304 },
} as const;

export type ResourceLimitsParse =
  | { ok: true; limits: ContainerResourceLimits }
  | { ok: false; field: keyof ContainerResourceLimits; reason: string };

/** Validates a request: each field a bounded finite number, or `null`. */
export function parseResourceLimits(value: unknown): ResourceLimitsParse {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const limits: ContainerResourceLimits = { ...UNRESTRICTED_LIMITS };
  for (const field of ["cpus", "memoryMiB", "pids"] as const) {
    const raw = record[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, field, reason: "must be a number or null" };
    }
    const bounds = RESOURCE_LIMIT_BOUNDS[field];
    if (raw < bounds.min || raw > bounds.max) {
      return { ok: false, field, reason: `must be between ${bounds.min} and ${bounds.max}` };
    }
    if (field !== "cpus" && !Number.isInteger(raw)) {
      return { ok: false, field, reason: "must be a whole number" };
    }
    limits[field] = field === "cpus" ? Math.round(raw * 100) / 100 : raw;
  }
  return { ok: true, limits };
}

export interface EnvironmentResourcePolicy {
  environmentId: string;
  /** What new runtimes of this environment are created with. */
  requested: ContainerResourceLimits;
  source: "environment" | "global" | "none";
  /** What Docker reports for the current runtime; `null` when unknown. */
  applied: ContainerResourceLimits | null;
  /** The daemon cannot enforce a requested axis (rootless, cgroup support). */
  unsupported: Array<keyof ContainerResourceLimits>;
  /**
   * A rootless daemon enforces limits only through the cgroup controllers
   * delegated to its user; the applied values are what it reports.
   */
  daemonRootless?: boolean;
}

export interface DockerCapacity {
  /** The daemon's view: on Docker Desktop, the VM, not the backend host. */
  scope: "docker-daemon";
  cpus: number | null;
  memoryBytes: number | null;
  operatingSystem: string | null;
  rootless: boolean;
  cgroupVersion: string | null;
  support: { cpuQuota: boolean | null; memoryLimit: boolean | null; pidsLimit: boolean | null };
  /** Log drivers the daemon offers (for the bounded `local` driver). */
  logDrivers: string[];
  /** Daemon-wide disk use by kind; unknown when Docker would not say. */
  disk: {
    imagesBytes: number | null;
    containersBytes: number | null;
    volumesBytes: number | null;
    buildCacheBytes: number | null;
    measuredAt: string | null;
  };
}

export interface ContainerUsageSample {
  containerId: string;
  environmentId: string | null;
  state: string;
  /** Cores in use (Docker's CPU percentage / 100; may exceed 1). */
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  pids: number | null;
  oomKilled: boolean | null;
  /**
   * Out-of-memory kills in the container (any process, not only PID 1) since
   * the backend began following Docker's events; null while it is not.
   */
  oomEvents: number | null;
  exitCode: number | null;
}

export interface ContainerUsageSnapshot {
  /** This installation's containers only. */
  scope: "installation";
  sampledAt: string | null;
  /** Older than the freshness bound for a visible surface. */
  stale: boolean;
  containers: ContainerUsageSample[];
  error: string | null;
}
