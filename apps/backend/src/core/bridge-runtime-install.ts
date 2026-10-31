/**
 * On-demand bridge runtimes for the standalone package.
 *
 * The desktop app ships every bridge complete, with its SDK closure vendored
 * under `dist/node_modules`. The npm package cannot: Cursor's SDK carries a
 * per-platform native package and Pi's closure is ~175 MB. So
 * `packages/cli/scripts/build.ts` ships those bridges' own bundles plus a
 * pinned manifest and lockfile under `resourceRoot/<bridge>/runtime/`, and
 * this installs them into the data directory the first time the bridge starts:
 *
 *   <data-dir>/bridge-runtimes/<bridge>/<digest>/
 *     package.json  bun.lock  patches/  dist/index.js  node_modules/
 *
 * `bun install --frozen-lockfile` makes the closure exactly the committed one,
 * integrity hashes included, and applies the same patches the repository does.
 * The digest names the bundle and its inputs together, so an upgrade installs
 * beside the previous runtime instead of over it, and a bridge that is running
 * never has its modules replaced underneath it.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CommandFailedError, runCommand } from "./shell.js";

/** Where an on-demand bridge's install inputs live inside its resource directory. */
export const BRIDGE_RUNTIME_SUBDIRECTORY = "runtime";
const DESCRIPTOR = "install.json";
/** Under the data directory. */
export const BRIDGE_RUNTIMES_DIRECTORY = "bridge-runtimes";
/** Written last, so a directory holding it is a finished install. */
const INSTALLED_MARKER = ".installed";
const STAGING_PREFIX = ".staging-";
/** Pi's closure is large; a slow link must not fail it, a wedged install must not hang a launch forever. */
export const BRIDGE_RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How much of bun's stderr an install failure carries. */
const STDERR_TAIL_CHARS = 2_000;

const BRIDGE_LABELS: Record<string, string> = {
  "cursor-bridge": "Cursor",
  "pi-bridge": "Pi",
};

export interface OnDemandBridgeRuntime {
  bridge: string;
  /** `resourceRoot/<bridge>`: the shipped bundle and its install inputs. */
  sourceDir: string;
  /** Where the installed runtime lives; the bridge is started from here. */
  installDir: string;
  digest: string;
}

/**
 * The on-demand runtime for a bridge, or `undefined` when the resource
 * directory holds a complete bridge (the desktop app, a container, a scenario
 * harness) or no bridge at all.
 */
export function onDemandBridgeRuntime(
  resourceRoot: string,
  dataDir: () => string,
  bridge: string,
): OnDemandBridgeRuntime | undefined {
  const sourceDir = path.join(resourceRoot, bridge);
  const descriptorPath = path.join(sourceDir, BRIDGE_RUNTIME_SUBDIRECTORY, DESCRIPTOR);
  if (!existsSync(descriptorPath)) return undefined;
  let digest: unknown;
  try {
    digest = (JSON.parse(readFileSync(descriptorPath, "utf8")) as { digest?: unknown }).digest;
  } catch {
    throw new Error(`The ${bridge} install descriptor is unreadable: ${descriptorPath}`);
  }
  // The digest becomes a path segment; accept nothing a build would not write.
  if (typeof digest !== "string" || !/^[0-9a-f]{16,64}$/.test(digest)) {
    throw new Error(`The ${bridge} install descriptor has an invalid digest: ${descriptorPath}`);
  }
  return {
    bridge,
    sourceDir,
    installDir: path.join(dataDir(), BRIDGE_RUNTIMES_DIRECTORY, bridge, digest),
    digest,
  };
}

export function isBridgeRuntimeInstalled(runtime: OnDemandBridgeRuntime): boolean {
  return existsSync(path.join(runtime.installDir, INSTALLED_MARKER));
}

export interface BridgeRuntimeInstallOptions {
  /** The bun executable that runs `install`. */
  bun: string;
  timeoutMs?: number;
  /** Injected by tests. */
  run?: typeof runCommand;
}

const flights = new Map<string, Promise<string>>();

/**
 * Install a bridge's runtime if it is not installed yet, and return the
 * directory to start the bridge from. Concurrent callers share one install.
 */
export function ensureBridgeRuntime(
  runtime: OnDemandBridgeRuntime,
  options: BridgeRuntimeInstallOptions,
): Promise<string> {
  if (isBridgeRuntimeInstalled(runtime)) return Promise.resolve(runtime.installDir);
  const existing = flights.get(runtime.installDir);
  if (existing) return existing;
  const flight = install(runtime, options).finally(() => {
    flights.delete(runtime.installDir);
  });
  flights.set(runtime.installDir, flight);
  return flight;
}

