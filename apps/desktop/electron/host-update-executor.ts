import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import {
  HOST_MAINTENANCE_EVENT,
  HOST_UPDATE_RESTART_DELAY_MS,
  isHostIdle,
  isHostMaintenanceSnapshot,
  isHostUpdateChannel,
  type HostMaintenanceSnapshot,
  type HostUpdateJob,
  type HostUpdaterReport,
} from "@orkestrator/protocol/host-maintenance";
import type { AutoUpdateController, UpdateCheckReport } from "./auto-update.js";
import {
  createLogger,
  formatLogError,
  type Logger,
  type LogEventOf,
} from "@orkestrator/protocol/logger";

/** The Local backend's host updater channel (loopback control listener only). */
export type HostUpdaterChannel = {
  /** A detailed snapshot: it carries the restart impact `when-idle` waits on. */
  snapshot(): Promise<HostMaintenanceSnapshot>;
  report(report: HostUpdaterReport): Promise<HostMaintenanceSnapshot>;
};

export type HostUpdateEngine = Pick<
  AutoUpdateController,
  "checkSilently" | "stageForRemote" | "installStaged"
> &
  Partial<Pick<AutoUpdateController, "releaseRemoteStage" | "setChannel">>;

export type RestartDecision = "restart" | "postpone" | "cancelled";

export type HostUpdateExecutor = {
  /** Announces the executor and picks up any request already waiting. */
  start(): Promise<void>;
  /** Feed every Local backend event; the executor reacts to its own. */
  handleEvent(event: string, payload: unknown): void;
  /** Forward every updater check, so a waiting check request is answered. */
  reportCheck(report: UpdateCheckReport): void;
};

/** Progress reports are throttled to this interval unless the step is large. */
const PROGRESS_INTERVAL_MS = 1_000;
const PROGRESS_STEP_PERCENT = 5;
/** How often `when-idle` re-reads the restart impact. */
const IDLE_POLL_MS = 15_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Applies remote update requests on this computer.
 *
 * The backend owns the job record and the host's update channel; this reads
 * them (on start, on every
 * reconnect, and from each `host-maintenance-updated` event), runs the work
 * through the app's updater, and reports each step back. A job is handled at
 * most once per process, and stops at its next step once the backend records
 * it cancelled (an open countdown closes). Installing quits this app, and the
 * next backend settles the job from the version it starts on.
 */
