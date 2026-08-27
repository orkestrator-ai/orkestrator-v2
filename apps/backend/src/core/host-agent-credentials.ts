import { createHash } from "node:crypto";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import {
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  getHostCursorCredentials,
  syncAgentTestCursorCredentials,
} from "./commands-files.js";
import {
  AGENT_TEST_CURSOR_CREDENTIAL_STORE_ENV,
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
} from "./commands-runtime-state.js";
import { cursorApiKeyFingerprint, resolveCursorApiKey } from "./commands-validation.js";

type HostCursorCredentials = Awaited<ReturnType<typeof getHostCursorCredentials>>;

export type CursorHostCredentialMaterial = {
  apiKey: string | undefined;
  hostCredentials: HostCursorCredentials;
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
  const hostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  const hostCredentials =
    context.runtimeFlavor === "agent-test" && allowed && !apiKey && hostHome
      ? await getHostCursorCredentials(process.platform, hostHome)
      : undefined;
  const fingerprint = createHash("sha256")
    .update(allowed ? "allowed" : "denied")
    .update("\0")
    .update(cursorApiKeyFingerprint(apiKey))
    .update("\0")
    .update(hostCredentials?.accessToken ?? "")
    .update("\0")
    .update(hostCredentials?.refreshToken ?? "")
    .update("\0")
    .update(hostCredentials?.apiKey ?? "")
    .digest("hex");
  return { apiKey, hostCredentials, fingerprint };
}

/** Apply Cursor's host credential policy to an ACP child environment. */
export async function applyCursorHostCredentialEnvironment(
  context: CommandContext,
  env: NodeJS.ProcessEnv,
  credentials: CursorHostCredentialMaterial,
): Promise<void> {
  if (credentials.apiKey) env.CURSOR_API_KEY = credentials.apiKey;
  else delete env.CURSOR_API_KEY;
  if (context.runtimeFlavor !== "agent-test") return;

  const cursorHome = path.join(
    context.storage.getDataDir(),
    "agent-credentials",
    "provider-homes",
    "cursor",
  );
  env.HOME = cursorHome;
  env[AGENT_TEST_CURSOR_CREDENTIAL_STORE_ENV] = "file";
  await syncAgentTestCursorCredentials(
    cursorHome,
    credentials.apiKey ? undefined : credentials.hostCredentials,
  );
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
