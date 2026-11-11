import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Where agent and GitHub credentials live on the host and in containers, and
 * where a launched OpenCode server's root-owned directories are. Stateless.
 */

export const CONTAINER_GITHUB_CREDENTIAL_FILE = "/tmp/orkestrator-ai/github-token";
export const CONTAINER_CLAUDE_CREDENTIAL_FILE = "/home/node/.claude/.credentials.json";
export const CONTAINER_CURSOR_API_KEY_FILE = "/tmp/orkestrator-ai/cursor-api-key";
export const CONTAINER_CURSOR_API_KEY_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/cursor-api-key-fingerprint";
/**
 * Both Cursor credential files live here. Nothing in the image guarantees it
 * exists: `workspace-setup.sh` only creates it past the `--prepare-only` exit
 * and only when it runs as `node`, so every writer has to create it itself.
 */
export const CONTAINER_CURSOR_CREDENTIAL_DIR = path.posix.dirname(CONTAINER_CURSOR_API_KEY_FILE);
export const HOST_CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV =
  "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR";
/**
 * `1` when the shell `dev:test` was started from set `CLAUDE_CONFIG_DIR` itself,
 * so the host directory above names a Keychain entry of its own. Absent means
 * the desktop fell back to `~/.claude` and Claude's plain entry.
 */
export const AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT_ENV =
  "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT";
/** The host's Pi agent directory, set by the desktop only when Pi is authorized. */
export const AGENT_TEST_HOST_PI_AGENT_DIR_ENV = "ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR";
export const CLAUDE_GITHUB_CREDENTIAL_FILE_ENV = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";
export const CLAUDE_GITHUB_ENV_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/claude-github-env-fingerprint";
export const CLAUDE_GITHUB_ENV_FINGERPRINT = createHash("sha256")
  .update("managed-github-query-environment-v1")
  .digest("hex");
/**
 * Where `orkestrator-bridge-launch opencode2` points the container's OpenCode
 * (2.x) server on an `opencode2-launch=1` image, all root-owned, so the server
 * reads its configuration, home and package cache from directories only the
 * backend's root exec writes. 2.x reads its global configuration from
 * `OPENCODE_CONFIG_DIR`, which replaces the XDG one (`opencode2/user-config.ts`),
 * so that is where root writes the plugins and the mirror; `XDG_CONFIG_HOME`
 * and the home stay empty. The launcher names the same paths
 * (docker/orkestrator-bridge-launch.sh).
 */
export const OPENCODE2_LAUNCH_ROOT = "/run/orkestrator-opencode2";
export const OPENCODE2_LAUNCH_CONFIG_HOME = `${OPENCODE2_LAUNCH_ROOT}/config`;
export const OPENCODE2_LAUNCH_CONFIG_DIR = `${OPENCODE2_LAUNCH_ROOT}/opencode`;
export const OPENCODE2_LAUNCH_HOME = `${OPENCODE2_LAUNCH_ROOT}/home`;
export const OPENCODE2_LAUNCH_CACHE_HOME = `${OPENCODE2_LAUNCH_ROOT}/cache`;
export const OPENCODE2_LAUNCH_PROJECT_CONFIG = `${OPENCODE2_LAUNCH_ROOT}/project/opencode.json`;

/**
 * The OpenCode twin of `applyBridgeLaunchEnvironment`
 * (`packages/protocol/src/node/bridge-launch-environment.ts`), inlined into
 * the credential plugin of a server `orkestrator-bridge-launch opencode2`
 * started (`buildOpenCode2CredentialPluginSource` in `opencode2/server.ts`).
 * The launcher runs OpenCode under `env -i`, so this applies the
 * environment the start script built to the server's own `process.env`, for
 * the tools it spawns, once the runtime is running and its configuration
 * directories are fixed. The snapshot is as untrusted as the shell that wrote
 * it: it never supplies a variable the launcher set, a bridge credential, or
 * any `OPENCODE_` variable, because OpenCode reads its flags from
 * `process.env` when it uses them (a later `OPENCODE_CONFIG_DIR` would load
 * plugins from wherever it named). `XDG_CONFIG_HOME` points at the server's
 * root-owned configuration, which its tools must not inherit; OpenCode
 * resolved it when it started. `XDG_CACHE_HOME` points at the root-owned
 * package cache, which is read-only to the tools, and is never taken from the
 * snapshot either: a later read of it must not find node's cache.
 */
export const OPENCODE_LAUNCH_ENVIRONMENT_SOURCE = `import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from "node:fs";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 4096;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_%.-]*$/;
const LAUNCH_ONLY = /^OPENCODE_|^ORKESTRATOR_BRIDGE_|(?:_BRIDGE_TOKEN|_TOKEN_SHA256|_AUTHORITY_KEY)$/;
const NOT_APPLIED = new Set(["PWD", "OLDPWD", "SHLVL", "_", "NODE_PATH", "XDG_CACHE_HOME"]);

function readSnapshot(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function applyLaunchEnvironment() {
  const file = process.env.ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT;
  if (!file) return;
  const trusted = new Set(
    (process.env.ORKESTRATOR_BRIDGE_LAUNCH_KEYS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  );
  delete process.env.ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT;
  delete process.env.ORKESTRATOR_BRIDGE_LAUNCH_KEYS;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  const snapshot = readSnapshot(file);
  try {
    rmSync(file, { force: true });
  } catch {
    // Removed by a stop, or never written.
  }
  if (!snapshot) return;
  for (const entry of snapshot.toString("utf8").split("\\0").slice(0, MAX_SNAPSHOT_ENTRIES)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!NAME_PATTERN.test(name) || NOT_APPLIED.has(name)) continue;
    if (trusted.has(name) || LAUNCH_ONLY.test(name)) continue;
    process.env[name] = entry.slice(separator + 1);
  }
}

`;
