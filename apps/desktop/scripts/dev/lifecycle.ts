import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, rename, rm, stat, truncate } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  resolveRuntimeProfile,
  statusManifestPath,
  type RuntimeProfile,
  type RuntimeProcessName,
  type RuntimeStatusManifest,
} from "../../electron/runtime-profile.js";
import type { DevArguments } from "./arguments.js";
import {
  atomicWriteJson,
  initializeProfile,
  liveness,
  processMatches,
  processStartTime,
  removeProfileState,
  readAndValidateSentinel,
  readProfile,
  readStatus,
  reserveLoopbackPorts,
  seedAgentTestProviderCredentials,
  seedInstalledAgentToolchains,
  seedInstalledModelCatalogCaches,
} from "./profile-io.js";
import { seedFixture } from "./fixture.js";

const packageRoot = path.resolve(import.meta.dir, "../..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const webRoot = path.join(repositoryRoot, "apps", "web");
const fixtureTemplateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const RUNTIME_PROCESS_NAMES: readonly RuntimeProcessName[] = ["launcher", "vite", "electron", "backend"];

type ElectronReady = {
  type: "orkestrator-electron-ready";
  profile: string;
  electronPid: number;
  backendPid?: number;
  authFile?: string;
  browserUrl?: string;
};

export type BoundedLogWriter = {
  write: (chunk: Buffer | string) => Promise<void>;
};

/**
 * Serializes writes and rotates before the active log exceeds its byte bound.
 * The old implementation launched overlapping append/stat/read/truncate jobs
 * for every child-process chunk, which both raced and re-read the whole file.
 */
export function createBoundedLogWriter(
  filePath: string,
  maxBytes = MAX_LOG_BYTES,
): BoundedLogWriter {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A bounded log writer requires a positive integer byte limit");
  }
  let queued = Promise.resolve();
  let size: number | undefined;
  const rotatedPath = `${filePath}.1`;

  return {
    write(chunk) {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // A single write can itself exceed the cap. Preserve its tail, which is
      // where compilers and process launchers normally put the useful summary.
      const bounded = source.byteLength > maxBytes
        ? source.subarray(source.byteLength - maxBytes)
        : source;
      queued = queued.then(async () => {
        size ??= (await stat(filePath).catch(() => null))?.size ?? 0;
        if (size > 0 && size + bounded.byteLength > maxBytes) {
          await rm(rotatedPath, { force: true });
          await rename(filePath, rotatedPath).catch(async (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          size = 0;
        }
        await appendFile(filePath, bounded, { mode: 0o600 });
        size += bounded.byteLength;
      });
      return queued;
    },
  };
}

function attachLog(child: ChildProcess, filePath: string, onLine?: (line: string) => void): void {
  const writer = createBoundedLogWriter(filePath);
  let pending = "";
  const consume = (chunk: Buffer) => {
    void writer.write(chunk).catch(() => undefined);
    if (!onLine) return;
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", (chunk: Buffer) => void writer.write(chunk).catch(() => undefined));
}

async function waitForUrl(url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The strict-port child is still starting.
    }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function resolveStoredProfile(args: DevArguments, flavor: "development" | "agent-test"): Promise<RuntimeProfile> {
  const provisional = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: args.profile,
    flavor,
    credentialSources: args.credentialSources,
    agentPlatforms: args.agentPlatforms,
  });
  const stored = path.join(provisional.profileRoot, "profile.json");
  return readProfile(stored).catch(() => provisional);
}

function childStartTime(child: ChildProcess): number {
  const pid = child.pid;
  if (!pid) throw new Error("Spawned process has no PID");
  return processStartTime(pid) ?? Date.now();
}

function killOwnedChild(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

type RuntimeProcessControl = {
  matches: typeof processMatches;
  signal: (pid: number, signal: NodeJS.Signals, processGroup: boolean) => void;
  sleep: (milliseconds: number) => Promise<void>;
  /** Injectable so the escalation deadlines can be tested without waiting them out. */
  now?: () => number;
};

const defaultRuntimeProcessControl: RuntimeProcessControl = {
  matches: processMatches,
  signal: (pid, signal, processGroup) => {
    if (processGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to the exact PID when the process is not a group leader.
      }
    }
    process.kill(pid, signal);
  },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};

function controlledLiveness(
  status: RuntimeStatusManifest,
  control: Pick<RuntimeProcessControl, "matches">,
): Record<RuntimeProcessName, boolean> {
  return Object.fromEntries(RUNTIME_PROCESS_NAMES.map((name) => [
    name,
    control.matches(status.pids[name], status.processStartTimes[name]),
  ])) as Record<RuntimeProcessName, boolean>;
}

function signalTrackedRuntimeProcess(
  status: RuntimeStatusManifest,
  name: RuntimeProcessName,
  signal: NodeJS.Signals,
  control: RuntimeProcessControl,
): void {
  const pid = status.pids[name];
  const startedAt = status.processStartTimes[name];
  if (!pid || !control.matches(pid, startedAt)) return;
  try {
    control.signal(pid, signal, name === "vite" || name === "electron");
  } catch {
    // A process can exit between the identity check and signal delivery.
  }
}

async function waitForTrackedRuntimeExit(
  status: RuntimeStatusManifest,
  timeoutMs: number,
  control: RuntimeProcessControl,
): Promise<RuntimeProcessName[]> {
  const now = control.now ?? Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const live = controlledLiveness(status, control);
    const survivors = RUNTIME_PROCESS_NAMES.filter((name) => live[name]);
    if (survivors.length === 0) return [];
    await control.sleep(100);
  }
  const live = controlledLiveness(status, control);
  return RUNTIME_PROCESS_NAMES.filter((name) => live[name]);
}

