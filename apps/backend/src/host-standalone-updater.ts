import {
  HOST_UPDATE_CHANNEL_TAGS,
  HOST_UPDATE_RESTART_DELAY_MS,
  hostUpdateChannelsReceived,
  hostUpdateChannelOfVersion,
  type HostUpdateChannel,
  isHostIdle,
  isHostVersion,
  type HostMaintenanceSnapshot,
  type HostUpdateJob,
  type HostUpdaterReport,
} from "@orkestrator/protocol/host-maintenance";
import {
  activateRelease,
  installLauncher,
  installRelease,
  isNewerVersion,
  readReleaseManifest,
  readServiceConfig,
  releaseEntry,
  requestRestart,
  runFile,
  satisfiesBunRange,
  STANDALONE_PACKAGE,
  type CommandRunner,
  type StandaloneLayout,
} from "@orkestrator/protocol/node/standalone-service";
import type { HostMaintenanceService } from "./core/host-maintenance.js";

/**
 * The executor of a standalone backend installed with `orkestrator service
 * install`: it updates itself.
 *
 * A check asks the npm registry for the dist-tags of the host's update channel
 * and every more stable one (`latest`, `beta`, `alpha`), and takes the newest
 * of them. An update installs that release beside the running one (Bun
 * verifies the registry integrity), smoke-runs it, installs its pinned
 * toolchain before any downtime, waits for the host to be idle when asked,
 * counts down, then switches `current`, marks the restart and shuts this
 * backend down. The launcher starts the new release; if it never becomes ready
 * the launcher rolls back, and the restored backend reports the job failed
 * from the launcher's evidence.
 */

type JobReport = Extract<HostUpdaterReport, { type: "job" }>;

const REGISTRY = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 30_000;
const IDLE_POLL_MS = 15_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface StandaloneUpdaterOptions {
  service: HostMaintenanceService;
  layout: StandaloneLayout;
  dataDir: string;
  currentVersion: string;
  /** Graceful shutdown of this backend; the launcher restarts it. */
  shutdown(): void;
  fetchImpl?: typeof fetch;
  run?: CommandRunner;
  registry?: string;
  now?: () => number;
  restartDelayMs?: number;
  idlePollMs?: number;
  log?: Pick<Console, "info" | "warn">;
}

