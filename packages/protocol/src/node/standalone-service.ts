/**
 * The on-disk layout of a supervised standalone backend, shared by
 * `orkestrator service install` (the CLI), the backend's self-updater and the
 * launcher the service manager runs (`bin/orkestrator-launcher.js`, which
 * repeats the few paths it needs because it must run without this package).
 *
 *   <dataDir>/backend/
 *     releases/<version>/            one `bun install orkestrator@<version>`
 *       node_modules/orkestrator/    the package, with its dependencies
 *     current  -> releases/<version>  what the launcher starts
 *     previous -> releases/<version>  what it falls back to
 *     service.json                   Bun binary, serve arguments, rollback arguments
 *     launcher-state.json            boot attempts, boot failures, rollback evidence
 *     restart-requested              the backend exited to be restarted
 *     launcher.js                    the launcher, copied from the release
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const STANDALONE_DIRECTORY = "backend";
export const STANDALONE_PACKAGE = "orkestrator";
/** Boots of a newly activated release before the launcher rolls back. */
export const STANDALONE_MAX_BOOT_ATTEMPTS = 2;

export interface StandaloneLayout {
  root: string;
  releases: string;
  current: string;
  previous: string;
  serviceFile: string;
  stateFile: string;
  restartMarker: string;
  launcher: string;
  logs: string;
}

export function standaloneLayout(dataDir: string): StandaloneLayout {
  const root = path.join(dataDir, STANDALONE_DIRECTORY);
  return {
    root,
    releases: path.join(root, "releases"),
    current: path.join(root, "current"),
    previous: path.join(root, "previous"),
    serviceFile: path.join(root, "service.json"),
    stateFile: path.join(root, "launcher-state.json"),
    restartMarker: path.join(root, "restart-requested"),
    launcher: path.join(root, "launcher.js"),
    logs: path.join(root, "logs"),
  };
}

export interface StandaloneServiceConfig {
  version: 1;
  dataDir: string;
  /** The Bun the service runs every release with; recorded at install. */
  bun: string;
  bunVersion: string;
  /** `orkestrator serve` arguments, without `--data-dir`. */
  args: string[];
  /**
   * What the release this install replaced was running with. Rolling back must
   * not hand it arguments only the newer release understands.
   */
  rollbackTarget?: { version: string; args: string[] };
  installedAt: string;
}

export interface LauncherState {
  version: 1;
  /** The last release that reached readiness. */
  lastReadyVersion: string | null;
  /** Boots of each release that has not reached readiness yet. */
  bootAttempts: Record<string, number>;
  /** The most recent rollback, which the restored backend reports. */
  rollback: { failedVersion: string; restoredVersion: string; at: string } | null;
  /** Boots of one release that this launcher saw exit before readiness, in a row. */
  bootFailure: { version: string; exits: number; at: string } | null;
}

/** A release that `service install` activated and that is not going to start. */
export interface StandaloneStartupFailure {
  /** The release now current in its place, after a rollback. */
  restoredVersion: string | null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readServiceConfig(layout: StandaloneLayout): StandaloneServiceConfig | null {
  const value = readJson(layout.serviceFile) as Partial<StandaloneServiceConfig> | null;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.bun !== "string" ||
    typeof value.dataDir !== "string" ||
    !Array.isArray(value.args)
  ) {
    return null;
  }
  return {
    version: 1,
    dataDir: value.dataDir,
    bun: value.bun,
    bunVersion: typeof value.bunVersion === "string" ? value.bunVersion : "",
    args: value.args.filter((arg): arg is string => typeof arg === "string"),
    ...(typeof value.rollbackTarget?.version === "string" &&
    Array.isArray(value.rollbackTarget.args)
      ? {
          rollbackTarget: {
            version: value.rollbackTarget.version,
            args: value.rollbackTarget.args.filter((arg): arg is string => typeof arg === "string"),
          },
        }
      : {}),
    installedAt: typeof value.installedAt === "string" ? value.installedAt : "",
  };
}

