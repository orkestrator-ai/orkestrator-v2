/**
 * The supervisor's real side effects: spawning the backend, its control
 * client, `bun add` staging, symlink swaps, the state file and database
 * snapshots. `supervisor.ts` takes all of this as an interface so its update
 * and rollback logic is tested with fakes.
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readlink, rename, rm, symlink, lstat } from "node:fs/promises";
import path from "node:path";
import { compareReleaseVersions } from "@orkestrator/protocol/release-channels";
import { STORAGE_DATABASE_FILE } from "@orkestrator/protocol/node/storage-database";
import {
  findPreMigrationSnapshot,
  restoreDatabaseSnapshot,
} from "@orkestrator/protocol/node/storage-snapshot-restore";
import { currentToolchainBinDir, pointToolchainCurrentAt } from "@orkestrator/toolchain/install";
import { installDirFor, launcherIn, packageRootIn, type RuntimeLayout } from "./layout.js";
import type {
  BackendChild,
  BackendClient,
  BackendEndpoint,
  SupervisorRuntime,
  SupervisorState,
} from "./supervisor.js";

const STAGE_TIMEOUT_MS = 10 * 60 * 1000;

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === "orkestrator" && typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

/** The staged package is the requested version and carries the approved manifest. */
export function verifyStagedPackage(
  installDir: string,
  version: string,
  requirementsSha256: string,
): void {
  const root = packageRootIn(installDir);
  const installed = readPackageVersion(root);
  if (installed !== version) {
    throw new Error(`bun installed orkestrator@${installed ?? "nothing"}, not ${version}`);
  }
  if (!existsSync(launcherIn(root))) throw new Error(`orkestrator@${version} has no launcher`);
  if (requirementsSha256) {
    const manifest = path.join(root, "resources", "release-requirements.json");
    if (!existsSync(manifest) || sha256File(manifest) !== requirementsSha256) {
      throw new Error(
        `orkestrator@${version} does not carry the requirements manifest that was approved`,
      );
    }
  }
}

