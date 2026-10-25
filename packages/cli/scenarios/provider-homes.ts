import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restrictGrokAuthSnapshot } from "@orkestrator/protocol/login-snapshots";
import {
  claudeLoginLookupOptions,
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
} from "../../../apps/backend/src/core/claude-host-credentials.js";

/** A harmless parent connection used to exercise backend startup sanitization. */
export const INHERITED_AGENT_TOOL_ENV = {
  ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:9/mcp",
  ORKESTRATOR_AGENT_MCP_TOKEN: "scenario-inherited-decoy",
} as const;

/**
 * The login a `claude` in the harness's own shell would use: the Keychain entry
 * named after an explicit `CLAUDE_CONFIG_DIR`, else the plain host entry.
 */
function readScenarioHostClaudeCredentials(
  hostEnv: NodeJS.ProcessEnv,
  hostHome: string,
): Promise<string | undefined> {
  const recorded = hostEnv.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR?.trim();
  const configDir = recorded || hostEnv.CLAUDE_CONFIG_DIR?.trim() || undefined;
  const explicit = recorded
    ? hostEnv.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT === "1"
    : Boolean(configDir);
  return getHostClaudeCredentials(
    process.platform,
    hostHome,
    configDir,
    claudeLoginLookupOptions(configDir, explicit),
  );
}

interface ProviderHomeOptions {
  root: string;
  credentialSource?: string;
  hostEnv?: NodeJS.ProcessEnv;
  hostHome?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Never fork a rotating login, even if its access token looks fresh. A 401 can refresh it. */
function copyableCredential(provider: "codex" | "opencode", contents: string): string {
  const refuse = () => {
    throw new Error(
      `Live ${provider} scenarios require API-key credentials; refusing to clone OAuth or unrecognized auth.json credentials because refresh could invalidate the host login.`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return refuse();
  }
  if (!record(parsed)) return refuse();
  if (provider === "codex") {
    if (
      typeof parsed.OPENAI_API_KEY !== "string" ||
      !parsed.OPENAI_API_KEY.trim() ||
      parsed.tokens != null ||
      (parsed.auth_mode != null && parsed.auth_mode !== "apikey")
    )
      return refuse();
    return JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: parsed.OPENAI_API_KEY });
  }
  const keys: Record<string, { type: "api"; key: string }> = {};
  for (const [name, credential] of Object.entries(parsed)) {
    if (
      !record(credential) ||
      credential.type !== "api" ||
      typeof credential.key !== "string" ||
      !credential.key.trim()
    )
      return refuse();
    keys[name] = { type: "api", key: credential.key };
  }
  return JSON.stringify(keys);
}

/**
 * Pi's API-key logins only. OAuth entries are dropped, never cloned: Pi
 * refreshes them in place, which would rotate the host's refresh token.
 */
function piApiKeys(contents: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    parsed = undefined;
  }
  const keys: Record<string, { type: "api_key"; key: string }> = {};
  if (record(parsed)) {
    for (const [name, credential] of Object.entries(parsed)) {
      if (
        record(credential) &&
        credential.type === "api_key" &&
        typeof credential.key === "string" &&
        credential.key.trim()
      )
        keys[name] = { type: "api_key", key: credential.key };
    }
  }
  if (Object.keys(keys).length === 0) {
    throw new Error(
      "Live pi scenarios require an api_key entry in Pi's auth.json; refusing to clone OAuth logins because refresh could invalidate the host login.",
    );
  }
  return JSON.stringify(keys);
}

/**
 * Isolate writable provider state. Only an explicitly selected live provider
 * receives credentials: API keys for Codex/OpenCode/Pi/Cursor, Claude's access
 * token without its refresh token, or Grok's login with its refresh token
 * blanked (the rule the agent-test profiles use). HOME stays intact for host tools; XDG consumers
 * Git, gh and mise are explicitly pointed at their original settings below.
 */
