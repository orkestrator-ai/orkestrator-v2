/**
 * `orkestrator serve --supervised`: a small parent process that runs the
 * backend as a child, restarts it when it exits, and installs updates for it
 * with a health-gated cutover and rollback. It is the backend's update host
 * for headless installs (the desktop app's is Electron main).
 *
 * The supervisor never imports the backend. It talks to the child only over
 * the child's loopback control listener, with the token from the auth file
 * the child names in its readiness line, exactly as Electron main does.
 *
 * Design: docs/architecture/release-channels-and-updates.md ("Headless supervisor").
 */
import type {
  UpdateHostOutcome,
  UpdateHostRegistration,
  UpdateHostRequest,
} from "@orkestrator/protocol/updates";

export const READY_TIMEOUT_MS = 120_000;
export const STABILITY_WINDOW_MS = 20_000;
export const STOP_TIMEOUT_MS = 60_000;
export const POLL_INTERVAL_MS = 2_000;
export const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
/** Launch failures of a freshly installed version before it is rolled back. */
export const CRASH_LOOP_LIMIT = 3;
/** ...within this sliding window... */
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
/** ...and only this soon after the install; later failures are not the update's. */
export const CRASH_LOOP_INSTALL_WINDOW_MS = 30 * 60 * 1000;
/** A backend that ran this long before exiting resets the backoff. */
export const STABLE_RUN_MS = 5 * 60 * 1000;
/** Progress while staging, so a slow download does not look like a stalled host. */
export const STAGE_HEARTBEAT_MS = 60_000;

export type BackendEndpoint = { url: string; token: string };
export type ExitInfo = { code: number | null; signal: string | null };

export type BackendChild = {
  ready: Promise<BackendEndpoint>;
  exited: Promise<ExitInfo>;
  signal(signal: "SIGTERM" | "SIGKILL"): void;
};

export type BackendClient = {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  status(): Promise<{ ok?: boolean; appVersion?: string }>;
};

export type SupervisorState = {
  version: 1;
  /** Set while a cutover runs; a supervisor that crashed mid-way rolls it back. */
  cutover: {
    jobId: string;
    fromRoot: string;
    fromInstallDir: string | null;
    toRoot: string;
    toInstallDir: string;
    toVersion: string;
    startedAt: number;
    toolchainBefore: string | null;
    userVersionBefore: number | null;
  } | null;
  /** An outcome to report once a backend is up and registered. */
  pendingOutcome: Omit<UpdateHostOutcome, "hostSessionId"> | null;
  /** The last successful install, for the crash-loop guard. */
  lastInstall: {
    toRoot: string;
    fromRoot: string;
    fromInstallDir: string | null;
    at: number;
    toolchainBefore: string | null;
    userVersionBefore: number | null;
  } | null;
};

export type SupervisorRuntime = {
  spawn(packageRoot: string, args: readonly string[]): BackendChild;
  client(endpoint: BackendEndpoint): BackendClient;
  /** `bun add` the exact version into a fresh directory, verified; returns the install directory. */
  stage(version: string, requirementsSha256: string): Promise<string>;
  /** The install directory `current` points at, or null for the bootstrap package. */
  readCurrent(): Promise<string | null>;
  /** Points `current` at an install directory, or removes it (back to the bootstrap). */
  setCurrent(installDir: string | null): Promise<void>;
  setPrevious(installDir: string | null): Promise<void>;
  packageRootOf(installDir: string): string;
  packageVersion(packageRoot: string): Promise<string | null>;
  readState(): Promise<SupervisorState | null>;
  writeState(state: SupervisorState): Promise<void>;
  /** The database's `PRAGMA user_version`, read with the backend stopped. */
  readUserVersion(): number | null;
  /** Restores the pre-migration snapshot of `fromVersion` taken after `since`. */
  restoreSnapshot(fromVersion: number, since: number): Promise<boolean>;
  readToolchainCurrent(): Promise<string | null>;
  pointToolchainCurrent(binDir: string): Promise<void>;
  /** Removes installed versions other than these install directories. */
  prune(keep: readonly string[]): Promise<void>;
  compareVersions(left: string, right: string): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
};

