/**
 * The runtime environment of a bridge started by `orkestrator-bridge-launch`
 * (docker/orkestrator-bridge-launch.sh).
 *
 * That launcher starts the bridge under `env -i` with only the backend's own
 * values, so nothing the agent's uid can write (a login profile, the
 * `/tmp/orkestrator-ai` snapshot, `BUN_OPTIONS`, `LD_PRELOAD`) decides how the
 * bridge itself is loaded. The agents a bridge spawns still need the
 * environment the start script built: tool paths, the project's runtime
 * variables, their own credentials. The script records it in a snapshot file,
 * and this module, imported first by every bridge entry point, applies it once
 * the runtime is already running, where a loader variable has nothing left to
 * load. The snapshot is as untrusted as the shell that wrote it, so it never
 * supplies a value the launcher set from the backend
 * (`ORKESTRATOR_BRIDGE_LAUNCH_KEYS`), a bridge credential or authority key, a
 * process authority (execution policy, coordinator research), or `NODE_PATH`, which steers this process's own module
 * resolution.
 *
 * Without the launcher's variables (a host bridge, an older image, a test) it
 * does nothing.
 */
import { closeSync, fstatSync, openSync, readSync, rmSync, constants } from "node:fs";

export const BRIDGE_LAUNCH_ENVIRONMENT_ENV = "ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT";
export const BRIDGE_LAUNCH_KEYS_ENV = "ORKESTRATOR_BRIDGE_LAUNCH_KEYS";
export const BRIDGE_LAUNCH_WORKDIR_ENV = "ORKESTRATOR_BRIDGE_LAUNCH_WORKDIR";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 4_096;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_%.-]*$/;
/** Names only the trusted launch may set. */
const LAUNCH_ONLY =
  /(?:_BRIDGE_TOKEN|_TOKEN_SHA256|_AUTHORITY_KEY)$|^ORKESTRATOR_BRIDGE_(?:LAUNCH_|EXECUTION_POLICY$)|^ORKESTRATOR_COORDINATOR_/;
/** The shell's own bookkeeping, and what would steer this process at run time. */
const NOT_APPLIED = new Set(["PWD", "OLDPWD", "SHLVL", "_", "NODE_PATH"]);

export interface BridgeLaunchEnvironmentResult {
  /** Variables taken from the snapshot. */
  applied: number;
  /** Variables the snapshot named that it may not set. */
  refused: number;
}

function readSnapshot(file: string): Buffer | null {
  let fd: number;
  try {
    // Not through a link the agent pointed somewhere else.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Apply the launcher's snapshot to `env` once, and remove it. */
export function applyBridgeLaunchEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  chdir: (directory: string) => void = (directory) => process.chdir(directory),
): BridgeLaunchEnvironmentResult | null {
  const file = env[BRIDGE_LAUNCH_ENVIRONMENT_ENV];
  if (!file) return null;
  const trusted = new Set(
    (env[BRIDGE_LAUNCH_KEYS_ENV] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const workdir = env[BRIDGE_LAUNCH_WORKDIR_ENV];
  delete env[BRIDGE_LAUNCH_ENVIRONMENT_ENV];
  delete env[BRIDGE_LAUNCH_KEYS_ENV];
  delete env[BRIDGE_LAUNCH_WORKDIR_ENV];

  const result: BridgeLaunchEnvironmentResult = { applied: 0, refused: 0 };
  const snapshot = readSnapshot(file);
  rmSync(file, { force: true });
  if (snapshot) {
    const entries = snapshot.toString("utf8").split("\0").slice(0, MAX_SNAPSHOT_ENTRIES);
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const name = entry.slice(0, separator);
      if (!NAME_PATTERN.test(name) || NOT_APPLIED.has(name)) continue;
      if (trusted.has(name) || LAUNCH_ONLY.test(name)) {
        result.refused += 1;
        continue;
      }
      env[name] = entry.slice(separator + 1);
      result.applied += 1;
    }
  }
  if (workdir) {
    try {
      chdir(workdir);
    } catch {
      // The bridge still runs from `/`; its own working-directory setting decides.
    }
  }
  return result;
}

applyBridgeLaunchEnvironment();
