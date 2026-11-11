import path from "node:path";
import { PACKAGED_TEST_OUTPUT_DIRECTORY } from "../../electron-builder.packaged-test.config";
import { withCleanup } from "../process-cleanup";
import { HEADLESS_ELECTRON_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";

/** Overrides the packaged executable the packaged Electron specs launch. */
export const PACKAGED_APP_EXECUTABLE_ENV = "ORKESTRATOR_PACKAGED_APP_EXECUTABLE";

/**
 * The executable `mise run package:linux:unpacked:test` leaves under
 * `release/packaged-test/` (electron-builder's `--dir` output,
 * `linux.executableName`), unless `ORKESTRATOR_PACKAGED_APP_EXECUTABLE` names
 * another one.
 *
 * Not `release/linux-unpacked/`: that build has the Node inspect fuse off, as
 * shipped, and Playwright's `_electron.launch` cannot start it
 * (`electron-builder.packaged-test.config.ts`). On macOS the same build comes
 * from `mise run package:mac:unpacked:test`.
 */
export function packagedAppExecutable(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const override = env[PACKAGED_APP_EXECUTABLE_ENV]?.trim();
  if (override) return path.resolve(repositoryRoot, override);
  if (platform === "darwin") {
    return path.join(
      repositoryRoot,
      PACKAGED_TEST_OUTPUT_DIRECTORY,
      `mac${arch === "arm64" ? "-arm64" : ""}`,
      "OrkestratorV2.app/Contents/MacOS/OrkestratorV2",
    );
  }
  const unpacked = arch === "x64" ? "linux-unpacked" : `linux-${arch}-unpacked`;
  return path.join(repositoryRoot, PACKAGED_TEST_OUTPUT_DIRECTORY, unpacked, "orkestrator-v2");
}

/**
 * Inherited variables the packaged app may see. Everything else is dropped:
 * a shell on this host descends from a production Orkestrator, so it carries
 * that instance's `ORKESTRATOR_*` roots and agent MCP token, provider and
 * GitHub credentials, and the signed-in session's display, D-Bus and runtime
 * sockets (Chromium's Linux `safeStorage` would reach the user's keyring
 * through D-Bus).
 */
const INHERITED = new Set(["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "USER", "LOGNAME", "SHELL"]);

/**
 * The environment for a packaged app on a disposable profile: allowlisted host
 * variables, `HOME` and the XDG base directories under `home`, the profile
 * file, no fixed control-MCP port, and no boot-time reachability probe
 * (`electronSpecEnvironment`).
 */
export function packagedLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  { home, profilePath }: { home: string; profilePath: string },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (INHERITED.has(name) || name.startsWith("LC_"))) {
      result[name] = value;
    }
  }
  return electronSpecEnvironment(result, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
    // Never contend for the fixed control-MCP port an installed app may own.
    ORKESTRATOR_CONTROL_MCP_PORT: "0",
  });
}

/**
 * The design-preview Chromium override (`ORKESTRATOR_DESIGN_CHROMIUM_PATH`,
 * read by the backend's `resolveDesignChromiumPath`) when the caller set a
 * non-empty one. `packagedLaunchEnvironment` drops it with every other
 * `ORKESTRATOR_*` variable; a spec that opens a design canvas on a host whose
 * Chromium is not at a default location forwards it explicitly with this.
 */
export function designChromiumEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = env.ORKESTRATOR_DESIGN_CHROMIUM_PATH?.trim();
  return value ? { ORKESTRATOR_DESIGN_CHROMIUM_PATH: value } : {};
}

/**
 * Chromium switches for the packaged app: on Linux always headless
 * (`HEADLESS_ELECTRON_SWITCHES`), so no window reaches the signed-in desktop
 * and `safeStorage` stays off any keyring. The environment above already has
 * no display variables.
 */
export function packagedLaunchSwitches(platform: NodeJS.Platform): readonly string[] {
  return platform === "linux" ? HEADLESS_ELECTRON_SWITCHES : [];
}

/**
 * A packaged spec's final cleanup: stop the app it launched, release what the
 * run served, then remove the temporary profile. It runs after the journey,
 * so `app` is the launched application whenever a launch succeeded, and null
 * only for a run that never launched one.
 *
 * The profile is removed only once the app's own process tree is proven
 * stopped. A launched app whose tree could not be snapshotted keeps its
 * profile, and the snapshot error is reported with the cleanup failure,
 * rather than deleting a profile a live app may still be writing.
 */
export async function stopPackagedAppThenRemoveProfile<App>(
  app: App | null,
  steps: {
    snapshot: (app: App) => number[];
    close: (app: App, owned: number[]) => Promise<void>;
    release: () => Promise<void>;
    waitForStopped: (owned: number[]) => Promise<void>;
    removeProfile: () => Promise<void>;
  },
): Promise<void> {
  // Nothing to wait for only when nothing was launched.
  let owned: number[] | undefined = app === null ? [] : undefined;
  await withCleanup(async () => {
    if (app === null) return;
    owned = steps.snapshot(app);
    await steps.close(app, owned);
  }, [
    async () => {
      await steps.release();
      if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
      await steps.waitForStopped(owned);
      await steps.removeProfile();
    },
  ]);
}