/**
 * The `rollbackTarget` for an install of `version` over a service whose current
 * release is `before`, read before the links move. A reinstall of the running
 * version keeps `previous`, so it keeps that release's arguments too, unless
 * they were this version's own, which the new arguments now replace.
 */
export function nextRollbackTarget(
  layout: StandaloneLayout,
  config: StandaloneServiceConfig | null,
  before: string | null,
  version: string,
): StandaloneServiceConfig["rollbackTarget"] {
  if (!config || !before) return undefined;
  const target = config.rollbackTarget;
  if (before === version) return target?.version === version ? undefined : target;
  const restored = target?.version === before && linkedVersion(layout.previous) === before;
  return { version: before, args: restored ? target.args : config.args };
}

export async function writeServiceConfig(
  layout: StandaloneLayout,
  config: StandaloneServiceConfig,
): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await writeAtomically(layout.serviceFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function readLauncherState(layout: StandaloneLayout): LauncherState {
  const value = readJson(layout.stateFile) as Partial<LauncherState> | null;
  const rollback = value?.rollback;
  const bootFailure = value?.bootFailure;
  return {
    version: 1,
    lastReadyVersion: typeof value?.lastReadyVersion === "string" ? value.lastReadyVersion : null,
    bootAttempts:
      value?.bootAttempts && typeof value.bootAttempts === "object" ? value.bootAttempts : {},
    rollback:
      rollback &&
      typeof rollback.failedVersion === "string" &&
      typeof rollback.restoredVersion === "string" &&
      typeof rollback.at === "string"
        ? rollback
        : null,
    bootFailure:
      bootFailure &&
      typeof bootFailure.version === "string" &&
      typeof bootFailure.exits === "number" &&
      typeof bootFailure.at === "string"
        ? bootFailure
        : null,
  };
}

/**
 * Whether the launcher has given up on `version` since `sinceMs`. It has when
 * it rolled that release back, or when the release has used up its boots and
 * no rollback is coming: the launcher only rolls back a release that never
 * reached readiness, to a different one. Otherwise, with its boots used up, the
 * rollback record is a retry delay away and says more, so this waits for it.
 */
export function readStartupFailure(
  layout: StandaloneLayout,
  version: string,
  sinceMs: number,
): StandaloneStartupFailure | null {
  const state = readLauncherState(layout);
  const rollback = state.rollback;
  if (rollback?.failedVersion === version && Date.parse(rollback.at) >= sinceMs) {
    return { restoredVersion: rollback.restoredVersion };
  }
  const failure = state.bootFailure;
  if (
    failure?.version !== version ||
    failure.exits < STANDALONE_MAX_BOOT_ATTEMPTS ||
    Date.parse(failure.at) < sinceMs
  ) {
    return null;
  }
  const previous = linkedVersion(layout.previous);
  const rollbackComing = previous && previous !== version && state.lastReadyVersion !== version;
  return rollbackComing ? null : { restoredVersion: null };
}

async function writeAtomically(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}

/** The version a release link points at, or null. */
export function linkedVersion(link: string): string | null {
  try {
    return path.basename(readlinkSync(link));
  } catch {
    return null;
  }
}

export function releaseDirectory(layout: StandaloneLayout, version: string): string {
  return path.join(layout.releases, version);
}

export function releasePackageRoot(releaseDir: string): string {
  return path.join(releaseDir, "node_modules", STANDALONE_PACKAGE);
}

export function releaseEntry(releaseDir: string): string {
  return path.join(releasePackageRoot(releaseDir), "bin", "orkestrator.js");
}

export function releaseLauncher(releaseDir: string): string {
  return path.join(releasePackageRoot(releaseDir), "bin", "orkestrator-launcher.js");
}

/** `package.json` of an installed release, or null when it is incomplete. */
export function readReleaseManifest(
  releaseDir: string,
): { version: string; engines?: { bun?: string } } | null {
  const manifest = readJson(path.join(releasePackageRoot(releaseDir), "package.json")) as {
    version?: unknown;
    engines?: { bun?: unknown };
  } | null;
  if (!manifest || typeof manifest.version !== "string") return null;
  if (!existsSync(releaseEntry(releaseDir))) return null;
  return {
    version: manifest.version,
    ...(typeof manifest.engines?.bun === "string"
      ? { engines: { bun: manifest.engines.bun } }
      : {}),
  };
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export const runFile: CommandRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/**
 * Installs `orkestrator@<version>` with its dependencies into its own release
 * directory. Bun checks each tarball against the registry's integrity hash.
 * The directory appears only once the install verified, by one rename, and an
 * existing complete release is reused.
 */
export async function installRelease(
  layout: StandaloneLayout,
  version: string,
  options: { bun: string; run?: CommandRunner; registry?: string },
): Promise<string> {
  const target = releaseDirectory(layout, version);
  if (readReleaseManifest(target)?.version === version) return target;
  const run = options.run ?? runFile;
  await mkdir(layout.releases, { recursive: true });
  const staging = path.join(layout.releases, `.staging-${version}-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(
      path.join(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "orkestrator-release",
          private: true,
          dependencies: { [STANDALONE_PACKAGE]: version },
        },
        null,
        2,
      )}\n`,
    );
    await run(
      options.bun,
      [
        "install",
        "--production",
        "--no-progress",
        ...(options.registry ? ["--registry", options.registry] : []),
      ],
      { cwd: staging, timeoutMs: 20 * 60 * 1000 },
    );
    const manifest = readReleaseManifest(staging);
    if (manifest?.version !== version) {
      throw new Error(`Installing ${STANDALONE_PACKAGE}@${version} produced no usable release`);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}

async function pointLink(link: string, target: string): Promise<void> {
  const temporary = `${link}.${process.pid}.${Date.now()}.tmp`;
  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, link);
}

/**
 * Makes `version` current and remembers what was current as `previous`, so
 * the launcher can fall back. Each link moves by one rename.
 */
export async function activateRelease(layout: StandaloneLayout, version: string): Promise<void> {
  const target = releaseDirectory(layout, version);
  const before = linkedVersion(layout.current);
  if (before && before !== version) {
    await pointLink(layout.previous, releaseDirectory(layout, before));
  }
  await pointLink(layout.current, target);
}

/** Copies the release's launcher into place; the service runs that stable copy. */
export async function installLauncher(layout: StandaloneLayout, releaseDir: string): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  const temporary = `${layout.launcher}.${process.pid}.tmp`;
  await copyFile(releaseLauncher(releaseDir), temporary);
  await rename(temporary, layout.launcher);
}

export async function requestRestart(layout: StandaloneLayout): Promise<void> {
  await writeFile(layout.restartMarker, `${new Date().toISOString()}\n`);
}

/**
 * Whether `version` satisfies an `engines` range. Only the forms this package
 * publishes are understood (`>=x.y.z`, `x.y.z`); anything else is accepted.
 */
export function satisfiesBunRange(range: string | undefined, version: string): boolean {
  if (!range) return true;
  const parse = (text: string) => text.split(".").map((part) => Number.parseInt(part, 10));
  const compare = (left: number[], right: number[]) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };
  const trimmed = range.trim();
  const minimum = /^>=\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (minimum) return compare(parse(version), parse(minimum[1]!)) >= 0;
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return compare(parse(version), parse(trimmed)) === 0;
  return true;
}

/** `a` is a newer release than `b` (numeric `x.y.z`, prereleases older). */
export function isNewerVersion(a: string, b: string): boolean {
  const split = (text: string) => {
    const [core = "", pre] = text.split("-", 2);
    return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (left.pre === right.pre) return false;
  if (!left.pre) return true;
  if (!right.pre) return false;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true }) > 0;
}

export async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").catch(() => null);
}