export type SupervisorOptions = {
  /** The package this supervisor runs from (the bootstrap when `current` is unset). */
  ownPackageRoot: string;
  ownVersion: string;
  /** Service flags for the child's `serve`, without `--supervised`. */
  serveArgs: readonly string[];
  runtime: SupervisorRuntime;
};

type Running = {
  startedAt: number;
  child: BackendChild;
  client: BackendClient;
  hostSessionId: string;
  root: string;
  installDir: string | null;
  version: string | null;
};

type LaunchResult = { ok: true; running: Running } | { ok: false; reason: string };

type Wake =
  | { kind: "exited"; exit: ExitInfo }
  | { kind: "install"; request: Extract<UpdateHostRequest, { kind: "install" }> }
  | { kind: "stopped" };

const EMPTY_STATE: SupervisorState = {
  version: 1,
  cutover: null,
  pendingOutcome: null,
  lastInstall: null,
};

/** The child always gets a loopback control listener: it is how the supervisor talks to it. */
export function childServeArgs(serveArgs: readonly string[]): string[] {
  const args = serveArgs.filter((arg) => arg !== "--supervised");
  const has = (flag: string) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (!has("--control-host")) args.push("--control-host", "127.0.0.1");
  if (!has("--control-port")) args.push("--control-port", "0");
  return args;
}

export class Supervisor {
  private readonly runtime: SupervisorRuntime;
  private readonly args: string[];
  private stopping = false;
  private wakeStop: (() => void) | null = null;
  private state: SupervisorState = EMPTY_STATE;
  private readonly handled = new Set<string>();
  /** When recent launches failed or backends exited, for the crash-loop guard. */
  private crashes: number[] = [];

  constructor(private readonly options: SupervisorOptions) {
    this.runtime = options.runtime;
    this.args = childServeArgs(options.serveArgs);
  }

  stop(): void {
    this.stopping = true;
    this.wakeStop?.();
  }

  private async saveState(patch: Partial<SupervisorState>): Promise<void> {
    const next = { ...this.state, ...patch };
    await this.runtime.writeState(next);
    this.state = next;
  }

  /** For paths that must go on when the disk is full: the state stays in memory. */
  private async trySaveState(patch: Partial<SupervisorState>): Promise<void> {
    try {
      await this.saveState(patch);
    } catch (error) {
      this.state = { ...this.state, ...patch };
      this.runtime.log.error(`[Supervisor] Could not save the supervisor state: ${String(error)}`);
    }
  }

  private registration(version: string | null): UpdateHostRegistration {
    return {
      hostKind: "supervisor",
      protocolVersion: 1,
      hostVersion: version ?? this.options.ownVersion,
      installKind: "npm-package",
      capabilities: { install: true, rollback: true, restart: ["now"] },
    };
  }

  /**
   * Runs `current` whenever it points at an installed package, even an older
   * one than this supervisor's: a rollback and an approved downgrade both
   * point it back. This package runs only without a `current`.
   */
  private async resolveRoot(): Promise<{ root: string; installDir: string | null }> {
    const installDir = await this.runtime.readCurrent();
    if (installDir) {
      const root = this.runtime.packageRootOf(installDir);
      const version = await this.runtime.packageVersion(root);
      if (version) {
        if (this.runtime.compareVersions(this.options.ownVersion, version) > 0) {
          this.runtime.log.info(
            `[Supervisor] Running ${version} from current, not this package's ${this.options.ownVersion}; \`orkestrator service install\` resets it`,
          );
        }
        return { root, installDir };
      }
    }
    return { root: this.options.ownPackageRoot, installDir: null };
  }

  private async stopChild(child: BackendChild): Promise<void> {
    child.signal("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      this.runtime.sleep(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!exited) {
      child.signal("SIGKILL");
      await child.exited;
    }
  }