async function install(
  runtime: OnDemandBridgeRuntime,
  options: BridgeRuntimeInstallOptions,
): Promise<string> {
  const label = BRIDGE_LABELS[runtime.bridge] ?? runtime.bridge;
  // `--frozen-lockfile` only freezes a lockfile that exists: without one, bun
  // resolves the manifest's ranges afresh and installs whatever is newest.
  if (!existsSync(path.join(runtime.sourceDir, BRIDGE_RUNTIME_SUBDIRECTORY, "bun.lock"))) {
    throw new Error(`Could not install ${label} support: the package is missing its lockfile`);
  }
  const bridgeRoot = path.dirname(runtime.installDir);
  await mkdir(bridgeRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireInstallLock(bridgeRoot, options.timeoutMs);
  try {
    // A different backend may have finished this digest while we waited.
    if (isBridgeRuntimeInstalled(runtime)) return runtime.installDir;
    return await installLocked(runtime, options, label, bridgeRoot);
  } finally {
    lock.close();
  }
}

async function installLocked(
  runtime: OnDemandBridgeRuntime,
  options: BridgeRuntimeInstallOptions,
  label: string,
  bridgeRoot: string,
): Promise<string> {
  // Older installers may not participate in our lock. Preserve their staging
  // trees while their owners are alive; unknown ownership is also preserved.
  await removeEntries(bridgeRoot, abandonedStaging);

  const staging = path.join(
    bridgeRoot,
    `${STAGING_PREFIX}${runtime.digest}-${process.pid}-${Date.now()}`,
  );
  console.log(`[ElectronBackend] Installing ${label} support (${runtime.bridge})…`);
  try {
    await cp(path.join(runtime.sourceDir, BRIDGE_RUNTIME_SUBDIRECTORY), staging, {
      recursive: true,
    });
    await mkdir(path.join(staging, "dist"), { recursive: true });
    await cp(
      path.join(runtime.sourceDir, "dist", "index.js"),
      path.join(staging, "dist", "index.js"),
    );
    try {
      await (options.run ?? runCommand)(
        options.bun,
        [
          "install",
          "--frozen-lockfile",
          "--production",
          // A flat tree is what Node-style resolution from `dist/index.js`
          // expects; packages that need a second version nest beneath their
          // dependent, as npm would lay them out.
          "--linker=hoisted",
          // The closure runs no lifecycle scripts in the repository either:
          // nothing in it is a trusted dependency.
          "--ignore-scripts",
          "--no-progress",
          "--no-summary",
        ],
        {
          cwd: staging,
          env: process.env,
          timeoutMs: options.timeoutMs ?? BRIDGE_RUNTIME_INSTALL_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw new Error(`Could not install ${label} support: ${installFailure(error)}`);
    }
    await writeFile(path.join(staging, INSTALLED_MARKER), `${new Date().toISOString()}\n`);
    try {
      await rename(staging, runtime.installDir);
    } catch (error) {
      // Only another install of the same digest can have created it, and a
      // directory there is only ever a finished one.
      if (!isBridgeRuntimeInstalled(runtime)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // Keep previous digests. Other backends, bridges and their lazy-loading
  // helpers may still use them, even after the installing backend has exited.
  // Reclamation needs a separate maintenance pass with proof of no live users.
  console.log(`[ElectronBackend] Installed ${label} support into ${runtime.installDir}`);
  return runtime.installDir;
}

function installFailure(error: unknown): string {
  if (error instanceof CommandFailedError) {
    if (error.executableMissing) return "bun was not found";
    if (error.timedOut) return "bun install timed out";
  }
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return "bun install failed";
  return message.length > STDERR_TAIL_CHARS
    ? `…${message.slice(message.length - STDERR_TAIL_CHARS)}`
    : message;
}

async function removeEntries(directory: string, match: (name: string) => boolean): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter(match)
      .map((name) => rm(path.join(directory, name), { recursive: true, force: true })),
  );
}

/**
 * A dedicated SQLite write transaction supplies an OS-backed cross-process
 * lock, released even on a crash. This database contains no application data.
 * Disable SQLite's synchronous busy wait and poll asynchronously so a second
 * installer never blocks this backend's event loop. Do not unlink this file:
 * waiters must always lock the same inode.
 */
async function acquireInstallLock(
  directory: string,
  timeoutMs = BRIDGE_RUNTIME_INSTALL_TIMEOUT_MS,
) {
  const lock = new Database(path.join(directory, ".install-lock.sqlite"));
  lock.exec("PRAGMA busy_timeout = 0");
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try {
        lock.exec("BEGIN IMMEDIATE");
        return lock;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline)
          throw new Error("Timed out waiting for bridge runtime installer");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } catch (error) {
    lock.close();
    throw error;
  }
}

function abandonedStaging(name: string): boolean {
  if (!name.startsWith(STAGING_PREFIX)) return false;
  const owner = /^\.staging-[0-9a-f]{16,64}-(\d+)-\d+$/.exec(name);
  if (!owner) return false;
  const pid = Number(owner[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