export async function stopTrackedRuntimeProcesses(
  status: RuntimeStatusManifest,
  control: RuntimeProcessControl = defaultRuntimeProcessControl,
): Promise<RuntimeProcessName[]> {
  if (control.matches(status.pids.launcher, status.processStartTimes.launcher)) {
    signalTrackedRuntimeProcess(status, "launcher", "SIGTERM", control);
    const survivors = await waitForTrackedRuntimeExit(status, 5_000, control);
    if (survivors.length === 0) return [];
  }

  for (const name of RUNTIME_PROCESS_NAMES) {
    signalTrackedRuntimeProcess(status, name, "SIGTERM", control);
  }
  let survivors = await waitForTrackedRuntimeExit(status, 5_000, control);
  if (survivors.length === 0) return [];

  for (const name of survivors) {
    signalTrackedRuntimeProcess(status, name, "SIGKILL", control);
  }
  survivors = await waitForTrackedRuntimeExit(status, 2_000, control);
  return survivors;
}

/**
 * Tracked processes still alive without their launcher. Restarting over these
 * would leave a second Vite/Electron/backend trio bound to the same profile
 * directory, with only the newer one recorded in the status manifest.
 */
export function orphanedRuntimeProcesses(
  live: Record<RuntimeProcessName, boolean> | null,
): RuntimeProcessName[] {
  if (!live || live.launcher) return [];
  return RUNTIME_PROCESS_NAMES.filter((name) => live[name]);
}

export function stoppedRuntimeStatusIfUnchanged(
  original: RuntimeStatusManifest,
  latest: RuntimeStatusManifest | null,
  updatedAt = new Date().toISOString(),
): RuntimeStatusManifest | null {
  if (
    !latest
    || latest.profile !== original.profile
    || RUNTIME_PROCESS_NAMES.some((name) => (
      latest.pids[name] !== original.pids[name]
      || latest.processStartTimes[name] !== original.processStartTimes[name]
    ))
  ) return null;
  return { ...latest, status: "stopped", updatedAt };
}