  /**
   * Starts a backend and registers as its host. With `expectVersion` this is
   * the cutover's health check: the readiness line, `/status` reporting the
   * version, no exit during the stability window, and a registration.
   */
  private async launch(
    root: string,
    installDir: string | null,
    health: { expectVersion: string } | null,
  ): Promise<LaunchResult> {
    const child = this.runtime.spawn(root, this.args);
    const fail = async (reason: string): Promise<LaunchResult> => {
      child.signal("SIGKILL");
      await child.exited;
      return { ok: false, reason };
    };
    let endpoint: BackendEndpoint;
    try {
      endpoint = await Promise.race([
        child.ready,
        child.exited.then((exit) => {
          throw new Error(`exited (${exit.signal ?? exit.code}) before it was ready`);
        }),
        this.runtime.sleep(READY_TIMEOUT_MS).then(() => {
          throw new Error(`was not ready within ${READY_TIMEOUT_MS / 1000} s`);
        }),
      ]);
    } catch (error) {
      return fail(`The backend ${error instanceof Error ? error.message : String(error)}`);
    }
    let client: BackendClient;
    let version: string | null;
    try {
      client = this.runtime.client(endpoint);
      version = await this.runtime.packageVersion(root);
    } catch (error) {
      return fail(`Could not initialize the backend client: ${String(error)}`);
    }
    if (health) {
      try {
        const status = await client.status();
        if (status.ok !== true || status.appVersion !== health.expectVersion) {
          return fail(
            `The backend reported ${status.appVersion ?? "no version"} instead of ${health.expectVersion}`,
          );
        }
      } catch (error) {
        return fail(`The backend did not answer its status check: ${String(error)}`);
      }
      const survived = await Promise.race([
        child.exited.then(() => false),
        this.runtime.sleep(STABILITY_WINDOW_MS).then(() => true),
      ]);
      if (!survived) return fail("The backend exited during the stability window");
    }
    let hostSessionId: string;
    try {
      ({ hostSessionId } = await client.invoke<{ hostSessionId: string }>("update_host_register", {
        registration: this.registration(version),
      }));
    } catch (error) {
      if (health) return fail(`The backend refused the installer: ${String(error)}`);
      // An older backend without the update protocol still runs; it just
      // cannot be updated in place.
      this.runtime.log.warn(
        `[Supervisor] The backend does not accept an installer: ${String(error)}`,
      );
      hostSessionId = "";
    }
    return {
      ok: true,
      running: {
        startedAt: this.runtime.now(),
        child,
        client,
        hostSessionId,
        root,
        installDir,
        version,
      },
    };
  }

  private async deliverPendingOutcome(running: Running): Promise<void> {
    const outcome = this.state.pendingOutcome;
    if (!outcome || !running.hostSessionId) return;
    try {
      await running.client.invoke("update_host_outcome", {
        hostSessionId: running.hostSessionId,
        ...outcome,
      });
    } catch (error) {
      // A job the backend no longer knows is not worth retrying forever.
      this.runtime.log.warn(`[Supervisor] Could not report the update outcome: ${String(error)}`);
    }
    await this.trySaveState({ pendingOutcome: null });
  }