export function createHostUpdateExecutor(options: {
  channel: HostUpdaterChannel;
  engine: HostUpdateEngine;
  /** Shows the countdown; resolves when someone chooses, the time runs out, or `signal` aborts. */
  confirmRestart(input: {
    version: string;
    restartAt: number;
    signal: AbortSignal;
  }): Promise<RestartDecision>;
  /** Runs just before installing, for example to mark the relaunch unattended. */
  beforeInstall?: (input: { jobId: string; version: string }) => Promise<void>;
  now?: () => number;
  restartDelayMs?: number;
  idlePollMs?: number;
  reportRetryMs?: number;
  log?: Pick<Logger<LogEventOf<"updater">>, "info" | "warn">;
}): HostUpdateExecutor {
  const { channel, engine } = options;
  const now = options.now ?? Date.now;
  const restartDelayMs = options.restartDelayMs ?? HOST_UPDATE_RESTART_DELAY_MS;
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const log = options.log ?? createLogger("updater");
  let started = false;
  let handledCheckId: string | null = null;
  let pendingCheckId: string | null = null;
  let lastCheck: UpdateCheckReport | null = null;
  let updateChannel: HostMaintenanceSnapshot["updateChannel"] | null = null;
  let handledJobId: string | null = null;
  let revision = -1;
  let ready = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing: Promise<void> | null = null;
  let recoveryDelay = options.reportRetryMs ?? 1_000;
  const pendingFailures = new Map<string, string>();
  const running = new Map<string, AbortController>();

  function send(report: HostUpdaterReport): Promise<HostMaintenanceSnapshot | null> {
    return channel.report(report).catch((error: unknown) => {
      log.warn("remote.report-failed", { error: formatLogError(error, { stack: false }) });
      return null;
    });
  }

  async function sendCritical(
    report: HostUpdaterReport,
    signal: AbortSignal,
  ): Promise<HostMaintenanceSnapshot | null> {
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
      const result = await send(report);
      if (result) return result;
      if (attempt < 2) await sleep((options.reportRetryMs ?? 1_000) * 2 ** attempt, signal);
    }
    return null;
  }

  function scheduleRecovery(): void {
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void refresh();
    }, recoveryDelay);
    recoveryTimer.unref?.();
    recoveryDelay = Math.min(30_000, recoveryDelay * 2);
  }

  function reportCheck(report: UpdateCheckReport): void {
    lastCheck = report;
    const checkRequestId = pendingCheckId;
    pendingCheckId = null;
    void send({
      type: "check",
      ...(report.channel ? { channel: report.channel } : {}),
      latestVersion: report.latestVersion,
      updateAvailable: report.updateAvailable,
      checkedAt: report.checkedAt,
      error: report.error,
      ...(checkRequestId ? { checkRequestId } : {}),
    });
  }

  async function runCheck(id: string): Promise<void> {
    pendingCheckId = id;
    await engine.checkSilently();
    // Joining a check whose result was already reported answers nothing new;
    // answer with what that check found.
    if (pendingCheckId === id) {
      reportCheck(
        lastCheck ?? {
          latestVersion: null,
          updateAvailable: null,
          checkedAt: new Date(now()).toISOString(),
          error: "The check did not complete",
        },
      );
    }
  }

  /** Waits until nothing is running, the deadline passes, or the job is cancelled. */
  async function waitForIdle(job: HostUpdateJob, signal: AbortSignal): Promise<void> {
    const deadline = job.idleDeadline ? Date.parse(job.idleDeadline) : now();
    while (!signal.aborted && now() < deadline) {
      const snapshot = await channel.snapshot().catch(() => null);
      if (snapshot?.job?.id === job.id && snapshot.job.state === "cancelled") return;
      if (snapshot?.impact && isHostIdle(snapshot.impact)) return;
      await sleep(Math.min(idlePollMs, Math.max(0, deadline - now())), signal);
    }
  }

  async function runJob(job: HostUpdateJob, signal: AbortSignal): Promise<void> {
    const fail = async (error: string) => {
      pendingFailures.set(job.id, error);
      const result = await sendCritical(
        { type: "job", jobId: job.id, state: "failed", error },
        signal,
      );
      if (result) pendingFailures.delete(job.id);
      else scheduleRecovery();
    };
    try {
      await send({ type: "job", jobId: job.id, state: "downloading", progressPercent: 0 });
      let lastProgressAt = 0;
      let lastPercent = 0;
      const staged = await engine.stageForRemote((percent) => {
        const at = now();
        if (
          at - lastProgressAt < PROGRESS_INTERVAL_MS &&
          percent - lastPercent < PROGRESS_STEP_PERCENT
        ) {
          return;
        }
        lastProgressAt = at;
        lastPercent = percent;
        void send({ type: "job", jobId: job.id, state: "downloading", progressPercent: percent });
      });
      if (signal.aborted) return;
      if (staged.status === "up-to-date") {
        await fail(`No update is available; ${job.fromVersion} is the newest release`);
        return;
      }
      if (job.requestedVersion && staged.version !== job.requestedVersion) {
        await fail(`The newest release is ${staged.version}, not ${job.requestedVersion}`);
        return;
      }
      if (job.drain === "when-idle") {
        await send({
          type: "job",
          jobId: job.id,
          state: "waiting-for-idle",
          targetVersion: staged.version,
        });
        await waitForIdle(job, signal);
        if (signal.aborted) return;
      }
      const restartAt = now() + restartDelayMs;
      await send({
        type: "job",
        jobId: job.id,
        state: "awaiting-restart",
        targetVersion: staged.version,
        restartAt: new Date(restartAt).toISOString(),
      });
      const decision = await options.confirmRestart({
        version: staged.version,
        restartAt,
        signal,
      });
      if (decision === "cancelled" || signal.aborted) return;
      if (decision === "postpone") {
        await send({ type: "job", jobId: job.id, state: "postponed" });
        return;
      }
      // Record the restart before quitting, so the next backend knows the
      // install was attempted.
      const acknowledged = await sendCritical(
        { type: "job", jobId: job.id, state: "restarting" },
        signal,
      );
      if (acknowledged?.job?.id !== job.id || acknowledged.job.state !== "restarting") {
        log.warn("remote.restart-not-recorded");
        if (!signal.aborted)
          await fail("The backend could not acknowledge the restart; retry the update");
        return;
      }
      await options
        .beforeInstall?.({ jobId: job.id, version: staged.version })
        .catch((error: unknown) =>
          log.warn("remote.relaunch-prepare-failed", { error: formatLogError(error) }),
        );
      log.info("remote.installing", { version: staged.version });
      if (!(await engine.installStaged(staged.version))) {
        await fail("The staged update is no longer available");
      }
    } catch (error) {
      if (!signal.aborted) await fail(message(error));
    } finally {
      running.delete(job.id);
      engine.releaseRemoteStage?.();
    }
  }

  function reconcile(snapshot: HostMaintenanceSnapshot): void {
    if (!started || !ready || snapshot.revision < revision) return;
    revision = snapshot.revision;
    // Before the check request: switching channels asks for a check on the new one.
    if (isHostUpdateChannel(snapshot.updateChannel)) {
      if (updateChannel !== snapshot.updateChannel) lastCheck = null;
      updateChannel = snapshot.updateChannel;
      engine.setChannel?.(snapshot.updateChannel);
    }
    const request = snapshot.checkRequest;
    if (request && request.id !== handledCheckId) {
      handledCheckId = request.id;
      void runCheck(request.id).catch((error: unknown) =>
        log.warn("remote.check-failed", { error: formatLogError(error, { stack: false }) }),
      );
    }
    const job = snapshot.job;
    if (!job) return;
    if (job.state === "cancelled") {
      running.get(job.id)?.abort();
      return;
    }
    if (job.state === "requested" && handledJobId !== job.id) {
      handledJobId = job.id;
      const controller = new AbortController();
      running.set(job.id, controller);
      void runJob(job, controller.signal);
    }
  }

  function refresh(): Promise<void> {
    refreshing ??= (async () => {
      try {
        const announcement = await send({ type: "ready" });
        if (!announcement) {
          ready = false;
          scheduleRecovery();
          return;
        }
        ready = true;
        for (const [jobId, error] of pendingFailures) {
          if (await send({ type: "job", jobId, state: "failed", error }))
            pendingFailures.delete(jobId);
        }
        if (pendingFailures.size) scheduleRecovery();
        else recoveryDelay = options.reportRetryMs ?? 1_000;
        reconcile(await channel.snapshot());
      } catch (error) {
        log.warn("remote.read-failed", { error: formatLogError(error, { stack: false }) });
        scheduleRecovery();
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await refresh();
    },
    handleEvent(event: string, payload: unknown): void {
      if (!started) return;
      if (event === HOST_MAINTENANCE_EVENT) {
        if (isHostMaintenanceSnapshot(payload)) reconcile(payload);
        return;
      }
      // A fresh stream or a reconciliation frame may have missed events.
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) void refresh();
    },
    reportCheck,
  };
}

