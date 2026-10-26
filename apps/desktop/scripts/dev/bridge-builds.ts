import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultRuntimeProfileRoots,
  runtimeProfileStatusPath,
} from "@orkestrator/protocol/node/runtime-profile-status";

/**
 * Bridge builds an agent-test profile runs. The backend launches every local
 * bridge from `bridges/<bridge>/dist/index.js` (`getBridgePath`), while it runs
 * from source itself, so a profile started after a bridge change would test
 * the previous build. `dev:test` therefore builds the bridges through Turbo
 * before it starts the backend, and records what it launched with; the live
 * suites compare that record with the checkout and refuse to spend tokens on a
 * build that no longer matches it.
 *
 * Node-compatible: Playwright's global setup imports it.
 */

export const LOCAL_BRIDGES = [
  "acp-bridge",
  "claude-bridge",
  "codex-bridge",
  "cursor-bridge",
  "pi-bridge",
] as const;

export type LocalBridge = (typeof LOCAL_BRIDGES)[number];

/** Written beside the profile's `status.json`; not part of that manifest's contract. */
export const BRIDGE_BUILDS_FILE = "bridge-builds.json";

/** Set to `1` to run against a profile whose bridges no longer match the checkout. */
export const ALLOW_STALE_BRIDGES_ENV = "ORKESTRATOR_AGENT_TEST_ALLOW_STALE_BRIDGES";

export type BridgeBuildState = {
  /** Turbo's `build` task hash: the bridge's sources, lockfile and workspace dependencies. */
  inputs: string | null;
  /** SHA-256 of `dist/index.js`, or null when it is missing. */
  bundle: string | null;
};

export type BridgeBuildRecord = {
  version: 1;
  repositoryRoot: string;
  recordedAt: string;
  bridges: Record<LocalBridge, BridgeBuildState>;
};

export type CommandResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

/** Runs `bunx turbo <args>` in the repository; injected by tests. */
export type TurboRunner = (args: string[], cwd: string) => CommandResult;

export const runTurbo: TurboRunner = (args, cwd) =>
  spawnSync("bunx", ["turbo", "--cwd", cwd, ...args], {
    cwd,
    encoding: "utf8",
    // The dry-run plan of five bridges is a few hundred kilobytes.
    maxBuffer: 64 * 1024 * 1024,
  });

function bridgeFilters(): string[] {
  return LOCAL_BRIDGES.map((bridge) => `--filter=${bridge}`);
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}`;
}

/**
 * Builds every local bridge. Turbo restores an unchanged bridge from its cache
 * (writing the cached `dist` back over whatever is on disk), so this costs a
 * few seconds unless a bridge or a package it bundles changed. Returns the
 * combined output for the caller's log.
 */
export function buildLocalBridges(
  repositoryRoot: string,
  run: TurboRunner = runTurbo,
): { ok: boolean; output: string } {
  const result = run(
    ["run", "build", ...bridgeFilters(), "--output-logs=errors-only"],
    repositoryRoot,
  );
  return { ok: result.status === 0, output: commandOutput(result) };
}

/** Each bridge's current `build` task hash, from a Turbo dry run (about 0.1 s). */
export function bridgeInputHashes(
  repositoryRoot: string,
  run: TurboRunner = runTurbo,
): Record<LocalBridge, string | null> {
  const result = run(["run", "build", ...bridgeFilters(), "--dry=json"], repositoryRoot);
  if (result.status !== 0) {
    throw new Error(`Turbo could not plan the bridge builds: ${commandOutput(result).trim()}`);
  }
  return parseBridgeInputHashes(result.stdout ?? "");
}

export function parseBridgeInputHashes(stdout: string): Record<LocalBridge, string | null> {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("Turbo's dry run printed no plan");
  const plan = JSON.parse(stdout.slice(start)) as { tasks?: unknown };
  if (!Array.isArray(plan.tasks)) throw new Error("Turbo's dry run plan has no tasks");
  const hashes = Object.fromEntries(LOCAL_BRIDGES.map((bridge) => [bridge, null])) as Record<
    LocalBridge,
    string | null
  >;
  for (const task of plan.tasks as Array<{ taskId?: unknown; hash?: unknown }>) {
    const bridge = LOCAL_BRIDGES.find((name) => task.taskId === `${name}#build`);
    if (bridge && typeof task.hash === "string") hashes[bridge] = task.hash;
  }
  return hashes;
}

export function bridgeBundleHash(repositoryRoot: string, bridge: LocalBridge): string | null {
  try {
    const bundle = readFileSync(path.join(repositoryRoot, "bridges", bridge, "dist", "index.js"));
    return createHash("sha256").update(bundle).digest("hex");
  } catch {
    return null;
  }
}

export function snapshotBridgeBuilds(
  repositoryRoot: string,
  options: { run?: TurboRunner; now?: () => Date } = {},
): BridgeBuildRecord {
  const inputs = bridgeInputHashes(repositoryRoot, options.run);
  const bridges = Object.fromEntries(
    LOCAL_BRIDGES.map((bridge) => [
      bridge,
      { inputs: inputs[bridge], bundle: bridgeBundleHash(repositoryRoot, bridge) },
    ]),
  ) as Record<LocalBridge, BridgeBuildState>;
  return {
    version: 1,
    repositoryRoot,
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    bridges,
  };
}

