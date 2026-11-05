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
 * host promises no boundary here (to-do 4980 task 3), so it just logs.
 */
export function buildOpenCodeCredentialPluginSource(onUnhardened: "refuse-tools" | "log"): string {
  return `const PR_SET_DUMPABLE = 4;

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
  delete process.env.OPENCODE_SERVER_PASSWORD;
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