/**
 * The 60 s countdown shown on this computer before a remote-requested restart.
 *
 * Restart Now and an unanswered dialog both restart; Postpone keeps working
 * and leaves the update to install on the next quit. `signal` (a remote
 * cancel) closes it. A macOS message box with no parent window runs
 * synchronously and would freeze the timer, so without a window the countdown
 * is a notification and the restart cannot be postponed: nobody has the app
 * open to be interrupted.
 */
export async function confirmRestartWithCountdown(input: {
  version: string;
  restartAt: number;
  productName: string;
  window: unknown | null;
  signal?: AbortSignal;
  showMessageBox(
    window: unknown,
    options: {
      type: "info";
      buttons: string[];
      defaultId: number;
      cancelId: number;
      message: string;
      detail: string;
      signal: AbortSignal;
    },
  ): Promise<{ response: number }>;
  notify(title: string, body: string): void;
  now?: () => number;
}): Promise<RestartDecision> {
  const now = input.now ?? Date.now;
  const remainingMs = Math.max(0, input.restartAt - now());
  const seconds = Math.round(remainingMs / 1000);
  const detail =
    `An update was requested from another device. ${input.productName} restarts in ${seconds} seconds to install it, ` +
    "which ends agent turns and terminals running on this computer. Containers keep running. " +
    "Choose Postpone to keep working; the update then installs the next time you quit.";
  const external = input.signal ?? new AbortController().signal;
  if (external.aborted) return "cancelled";
  if (!input.window) {
    input.notify(
      `${input.productName} restarts in ${seconds} seconds`,
      `Installing ${input.version}.`,
    );
    await sleep(remainingMs, external);
    return external.aborted ? "cancelled" : "restart";
  }
  const close = new AbortController();
  const timer = setTimeout(() => close.abort(), remainingMs);
  const onCancel = () => close.abort();
  external.addEventListener("abort", onCancel, { once: true });
  try {
    const result = await input.showMessageBox(input.window, {
      type: "info",
      buttons: ["Restart Now", "Postpone"],
      defaultId: 0,
      cancelId: 1,
      message: `Restarting to install ${input.productName} ${input.version}`,
      detail,
      signal: close.signal,
    });
    if (external.aborted) return "cancelled";
    // An aborted box resolves as if cancelled; the deadline means restart.
    if (close.signal.aborted) return "restart";
    return result.response === 1 ? "postpone" : "restart";
  } finally {
    clearTimeout(timer);
    external.removeEventListener("abort", onCancel);
  }
}
