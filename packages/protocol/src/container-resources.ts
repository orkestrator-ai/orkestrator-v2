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

/**
 * The built-in budget for a new runtime when neither the environment nor
 * Settings → Container sets one. It contains a runaway environment (a leak, a
 * fork bomb) before it exhausts the daemon, the backend or sibling
 * environments; it is not a packing target. Chosen from the workload
 * measurements in docs/architecture/container-lifecycle.md ("Resource budgets
 * and usage"):
 *
 * - CPU: none. CPU is compressible and Docker shares it fairly; a cap only
 *   slowed builds and browsers.
 * - Memory: a fixed preset, capped at a fraction of the daemon's memory (on
 *   Docker Desktop, the VM's), so a small VM keeps room for the daemon and
 *   other containers. The preset covers every measured workload's peak.
 * - PIDs: several times the measured peak, far below a fork bomb.
 */
export const BUILT_IN_RESOURCE_BUDGET = {
  cpus: null,
  memoryMiB: 8192,
  memoryFractionOfDaemon: 0.75,
  pids: 4096,
} as const;

export type ResourceAxis = keyof ContainerResourceLimits;

/** What the daemon reports it can enforce; `null` is unknown. */
export interface ResourceEnforcement {
  memoryBytes: number | null;
  rootless: boolean;
  support: { cpuQuota: boolean | null; memoryLimit: boolean | null; pidsLimit: boolean | null };
}

const SUPPORT_KEY = {
  cpus: "cpuQuota",
  memoryMiB: "memoryLimit",
  pids: "pidsLimit",
} as const satisfies Record<ResourceAxis, keyof ResourceEnforcement["support"]>;

/**
 * Whether a limit on `axis` would be enforced. A daemon that says it cannot
 * is believed; unknown support is trusted except on a rootless daemon, where
 * an undelegated controller records the limit and enforces nothing.
 */
export function axisEnforceable(axis: ResourceAxis, daemon: ResourceEnforcement): boolean {
  const support = daemon.support[SUPPORT_KEY[axis]];
  return support === true || (support === null && !daemon.rootless);
}

export interface BuiltInResourceDefault {
  /** What a new runtime gets: only the axes this daemon enforces. */
  limits: ContainerResourceLimits;
  /** Default axes left off because this daemon cannot enforce them. */
  unenforced: ResourceAxis[];
}

/**
 * {@link BUILT_IN_RESOURCE_BUDGET} for this daemon. Memory is the preset or
 * the daemon fraction, whichever is smaller, rounded down to 256 MiB; with
 * the daemon's memory unknown it is the preset. An axis the daemon cannot
 * enforce is left unrestricted and reported, never claimed.
 */
export function builtInResourceDefault(daemon: ResourceEnforcement): BuiltInResourceDefault {
  const budget = BUILT_IN_RESOURCE_BUDGET;
  const fraction =
    daemon.memoryBytes === null
      ? null
      : Math.floor((daemon.memoryBytes * budget.memoryFractionOfDaemon) / (1024 * 1024) / 256) *
        256;
  const memoryMiB = Math.max(
    RESOURCE_LIMIT_BOUNDS.memoryMiB.min,
    fraction === null ? budget.memoryMiB : Math.min(budget.memoryMiB, fraction),
  );
  const wanted: ContainerResourceLimits = { cpus: budget.cpus, memoryMiB, pids: budget.pids };
  const limits: ContainerResourceLimits = { ...UNRESTRICTED_LIMITS };
  const unenforced: ResourceAxis[] = [];
  for (const axis of ["cpus", "memoryMiB", "pids"] as const) {
    if (wanted[axis] === null) continue;
    if (axisEnforceable(axis, daemon)) limits[axis] = wanted[axis];
    else unenforced.push(axis);
  }
  return { limits, unenforced };
}

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
  /**
   * `global` is Settings → Container; `default` is the built-in budget for
   * this daemon (absent from older backends, which report `none` instead).
   */
  source: "environment" | "global" | "default" | "none";
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
  /**
   * The built-in budget new runtimes get on this daemon when nothing else is
   * set. Absent from backends older than the default, which apply none.
   */
  builtInDefault?: BuiltInResourceDefault;
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
