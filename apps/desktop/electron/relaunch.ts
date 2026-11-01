import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");

/**
 * Restarts the application after this instance exits.
 *
 * An AppImage runs from a temporary FUSE mount (`/tmp/.mount_<name><random>`)
 * that its runtime removes the moment the main process exits. `app.relaunch()`
 * restarts `process.execPath`, which is inside that mount, through a
 * `--type=relauncher` helper that is itself the mounted executable. The new
 * instance then starts against a mount that has gone: Chromium cannot open
 * `icudtl.dat` and stops itself with a breakpoint trap (SIGTRAP at startup).
 *
 * For an AppImage, a shell outside the mount waits for this process to exit and
 * then starts the image file itself, which mounts afresh. The environment loses
 * every entry that points into an AppImage mount: the runtime adds its own
 * again, and inherited ones would name directories that no longer exist.
 */

type Spawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string },
) => { unref(): void; once(event: "error", listener: (error: Error) => void): unknown };

export interface RelaunchContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  pid: number;
  argv: string[];
  homeDirectory: string;
  spawn: Spawn;
  /** Registers a waiter outside an app scope before Electron can quit. */
  runSystemdService?: (args: string[], env: NodeJS.ProcessEnv) => boolean;
}

function inSystemdUnit(): boolean {
  if (process.platform !== "linux") return false;
  try {
    // The first launch can be an app scope; subsequent launches run in the
    // transient service created below and need the same cgroup handoff.
    return /\/(?:app[^/]*\.scope|[^/]+\.service)(?:\n|$)/.test(
      readFileSync("/proc/self/cgroup", "utf8"),
    );
  } catch {
    return false;
  }
}

const defaultContext = (): RelaunchContext => ({
  platform: process.platform,
  env: process.env,
  pid: process.pid,
  argv: process.argv,
  homeDirectory: os.homedir(),
  spawn: (command, args, options) => spawn(command, args, options),
  ...(inSystemdUnit()
    ? {
        runSystemdService: (args: string[], env: NodeJS.ProcessEnv) =>
          spawnSync("/usr/bin/systemd-run", args, {
            env,
            cwd: os.homedir(),
            stdio: "ignore",
            timeout: 5_000,
          }).status === 0,
      }
    : {}),
});

/** A path inside any AppImage runtime mount, this one's or an older instance's. */
const APPIMAGE_MOUNT = /\/\.mount_[^/:]*(?:\/|$)/;

/** Waits for the PID in $1 to exit, then runs the remaining arguments. */
const WAIT_THEN_EXEC = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"';

/** The environment for a fresh AppImage launch, without any mount paths. */
export function appImageRelaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((entry) => !APPIMAGE_MOUNT.test(entry))
      .join(":");
    if (kept) next[key] = kept;
  }
  // The runtime sets these for the instance it starts.
  delete next.APPDIR;
  delete next.APPIMAGE;
  delete next.ARGV0;
  return next;
}

export function relaunchApplication(
  app: Pick<Electron.App, "relaunch">,
  context: RelaunchContext = defaultContext(),
): void {
  const image = context.env.APPIMAGE;
  if (context.platform !== "linux" || !image) {
    app.relaunch();
    return;
  }
  const env = appImageRelaunchEnvironment(context.env);
  const args = [
    "-c",
    WAIT_THEN_EXEC,
    "orkestrator-relaunch",
    String(context.pid),
    image,
    ...context.argv.slice(1),
  ];
  // setsid/detached does not leave the app's cgroup. A transient service does,
  // so stopping an Omarchy/UWSM app scope cannot kill the restart waiter.
  // Wait for registration: callers quit immediately after this returns.
  if (context.runSystemdService) {
    const registered = context.runSystemdService(
      [
        "--user",
        "--quiet",
        "--collect",
        "--service-type=exec",
        "--expand-environment=no",
        `--working-directory=${context.homeDirectory}`,
        "--property=UnsetEnvironment=APPDIR APPIMAGE ARGV0",
        // Bare keys copy values from the sanitized environment without exposing
        // credentials in systemd-run's command line.
        ...Object.keys(env).map((key) => `--setenv=${key}`),
        "--",
        "/bin/sh",
        ...args,
      ],
      env,
    );
    if (registered) return;
    log.warn("relaunch.service-register-failed");
  }
  const waiter = context.spawn("/bin/sh", args, {
    detached: true,
    stdio: "ignore",
    env,
    // OWD can be a deleted worktree; the current directory can be a mount
    // that disappears on exit. Neither is a reliable place to start from.
    cwd: context.homeDirectory,
  });
  // A spawn failure arrives asynchronously, usually before the quit completes.
  // Electron's relauncher is the better fallback than no relaunch at all.
  waiter.once("error", (error) => {
    log.error("relaunch.schedule-failed", { error: formatLogError(error) });
    app.relaunch();
  });
  waiter.unref();
}
