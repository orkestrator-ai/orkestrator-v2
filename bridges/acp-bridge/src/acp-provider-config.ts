import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";

export interface AcpProviderConfig {
  id: string;
  name: string;
  executable: string;
  /** Argument template. `{{model}}` and `{{effort}}` expand to provider flags. */
  argv: string[];
  env: Record<string, string>;
  requiresAuthenticate: boolean;
  authMethodEnv?: string;
  modeMap: Record<string, AgentConversationMode>;
  extensionPrefixes: string[];
  acknowledgedExtensionMethods: string[];
  modelUpdateMethods: string[];
  sessionUpdateMethods: string[];
}

const GROK_PROVIDER: AcpProviderConfig = {
  id: "grok",
  name: "Grok",
  executable: "grok",
  argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
  env: {},
  requiresAuthenticate: true,
  authMethodEnv: "GROK_AUTH_METHOD_ID",
  modeMap: {
    agent: "build",
    code: "build",
    build: "build",
    agentic: "build",
    plan: "plan",
    architect: "plan",
    ask: "plan",
  },
  extensionPrefixes: ["x.ai/", "_x.ai/"],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: ["x.ai/models/update", "_x.ai/models/update"],
  sessionUpdateMethods: ["x.ai/session/update", "_x.ai/session/update"],
};

/**
 * Prompt content a provider is known to accept although its `initialize`
 * answer does not declare it.
 *
 * Empty today. Grok 1.0.52 answered `promptCapabilities.image: false` yet read
 * a standard inline `image` block, so it was credited here; 1.0.67 declares
 * `image: true` itself, and its entry was removed. Keyed by provider id, not by
 * launcher record, so the backend's serialized config and the built-in one
 * agree. Add an entry only with evidence that the agent reads the content
 * (an image sent only as a block, no path in the text, described correctly),
 * and remove it once the agent declares the capability itself.
 */
const UNDECLARED_PROMPT_CAPABILITIES: Readonly<Record<string, { image?: true }>> = {};

export function undeclaredPromptCapabilities(providerId: string): { image?: true } {
  return Object.hasOwn(UNDECLARED_PROMPT_CAPABILITIES, providerId)
    ? UNDECLARED_PROMPT_CAPABILITIES[providerId]!
    : {};
}

export function loadAcpProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AcpProviderConfig {
  const serialized = environment.ACP_PROVIDER_CONFIG?.trim();
  if (serialized) return parseProviderConfig(serialized);

  const id = environment.ACP_PROVIDER?.trim();
  if (id && id !== "grok") {
    throw new Error(
      "ACP_PROVIDER_CONFIG is required for ACP providers other than grok (ACP_PROVIDER=grok is built in)",
    );
  }
  return {
    ...GROK_PROVIDER,
    executable: environment.ACP_AGENT_PATH?.trim() || GROK_PROVIDER.executable,
  };
}

/**
 * Flags that take a provider's own network tools away.
 *
 * Grok's web search and web fetch run through xAI rather than as a command on
 * this machine, and Grok does not ask permission before a search, so denying
 * permission requests cannot stop them. `--disable-web-search` removes both
 * tools from the toolset ("web fetch is off (disable_web_search)" in 1.0.52),
 * and on 1.0.67 also the hosted search's `open_page` actions, which no other
 * switch removes. xAI's hosted X search tools (`x_keyword_search` and
 * friends) survive every switch.
 * It is a top-level flag, and a shared leader process ignores it, so the agent
 * subcommand also gets `--no-leader`: a user config with `[cli] use_leader`
 * would otherwise hand the session to a leader that still has the tools.
 *
 * Keyed by provider id, not by launcher record, for the same reason as
 * `UNDECLARED_PROMPT_CAPABILITIES`: the backend's serialized config and the
 * built-in one must agree, and a record that forgot the flag must not fail open.
 */
const NETWORK_DENIED_ARGUMENTS: Readonly<
  Record<
    string,
    { leading: readonly string[]; subcommand: string; afterSubcommand: readonly string[] }
  >
> = {
  grok: {
    leading: ["--disable-web-search"],
    subcommand: "agent",
    afterSubcommand: ["--no-leader"],
  },
};

/**
 * What makes a provider load the checkout's own configuration when the
 * session's policy turns project resources on.
 *
 * Grok skips a git checkout's AGENTS.md, skills, `.grok/commands`, hooks,
 * project MCP and LSP servers and project permission rules until the folder is
 * trusted in `$GROK_HOME/trusted_folders.toml`, and says nothing when it does.
 * Every environment is a git checkout Grok has not seen: a container's
 * `/workspace` never matches the host paths in a staged trust store, and a
 * host worktree is covered only when its main checkout was trusted. Headless,
 * it never asks. `GROK_FOLDER_TRUST=0` turns the gate off for this process
 * only and records nothing (`grok --trust` would write a lasting grant to the
 * user's store). A shared leader resolves trust in its own process, which this
 * environment does not reach, hence `--no-leader` as for network denial.
 *
 * Keyed by provider id for the same reason as `NETWORK_DENIED_ARGUMENTS`.
 */
const PROJECT_TRUST: Readonly<
  Record<
    string,
    {
      env: Readonly<Record<string, string>>;
      subcommand: string;
      afterSubcommand: readonly string[];
    }
  >
> = {
  grok: {
    env: { GROK_FOLDER_TRUST: "0" },
    subcommand: "agent",
    afterSubcommand: ["--no-leader"],
  },
};

