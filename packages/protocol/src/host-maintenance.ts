/**
 * Remote-initiated maintenance of the host that runs a backend: checking for
 * and installing an Orkestrator update.
 *
 * The backend owns the durable job record and is what every client talks to.
 * The host's executor applies the job: the desktop app's main process, which
 * reports progress over the backend's loopback control listener (remote
 * clients cannot reach it), or, for a supervised standalone backend, the
 * backend itself. Dependency tasks (toolchain repair, container image, `gh`)
 * always run in the backend. See `docs/architecture/host-updates.md`.
 */

/** Emitted with a {@link HostMaintenanceSnapshot} whenever the snapshot changes. */
export const HOST_MAINTENANCE_EVENT = "host-maintenance-updated";

/** How long the host shows its countdown before restarting into an update. */
export const HOST_UPDATE_RESTART_DELAY_MS = 60_000;

/** Default and bounds for waiting until the host is idle before restarting. */
export const HOST_UPDATE_IDLE_WAIT = Object.freeze({
  defaultSeconds: 3_600,
  minSeconds: 60,
  maxSeconds: 86_400,
});

/**
 * What can apply an update on this host.
 *
 * - `desktop`: the Orkestrator app that started this backend.
 * - `standalone`: a backend installed with `orkestrator service install`,
 *   which updates itself and is restarted by its service launcher.
 * - `none`: nothing; update Orkestrator on the host by hand.
 */
export type HostUpdaterKind = "desktop" | "standalone" | "none";

/** When an update may restart the host: right away, or once nothing is running. */
export type HostUpdateDrain = "now" | "when-idle";

/**
 * Which releases a host updates to, most stable first. A channel also receives
 * every more stable channel's releases: Beta gets betas and stable releases,
 * Unstable gets all three. Switching to a more stable channel never
 * downgrades; the host stays on its version until that channel overtakes it.
 */
export const HOST_UPDATE_CHANNELS = ["stable", "beta", "unstable"] as const;
export type HostUpdateChannel = (typeof HOST_UPDATE_CHANNELS)[number];

/**
 * Each channel's release name: the version suffix (`2.23.0`, `2.23.0-beta`,
 * `2.23.0-alpha`), the electron-updater channel and the npm dist-tag.
 */
export const HOST_UPDATE_CHANNEL_TAGS: Readonly<
  Record<HostUpdateChannel, "latest" | "beta" | "alpha">
> = Object.freeze({ stable: "latest", beta: "beta", unstable: "alpha" });

export function isHostUpdateChannel(value: unknown): value is HostUpdateChannel {
  return HOST_UPDATE_CHANNELS.includes(value as HostUpdateChannel);
}

/**
 * The channel a release belongs to, from its version: no suffix is Stable,
 * `-beta[.N]` is Beta and `-alpha[.N]` is Unstable. Null for anything else,
 * which no channel ships.
 */
export function hostUpdateChannelOfVersion(version: string): HostUpdateChannel | null {
  const match = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.\d+)?)?$/.exec(version);
  if (!match) return null;
  if (match[1] === undefined) return "stable";
  if (match[1] === HOST_UPDATE_CHANNEL_TAGS.beta) return "beta";
  if (match[1] === HOST_UPDATE_CHANNEL_TAGS.unstable) return "unstable";
  return null;
}

/** The channels whose releases a host on `channel` installs, most stable first. */
export function hostUpdateChannelsReceived(
  channel: HostUpdateChannel,
): readonly HostUpdateChannel[] {
  return HOST_UPDATE_CHANNELS.slice(0, HOST_UPDATE_CHANNELS.indexOf(channel) + 1);
}

export const HOST_UPDATE_JOB_STATES = [
  "requested",
  "downloading",
  "waiting-for-idle",
  "awaiting-restart",
  "restarting",
  "succeeded",
  "failed",
  "postponed",
  "cancelled",
] as const;

export type HostUpdateJobState = (typeof HOST_UPDATE_JOB_STATES)[number];

/** States in which the job is still in progress. */
export const ACTIVE_HOST_UPDATE_JOB_STATES: ReadonlySet<HostUpdateJobState> = new Set([
  "requested",
  "downloading",
  "waiting-for-idle",
  "awaiting-restart",
  "restarting",
]);

/** States from which an update may still be cancelled: anything before the restart. */
export const CANCELLABLE_HOST_UPDATE_JOB_STATES: ReadonlySet<HostUpdateJobState> = new Set([
  "requested",
  "downloading",
  "waiting-for-idle",
  "awaiting-restart",
]);

export function isActiveHostUpdateJob(job: Pick<HostUpdateJob, "state"> | null): boolean {
  return job !== null && ACTIVE_HOST_UPDATE_JOB_STATES.has(job.state);
}