async function swapLink(link: string, target: string | null): Promise<void> {
  if (target === null) {
    await rm(link, { force: true });
    return;
  }
  const existing = await lstat(link).catch(() => null);
  if (existing && !existing.isSymbolicLink()) throw new Error(`${link} is not a symbolic link`);
  const relative = path.relative(path.dirname(link), target);
  const temporary = `${link}.${randomUUID()}.tmp`;
  await symlink(relative, temporary, "dir");
  try {
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readLink(link: string): Promise<string | null> {
  try {
    const target = await readlink(link);
    const resolved = path.resolve(path.dirname(link), target);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Each version's launcher sets its own roots and version; an inherited value
 * would make a new version report the old one's identity (and fail its health
 * check) or load the old one's resources.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ORKESTRATOR_APP_ROOT;
  delete next.ORKESTRATOR_RESOURCE_ROOT;
  delete next.ORKESTRATOR_VERSION;
  return next;
}

function spawnBackend(bunPath: string, packageRoot: string, args: readonly string[]): BackendChild {
  const child = Bun.spawn([bunPath, launcherIn(packageRoot), "serve", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: childEnvironment(process.env),
  });
  let resolveReady!: (endpoint: BackendEndpoint) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<BackendEndpoint>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Keep an unobserved rejection from becoming fatal: `launch` races it.
  ready.catch(() => undefined);
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    let found = false;
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!found && line.startsWith("{")) {
          try {
            const message = JSON.parse(line) as {
              type?: unknown;
              url?: unknown;
              authFile?: unknown;
            };
            if (
              message.type === "orkestrator-backend-ready" &&
              typeof message.url === "string" &&
              typeof message.authFile === "string"
            ) {
              const auth = JSON.parse(readFileSync(message.authFile, "utf8")) as {
                token?: unknown;
              };
              if (typeof auth.token !== "string" || auth.token.length < 16) {
                rejectReady(new Error("The backend's auth file has no valid token"));
              } else {
                found = true;
                resolveReady({ url: message.url, token: auth.token });
              }
              continue;
            }
          } catch {
            // Not the readiness line; pass it through.
          }
        }
        process.stdout.write(`${line}\n`);
      }
    }
  })().catch((error: unknown) =>
    rejectReady(error instanceof Error ? error : new Error(String(error))),
  );
  const exited = child.exited.then((code) => ({
    code,
    signal:
      child.signalCode === null || child.signalCode === undefined ? null : String(child.signalCode),
  }));
  return {
    ready,
    exited,
    signal(signal) {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
}

function backendClient(endpoint: BackendEndpoint): BackendClient {
  const base = endpoint.url.endsWith("/") ? endpoint.url : `${endpoint.url}/`;
  const headers = {
    authorization: `Bearer ${endpoint.token}`,
    "content-type": "application/json",
  };
  return {
    async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
      const response = await fetch(`${base}__orkestrator/invoke`, {
        method: "POST",
        headers,
        body: JSON.stringify({ command, args }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body.result as T;
    },
    async status() {
      const response = await fetch(`${base}__orkestrator/status`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as { ok?: boolean; appVersion?: string };
    },
  };
}

export function readDatabaseUserVersion(dataDir: string): number | null {
  const file = path.join(dataDir, STORAGE_DATABASE_FILE);
  if (!existsSync(file)) return null;
  const database = new Database(file, { readonly: true });
  try {
    return (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

export function createSupervisorRuntime(options: {
  dataDir: string;
  layout: RuntimeLayout;
  bunPath: string;
  log?: Pick<Console, "info" | "warn" | "error">;
}): SupervisorRuntime {
  const { layout, dataDir, bunPath } = options;
  const run = async (command: string[], cwd: string) => {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
    const timer = setTimeout(() => child.kill("SIGKILL"), STAGE_TIMEOUT_MS);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0)
      throw new Error(`\`${command.join(" ")}\` failed: ${stderr.trim().slice(-1500)}`);
  };
  return {
    spawn: (packageRoot, args) => spawnBackend(bunPath, packageRoot, args),
    client: backendClient,
    async stage(version, requirementsSha256) {
      const target = installDirFor(layout, version);
      if (existsSync(target)) {
        try {
          verifyStagedPackage(target, version, requirementsSha256);
          return target;
        } catch {
          rmSync(target, { recursive: true, force: true });
        }
      }
      mkdirSync(layout.versions, { recursive: true, mode: 0o700 });
      const staging = path.join(layout.versions, `.staging-${version}-${randomUUID()}`);
      mkdirSync(staging, { mode: 0o700 });
      try {
        writeFileSync(
          path.join(staging, "package.json"),
          `${JSON.stringify({ name: "orkestrator-runtime", private: true }, null, 2)}\n`,
        );
        // Bun verifies every tarball against the registry's integrity hash.
        await run([bunPath, "add", "--exact", `orkestrator@${version}`], staging);
        verifyStagedPackage(staging, version, requirementsSha256);
        renameSync(staging, target);
        return target;
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    },
    readCurrent: () => readLink(layout.current),
    setCurrent: (installDir) => swapLink(layout.current, installDir),
    setPrevious: (installDir) => swapLink(layout.previous, installDir),
    packageRootOf: packageRootIn,
    packageVersion: async (packageRoot) => readPackageVersion(packageRoot),
    async readState() {
      try {
        const value = JSON.parse(readFileSync(layout.state, "utf8")) as SupervisorState;
        return value?.version === 1 ? value : null;
      } catch {
        return null;
      }
    },
    async writeState(state) {
      mkdirSync(layout.root, { recursive: true, mode: 0o700 });
      const temporary = `${layout.state}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, layout.state);
    },
    readUserVersion: () => readDatabaseUserVersion(dataDir),
    async restoreSnapshot(fromVersion, since) {
      const snapshot = findPreMigrationSnapshot(dataDir, { since, fromVersion });
      if (!snapshot) return false;
      restoreDatabaseSnapshot(dataDir, snapshot.file);
      return true;
    },
    async readToolchainCurrent() {
      try {
        return realpathSync(currentToolchainBinDir(dataDir));
      } catch {
        return null;
      }
    },
    pointToolchainCurrent: async (binDir) => {
      await pointToolchainCurrentAt(dataDir, binDir);
    },
    async prune(keep) {
      const kept = new Set(keep.map((entry) => path.resolve(entry)));
      let entries: string[] = [];
      try {
        entries = readdirSync(layout.versions);
      } catch {
        return;
      }
      for (const name of entries) {
        const directory = path.join(layout.versions, name);
        if (kept.has(path.resolve(directory))) continue;
        // A staging directory younger than a day may belong to a running stage.
        if (name.startsWith(".staging-") && Date.now() - statSync(directory).mtimeMs < 86_400_000) {
          continue;
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
    compareVersions(left, right) {
      try {
        return compareReleaseVersions(left, right);
      } catch {
        return Bun.semver.order(left, right);
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: options.log ?? console,
  };
}
