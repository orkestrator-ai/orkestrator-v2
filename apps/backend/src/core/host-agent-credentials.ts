import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { claudeLoginLookupOptions } from "./claude-host-credentials.js";
import {
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  runtimeHostClaudeConfigDir,
} from "./commands-files.js";
import {
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV,
  AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT_ENV,
  AGENT_TEST_HOST_PI_AGENT_DIR_ENV,
} from "./agent-credential-files.js";
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

  const hostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim();
  if (env.ANTHROPIC_API_KEY || !hostHome) return;

  // The login the shell `dev:test` started in uses: an added account's own
  // Keychain entry when that shell named its directory, else the default one.
  // Never the profile's own `CLAUDE_CONFIG_DIR`, which is not the host's.
  const { configDir, explicit } = runtimeHostClaudeConfigDir({
    [AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]: process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV],
    [AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT_ENV]:
      process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT_ENV],
  });
  const credentials = await getHostClaudeCredentials(
    process.platform,
    hostHome,
    configDir,
    claudeLoginLookupOptions(configDir, explicit),
  );
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
 * The login travels with the host's saved default model, because a login can
 * refuse models its provider lists: a ChatGPT login (`openai` since Pi 1.2.0,
 * or the legacy `openai-codex`) cannot run the first model Pi's catalogue
 * offers. Only `defaultProvider` and `defaultModel` are read from the host's
 * `settings.json`, and the bridge uses them when the profile's own settings
 * name no default or name one unavailable from a signed-in provider.
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
  delete env.PI_BRIDGE_DEFAULT_MODEL;
  if (context.runtimeFlavor !== "agent-test" || !context.credentialSources?.has("pi")) return;

  const hostAgentDir = process.env[AGENT_TEST_HOST_PI_AGENT_DIR_ENV]?.trim();
  if (!hostAgentDir) return;
  const authFile = path.join(hostAgentDir, "auth.json");
  const info = await stat(authFile).catch(() => null);
  if (!info?.isFile()) return;
  env.PI_BRIDGE_AUTH_FILE = authFile;
  const defaultModel = await readPiDefaultModel(path.join(hostAgentDir, "settings.json"));
  if (defaultModel) env.PI_BRIDGE_DEFAULT_MODEL = defaultModel;
}

/** Far larger than any real Pi `settings.json`; a bigger file is not read. */
const MAX_PI_SETTINGS_BYTES = 1024 * 1024;
/** The bridge's own bound on a model id (`MAX_MODEL_ID_BYTES`). */
const MAX_PI_MODEL_ID_BYTES = 1024;

/**
 * The `provider/modelId` a Pi `settings.json` saves as its default, or
 * undefined when it names none.
 *
 * Pi starts on its saved default only when both keys are set, so one alone is
 * not a default. A provider id never contains a slash; one that does would be
 * split differently by the bridge, so it is not passed on.
 */
export async function readPiDefaultModel(settingsFile: string): Promise<string | undefined> {
  try {
    const info = await stat(settingsFile);
    if (!info.isFile() || info.size > MAX_PI_SETTINGS_BYTES) return undefined;
    // Pi strips a byte-order mark before parsing; so does this.
    const text = (await readFile(settingsFile, "utf8")).replace(/^\uFEFF/, "");
    const settings = JSON.parse(text) as unknown;
    if (!settings || typeof settings !== "object") return undefined;
    const { defaultProvider, defaultModel } = settings as Record<string, unknown>;
    if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return undefined;
    const provider = defaultProvider.trim();
    const model = defaultModel.trim();
    if (!provider || !model || provider.includes("/")) return undefined;
    const id = `${provider}/${model}`;
    return Buffer.byteLength(id) > MAX_PI_MODEL_ID_BYTES ? undefined : id;
  } catch {
    return undefined;
  }
}