  private async report(
    running: Running,
    request: UpdateHostRequest,
    status: "progress" | "succeeded" | "failed",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await running.client.invoke("update_host_report", {
        hostSessionId: running.hostSessionId,
        requestId: request.requestId,
        jobId: request.jobId,
        status,
        ...extra,
      });
    } catch (error) {
      this.runtime.log.warn(`[Supervisor] Could not report to the backend: ${String(error)}`);
    }
  }

  private async prepare(
    running: Running,
    request: Extract<UpdateHostRequest, { kind: "prepare" }>,
  ): Promise<void> {
    const progress = {
      progress: { percent: null, message: `Installing orkestrator@${request.target.version}` },
    };
    await this.report(running, request, "progress", progress);
    let staging = true;
    void (async () => {
      // Each `bun add` may take minutes; the backend fails a host that is quiet for too long.
      while (staging) {
        await this.runtime.sleep(STAGE_HEARTBEAT_MS);
        if (staging) await this.report(running, request, "progress", progress);
      }
    })();
    try {
      // A rollback needs a version that will still exist: the bootstrap
      // package can live in a cache that is cleaned, so stage it too.
      if (!running.installDir && running.version) {
        await this.runtime.stage(running.version, "");
      }
      await this.runtime.stage(request.target.version, request.target.requirementsSha256);
      staging = false;
      await this.report(running, request, "succeeded");
    } catch (error) {
      staging = false;
      await this.report(running, request, "failed", {
        error: {
          code: "stage-failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        },
      });
    }
  }

  /** Polls for requests until the child exits, an install arrives, or we stop. */
  private serve(running: Running): Promise<Wake> {
    return new Promise<Wake>((resolve) => {
      let done = false;
      const finish = (wake: Wake) => {
        if (done) return;
        done = true;
        this.wakeStop = null;
        resolve(wake);
      };
      this.wakeStop = () => finish({ kind: "stopped" });
      if (this.stopping) finish({ kind: "stopped" });
      void running.child.exited.then((exit) => finish({ kind: "exited", exit }));
      const poll = async () => {
        while (!done) {
          if (!running.hostSessionId) {
            try {
              ({ hostSessionId: running.hostSessionId } = await running.client.invoke<{
                hostSessionId: string;
              }>("update_host_register", { registration: this.registration(running.version) }));
              await this.deliverPendingOutcome(running);
            } catch {
              // A transient startup failure is retried at the bounded polling interval.
            }
          }
          if (running.hostSessionId) {
            try {
              const pending = await running.client.invoke<UpdateHostRequest[]>(
                "update_host_pending",
                { hostSessionId: running.hostSessionId },
              );
              for (const request of pending) {
                if (done || this.handled.has(request.requestId)) continue;
                this.handled.add(request.requestId);
                if (request.kind === "prepare") void this.prepare(running, request);
                else if (request.kind === "cancel") {
                  // A staged version that is never installed is pruned after the next update.
                  await this.report(running, request, "succeeded");
                } else {
                  // Answer first: the backend is stopped a moment from now.
                  await this.report(running, request, "progress", {
                    progress: { percent: null, message: "restarting" },
                  });
                  await this.report(running, request, "succeeded");
                  finish({ kind: "install", request });
                }
              }
            } catch (error) {
              if (String(error).includes("register again")) {
                try {
                  ({ hostSessionId: running.hostSessionId } = await running.client.invoke<{
                    hostSessionId: string;
                  }>("update_host_register", { registration: this.registration(running.version) }));
                } catch {
                  // Retried on the next poll.
                }
              }
            }
          }
          await this.runtime.sleep(POLL_INTERVAL_MS);
        }
      };
      void poll();
    });
  }

  /**
   * The health-gated cutover. Nothing is committed until the new version has
   * passed its health check; any failure restores the previous version, its
   * provider binaries and, if the new version migrated it, the database.
   */
  private async cutover(
    running: Running,
    request: Extract<UpdateHostRequest, { kind: "install" }>,
  ): Promise<Running | null> {
    const toVersion = request.target.version;
    let toInstallDir: string;
    let fromRoot = running.root;
    let fromInstallDir = running.installDir;
    const startedAt = this.runtime.now();
    try {
      toInstallDir = await this.runtime.stage(toVersion, request.target.requirementsSha256);
      if (!fromInstallDir && running.version) {
        // Roll back to the staged copy of the bootstrap package (normally
        // staged by prepare already), not to a cache that may be cleaned.
        try {
          fromInstallDir = await this.runtime.stage(running.version, "");
          fromRoot = this.runtime.packageRootOf(fromInstallDir);
        } catch (error) {
          this.runtime.log.warn(
            `[Supervisor] Could not stage ${running.version} to roll back to; using this package: ${String(error)}`,
          );
        }
      }
      await this.saveState({
        cutover: {
          jobId: request.jobId,
          fromRoot,
          fromInstallDir,
          toRoot: this.runtime.packageRootOf(toInstallDir),
          toInstallDir,
          toVersion,
          startedAt,
          toolchainBefore: await this.runtime.readToolchainCurrent(),
          userVersionBefore: null,
        },
      });
    } catch (error) {
      // Nothing was stopped or changed: the running backend stays, and the
      // job it already marked restarting ends as an install that never ran.
      this.runtime.log.error(`[Supervisor] Could not prepare the update: ${String(error)}`);
      await this.trySaveState({
        cutover: null,
        pendingOutcome: {
          jobId: request.jobId,
          outcome: "failed",
          rollbackFailed: false,
          error: { code: "install-failed", message: String(error).slice(0, 2000) },
        },
      });
      await this.deliverPendingOutcome(running);
      return running;
    }
    await this.stopChild(running.child);
    try {
      return await this.switchTo(request, toInstallDir, startedAt);
    } catch (error) {
      this.runtime.log.error(`[Supervisor] The update to ${toVersion} failed: ${String(error)}`);
      return this.rollBack(request.jobId, {
        code: "install-failed",
        message: String(error).slice(0, 2000),
      });
    }
  }

  /** With the old backend stopped: switch over and health-check the new version. */
  private async switchTo(
    request: Extract<UpdateHostRequest, { kind: "install" }>,
    toInstallDir: string,
    startedAt: number,
  ): Promise<Running | null> {
    const toVersion = request.target.version;
    const toRoot = this.runtime.packageRootOf(toInstallDir);
    await this.saveState({
      cutover: { ...this.state.cutover!, userVersionBefore: this.runtime.readUserVersion() },
    });
    if (request.toolchainBinDir) await this.runtime.pointToolchainCurrent(request.toolchainBinDir);
    await this.runtime.setCurrent(toInstallDir);
    const started = await this.launch(toRoot, toInstallDir, { expectVersion: toVersion });
    if (started.ok) {
      const cutover = this.state.cutover!;
      try {
        await this.runtime.setPrevious(cutover.fromInstallDir);
        await this.saveState({
          cutover: null,
          pendingOutcome: { jobId: request.jobId, outcome: "succeeded" },
          lastInstall: {
            toRoot,
            fromRoot: cutover.fromRoot,
            fromInstallDir: cutover.fromInstallDir,
            at: startedAt,
            toolchainBefore: cutover.toolchainBefore,
            userVersionBefore: cutover.userVersionBefore,
          },
        });
      } catch (error) {
        // No database restore is safe until the replacement has really exited.
        await this.stopChild(started.running.child);
        throw error;
      }
      await this.deliverPendingOutcome(started.running);
      const keep = [toInstallDir, ...(cutover.fromInstallDir ? [cutover.fromInstallDir] : [])];
      await this.runtime.prune(keep).catch(() => undefined);
      this.runtime.log.info(`[Supervisor] Updated to ${toVersion}`);
      return started.running;
    }
    this.runtime.log.error(`[Supervisor] ${toVersion} failed its health check: ${started.reason}`);
    return this.rollBack(request.jobId, { code: "health-check", message: started.reason });
  }

  private async restorePrevious(record: {
    fromRoot: string;
    fromInstallDir: string | null;
    toolchainBefore: string | null;
    userVersionBefore: number | null;
    startedAt: number;
  }): Promise<void> {
    // Restore the restart pointer even if database or toolchain recovery fails.
    await this.runtime.setCurrent(record.fromInstallDir);
    const now = this.runtime.readUserVersion();
    if (
      record.userVersionBefore !== null &&
      now !== null &&
      now !== record.userVersionBefore &&
      !(await this.runtime.restoreSnapshot(record.userVersionBefore, record.startedAt))
    ) {
      this.runtime.log.error(
        `[Supervisor] The database moved from schema ${record.userVersionBefore} to ${now} and no snapshot was found to restore`,
      );
    }
    if (record.toolchainBefore) await this.runtime.pointToolchainCurrent(record.toolchainBefore);
  }

  private async rollBack(
    jobId: string,
    error: { code: string; message: string },
  ): Promise<Running | null> {
    const cutover = this.state.cutover;
    if (!cutover) return null;
    let restoreError: string | null = null;
    try {
      await this.restorePrevious(cutover);
    } catch (caught) {
      // Still start the previous version from its own root; the failure is reported.
      restoreError = String(caught);
      this.runtime.log.error(
        `[Supervisor] Could not restore the previous version: ${restoreError}`,
      );
    }
    const restored = await this.launch(cutover.fromRoot, cutover.fromInstallDir, null);
    const failure = !restored.ok
      ? "the previous version did not start either"
      : restoreError
        ? `restoring the previous version failed: ${restoreError}`
        : null;
    await this.trySaveState({
      cutover: null,
      pendingOutcome:
        failure === null
          ? { jobId, outcome: "rolled-back", error }
          : {
              jobId,
              outcome: "failed",
              rollbackFailed: true,
              error: { code: error.code, message: `${error.message}; ${failure}`.slice(0, 2000) },
            },
    });
    if (!restored.ok) {
      this.runtime.log.error(`[Supervisor] The previous version did not start: ${restored.reason}`);
      return null;
    }
    await this.deliverPendingOutcome(restored.running);
    return restored.running;
  }

  /**
   * A supervisor that died mid-cutover finishes by rolling back. Best
   * effort: whatever cannot be restored is reported, and the supervisor still
   * starts a backend rather than exiting on the same error every restart.
   */
  private async recover(): Promise<void> {
    this.state = (await this.runtime.readState().catch(() => null)) ?? { ...EMPTY_STATE };
    const cutover = this.state.cutover;
    if (!cutover) return;
    this.runtime.log.warn(
      `[Supervisor] Rolling back an update to ${cutover.toVersion} that a restart interrupted`,
    );
    let restoreError: string | null = null;
    try {
      await this.restorePrevious(cutover);
    } catch (error) {
      restoreError = String(error);
      this.runtime.log.error(
        `[Supervisor] Could not restore the previous version: ${restoreError}`,
      );
    }
    const error = { code: "interrupted", message: "The supervisor restarted during the update" };
    await this.trySaveState({
      cutover: null,
      pendingOutcome: restoreError
        ? {
            jobId: cutover.jobId,
            outcome: "failed",
            rollbackFailed: true,
            error: { ...error, message: `${error.message}; ${restoreError}`.slice(0, 2000) },
          }
        : { jobId: cutover.jobId, outcome: "rolled-back", error },
    });
  }

  private recordCrash(): void {
    const now = this.runtime.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_LOOP_WINDOW_MS), now];
  }

  /**
   * A version this supervisor installed less than 30 minutes ago that fails
   * to start 3 times within 10 minutes is rolled back rather than retried
   * forever. Later failures are not the update's: rolling back then would
   * restore a database snapshot that is out of date.
   */
  private async crashLoopGuard(root: string): Promise<void> {
    const last = this.state.lastInstall;
    if (!last) return;
    if (this.runtime.now() - last.at >= CRASH_LOOP_INSTALL_WINDOW_MS) {
      await this.trySaveState({ lastInstall: null });
      return;
    }
    if (last.toRoot !== root || this.crashes.length < CRASH_LOOP_LIMIT) return;
    this.runtime.log.error(`[Supervisor] ${root} keeps failing to start; rolling back`);
    try {
      await this.restorePrevious({ ...last, startedAt: last.at });
      await this.runtime.setPrevious(null);
    } catch (error) {
      this.runtime.log.error(`[Supervisor] Could not roll back: ${String(error)}`);
    }
    await this.trySaveState({ lastInstall: null });
    this.crashes = [];
  }

  async run(): Promise<number> {
    await this.recover();
    let running: Running | null = null;
    let backoff = 0;
    while (!this.stopping) {
      if (!running) {
        const { root, installDir } = await this.resolveRoot();
        const started = await this.launch(root, installDir, null);
        if (!started.ok) {
          this.recordCrash();
          this.runtime.log.error(`[Supervisor] ${started.reason}`);
          await this.crashLoopGuard(root);
          await this.runtime.sleep(
            RESTART_BACKOFF_MS[Math.min(backoff, RESTART_BACKOFF_MS.length - 1)]!,
          );
          backoff += 1;
          continue;
        }
        running = started.running;
        await this.deliverPendingOutcome(running);
      }
      const wake = await this.serve(running);
      if (wake.kind === "stopped") break;
      if (wake.kind === "exited") {
        // A backend that ran for a while before exiting is not a crash loop.
        if (this.runtime.now() - running.startedAt > STABLE_RUN_MS) {
          backoff = 0;
          this.crashes = [];
        }
        this.recordCrash();
        this.runtime.log.warn(
          `[Supervisor] The backend exited (${wake.exit.signal ?? wake.exit.code}); restarting`,
        );
        await this.crashLoopGuard(running.root);
        running = null;
        await this.runtime.sleep(
          RESTART_BACKOFF_MS[Math.min(backoff, RESTART_BACKOFF_MS.length - 1)]!,
        );
        backoff += 1;
        continue;
      }
      backoff = 0;
      this.crashes = [];
      const from = running;
      try {
        running = await this.cutover(from, wake.request);
      } catch (error) {
        this.runtime.log.error(`[Supervisor] The update failed unexpectedly: ${String(error)}`);
        await this.stopChild(from.child);
        running = null;
      }
    }
    // A stop that arrived during a cutover or a launch finds the backend here.
    if (running) await this.stopChild(running.child);
    return 0;
  }
}
