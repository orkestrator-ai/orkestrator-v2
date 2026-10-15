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
};

function isMarker(value: unknown): value is PendingInstallMarker {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.jobId === "string" &&
    typeof record.fromVersion === "string" &&
    typeof record.toVersion === "string" &&
    (record.mode === "now" || record.mode === "on-quit")
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

async function writeMarker(file: string, marker: PendingInstallMarker): Promise<void> {
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

export function createDesktopUpdateHost(options: DesktopUpdateHostOptions): DesktopUpdateHost {
  const log = options.log ?? console;
  const now = options.now ?? (() => Date.now());
  const progressIntervalMs = options.progressIntervalMs ?? 1_000;
  let hostSessionId: string | null = null;
  let registering: Promise<void> | null = null;
  const handled = new Set<string>();
  let download: { jobId: string; cancel(): void } | null = null;
  let updaterError: Error | null = null;

  const updater = options.updater;
  if (updater) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.on("error", (error) => {
      updaterError = error;
      log.warn("[Updater] Update failed:", error);
    });
  }

  async function report(
    request: UpdateHostRequest,
    status: "progress" | "succeeded" | "failed",
    extra: {
      progress?: { percent: number | null; message: string | null };
      error?: { code: string; message: string };
    } = {},
  ): Promise<void> {
    if (!hostSessionId) return;
    try {
      await options.invoke("update_host_report", {
        hostSessionId,
        requestId: request.requestId,
        jobId: request.jobId,
        status,
        ...extra,
      });
    } catch (error) {
      // A report the backend no longer wants (a cancelled job) is not fatal;
      // the backend's own timeout settles anything we fail to deliver.
      log.warn("[Updater] Could not report to the backend:", error);
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
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || version !== request.target.version) {
        throw Object.assign(
          new Error(
            `The release feed offered ${version ?? "nothing"} instead of ${request.target.version}`,
          ),
          { code: "feed-mismatch" },
        );
      }
      // electron-updater verifies the SHA-512 from the feed; Squirrel.Mac
      // also checks the code signature while staging.
      await updater.downloadUpdate(token);
      if (updaterError) throw updaterError;
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
    };
    try {
      await writeMarker(options.markerFile, marker);
    } catch (error) {
      await report(request, "failed", { error: errorReport(error, "marker-failed") });
      return;
    }
    if (request.restart === "on-quit") {
      updater.autoInstallOnAppQuit = true;
      await report(request, "succeeded");
      return;
    }
    // Tell the backend first: this process and the backend are gone a moment
    // after quitAndInstall, and the job must already read "restarting".
    await report(request, "progress", { progress: { percent: null, message: "restarting" } });
    await report(request, "succeeded");
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      await rm(options.markerFile, { force: true }).catch(() => undefined);
      log.warn("[Updater] quitAndInstall failed:", error);
    }
  }

  async function cancel(request: Extract<UpdateHostRequest, { kind: "cancel" }>) {
    if (download?.jobId === request.jobId) download.cancel();
    if (updater) updater.autoInstallOnAppQuit = false;
    await rm(options.markerFile, { force: true }).catch(() => undefined);
    await report(request, "succeeded");
  }

  function handle(request: UpdateHostRequest): void {
    if (handled.has(request.requestId)) return;
    handled.add(request.requestId);
    const run =
      request.kind === "prepare"
        ? prepare(request)
        : request.kind === "install"
          ? install(request)
          : cancel(request);
    void run.catch((error: unknown) => log.warn("[Updater] Update request failed:", error));
  }

  function registration(): UpdateHostRegistration {
    return {
      hostKind: "desktop",
      protocolVersion: UPDATE_HOST_PROTOCOL_VERSION,
      hostVersion: options.appVersion,
      installKind: options.installKind,
      capabilities: { install: updater !== null, rollback: false, restart: ["now", "on-quit"] },
      unavailableReason: updater ? null : options.unavailableReason,
    };
  }

  async function register(): Promise<void> {
    registering ??= (async () => {
      const reply = await options.invoke<{ hostSessionId: string; pending: UpdateHostRequest[] }>(
        "update_host_register",
        { registration: registration() },
      );
      hostSessionId = reply.hostSessionId;
      for (const request of reply.pending) handle(request);
    })().finally(() => {
      registering = null;
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
      const outcome =
        options.appVersion === marker.toVersion
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
    },
  };
}