/**
 * Why the bridges a profile started with differ from the checkout now, one
 * line per bridge; empty when they match. A changed input means the source
 * moved on without a rebuild; a changed bundle means `dist` was rebuilt or
 * replaced under the running profile, whose bridge processes may still run
 * the old one.
 */
export function compareBridgeBuilds(
  recorded: BridgeBuildRecord,
  current: BridgeBuildRecord,
): string[] {
  const problems: string[] = [];
  for (const bridge of LOCAL_BRIDGES) {
    const before = recorded.bridges[bridge];
    const now = current.bridges[bridge];
    if (!before?.bundle) {
      problems.push(`${bridge}: the profile started without a build`);
    } else if (!now.bundle) {
      problems.push(`${bridge}: dist/index.js is missing`);
    } else if (before.inputs !== now.inputs) {
      problems.push(`${bridge}: its sources changed since the profile started`);
    } else if (before.bundle !== now.bundle) {
      problems.push(`${bridge}: dist/index.js changed since the profile started`);
    }
  }
  return problems;
}

export function bridgeBuildRecordPath(statusPath: string): string {
  return path.join(path.dirname(statusPath), BRIDGE_BUILDS_FILE);
}

export async function writeBridgeBuildRecord(
  statusPath: string,
  record: BridgeBuildRecord,
): Promise<void> {
  const target = bridgeBuildRecordPath(statusPath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export function parseBridgeBuildRecord(value: unknown): BridgeBuildRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BridgeBuildRecord>;
  if (
    candidate.version !== 1 ||
    typeof candidate.repositoryRoot !== "string" ||
    !candidate.bridges ||
    typeof candidate.bridges !== "object"
  ) {
    return null;
  }
  return candidate as BridgeBuildRecord;
}

export async function readBridgeBuildRecord(statusPath: string): Promise<BridgeBuildRecord | null> {
  try {
    return parseBridgeBuildRecord(
      JSON.parse(await readFile(bridgeBuildRecordPath(statusPath), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

/**
 * Builds the bridges for a starting profile and records the result. Throws
 * with the log path when a build fails: a profile must not start on a bridge
 * that no longer compiles, or on the build before it.
 */
export async function prepareProfileBridgeBuilds(options: {
  repositoryRoot: string;
  statusPath: string;
  writeLog: (text: string) => Promise<void>;
  logPath: string;
  run?: TurboRunner;
}): Promise<BridgeBuildRecord> {
  const built = buildLocalBridges(options.repositoryRoot, options.run);
  await options.writeLog(built.output);
  if (!built.ok) throw new Error(`Bridge build failed; see ${options.logPath}`);
  const record = snapshotBridgeBuilds(options.repositoryRoot, { run: options.run });
  const missing = LOCAL_BRIDGES.filter((bridge) => !record.bridges[bridge].bundle);
  if (missing.length > 0) {
    throw new Error(`Bridge build left no dist/index.js for ${missing.join(", ")}`);
  }
  await writeBridgeBuildRecord(options.statusPath, record);
  return record;
}

export type ProfileBridgeCheck =
  | { state: "current" }
  | { state: "allowed"; problems: string[] }
  | { state: "no-profile" }
  | { state: "unrecorded" };

/**
 * The live-suite guard: throws when the bridges the named profile started with
 * no longer match its checkout, so a run fails before its first billed turn.
 * A profile with no status yet is left to the suite (it fails on its own); one
 * started before records existed is reported, not failed.
 */
export async function checkProfileBridgeBuilds(options: {
  profile: string;
  env?: NodeJS.ProcessEnv;
  developmentRoot?: string;
  run?: TurboRunner;
}): Promise<ProfileBridgeCheck> {
  const env = options.env ?? process.env;
  const developmentRoot =
    options.developmentRoot ?? defaultRuntimeProfileRoots(process.platform, env).developmentRoot;
  const { id, statusPath } = runtimeProfileStatusPath(developmentRoot, options.profile);
  const statusExists = await readFile(statusPath, "utf8").then(
    () => true,
    () => false,
  );
  if (!statusExists) return { state: "no-profile" };
  const recorded = await readBridgeBuildRecord(statusPath);
  if (!recorded) return { state: "unrecorded" };
  const problems = compareBridgeBuilds(
    recorded,
    snapshotBridgeBuilds(recorded.repositoryRoot, { run: options.run }),
  );
  if (problems.length === 0) return { state: "current" };
  if (env[ALLOW_STALE_BRIDGES_ENV] === "1") return { state: "allowed", problems };
  throw new Error(
    [
      `Profile ${id} is running bridge builds that no longer match ${recorded.repositoryRoot}:`,
      ...problems.map((problem) => `  - ${problem}`),
      `Restart it so dev:test rebuilds them: mise run dev:stop --profile ${id}, then mise run dev:test --profile ${id} with its original flags.`,
      `Set ${ALLOW_STALE_BRIDGES_ENV}=1 to run against these builds anyway.`,
    ].join("\n"),
  );
}