export type ProfileSeedDependencies = {
  seedModelCatalogCaches?: typeof seedInstalledModelCatalogCaches;
  seedProviderCredentials?: typeof seedAgentTestProviderCredentials;
  seedAgentToolchains?: typeof seedInstalledAgentToolchains;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Pre-populate an isolated profile from the host installation, before Electron.
 *
 * Only `agent-test` seeds anything: an ordinary `dev` run uses the durable
 * per-installation state and has nothing to copy into. Electron downloads
 * whatever is still missing, so this must complete first — Cursor and Grok have
 * no PATH fallback, and the difference between seeding and downloading is
 * minutes of startup, not whether the profile works.
 */
export async function seedAgentTestProfileState(
  profile: RuntimeProfile,
  flavor: "development" | "agent-test",
  dependencies: ProfileSeedDependencies = {},
): Promise<void> {
  if (flavor !== "agent-test") return;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));
  const [, , toolchains] = await Promise.all([
    (dependencies.seedModelCatalogCaches ?? seedInstalledModelCatalogCaches)(profile),
    (dependencies.seedProviderCredentials ?? seedAgentTestProviderCredentials)(profile),
    (dependencies.seedAgentToolchains ?? seedInstalledAgentToolchains)(profile),
  ]);
  if (toolchains.seeded.length > 0) {
    log(`Seeded toolchains from the host install: ${toolchains.seeded.join(", ")}`);
  }
  // A slow startup is otherwise the only symptom of a seeder that has stopped
  // working, and it looks exactly like a host that has nothing installed.
  if (toolchains.failed.length > 0) {
    warn(`Could not seed from the host install: ${toolchains.failed.join(", ")}`);
  }
  const pending = profile.agentPlatforms.filter((platform) => (
    !toolchains.seeded.some((entry) => entry.startsWith(`${platform}@`))
  ));
  if (pending.length > 0) {
    // Attributes a long or hung startup before Electron is even launched.
    log(`Electron will download managed toolchains for: ${pending.join(", ")}`);
  }
}

