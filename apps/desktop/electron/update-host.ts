import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  TERMINAL_EVENT_STREAM_CONNECTED_EVENT,
} from "@orkestrator/protocol/gateway-event-stream";
import {
  UPDATE_HOST_PROTOCOL_VERSION,
  UPDATE_HOST_REQUEST_EVENT,
  type UpdateHostRegistration,
  type UpdateHostRequest,
  type UpdateInstallKind,
} from "@orkestrator/protocol/updates";
import type { UpdaterLike } from "./auto-update.js";

/**
 * The desktop side of the host protocol: Electron main installs the app on
 * the backend's behalf. The backend owns the workflow (channel, consent, job
 * state, audit); this module only pins electron-updater to the one release the
 * backend resolved, downloads and verifies it, and restarts into it.
 *
 * Nothing is downloaded before consent: `autoDownload` stays off and a
 * download only starts from a `prepare` request for an approved job. After a
 * restart the new process reports the outcome from `pending-install.json`.
 */

export type DesktopUpdateHostOptions = {
  /** Null when this install cannot update itself (dev, ad-hoc signed, pacman). */
  updater: UpdaterLike | null;
  unavailableReason: string | null;
  installKind: Extract<UpdateInstallKind, "mac-app" | "appimage">;
  appVersion: string;
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  createCancellationToken?: () => { cancel(): void };
  /** `<userData>/updates/pending-install.json`. */
  markerFile: string;
  /** Release download bases this host accepts from its backend. */
  allowedFeedBaseUrls: readonly string[];
  log?: Pick<Console, "info" | "warn">;
  /** Minimum gap between forwarded download-progress reports. */
  progressIntervalMs?: number;
  now?: () => number;
  /**
   * Keeps a copy of the running app before installing, so a version that
   * fails to start can be rolled back (`update-rollback.ts`). Absent where
   * the install cannot be replaced in place.
   */
  keepRollbackCopy?: () => Promise<string>;
  /** Deletes that copy once the installed version has reported its first start. */
  discardRollbackCopy?: () => Promise<void>;
};

export type DesktopUpdateHost = {
  /** Register (or re-register) with the local backend and act on pending requests. */
  register(): Promise<void>;
  /** Fed every local backend event. */
  handleBackendEvent(event: string, payload: unknown): void;
  /** After the first window loaded: report what the last restart did. */
  reportStartupOutcome(): Promise<void>;
  isRegistered(): boolean;
};

export type PendingInstallMarker = {
  version: 1;
  jobId: string;
  fromVersion: string;
  toVersion: string;
  mode: "now" | "on-quit";
  createdAt: string;
  /** The copy of the previous app a failed start restores. */
  rollbackPath?: string | null;
  /** Set by the failed new version once it put the previous one back. */
  rolledBack?: { reason: string } | null;
  /**
   * Set when the new version first starts. A rollback is allowed only during
   * that first launch: later failures are not the update's, and restoring
   * the pre-update database then would discard everything since.
   */
  launched?: boolean;
};

function isMarker(value: unknown): value is PendingInstallMarker {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.jobId === "string" &&
    typeof record.fromVersion === "string" &&
    typeof record.toVersion === "string" &&
    (record.mode === "now" || record.mode === "on-quit") &&
    (record.rollbackPath === undefined ||
      record.rollbackPath === null ||
      typeof record.rollbackPath === "string")
  );
}

