/**
 * The update protocol: the `update_*` backend commands, the `update-status`
 * event and the `/__orkestrator/status` handshake that a local renderer, a
 * remote client and the CLI all use, plus the host protocol between a backend
 * and the process that installs it (Electron main or the headless supervisor).
 *
 * The update protocol is append-only and outlives every other compatibility
 * window, so a client can always update an older backend. Design:
 * docs/architecture/release-channels-and-updates.md.
 */
import type { ReleaseChannel } from "./release-channels.js";
import type { ReleaseRequirementItem, ReleaseRequirementsDiff } from "./release-requirements.js";

export const UPDATE_STATUS_EVENT = "update-status";
/**
 * Desktop main forwards the local backend's `update-status` to every window
 * under this name, so a window bound to a remote still sees this app's own
 * update state.
 */
export const LOCAL_UPDATE_STATUS_EVENT = "local-update-status";
/**
 * Desktop main → every window: its event stream from the local backend
 * reconnected, so local update events may have been missed. Windows re-read
 * the status, whichever connection they are bound to.
 */
export const LOCAL_UPDATE_RESYNC_EVENT = "local-update-resync";
/** Menu → renderer: open the update panel (the menu has already asked for a check). */
export const OPEN_UPDATE_PANEL_EVENT = "open-update-panel";

/** The client commands; host commands (`update_host_*`) are never exposed to a renderer. */
export const UPDATE_CLIENT_COMMANDS = [
  "update_get_status",
  "update_check",
  "update_set_channel",
  "update_start",
  "update_install_now",
  "update_install_on_quit",
  "update_cancel",
  "update_acknowledge_notice",
  "update_get_audit",
] as const;
export type UpdateClientCommand = (typeof UPDATE_CLIENT_COMMANDS)[number];

export function isUpdateClientCommand(value: unknown): value is UpdateClientCommand {
  return typeof value === "string" && (UPDATE_CLIENT_COMMANDS as readonly string[]).includes(value);
}

/** The installer's own commands; only the host process may send them. */
export function isUpdateHostCommand(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("update_host_");
}
export const UPDATE_HOST_REQUEST_EVENT = "update-host-request";
export const UPDATE_HOST_PROTOCOL_VERSION = 1;
/** Environment override for the release download base (qualification only). */
export const UPDATE_FEED_URL_ENV = "ORKESTRATOR_UPDATE_FEED_URL";
/** Opt-out for managed installs and for debugging the updater itself. */
export const DISABLE_AUTO_UPDATE_ENV = "ORKESTRATOR_DISABLE_AUTO_UPDATE";

export type UpdateHostKind = "desktop" | "supervisor" | "none";
export type UpdateInstallKind = "mac-app" | "appimage" | "npm-package";

export type UpdateHostInfo = {
  kind: UpdateHostKind;
  installKind: UpdateInstallKind | null;
  /** True when a registered host can stage and install a release. */
  canInstall: boolean;
  /** Why installing is unavailable, in words a user can act on. */
  unavailableReason: string | null;
  hostVersion: string | null;
  protocolVersion: number | null;
};

export const UPDATE_JOB_PHASES = [
  "approved",
  "fetching-dependencies",
  "downloading",
  "ready",
  "installing",
  "restarting",
  "verifying",
  "succeeded",
  "failed",
  "rolled-back",
  "cancelled",
] as const;
export type UpdateJobPhase = (typeof UPDATE_JOB_PHASES)[number];

export type UpdateJobStep =
  | "consent"
  | "dependencies"
  | "download"
  | "install"
  | "restart"
  | "health";

/** Who asked for an update, recorded in the audit log on the updated machine. */
export type UpdateRequester = {
  /** `control` is the loopback listener (this machine); `browser` serves remote clients. */
  listener: "control" | "browser" | "internal";
  remoteAddress: string | null;
  /** Tailscale login, only when Tailscale Serve set it on a loopback request. */
  tailscaleUser: string | null;
  identitySource: "tailscale-serve" | "client-declared" | "local";
  /** What the client says about itself; labelled as declared, never verified. */
  client: UpdateClientInfo | null;
};

export type UpdateClientInfo = {
  kind: "desktop" | "web" | "cli" | "other";
  version: string | null;
  name: string | null;
};

export type UpdateTarget = {
  version: string;
  tag: string;
  channel: ReleaseChannel;
  requirementsSha256: string;
};

export type UpdateJobError = { step: UpdateJobStep; code: string; message: string };

/** What the job fetched before the restart, kept so a rollback can undo it. */
export type UpdateJobDependencies = {
  /** The target's activated provider binaries (`toolchains/bin/<hash>`). */
  toolchainBinDir: string | null;
  /** A pulled published image that replaces the default image at install. */
  image: { pulledRef: string; imageId: string; previousImageId: string | null } | null;
};

export type UpdateJob = {
  id: string;
  fromVersion: string;
  target: UpdateTarget;
  approvedConsentIds: string[];
  /** `immediate` restarts as soon as the update is ready (the remote default). */
  restartPolicy: "immediate" | "manual";
  /** An explicit "install latest <channel> now" below the running version. */
  downgrade: boolean;
  phase: UpdateJobPhase;
  createdAt: string;
  updatedAt: string;
  requester: UpdateRequester;
  progress: { step: UpdateJobStep; percent: number | null; message: string | null } | null;
  error: UpdateJobError | null;
  /** Set only when restoring the previous version failed too. */
  rollbackFailed: boolean;
  /** Requirement items someone must act on at this machine after the update. */
  actionsOnHost: ReleaseRequirementItem[];
  /** The database version before installing, for the rollback floor. */
  storageSchemaVersion: number | null;
  /** How the install was requested: now, or armed to run when the app quits. */
  installWhen: "now" | "on-quit" | null;
  dependencies: UpdateJobDependencies | null;
};

