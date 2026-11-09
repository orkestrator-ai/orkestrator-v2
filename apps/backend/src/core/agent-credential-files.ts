import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Where agent and GitHub credentials live on the host and in containers, and
 * the OpenCode plugin that exposes the managed GitHub token. Stateless.
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
export const OPENCODE_GITHUB_ENV_PLUGIN_PATH =
  "/home/node/.config/opencode/plugins/orkestrator-github-env.js";
export const OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT_FILE =
  "/tmp/orkestrator-ai/opencode-github-env-plugin-fingerprint";

export function buildOpenCodeGitHubEnvironmentPluginSource(
  credentialFile = CONTAINER_GITHUB_CREDENTIAL_FILE,
): string {
  return `import { readFile } from "node:fs/promises";

const credentialFile = ${JSON.stringify(credentialFile)};

export const OrkestratorGitHubEnvironmentPlugin = async () => ({
  "shell.env": async (_input, output) => {
    let token = "";
    try {
      token = (await readFile(credentialFile, "utf8")).trim();
    } catch {
      // Missing or unreadable managed state means no GitHub identity.
    }
    if (token) {
      output.env.GITHUB_TOKEN = token;
      output.env.GH_TOKEN = token;
    }
  },
});
`;
}

export const OPENCODE_GITHUB_ENV_PLUGIN_SOURCE = buildOpenCodeGitHubEnvironmentPluginSource();
export const OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT = createHash("sha256")
  .update(OPENCODE_GITHUB_ENV_PLUGIN_SOURCE)
  .digest("hex");

export const OPENCODE_CREDENTIAL_PLUGIN_FILE = "orkestrator-credential.js";
export const OPENCODE_CREDENTIAL_PLUGIN_PATH = `/home/node/.config/opencode/plugins/${OPENCODE_CREDENTIAL_PLUGIN_FILE}`;
export const OPENCODE_GITHUB_ENV_PLUGIN_FILE = "orkestrator-github-env.js";

/**
 * Where `orkestrator-bridge-launch opencode` points the server on an
 * `opencode-launch=1` image: `XDG_CONFIG_HOME` and `OPENCODE_TEST_HOME`, both
 * root-owned, so OpenCode reads its global configuration and its `~/.opencode`
 * from directories only the backend's root exec writes. The launcher names the
 * same paths (docker/orkestrator-bridge-launch.sh).
 */
export const OPENCODE_LAUNCH_ROOT = "/run/orkestrator-opencode";
export const OPENCODE_LAUNCH_CONFIG_HOME = `${OPENCODE_LAUNCH_ROOT}/config`;
export const OPENCODE_LAUNCH_CONFIG_DIR = `${OPENCODE_LAUNCH_CONFIG_HOME}/opencode`;
export const OPENCODE_LAUNCH_HOME = `${OPENCODE_LAUNCH_ROOT}/home`;

/**
 * What a bridge does for itself (`loadBridgeCredential`), for OpenCode, which
 * compares a plain `OPENCODE_SERVER_PASSWORD` and runs its tools under the same
 * uid. `exec` resets the non-dumpable flag, so this has to run inside the server.
 * OpenCode keeps the value it read at startup, so removing the variable leaves
 * authentication on and only stops tools inheriting it. OpenCode loads plugins
 * before the first tool of an instance can run. A bare `Bun.spawn` would still
 * pass the variable on; OpenCode 1.19 spawns through `node:child_process` and
 * shell tools with an explicit environment, which do not (recheck on a bump).
 *
 * With `refuse-tools`, a Linux server that could not be hardened refuses tools
 * rather than let them read the password out of `/proc`. A container pins the
 * binary, so that should never fire. A host's OpenCode may be any build and the
 * host promises no boundary here (docs/architecture/agent-approvals.md), so it
 * just logs.
 */
export function buildOpenCodeCredentialPluginSource(
  onUnhardened: "refuse-tools" | "log",
  options: { applyLaunchEnvironment?: boolean } = {},
): string {
  return `${options.applyLaunchEnvironment ? OPENCODE_LAUNCH_ENVIRONMENT_SOURCE : ""}const PR_SET_DUMPABLE = 4;

async function markNonDumpable() {
  if (process.platform !== "linux") return true;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      return libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) === 0;
    } finally {
      libc.close();
    }
  } catch {
    return false;
  }
}

export const OrkestratorCredentialPlugin = async () => {
  delete process.env.OPENCODE_SERVER_PASSWORD;${
    options.applyLaunchEnvironment ? "\n  applyLaunchEnvironment();" : ""
  }
  if (await markNonDumpable()) return {};
  process.stderr.write("Orkestrator could not protect the OpenCode server password from this server's tools.\\n");
  return ${
    onUnhardened === "refuse-tools"
      ? `{
    "tool.execute.before": async () => {
      throw new Error("Refusing to run tools: Orkestrator could not protect this OpenCode server's password from them.");
    },
  }`
      : "{}"
  };
};
`;
}

/**
 * The OpenCode twin of `applyBridgeLaunchEnvironment`
 * (`packages/protocol/src/node/bridge-launch-environment.ts`), inlined into
 * the credential plugin of a server `orkestrator-bridge-launch opencode`
 * started. The launcher runs OpenCode under `env -i`, so this applies the
 * environment the start script built to the server's own `process.env`, for
 * the tools it spawns, once the runtime is running and its configuration
 * directories are fixed. The snapshot is as untrusted as the shell that wrote
 * it: it never supplies a variable the launcher set, a bridge credential, or
 * any `OPENCODE_` variable, because OpenCode reads its flags from
 * `process.env` when it uses them (a later `OPENCODE_CONFIG_DIR` would load
 * plugins from wherever it named). `XDG_CONFIG_HOME` points at the server's
 * root-owned configuration, which its tools must not inherit; OpenCode
 * resolved it when it started.
 */
const OPENCODE_LAUNCH_ENVIRONMENT_SOURCE = `import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from "node:fs";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 4096;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_%.-]*$/;
const LAUNCH_ONLY = /^OPENCODE_|^ORKESTRATOR_BRIDGE_|(?:_BRIDGE_TOKEN|_TOKEN_SHA256|_AUTHORITY_KEY)$/;
const NOT_APPLIED = new Set(["PWD", "OLDPWD", "SHLVL", "_", "NODE_PATH"]);

function readSnapshot(file) {
  let fd;
  try {
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

function applyLaunchEnvironment() {
  const file = process.env.ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT;
  if (!file) return;
  const trusted = new Set(
    (process.env.ORKESTRATOR_BRIDGE_LAUNCH_KEYS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  );
  delete process.env.ORKESTRATOR_BRIDGE_LAUNCH_ENVIRONMENT;
  delete process.env.ORKESTRATOR_BRIDGE_LAUNCH_KEYS;
  delete process.env.XDG_CONFIG_HOME;
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
