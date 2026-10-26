import { spawn } from "node:child_process";
import os from "node:os";

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
}

const defaultContext = (): RelaunchContext => ({
  platform: process.platform,
  env: process.env,
  pid: process.pid,
  argv: process.argv,
  homeDirectory: os.homedir(),
  spawn: (command, args, options) => spawn(command, args, options),
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
  const owd = context.env.OWD;
  const waiter = context.spawn(
    "/bin/sh",
    [
      "-c",
      WAIT_THEN_EXEC,
      "orkestrator-relaunch",
      String(context.pid),
      image,
      ...context.argv.slice(1),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: appImageRelaunchEnvironment(context.env),
      // The current directory may be inside the mount that is about to go.
      cwd: owd && !APPIMAGE_MOUNT.test(owd) ? owd : context.homeDirectory,
    },
  );
  // A spawn failure arrives asynchronously, usually before the quit completes.
  // Electron's relauncher is the better fallback than no relaunch at all.
  waiter.once("error", (error) => {
    console.error("[Desktop] Could not schedule the AppImage relaunch:", error);
    app.relaunch();
  });
  waiter.unref();
}