export async function readPendingInstallMarker(file: string): Promise<PendingInstallMarker | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isMarker(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writePendingInstallMarker(
  file: string,
  marker: PendingInstallMarker,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function errorReport(error: unknown, fallbackCode: string): { code: string; message: string } {
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code).slice(0, 64)
      : fallbackCode;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  return { code, message: message || fallbackCode };
}

type ReportExtra = {
  progress?: { percent: number | null; message: string | null };
  error?: { code: string; message: string };
};

/** Delivery attempts for a final report before the backend's own timeout takes over. */
const MAX_REPORT_ATTEMPTS = 3;

export function createDesktopUpdateHost(options: DesktopUpdateHostOptions): DesktopUpdateHost {
  const log = options.log ?? console;
  const now = options.now ?? (() => Date.now());
  const progressIntervalMs = options.progressIntervalMs ?? 1_000;
  let hostSessionId: string | null = null;
  let registering: Promise<void> | null = null;
  let registerAgain = false;
  const handled = new Set<string>();
  /** Final reports the backend has not received, re-sent while it still lists the request. */
  const undelivered = new Map<
    string,
    {
      request: UpdateHostRequest;
      status: "succeeded" | "failed";
      extra: ReportExtra;
      attempts: number;
    }
  >();
  let operationTail: Promise<void> = Promise.resolve();
  const cancelledJobs = new Set<string>();
  let download: { jobId: string; cancel(): void } | null = null;
  let updaterError: Error | null = null;
  /** The copy of this app the last successful prepare kept. */
  let rollbackPath: string | null = null;
  /** The install this process armed: restarting into it now, or on quit. */
  let armed: { jobId: string; mode: "now" | "on-quit" } | null = null;

  const updater = options.updater;
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on("error", (error) => {
      updaterError = error;
      log.warn("[Updater] Update failed:", error);
      if (armed) void abandonArmedInstall(armed.jobId, error);
    });
  }

  async function report(
    request: UpdateHostRequest,
    status: "progress" | "succeeded" | "failed",
    extra: ReportExtra = {},
  ): Promise<void> {
    const final = status !== "progress";
    if (!hostSessionId) {
      if (final) undelivered.set(request.requestId, { request, status, extra, attempts: 0 });
      return;
    }
    try {
      await options.invoke("update_host_report", {
        hostSessionId,
        requestId: request.requestId,
        jobId: request.jobId,
        status,
        ...extra,
      });
      if (final) undelivered.delete(request.requestId);
    } catch (error) {
      log.warn("[Updater] Could not report to the backend:", error);
      if (!final) return;
      // A reconnect may have replaced the session. Registering again lists
      // the request if the backend still waits for it, and the report goes
      // again; a request it no longer lists (a cancelled job) is dropped.
      const attempts = (undelivered.get(request.requestId)?.attempts ?? 0) + 1;
      if (attempts >= MAX_REPORT_ATTEMPTS) {
        undelivered.delete(request.requestId);
        return;
      }
      undelivered.set(request.requestId, { request, status, extra, attempts });
      void register().catch((registerError: unknown) =>
        log.warn("[Updater] Could not re-register with the backend:", registerError),
      );
    }
  }

  /**
   * The updater failed after this host armed an install (Squirrel.Mac's
   * staging, or the AppImage swap), so nothing was installed and the old
   * version keeps running. The install request is already settled, so the
   * backend hears about it as an outcome.
   */
  async function abandonArmedInstall(jobId: string, error: unknown): Promise<void> {
    armed = null;
    if (updater) updater.autoInstallOnAppQuit = false;
    await rm(options.markerFile, { force: true }).catch(() => undefined);
    if (!hostSessionId) return;
    try {
      await options.invoke("update_host_outcome", {
        hostSessionId,
        jobId,
        outcome: "failed",
        rollbackFailed: false,
        error: { code: "install-failed", message: errorReport(error, "install-failed").message },
      });
    } catch (reportError) {
      log.warn("[Updater] Could not report the failed install:", reportError);
    }
  }

  async function prepare(request: Extract<UpdateHostRequest, { kind: "prepare" }>) {
    if (!updater) {
      await report(request, "failed", {
        error: { code: "unsupported", message: options.unavailableReason ?? "Cannot update" },
      });
      return;
    }
    const base = request.feedBaseUrl.replace(/\/+$/, "");
    if (!options.allowedFeedBaseUrls.some((allowed) => allowed.replace(/\/+$/, "") === base)) {
      await report(request, "failed", {
        error: { code: "untrusted-feed", message: `Refusing release feed ${base}` },
      });
      return;
    }
    updaterError = null;
    updater.allowDowngrade = request.allowDowngrade;
    updater.setFeedURL({
      provider: "generic",
      url: `${base}/${encodeURIComponent(request.target.tag)}`,
      channel: "latest",
      // GitHub's asset storage does not support multi-range requests.
      useMultipleRangeRequest: false,
    });
    const token = options.createCancellationToken?.();
    download = { jobId: request.jobId, cancel: () => token?.cancel() };
    let lastProgress = 0;
    const onProgress = (info: { percent?: number }) => {
      if (now() - lastProgress < progressIntervalMs) return;
      lastProgress = now();
      void report(request, "progress", {
        progress: {
          percent: typeof info.percent === "number" ? info.percent : null,
          message: "Downloading the app",
        },
      });
    };
    updater.on("download-progress", onProgress);
    try {
      if (cancelledJobs.has(request.jobId)) throw new Error("Update cancelled");
      const result = await updater.checkForUpdates();
      if (cancelledJobs.has(request.jobId)) throw new Error("Update cancelled");
      const version = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || version !== request.target.version) {
        throw Object.assign(
          new Error(
            `The release feed offered ${version ?? "nothing"} instead of ${request.target.version}`,
          ),
          { code: "feed-mismatch" },
        );
      }
      // electron-updater verifies the SHA-512 from the feed. Squirrel.Mac
      // checks the code signature when it stages the update, at install.
      await updater.downloadUpdate(token);
      if (cancelledJobs.has(request.jobId)) throw new Error("Update cancelled");
      if (updaterError) throw updaterError;
      if (options.keepRollbackCopy) {
        // Before install, not after: a version that cannot start must find it.
        try {
          rollbackPath = await options.keepRollbackCopy();
        } catch (error) {
          throw Object.assign(
            new Error(
              `Could not keep a copy of this version to roll back to (${error instanceof Error ? error.message : String(error)}); free some disk space and try again`,
            ),
            { code: "rollback-copy-failed" },
          );
        }
      }
      if (cancelledJobs.has(request.jobId)) throw new Error("Update cancelled");
      await report(request, "succeeded");
    } catch (error) {
      await report(request, "failed", { error: errorReport(error, "download-failed") });
    } finally {
      updater.off("download-progress", onProgress);
      updater.allowDowngrade = false;
      download = null;
    }
  }

  async function install(request: Extract<UpdateHostRequest, { kind: "install" }>) {
    if (!updater) {
      await report(request, "failed", {
        error: { code: "unsupported", message: options.unavailableReason ?? "Cannot update" },
      });
      return;
    }
    if (updaterError) {
      await report(request, "failed", { error: errorReport(updaterError, "staging-failed") });
      return;
    }
    const marker: PendingInstallMarker = {
      version: 1,
      jobId: request.jobId,
      fromVersion: request.fromVersion,
      toVersion: request.target.version,
      mode: request.restart,
      createdAt: new Date(now()).toISOString(),
      rollbackPath,
    };
    try {
      await writePendingInstallMarker(options.markerFile, marker);
    } catch (error) {
      await report(request, "failed", { error: errorReport(error, "marker-failed") });
      return;
    }
    if (request.restart === "on-quit") {
      updater.autoInstallOnAppQuit = true;
      try {
        // electron-updater hands a download to Squirrel.Mac, or registers the
        // AppImage's quit handler, only when a download completes with the
        // flag set. The file is cached from prepare, so this completes at
        // once and stages the update (macOS) or arms the swap (AppImage).
        updaterError = null;
        await updater.downloadUpdate(options.createCancellationToken?.());
        if (updaterError) throw updaterError;
      } catch (error) {
        updater.autoInstallOnAppQuit = false;
        await rm(options.markerFile, { force: true }).catch(() => undefined);
        await report(request, "failed", { error: errorReport(error, "staging-failed") });
        return;
      }
      armed = { jobId: request.jobId, mode: "on-quit" };
      await report(request, "succeeded");
      return;
    }
    // Tell the backend first: this process and the backend are gone a moment
    // after quitAndInstall, and the job must already read "restarting".
    await report(request, "progress", { progress: { percent: null, message: "restarting" } });
    await report(request, "succeeded");
    armed = { jobId: request.jobId, mode: "now" };
    try {
      // Its failures (Squirrel.Mac's staging, the AppImage swap) arrive as
      // updater `error` events, which abandon the armed install.
      updater.quitAndInstall(true, true);
    } catch (error) {
      await abandonArmedInstall(request.jobId, error);
    }
  }

  async function cancel(request: Extract<UpdateHostRequest, { kind: "cancel" }>) {
    if (download?.jobId === request.jobId) download.cancel();
    if (!armed || armed.jobId === request.jobId) {
      // An update Squirrel.Mac has staged still installs on quit; the
      // backend refuses to cancel one.
      armed = null;
      if (updater) updater.autoInstallOnAppQuit = false;
      await rm(options.markerFile, { force: true }).catch(() => undefined);
    }
    await report(request, "succeeded");
  }

  function handle(request: UpdateHostRequest): void {
    if (handled.has(request.requestId)) return;
    handled.add(request.requestId);
    if (request.kind === "cancel") {
      cancelledJobs.add(request.jobId);
      if (download?.jobId === request.jobId) download.cancel();
    }
    // electron-updater shares one pending download promise. Drain a cancelled
    // prepare before another request may change its feed, policy or listeners.
    operationTail = operationTail
      .then(async () => {
        if (request.kind === "prepare") await prepare(request);
        else if (request.kind === "install") await install(request);
        else {
          await cancel(request);
          cancelledJobs.delete(request.jobId);
        }
      })
      .catch((error: unknown) => log.warn("[Updater] Update request failed:", error));
  }

  function registration(): UpdateHostRegistration {
    return {
      hostKind: "desktop",
      protocolVersion: UPDATE_HOST_PROTOCOL_VERSION,
      hostVersion: options.appVersion,
      installKind: options.installKind,
      capabilities: {
        install: updater !== null,
        rollback: updater !== null && options.keepRollbackCopy !== undefined,
        restart: ["now", "on-quit"],
      },
      unavailableReason: updater ? null : options.unavailableReason,
      armedJobId: armed?.mode === "on-quit" ? armed.jobId : null,
    };
  }

  async function register(): Promise<void> {
    if (registering) {
      // Whatever asked may have missed this registration's pending list.
      registerAgain = true;
      return registering;
    }
    registering = (async () => {
      const reply = await options.invoke<{ hostSessionId: string; pending: UpdateHostRequest[] }>(
        "update_host_register",
        { registration: registration() },
      );
      hostSessionId = reply.hostSessionId;
      const listed = new Set(reply.pending.map((request) => request.requestId));
      for (const requestId of Array.from(undelivered.keys())) {
        if (!listed.has(requestId)) undelivered.delete(requestId);
      }
      for (const request of reply.pending) {
        const retry = undelivered.get(request.requestId);
        if (retry) void report(retry.request, retry.status, retry.extra);
        else handle(request);
      }
    })().finally(() => {
      registering = null;
      if (registerAgain) {
        registerAgain = false;
        void register().catch((error: unknown) =>
          log.warn("[Updater] Could not re-register with the backend:", error),
        );
      }
    });
    return registering;
  }

  return {
    register,
    isRegistered: () => hostSessionId !== null,
    handleBackendEvent(event, payload) {
      if (event === UPDATE_HOST_REQUEST_EVENT) {
        const message = payload as { hostSessionId?: unknown; request?: UpdateHostRequest };
        if (!hostSessionId || message?.hostSessionId !== hostSessionId || !message.request) return;
        handle(message.request);
        return;
      }
      // A reconnect may have missed a request; registering again returns them.
      if (
        hostSessionId &&
        (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT ||
          event === TERMINAL_EVENT_STREAM_CONNECTED_EVENT)
      ) {
        void register().catch((error: unknown) =>
          log.warn("[Updater] Could not re-register with the backend:", error),
        );
      }
    },
    async reportStartupOutcome() {
      const marker = await readPendingInstallMarker(options.markerFile);
      if (!marker || !hostSessionId) return;
      const outcome = marker.rolledBack
        ? {
            outcome: "rolled-back" as const,
            error: { code: "health-check", message: marker.rolledBack.reason.slice(0, 2000) },
          }
        : options.appVersion === marker.toVersion
          ? { outcome: "succeeded" as const }
          : {
              outcome: "failed" as const,
              rollbackFailed: false,
              error: {
                code: "install-not-applied",
                message: `Still running ${options.appVersion}; ${marker.toVersion} was not installed`,
              },
            };
      try {
        await options.invoke("update_host_outcome", {
          hostSessionId,
          jobId: marker.jobId,
          ...outcome,
        });
      } catch (error) {
        log.warn("[Updater] Could not report the update outcome:", error);
      }
      await rm(options.markerFile, { force: true }).catch(() => undefined);
      // Only the first launch after an update may roll it back, and that
      // launch got this far: the copy of the previous version is no use now.
      await options.discardRollbackCopy?.().catch((error: unknown) => {
        log.warn("[Updater] Could not delete the rollback copy:", error);
      });
    },
  };
}