export async function isolateProviderHomes(
  options: ProviderHomeOptions,
): Promise<Record<string, string>> {
  const hostEnv = options.hostEnv ?? process.env;
  const hostHome = options.hostHome ?? os.homedir();
  const base = path.join(options.root, "provider-homes");
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    CODEX_HOME: path.join(base, "codex"),
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_DATA_HOME: path.join(base, "xdg-data"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    // Home-relative, so container input staging finds them under the
    // disposable host home below.
    PI_CODING_AGENT_DIR: path.join(base, ".pi", "agent"),
    GROK_HOME: path.join(base, ".grok"),
  };
  for (const directory of Object.values(env))
    await mkdir(directory, { recursive: true, mode: 0o700 });

  if (options.credentialSource === "claude") {
    if (hostEnv.ANTHROPIC_API_KEY?.trim()) {
      env.ANTHROPIC_API_KEY = hostEnv.ANTHROPIC_API_KEY;
    } else {
      const token =
        hostEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
        hostEnv.ANTHROPIC_AUTH_TOKEN?.trim() ||
        getClaudeOAuthAccessToken(await readScenarioHostClaudeCredentials(hostEnv, hostHome));
      if (token) {
        env.ANTHROPIC_AUTH_TOKEN = token;
        // Containers stage this file too. Never give either runtime a refresh token.
        await writeFile(
          path.join(env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: token } }),
          { mode: 0o600 },
        );
      }
    }
    // Pin later credential lookups to the disposable home, including Keychain
    // and container input staging. The original host was read only above.
    env.ORKESTRATOR_AGENT_TEST_HOST_HOME = base;
    env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR!;
    // The disposable copy is a file, not a Keychain entry: never inherit the flag.
    env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_EXPLICIT = "";
  }
  if (options.credentialSource === "pi") {
    const source = path.join(
      hostEnv.PI_CODING_AGENT_DIR?.trim() || path.join(hostHome, ".pi", "agent"),
      "auth.json",
    );
    const contents = await readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new Error("Cannot read pi scenario credentials");
    });
    if (contents) {
      await writeFile(path.join(env.PI_CODING_AGENT_DIR!, "auth.json"), piApiKeys(contents), {
        mode: 0o600,
      });
    }
    env.ORKESTRATOR_AGENT_TEST_HOST_HOME = base;
    env.ORKESTRATOR_AGENT_TEST_HOST_PI_AGENT_DIR = env.PI_CODING_AGENT_DIR!;
  }
  if (options.credentialSource === "grok") {
    if (hostEnv.XAI_API_KEY?.trim()) {
      env.XAI_API_KEY = hostEnv.XAI_API_KEY.trim();
      await writeFile(path.join(env.GROK_HOME!, "xai-api-key"), env.XAI_API_KEY, { mode: 0o600 });
    } else {
      const source = path.join(
        hostEnv.GROK_HOME?.trim() || path.join(hostHome, ".grok"),
        "auth.json",
      );
      const contents = await readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error("Cannot read grok scenario credentials");
      });
      if (contents) {
        const snapshot = restrictGrokAuthSnapshot(contents);
        if ("withheld" in snapshot)
          throw new Error(`Live grok scenarios cannot use the host login: ${snapshot.withheld}`);
        await writeFile(path.join(env.GROK_HOME!, "auth.json"), snapshot.text, { mode: 0o600 });
      }
    }
    env.ORKESTRATOR_AGENT_TEST_HOST_HOME = base;
  }
  if (options.credentialSource === "cursor" && hostEnv.CURSOR_API_KEY?.trim()) {
    env.CURSOR_API_KEY = hostEnv.CURSOR_API_KEY.trim();
  }
  if (options.credentialSource === "codex" || options.credentialSource === "opencode") {
    const provider = options.credentialSource;
    const source =
      provider === "codex"
        ? path.join(hostEnv.CODEX_HOME?.trim() || path.join(hostHome, ".codex"), "auth.json")
        : path.join(
            hostEnv.XDG_DATA_HOME?.trim() || path.join(hostHome, ".local", "share"),
            "opencode",
            "auth.json",
          );
    const contents =
      provider === "codex" && (hostEnv.CODEX_API_KEY?.trim() || hostEnv.OPENAI_API_KEY?.trim())
        ? JSON.stringify({
            OPENAI_API_KEY: hostEnv.CODEX_API_KEY?.trim() || hostEnv.OPENAI_API_KEY?.trim(),
          })
        : await readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw new Error(`Cannot read ${provider} scenario credentials`);
          });
    if (contents) {
      const safe = copyableCredential(provider, contents);
      const target =
        provider === "codex"
          ? path.join(env.CODEX_HOME!, "auth.json")
          : path.join(env.XDG_DATA_HOME!, "opencode", "auth.json");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, safe, { mode: 0o600 });
    }
  }
  return env;
}

/** The exact environment passed by startIsolatedBackend; overrides cannot bypass isolation. */
export async function prepareIsolatedBackendEnvironment(
  options: ProviderHomeOptions & {
    env?: Record<string, string>;
  },
): Promise<NodeJS.ProcessEnv> {
  const hostEnv = options.hostEnv ?? process.env;
  const hostHome = options.hostHome ?? os.homedir();
  const env = { ...hostEnv, ...options.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ORKESTRATOR_AGENT_TEST_") || key === "ORKESTRATOR_CREDENTIAL_SOURCE")
      delete env[key];
  }
  // These can otherwise outrank the disposable provider homes or authorize a
  // different provider. Resolve the selected credentials from hostEnv only.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_AUTH_JSON",
    "CURSOR_API_KEY",
    "XAI_API_KEY",
    "GROK_AUTH_FILE",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_AUTH_METHOD_ID",
  ])
    delete env[key];
  const providerHomes = await isolateProviderHomes({ ...options, hostEnv, hostHome });
  const config = hostEnv.XDG_CONFIG_HOME?.trim() || path.join(hostHome, ".config");
  const data = hostEnv.XDG_DATA_HOME?.trim() || path.join(hostHome, ".local", "share");
  const state = hostEnv.XDG_STATE_HOME?.trim() || path.join(hostHome, ".local", "state");
  // Git reads both XDG git/config and ~/.gitconfig in this order. An include
  // file retains both and their relative include semantics after XDG changes.
  const gitConfig = path.join(options.root, "git-global-config");
  if (!hostEnv.GIT_CONFIG_GLOBAL) {
    await writeFile(
      gitConfig,
      [path.join(config, "git", "config"), path.join(hostHome, ".gitconfig")]
        .map((file) => `[include]\n\tpath = ${JSON.stringify(file)}\n`)
        .join(""),
      { mode: 0o600 },
    );
  }
  return {
    ...env,
    GH_CONFIG_DIR: hostEnv.GH_CONFIG_DIR || path.join(config, "gh"),
    MISE_CONFIG_DIR: hostEnv.MISE_CONFIG_DIR || path.join(config, "mise"),
    MISE_DATA_DIR: hostEnv.MISE_DATA_DIR || path.join(data, "mise"),
    MISE_STATE_DIR: hostEnv.MISE_STATE_DIR || path.join(state, "mise"),
    GIT_CONFIG_GLOBAL: hostEnv.GIT_CONFIG_GLOBAL ?? gitConfig,
    ...providerHomes,
    ...INHERITED_AGENT_TOOL_ENV,
    ORKESTRATOR_CONTROL_MCP_DISABLED: "1",
  };
}
