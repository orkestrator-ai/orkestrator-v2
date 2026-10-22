import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { getClaudeOAuthAccessToken, getHostClaudeCredentials } from "./commands-files.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  AGENT_TEST_HOST_PI_AGENT_DIR_ENV,
} from "./commands-runtime-state.js";
import { cursorApiKeyFingerprint, resolveCursorApiKey } from "./commands-validation.js";

export type CursorHostCredentialMaterial = {
  apiKey: string | undefined;
  fingerprint: string;
};

/** Resolve the credential inputs shared by ordinary launches and catalogue probes. */
export async function resolveCursorHostCredentialMaterial(
  context: CommandContext,
): Promise<CursorHostCredentialMaterial> {
  const allowed =
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has("cursor");
  const apiKey = allowed
    ? resolveCursorApiKey((await context.storage.loadConfig()).global).apiKey
    : undefined;
  const fingerprint = createHash("sha256")
    .update(allowed ? "allowed" : "denied")
    .update("\0")
    .update(cursorApiKeyFingerprint(apiKey))
    .digest("hex");
  return { apiKey, fingerprint };
}

/**
 * Apply Claude's agent-test host credential policy to a child environment.
 *
 * The host login is read here and handed over as a bearer access token, never
 * its refresh token. The child keeps the profile's own `CLAUDE_CONFIG_DIR`, so
 * its sessions, settings and project state stay in the profile rather than in
 * the host's `~/.claude`; the host directory is only read, to find the login.
 */
export async function applyClaudeHostCredentialEnvironment(
  context: CommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (context.runtimeFlavor !== "agent-test" || !context.credentialSources?.has("claude")) return;

  const hostConfigDir = process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim();
  const hostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  if (env.ANTHROPIC_API_KEY || !hostHome) return;

  const credentials = await getHostClaudeCredentials(process.platform, hostHome, hostConfigDir);
  const accessToken = getClaudeOAuthAccessToken(credentials);
  if (accessToken) env.ANTHROPIC_AUTH_TOKEN = accessToken;
}

/**
 * Apply Pi's credential policy to a local Pi bridge or catalogue probe.
 *
 * A local run leaves `PI_AGENT_DIR` unset, so Pi uses its own default
 * `~/.pi/agent`. That is the user's own login in production and the isolated
 * profile's directory in agent-test. An agent-test profile that authorizes Pi
 * also gets the host's `auth.json`, and only that file: the profile keeps its
 * own settings, models, MCP config and extensions. The bridge uses the host
 * file directly rather than a copy. A copy would rotate an OAuth refresh token
 * the host's `pi` still holds.
 *
 * Pi creates a credential file that is missing, so a host that never signed in
 * to Pi is not pointed at one. A file that appears later is used from the next
 * bridge start.
 */
export async function applyPiHostCredentialEnvironment(
  context: CommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  delete env.PI_AGENT_DIR;
  delete env.PI_BRIDGE_AUTH_FILE;
  if (context.runtimeFlavor !== "agent-test" || !context.credentialSources?.has("pi")) return;

  const hostAgentDir = process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV]?.trim();
  if (!hostAgentDir) return;
  const authFile = path.join(hostAgentDir, "auth.json");
  const info = await stat(authFile).catch(() => null);
  if (info?.isFile()) env.PI_BRIDGE_AUTH_FILE = authFile;
}
