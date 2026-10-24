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