export interface HostUpdateJob {
  id: string;
  state: HostUpdateJobState;
  /** The version running when the update was requested. */
  fromVersion: string;
  /** The version the caller required; null accepts the newest release. */
  requestedVersion: string | null;
  /** The version the updater staged, once known. */
  targetVersion: string | null;
  drain: HostUpdateDrain;
  /** With `when-idle`: restart at this time even if work is still running. */
  idleDeadline: string | null;
  /** Download progress, 0–100, while downloading. */
  progressPercent: number | null;
  /** When the host restarts unless someone at it postpones (`awaiting-restart`). */
  restartAt: string | null;
  /** Bounded, content-free reason for `failed`. */
  error: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface HostUpdaterStatus {
  kind: HostUpdaterKind;
  /** The host can check for and install an update now. */
  available: boolean;
  /** Why not, when unavailable. */
  reason: string | null;
  /** The newest release the last check found. */
  latestVersion: string | null;
  /** Whether that release is newer than the running version. */
  updateAvailable: boolean | null;
  checkedAt: string | null;
  checkError: string | null;
}

/** What restarting the host would interrupt right now. */
export interface HostRestartImpact {
  /** Agent tabs and coordinator conversations with a turn in progress. */
  workingAgents: number;
  /** Agent tabs waiting for an answer from someone. */
  waitingAgents: number;
  /** Running agent tabs whose activity cannot be observed, including terminal agents. */
  unknownAgents?: number;
  /** Build pipelines currently running (paused pipelines are idle). */
  activePipelines: number;
  /** Every terminal the backend owns. Host shells end with it. */
  terminals: number;
  /**
   * Of `terminals`, those whose shell runs in a container. The shell keeps
   * running there, but the backend's attachment ends: the tab opens a new
   * shell when the backend is back. Older backends leave it out.
   */
  containerTerminals?: number;
  /** Bridges and servers the backend runs on the host; they restart with it. */
  hostServers: number;
  measuredAt: string;
}

/** Nothing a restart would cut short: no agent turn and no pipeline in progress. */
export function isHostIdle(impact: HostRestartImpact): boolean {
  return (
    impact.workingAgents === 0 && (impact.unknownAgents ?? 0) === 0 && impact.activePipelines === 0
  );
}

/** Work on the host's dependencies that the backend runs itself. */
export const HOST_TASK_KINDS = ["toolchain-repair", "image-update", "gh-update"] as const;
export type HostTaskKind = (typeof HOST_TASK_KINDS)[number];

export interface HostTask {
  id: string;
  kind: HostTaskKind;
  state: "running" | "succeeded" | "failed";
  /** Short, content-free description of the current step. */
  stage: string | null;
  error: string | null;
  /** Bounded, content-free outcome (versions, image IDs, environment IDs). */
  result: Record<string, unknown> | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** One managed tool on the host. */
export interface HostToolStatus {
  name: string;
  /** The version this Orkestrator release pins. */
  pinnedVersion: string;
  /**
   * `managed`: the verified copy Orkestrator installed. `path`: a copy found on
   * PATH, which Orkestrator does not manage. `missing`: neither.
   */
  source: "managed" | "path" | "missing";
  /** The managed copy's version; null for PATH copies, which are not probed. */
  installedVersion: string | null;
  /** Only `gh` may follow upstream releases instead of its pin (unqualified). */
  channel?: "pinned" | "latest";
}

/** The container image environments are created from. */
export interface HostImageStatus {
  name: string;
  present: boolean;
  /** Whether it provides what this backend needs; null when absent. */
  compatible: boolean | null;
  reason: string | null;
  /** The release image matching this backend's version. */
  releaseReference: string;
  /** Environments whose container still runs an older image. */
  outdatedEnvironments: Array<{ id: string; name: string; projectId: string }>;
}

/** The pins a newer release brings, from its published `toolchain-pins.json`. */
export interface HostReleasePins {
  version: string;
  tools: Record<string, string>;
}

export interface HostMaintenanceSnapshot {
  /** Increases with every change; a client keeps the highest it has seen. */
  revision: number;
  /** The Orkestrator version this backend runs. */
  version: string;
  updater: HostUpdaterStatus;
  /** A check a client asked for that the executor has not answered yet. */
  checkRequest: { id: string; requestedAt: string } | null;
  /** The current update job, or the most recent finished one. */
  job: HostUpdateJob | null;
  /** The latest dependency task of each kind. */
  tasks: Partial<Record<HostTaskKind, HostTask>>;
  /** What the newest release changes in the toolchain, when known. */
  nextRelease: HostReleasePins | null;
  /** Whether `gh` follows its pin or upstream releases. */
  ghChannel: "pinned" | "latest";
  /** Which Orkestrator releases this host updates to. */
  updateChannel: HostUpdateChannel;
  /**
   * Live readings, present only in a detailed read (`host.status`,
   * `get_host_maintenance { detail: true }`), never in events.
   */
  impact?: HostRestartImpact;
  tools?: HostToolStatus[];
  image?: HostImageStatus | null;
}

/** Job states the executor may report. */
export const HOST_UPDATER_REPORTED_JOB_STATES = [
  "downloading",
  "waiting-for-idle",
  "awaiting-restart",
  "restarting",
  "failed",
  "postponed",
] as const;

export type HostUpdaterReportedJobState = (typeof HOST_UPDATER_REPORTED_JOB_STATES)[number];

/** What the executor sends the backend. */
export type HostUpdaterReport =
  | { type: "ready" }
  | {
      type: "check";
      latestVersion: string | null;
      updateAvailable: boolean | null;
      checkedAt: string;
      error: string | null;
      /** The check request this answers, when it answers one. */
      checkRequestId?: string;
      /** Channel whose registry/feed was queried. */
      channel?: HostUpdateChannel;
    }
  | {
      type: "job";
      jobId: string;
      state: HostUpdaterReportedJobState;
      progressPercent?: number;
      targetVersion?: string;
      restartAt?: string;
      error?: string;
    };

export const HOST_MAINTENANCE_LIMITS = Object.freeze({
  idMaxChars: 100,
  versionMaxChars: 64,
  errorMaxChars: 500,
});

/** Semantic-version-like release names, for example `2.21.1` or `2.22.0-rc.1`. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isHostVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= HOST_MAINTENANCE_LIMITS.versionMaxChars &&
    VERSION_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= HOST_MAINTENANCE_LIMITS.idMaxChars &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

/** Validates an executor report; null when it is malformed. */
export function parseHostUpdaterReport(value: unknown): HostUpdaterReport | null {
  if (!isRecord(value)) return null;
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "check") {
    if (!isTimestamp(value.checkedAt)) return null;
    if (value.latestVersion !== null && !isHostVersion(value.latestVersion)) return null;
    if (value.updateAvailable !== null && typeof value.updateAvailable !== "boolean") return null;
    if (value.checkRequestId !== undefined && !isId(value.checkRequestId)) return null;
    if (value.channel !== undefined && !isHostUpdateChannel(value.channel)) return null;
    return {
      type: "check",
      latestVersion: value.latestVersion,
      updateAvailable: value.updateAvailable,
      checkedAt: value.checkedAt,
      error: boundedText(value.error, HOST_MAINTENANCE_LIMITS.errorMaxChars),
      ...(value.checkRequestId !== undefined ? { checkRequestId: value.checkRequestId } : {}),
      ...(value.channel !== undefined ? { channel: value.channel } : {}),
    };
  }
  if (value.type === "job") {
    if (!isId(value.jobId)) return null;
    if (!HOST_UPDATER_REPORTED_JOB_STATES.includes(value.state as HostUpdaterReportedJobState)) {
      return null;
    }
    const report: Extract<HostUpdaterReport, { type: "job" }> = {
      type: "job",
      jobId: value.jobId,
      state: value.state as HostUpdaterReportedJobState,
    };
    if (value.progressPercent !== undefined) {
      if (typeof value.progressPercent !== "number" || !Number.isFinite(value.progressPercent)) {
        return null;
      }
      report.progressPercent = Math.min(100, Math.max(0, Math.round(value.progressPercent)));
    }
    if (value.targetVersion !== undefined) {
      if (!isHostVersion(value.targetVersion)) return null;
      report.targetVersion = value.targetVersion;
    }
    if (value.restartAt !== undefined) {
      if (!isTimestamp(value.restartAt)) return null;
      report.restartAt = value.restartAt;
    }
    const error = boundedText(value.error, HOST_MAINTENANCE_LIMITS.errorMaxChars);
    if (error) report.error = error;
    return report;
  }
  return null;
}

/** Shallow shape check for a snapshot read back from a backend. */
export function isHostMaintenanceSnapshot(value: unknown): value is HostMaintenanceSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.revision !== "number" || typeof value.version !== "string") return false;
  if (!isRecord(value.updater) || typeof value.updater.available !== "boolean") return false;
  if (value.checkRequest !== null && !isRecord(value.checkRequest)) return false;
  if (value.job !== null) {
    if (!isRecord(value.job) || !isId(value.job.id)) return false;
    if (!HOST_UPDATE_JOB_STATES.includes(value.job.state as HostUpdateJobState)) return false;
  }
  return true;
}