/**
 * Environment every child of a provider gets, whatever the session's policy.
 *
 * Grok 1.0.67 lets a git worktree use its main checkout's saved "always allow"
 * answers by default (`[features] worktree_inherits_main_approvals`). Every
 * Orkestrator environment is a worktree of a checkout the user may also run
 * Grok in, so a TUI grant there would let a tool run without the
 * `session/request_permission` the bridge answers from the execution policy.
 * `GROK_WORKTREE_INHERITS_MAIN_APPROVALS=false` turns the inheritance off for
 * this process only; the main checkout's "never allow" answers still apply.
 *
 * Applied after the launcher record's own `env`, and keyed by provider id for
 * the same reason as `NETWORK_DENIED_ARGUMENTS`: the backend's serialized
 * record carries `env: {}`, and the policy must not depend on it.
 */
const POLICY_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grok: { GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "false" },
};

function projectTrust(config: AcpProviderConfig, trustProject: boolean | undefined) {
  return trustProject && Object.hasOwn(PROJECT_TRUST, config.id)
    ? PROJECT_TRUST[config.id]!
    : undefined;
}

/** The environment a provider child is spawned with. */
export function providerEnv(
  config: AcpProviderConfig,
  options: { trustProject?: boolean },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...config.env,
    ...(Object.hasOwn(POLICY_ENV, config.id) ? POLICY_ENV[config.id] : {}),
    ...projectTrust(config, options.trustProject)?.env,
  };
}

export function providerArgv(
  config: AcpProviderConfig,
  options: {
    model?: string;
    effort?: string;
    approvals?: "ask" | "auto-approve" | "deny";
    /** The session's policy denies `network`. */
    denyNetwork?: boolean;
    /** The session's policy turns project resources on. */
    trustProject?: boolean;
    readOnlyProfilePath?: string;
  },
): string[] {
  if (options.readOnlyProfilePath && !config.argv.includes("agent")) {
    throw new Error("Grok read-only profile requires a local agent launcher");
  }
  const network =
    options.denyNetwork && Object.hasOwn(NETWORK_DENIED_ARGUMENTS, config.id)
      ? NETWORK_DENIED_ARGUMENTS[config.id]!
      : undefined;
  const trust = projectTrust(config, options.trustProject);
  const argv = config.argv.flatMap((argument) => {
    if (
      argument === "--always-approve" &&
      options.approvals &&
      options.approvals !== "auto-approve"
    ) {
      return [];
    }
    if (argument === "{{model}}") return options.model ? ["--model", options.model] : [];
    if (argument === "{{effort}}") {
      return options.effort ? ["--reasoning-effort", options.effort] : [];
    }
    const after = [
      ...(network && argument === network.subcommand ? network.afterSubcommand : []),
      ...(trust && argument === trust.subcommand ? trust.afterSubcommand : []),
      ...(argument === "agent" && options.readOnlyProfilePath ? ["--no-leader"] : []),
    ];
    return [
      argument,
      ...new Set(after),
      ...(argument === "agent" && options.readOnlyProfilePath
        ? ["--agent-profile", options.readOnlyProfilePath]
        : []),
    ];
  });
  return network ? [...network.leading, ...argv] : argv;
}

function parseProviderConfig(serialized: string): AcpProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("ACP_PROVIDER_CONFIG must be valid JSON");
  }
  if (!isRecord(value)) throw new Error("ACP_PROVIDER_CONFIG must be a JSON object");
  const id = requiredString(value.id, "id");
  const executable = requiredString(value.executable, "executable");
  const argv = stringArray(value.argv, "argv", 128);
  const modeMap: Record<string, AgentConversationMode> = isRecord(value.modeMap)
    ? (Object.fromEntries(
        Object.entries(value.modeMap).flatMap(([agentMode, normalized]) =>
          normalized === "build" || normalized === "plan" ? [[agentMode, normalized]] : [],
        ),
      ) as Record<string, AgentConversationMode>)
    : {};
  const env = isRecord(value.env)
    ? Object.fromEntries(
        Object.entries(value.env).flatMap(([key, entry]) =>
          typeof entry === "string" ? [[key, entry]] : [],
        ),
      )
    : {};
  return {
    id,
    name: optionalString(value.name) ?? id,
    executable,
    argv,
    env,
    requiresAuthenticate: value.requiresAuthenticate === true,
    ...(optionalString(value.authMethodEnv)
      ? { authMethodEnv: optionalString(value.authMethodEnv) }
      : {}),
    modeMap,
    extensionPrefixes: stringArray(value.extensionPrefixes, "extensionPrefixes", 64, true),
    acknowledgedExtensionMethods: stringArray(
      value.acknowledgedExtensionMethods,
      "acknowledgedExtensionMethods",
      64,
      true,
    ),
    modelUpdateMethods: stringArray(value.modelUpdateMethods, "modelUpdateMethods", 64, true),
    sessionUpdateMethods: stringArray(value.sessionUpdateMethods, "sessionUpdateMethods", 64, true),
  };
}

function stringArray(value: unknown, field: string, maximum: number, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => !optionalString(entry))
  ) {
    throw new Error(`ACP_PROVIDER_CONFIG.${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`ACP_PROVIDER_CONFIG.${field} must be a non-empty string`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && Buffer.byteLength(trimmed) <= 4_096 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