export function createStandaloneUpdater(options: StandaloneUpdaterOptions) {
  const { service, layout } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const run = options.run ?? runFile;
  const registry = options.registry ?? REGISTRY;
  const now = options.now ?? Date.now;
  const restartDelayMs = options.restartDelayMs ?? HOST_UPDATE_RESTART_DELAY_MS;
  const idlePollMs = options.idlePollMs ?? IDLE_POLL_MS;
  const log = options.log ?? console;
  let handledCheckId: string | null = null;
  const handledJobs = new Set<string>();
  const running = new Map<string, AbortController>();
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let unsubscribe: (() => void) | null = null;

  let channel = service.updateChannel();
  let channelGeneration = 0;

  async function latestVersion(channel: HostUpdateChannel): Promise<string> {
    const response = await fetchImpl(`${registry}/${STANDALONE_PACKAGE}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`The npm registry answered HTTP ${response.status}`);
    const metadata = (await response.json()) as { "dist-tags"?: Record<string, unknown> };
    // A tag is only moved by its own channel's releases, so a stable release
    // newer than the last beta is found under `latest`, not `beta`.
    const newest = hostUpdateChannelsReceived(channel)
      .map((received) => metadata["dist-tags"]?.[HOST_UPDATE_CHANNEL_TAGS[received]])
      .filter(isHostVersion)
      .reduce<string | null>(
        (best, version) => (best === null || isNewerVersion(version, best) ? version : best),
        null,
      );
    if (!newest) throw new Error(`The npm registry reported no ${channel} release`);
    return newest;
  }

  async function check(checkRequestId?: string): Promise<void> {
    const generation = channelGeneration;
    const checkedChannel = service.updateChannel();
    const checkedAt = new Date(now()).toISOString();
    try {
      const latest = await latestVersion(checkedChannel);
      if (generation !== channelGeneration || checkedChannel !== service.updateChannel()) return;
      service.report({
        type: "check",
        channel: checkedChannel,
        latestVersion: latest,
        updateAvailable: isNewerVersion(latest, options.currentVersion),
        checkedAt,
        error: null,
        ...(checkRequestId ? { checkRequestId } : {}),
      });
    } catch (error) {
      if (generation !== channelGeneration || checkedChannel !== service.updateChannel()) return;
      service.report({
        type: "check",
        channel: checkedChannel,
        latestVersion: null,
        updateAvailable: null,
        checkedAt,
        error: message(error),
        ...(checkRequestId ? { checkRequestId } : {}),
      });
    }
  }

  async function waitForIdle(job: HostUpdateJob, signal: AbortSignal): Promise<void> {
    const deadline = job.idleDeadline ? Date.parse(job.idleDeadline) : now();
    while (!signal.aborted && now() < deadline) {
      const impact = await service.impact();
      if (impact && isHostIdle(impact)) return;
      await sleep(Math.min(idlePollMs, Math.max(0, deadline - now())), signal);
    }
  }

  async function runJob(job: HostUpdateJob, signal: AbortSignal): Promise<void> {
    const report = (patch: Omit<JobReport, "type" | "jobId">) =>
      service.report({ type: "job", jobId: job.id, ...patch });
    try {
      const config = readServiceConfig(layout);
      if (!config) throw new Error(`${layout.serviceFile} is missing; reinstall the service`);
      report({ state: "downloading", progressPercent: 0 });
      const selectedChannel = service.updateChannel();
      const target = job.requestedVersion ?? (await latestVersion(selectedChannel));
      const targetChannel = hostUpdateChannelOfVersion(target);
      if (!targetChannel || !hostUpdateChannelsReceived(selectedChannel).includes(targetChannel)) {
        throw new Error(`${target} is not available on the ${selectedChannel} channel`);
      }
      if (!isNewerVersion(target, options.currentVersion)) {
        report({
          state: "failed",
          error: `No update is available; ${options.currentVersion} is the newest release`,
        });
        return;
      }
      const releaseDir = await installRelease(layout, target, { bun: config.bun, run });
      if (signal.aborted) return;
      report({ state: "downloading", progressPercent: 60, targetVersion: target });
      const manifest = readReleaseManifest(releaseDir);
      if (!satisfiesBunRange(manifest?.engines?.bun, config.bunVersion)) {
        throw new Error(
          `${target} needs Bun ${manifest?.engines?.bun}; the service runs ${config.bunVersion}. Reinstall the service with a newer Bun.`,
        );
      }
      const entry = releaseEntry(releaseDir);
      const smoke = await run(config.bun, [entry, "--version"], { timeoutMs: 60_000 });
      if (!smoke.stdout.includes(target)) throw new Error(`${target} did not run`);
      // Download the new pins now, so the restart only swaps processes.
      await run(config.bun, [entry, "toolchain", "install", "--data-dir", options.dataDir], {
        timeoutMs: 20 * 60 * 1000,
      });
      if (signal.aborted) return;
      if (job.drain === "when-idle") {
        report({ state: "waiting-for-idle", targetVersion: target });
        await waitForIdle(job, signal);
        if (signal.aborted) return;
      }
      const restartAt = now() + restartDelayMs;
      report({
        state: "awaiting-restart",
        targetVersion: target,
        restartAt: new Date(restartAt).toISOString(),
      });
      // Nobody sits at a standalone backend: the countdown is the window in
      // which a remote client may still cancel.
      await sleep(Math.max(0, restartAt - now()), signal);
      if (signal.aborted) return;
      const recorded = report({ state: "restarting" });
      if (recorded.job?.id !== job.id || recorded.job.state !== "restarting") return;
      await installLauncher(layout, releaseDir);
      await activateRelease(layout, target);
      await requestRestart(layout);
      log.info(`[Updater] Restarting into ${target}`);
      options.shutdown();
    } catch (error) {
      if (!signal.aborted) report({ state: "failed", error: message(error) });
    } finally {
      running.delete(job.id);
    }
  }

  function reconcile(snapshot: HostMaintenanceSnapshot): void {
    if (channel !== snapshot.updateChannel) {
      channel = snapshot.updateChannel;
      channelGeneration += 1;
    }
    const request = snapshot.checkRequest;
    if (request && request.id !== handledCheckId) {
      handledCheckId = request.id;
      void check(request.id);
    }
    const job = snapshot.job;
    if (!job) return;
    if (job.state === "cancelled") {
      running.get(job.id)?.abort();
      return;
    }
    if (job.state === "requested" && !handledJobs.has(job.id)) {
      handledJobs.add(job.id);
      const controller = new AbortController();
      running.set(job.id, controller);
      void runJob(job, controller.signal);
    }
  }

  return {
    start(): void {
      if (unsubscribe) return;
      unsubscribe = service.subscribe(reconcile);
      reconcile(service.snapshot());
      const initial = setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
      const interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
      initial.unref?.();
      interval.unref?.();
      timers = [initial, interval];
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      for (const controller of running.values()) controller.abort();
    },
    check,
  };
}