export async function startDevelopment(args: DevArguments, flavor: "development" | "agent-test"): Promise<void> {
  const existingProfile = await resolveStoredProfile(args, flavor);
  const existingStatusPath = statusManifestPath(existingProfile);
  const existingStatus = await readStatus(existingStatusPath);
  const existingLive = existingStatus ? liveness(existingStatus) : null;
  if (existingStatus && existingLive?.launcher) {
    console.log(`Profile ${existingProfile.id} is already running.`);
    printHumanStatus(existingStatus, existingLive);
    return;
  }
  const orphaned = orphanedRuntimeProcesses(existingLive);
  if (orphaned.length > 0) {
    throw new Error(
      `Profile ${existingProfile.id} has surviving processes without its launcher: ${orphaned.join(", ")}. Run bun run dev:stop before restarting.`,
    );
  }

  const [rendererPort, gatewayPort] = await reserveLoopbackPorts(2) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: args.profile,
    flavor,
    rendererPort,
    gatewayPort,
    credentialSources: args.credentialSources,
    agentPlatforms: args.agentPlatforms,
  });
  const profilePath = await initializeProfile(profile);
  await seedAgentTestProfileState(profile, flavor);
  const statusPath = statusManifestPath(profile);
  const rendererUrl = `http://${profile.rendererHost}:${profile.rendererPort}`;
  const startedAt = new Date().toISOString();
  const launcherStart = processStartTime(process.pid) ?? Date.now();
  let status: RuntimeStatusManifest = {
    version: 1,
    status: "starting",
    profile: profile.id,
    flavor: profile.flavor,
    dataDir: profile.dataDir,
    electronTitle: profile.electronTitle,
    rendererUrl,
    logDir: profile.logDir,
    statusPath,
    startedAt,
    updatedAt: startedAt,
    pids: { launcher: process.pid },
    processStartTimes: { launcher: launcherStart },
  };
  await atomicWriteJson(statusPath, status);

  try {
    const build = spawnSync("bunx", ["tsc", "-p", "tsconfig.electron.json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    await createBoundedLogWriter(path.join(profile.logDir, "build.log"))
      .write(`${build.stdout}${build.stderr}`);
    if (build.status !== 0) throw new Error(`Electron compilation failed; see ${path.join(profile.logDir, "build.log")}`);

    if (args.fixtureEnvironments.includes("container")) {
      const inspected = spawnSync("docker", ["image", "inspect", profile.dockerImage], { encoding: "utf8" });
      if (inspected.status !== 0) {
        const imageBuild = spawnSync(
          "docker",
          ["build", "-t", profile.dockerImage, "-f", path.join(repositoryRoot, "docker", "Dockerfile"), repositoryRoot],
          { encoding: "utf8" },
        );
        await createBoundedLogWriter(path.join(profile.logDir, "docker-build.log"))
          .write(`${imageBuild.stdout}${imageBuild.stderr}`);
        if (imageBuild.status !== 0) {
          throw new Error(`Development Docker image build failed; see ${path.join(profile.logDir, "docker-build.log")}`);
        }
      }
    }
  } catch (error) {
    status = {
      ...status,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(statusPath, status);
    throw error;
  }

  let vite: ChildProcess | null = null;
  let electron: ChildProcess | null = null;
  let shuttingDown = false;
  const writeStatus = async (updates: Partial<RuntimeStatusManifest>) => {
    status = { ...status, ...updates, updatedAt: new Date().toISOString() };
    await atomicWriteJson(statusPath, status);
  };
  const shutdown = async (finalStatus: "stopped" | "failed", error?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await writeStatus({ status: "stopping", ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
    killOwnedChild(electron, "SIGTERM");
    killOwnedChild(vite, "SIGTERM");
    await Bun.sleep(500);
    killOwnedChild(electron, "SIGKILL");
    killOwnedChild(vite, "SIGKILL");
    await writeStatus({ status: finalStatus });
  };
  process.once("SIGINT", () => void shutdown("stopped").then(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown("stopped").then(() => process.exit(143)));

  try {
    await Promise.all([
      truncate(path.join(profile.logDir, "vite.log"), 0).catch(() => undefined),
      truncate(path.join(profile.logDir, "electron.log"), 0).catch(() => undefined),
    ]);
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VITE_DEV_HOST: profile.rendererHost,
        VITE_DEV_PORT: String(profile.rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
      },
    });
    attachLog(vite, path.join(profile.logDir, "vite.log"));
    if (!vite.pid) throw new Error("Vite failed to start");
    await writeStatus({
      pids: { ...status.pids, vite: vite.pid },
      processStartTimes: { ...status.processStartTimes, vite: childStartTime(vite) },
    });
    await waitForUrl(rendererUrl);

    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    electron = spawn(electronExecutable, ["apps/desktop/dist/electron/main.js"], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...electronEnv,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      },
    });
    if (!electron.pid) throw new Error("Electron failed to start");
    await writeStatus({
      pids: { ...status.pids, electron: electron.pid },
      processStartTimes: { ...status.processStartTimes, electron: childStartTime(electron) },
    });

    const ready = await new Promise<ElectronReady>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Electron/backend readiness")), 60_000);
      electron!.once("error", reject);
      electron!.once("exit", (code, signal) => reject(new Error(`Electron exited before readiness (code ${code ?? "unknown"}, signal ${signal ?? "none"})`)));
      attachLog(electron!, path.join(profile.logDir, "electron.log"), (line) => {
        try {
          const message = JSON.parse(line) as Partial<ElectronReady>;
          if (message.type !== "orkestrator-electron-ready" || message.profile !== profile.id) return;
          clearTimeout(timeout);
          resolve(message as ElectronReady);
        } catch {}
      });
    });
    if (!ready.browserUrl || !ready.authFile || !ready.backendPid) {
      throw new Error("Electron readiness did not include the loopback browser gateway");
    }
    let testProject: string | undefined;
    if (args.fixture) {
      testProject = await seedFixture({
        profile,
        templateRoot: fixtureTemplateRoot,
        browserUrl: ready.browserUrl,
        authFile: ready.authFile,
        environments: args.fixtureEnvironments,
      });
    }
    await writeStatus({
      status: "ready",
      browserUrl: ready.browserUrl,
      authFile: ready.authFile,
      testProject,
      pids: { ...status.pids, backend: ready.backendPid },
      processStartTimes: {
        ...status.processStartTimes,
        backend: processStartTime(ready.backendPid) ?? Date.now(),
      },
    });
    printHumanStatus(status, liveness(status));

    const termination = await Promise.race([
      new Promise<{ child: "electron"; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        electron!.once("exit", (code, signal) => resolve({ child: "electron", code, signal }));
      }),
      new Promise<{ child: "vite"; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        vite!.once("exit", (code, signal) => resolve({ child: "vite", code, signal }));
      }),
    ]);
    const cleanElectronExit = termination.child === "electron"
      && (termination.code === 0 || termination.signal === "SIGTERM");
    await shutdown(
      cleanElectronExit ? "stopped" : "failed",
      cleanElectronExit
        ? undefined
        : new Error(`${termination.child} exited unexpectedly (code ${termination.code ?? "unknown"}, signal ${termination.signal ?? "none"})`),
    );
  } catch (error) {
    await shutdown("failed", error);
    throw error;
  }
}

