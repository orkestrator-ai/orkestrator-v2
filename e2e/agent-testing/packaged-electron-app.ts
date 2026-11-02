import path from "node:path";
import { HEADLESS_ELECTRON_SWITCHES } from "./electron-launch-switches";

/** Overrides the packaged executable the packaged Electron specs launch. */
export const PACKAGED_APP_EXECUTABLE_ENV = "ORKESTRATOR_PACKAGED_APP_EXECUTABLE";

/**
 * The executable `mise run package:linux:unpacked` leaves under `release/`
 * (electron-builder's `--dir` output, `linux.executableName`), unless
 * `ORKESTRATOR_PACKAGED_APP_EXECUTABLE` names another one.
 */
export function packagedAppExecutable(repositoryRoot: string, env: NodeJS.ProcessEnv): string {
  const override = env[PACKAGED_APP_EXECUTABLE_ENV]?.trim();
  if (override) return path.resolve(repositoryRoot, override);
  const unpacked = process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`;
  return path.join(repositoryRoot, "release", unpacked, "orkestrator-v2");
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
 * file, and no fixed control-MCP port.
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
  return {
    ...result,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
    // Never contend for the fixed control-MCP port an installed app may own.
    ORKESTRATOR_CONTROL_MCP_PORT: "0",
  };
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