export type UpdateNoticeKind =
  | "action-needed-on-host"
  | "update-succeeded"
  | "update-rolled-back"
  | "update-failed";

export type UpdateNotice = {
  id: string;
  kind: UpdateNoticeKind;
  jobId: string;
  version: string;
  createdAt: string;
  message: string;
  items: ReleaseRequirementItem[];
};

export type UpdateOffer = UpdateTarget & {
  publishedAt: string;
  diff: ReleaseRequirementsDiff;
  compatibility: { minClientVersion: string; minBackendVersion: string };
  /** True when installing it would move below the running version. */
  downgrade: boolean;
};

export type UpdateCheckState = {
  status: "never" | "checking" | "ok" | "failed";
  checkedAt: string | null;
  error: { code: string; message: string } | null;
  resolution: "update" | "up-to-date" | "waiting-for-channel" | null;
};

export type UpdateStatusSnapshot = {
  /**
   * Identifies the backend process. Revisions count from zero again in a new
   * process, so they only order snapshots with the same generation.
   */
  generation: string;
  revision: number;
  updateProtocol: number;
  currentVersion: string;
  /** The running version's own channel, or null for a non-channel build. */
  currentChannel: ReleaseChannel | null;
  /** The subscription. */
  channel: ReleaseChannel;
  platform: string;
  arch: string;
  host: UpdateHostInfo;
  automaticChecks: boolean;
  check: UpdateCheckState;
  /** A newer release on the subscription, with what it needs approved. */
  available: UpdateOffer | null;
  /** When waiting for a narrower channel: what "install latest now" would install. */
  downgradeOption: UpdateOffer | null;
  job: UpdateJob | null;
  notices: UpdateNotice[];
};

/** The `/__orkestrator/status` payload (authenticated). Older backends send only `ok`. */
export type GatewayStatusPayload = {
  ok: true;
  appVersion?: string;
  updateProtocol?: number;
  host?: { kind: UpdateHostKind; installKind: UpdateInstallKind | null; canInstall: boolean };
  updates?: {
    channel: ReleaseChannel;
    available: string | null;
    jobPhase: UpdateJobPhase | null;
  };
};

export type UpdateStartArgs = {
  targetVersion: string;
  requirementsSha256: string;
  approvedConsentIds: string[];
  restartPolicy: "immediate" | "manual";
  allowDowngrade?: boolean;
  client?: UpdateClientInfo;
};

export type UpdateAuditEntry = {
  at: string;
  action:
    | "set-channel"
    | "start"
    | "install"
    | "cancel"
    | "succeeded"
    | "failed"
    | "rolled-back"
    | "cancelled";
  jobId: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  channel: ReleaseChannel | null;
  approvedConsentIds?: string[];
  requirementsSha256?: string;
  requester: UpdateRequester | null;
  detail?: string;
};

export type UpdateHostCapabilities = {
  install: boolean;
  rollback: boolean;
  /** Restart timing the host supports; the desktop also offers install-on-quit. */
  restart: Array<"now" | "on-quit">;
};

export type UpdateHostRegistration = {
  hostKind: Exclude<UpdateHostKind, "none">;
  protocolVersion: number;
  hostVersion: string;
  installKind: UpdateInstallKind;
  capabilities: UpdateHostCapabilities;
  /** Why the host cannot install (a dev build, the opt-out), when it cannot. */
  unavailableReason?: string | null;
  /**
   * The job this host process has armed to install when the app quits. After
   * a backend-only restart it tells a still-armed host from one that
   * restarted without installing.
   */
  armedJobId?: string | null;
};

export type UpdateHostRequest =
  | {
      kind: "prepare";
      requestId: string;
      jobId: string;
      target: UpdateTarget;
      /** Release download base the host resolves `<base>/<tag>/<asset>` against. */
      feedBaseUrl: string;
      allowDowngrade: boolean;
    }
  | {
      kind: "install";
      requestId: string;
      jobId: string;
      target: UpdateTarget;
      fromVersion: string;
      restart: "now" | "on-quit";
      storageSchemaVersion: number | null;
      /** Pre-fetched provider binaries the new version runs with (supervisor). */
      toolchainBinDir: string | null;
    }
  | { kind: "cancel"; requestId: string; jobId: string };

export type UpdateHostReport = {
  hostSessionId: string;
  requestId: string;
  jobId: string;
  status: "progress" | "succeeded" | "failed";
  progress?: { percent: number | null; message: string | null };
  error?: { code: string; message: string };
};

/** What a host reports after the restart an install request caused. */
export type UpdateHostOutcome = {
  hostSessionId: string;
  jobId: string;
  outcome: "succeeded" | "rolled-back" | "failed";
  error?: { code: string; message: string };
  rollbackFailed?: boolean;
};

const TERMINAL: ReadonlySet<UpdateJobPhase> = new Set([
  "succeeded",
  "failed",
  "rolled-back",
  "cancelled",
]);

export function isTerminalUpdatePhase(phase: UpdateJobPhase): boolean {
  return TERMINAL.has(phase);
}

/** Phases a job may still be cancelled from: nothing on the machine has changed yet. */
export function isCancellableUpdatePhase(phase: UpdateJobPhase): boolean {
  return (
    phase === "approved" ||
    phase === "fetching-dependencies" ||
    phase === "downloading" ||
    phase === "ready"
  );
}