export function printHumanStatus(status: RuntimeStatusManifest, live: Record<string, boolean>): void {
  console.log(`Profile: ${status.profile} (${status.status})`);
  console.log(`Electron: ${status.electronTitle}`);
  console.log(`Renderer: ${status.rendererUrl}`);
  if (status.browserUrl) console.log(`Browser: ${status.browserUrl}`);
  if (status.testProject) console.log(`Test project: ${status.testProject}`);
  console.log(`Status: ${status.statusPath}`);
  console.log(`Logs: ${status.logDir}`);
  console.log(`Live: ${Object.entries(live).filter(([, value]) => value).map(([name]) => name).join(", ") || "none"}`);
}

export async function showStatus(args: DevArguments): Promise<number> {
  const profile = await resolveStoredProfile(args, "agent-test");
  const status = await readStatus(statusManifestPath(profile));
  if (!status) {
    if (args.json) console.log(JSON.stringify({ status: "missing", profile: profile.id, live: {} }, null, 2));
    else console.log(`Profile ${profile.id} has no runtime status.`);
    return 1;
  }
  const live = liveness(status);
  if (args.json) console.log(JSON.stringify({ ...status, live }, null, 2));
  else printHumanStatus(status, live);
  return status.status === "ready" && live.launcher ? 0 : 1;
}

export async function stopProfile(args: DevArguments): Promise<number> {
  const profile = await resolveStoredProfile(args, "agent-test");
  const statusPath = statusManifestPath(profile);
  const status = await readStatus(statusPath);
  if (!status || !Object.values(liveness(status)).some(Boolean)) {
    console.log(`Profile ${profile.id} is not running.`);
    return 0;
  }
  const survivors = await stopTrackedRuntimeProcesses(status);
  if (survivors.length === 0) {
    const latest = await readStatus(statusPath);
    const stoppedStatus = stoppedRuntimeStatusIfUnchanged(status, latest);
    if (stoppedStatus) await atomicWriteJson(statusPath, stoppedStatus);
    console.log(`Stopped profile ${profile.id}.`);
    return 0;
  }
  console.error(`Profile ${profile.id} did not stop cleanly. Surviving owned processes: ${survivors.join(", ")}`);
  return 1;
}

export async function resetProfile(args: DevArguments): Promise<number> {
  const profile = await resolveStoredProfile(args, "agent-test");
  const status = await readStatus(statusManifestPath(profile));
  if (status && Object.values(liveness(status)).some(Boolean)) {
    if (!args.stopFirst) throw new Error("Profile is running; stop it first or pass --stop-first");
    const stopped = await stopProfile(args);
    if (stopped !== 0) return stopped;
  }
  await readAndValidateSentinel(profile);

  let containersRemoved = 0;
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", `label=orkestrator-owner=${profile.dockerOwner}`], { encoding: "utf8" });
  if (listed.status === 0) {
    const ids = listed.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
    if (ids.length) {
      const removed = spawnSync("docker", ["rm", "-f", ...ids], { encoding: "utf8" });
      if (removed.status !== 0) throw new Error(removed.stderr.trim() || "Could not remove profile Docker containers");
      containersRemoved = ids.length;
    }
  }

  await removeProfileState(profile, args.keepToolchains);
  console.log(`Reset profile ${profile.id}: removed ${containersRemoved} exact-owner Docker container(s) and disposable profile state.${args.keepToolchains ? " Toolchains were retained." : " It can be recreated with bun run dev:test."}`);
  return 0;
}
