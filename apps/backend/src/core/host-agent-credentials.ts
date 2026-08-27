import { createHash } from "node:crypto";
import type { CommandContext } from "./commands-context.js";
import { getClaudeOAuthAccessToken, getHostClaudeCredentials } from "./commands-files.js";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "./commands-runtime-state.js";
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

/** Apply Claude's agent-test host credential policy to a child environment. */
export async function applyClaudeHostCredentialEnvironment(
  context: CommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (context.runtimeFlavor !== "agent-test" || !context.credentialSources?.has("claude")) return;

  const hostConfigDir = process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim();
  if (hostConfigDir) env.CLAUDE_CONFIG_DIR = hostConfigDir;
  const hostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  if (env.ANTHROPIC_API_KEY || !hostHome) return;

  const credentials = await getHostClaudeCredentials(process.platform, hostHome, hostConfigDir);
  const accessToken = getClaudeOAuthAccessToken(credentials);
  if (accessToken) env.ANTHROPIC_AUTH_TOKEN = accessToken;
}
