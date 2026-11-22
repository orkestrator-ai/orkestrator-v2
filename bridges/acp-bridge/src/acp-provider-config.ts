import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemPrompt } from "@agentclientprotocol/sdk";
import { antigravitySystemPromptMeta } from "./antigravity-acp.js";
import {
  withheldGitHubCredentialEnvironment,
  type AgentConversationMode,
} from "@orkestrator/protocol/native-agent";

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
 * Google Antigravity's `agy acp` (docs/architecture/agent-engines.md,
 * "Antigravity"). `--process-per-session` serves each session from its own
 * worker, which is what makes agy advertise `mcpCapabilities.http` (absent
 * without it on 1.5.12), so Orkestrator's HTTP MCP connection can be handed
 * over in `session/new`. There is no model or effort flag: both are session
 * config options. `requiresAuthenticate` is false on purpose: agy's
 * `authenticate` starts an interactive browser sign-in, while a session
 * request without a login fails at once with `Authentication required`, which
 * the bridge reports as sign-in required (`acp-context.ts`).
 */
const ANTIGRAVITY_PROVIDER: AcpProviderConfig = {
  id: "antigravity",
  name: "Antigravity",
  executable: "agy",
  argv: ["acp", "--process-per-session"],
  env: {},
  requiresAuthenticate: false,
  authMethodEnv: "ORKESTRATOR_ANTIGRAVITY_AUTH_METHOD",
  modeMap: { default: "build", plan: "plan" },
  extensionPrefixes: [],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: [],
  sessionUpdateMethods: [],
};

const BUILT_IN_PROVIDERS: Readonly<Record<string, AcpProviderConfig>> = {
  grok: GROK_PROVIDER,
  antigravity: ANTIGRAVITY_PROVIDER,
};

/**
 * Providers that reattach a session the bridge still holds a transcript for
 * with `session/resume` instead of `session/load`, when the agent advertises
 * `sessionCapabilities.resume`. Resume restores the conversation without
 * replaying it, so the bridge's rows are not rebuilt or duplicated. Keyed by
 * provider id: Grok keeps its verified `session/load` path.
 */
const SESSION_RESUME_PREFERRED: ReadonlySet<string> = new Set(["antigravity"]);

export function prefersSessionResume(providerId: string): boolean {
  return SESSION_RESUME_PREFERRED.has(providerId);
}

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

/**
 * How a provider forks a session, when it can. ACP's own `session/fork` is still
 * unstable and Grok does not advertise it; Grok has an extension instead, and
 * lists a session's prompts on another (`_x.ai/rewind/points`), which is what
 * names a fork point. Keyed by provider id for the same reason as above.
 */
const SESSION_FORK_METHODS: Readonly<Record<string, { fork: string; promptPoints: string }>> = {
  grok: { fork: "_x.ai/session/fork", promptPoints: "_x.ai/rewind/points" },
};

export function sessionForkMethods(
  providerId: string,
): { fork: string; promptPoints: string } | undefined {
  return Object.hasOwn(SESSION_FORK_METHODS, providerId)
    ? SESSION_FORK_METHODS[providerId]
    : undefined;
}

export function loadAcpProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AcpProviderConfig {
  const serialized = environment.ACP_PROVIDER_CONFIG?.trim();
  if (serialized) return parseProviderConfig(serialized);

  const id = environment.ACP_PROVIDER?.trim() || "grok";
  const builtIn = Object.hasOwn(BUILT_IN_PROVIDERS, id) ? BUILT_IN_PROVIDERS[id] : undefined;
  if (!builtIn) {
    throw new Error(
      "ACP_PROVIDER_CONFIG is required for ACP providers other than grok and antigravity (both are built in)",
    );
  }
  return {
    ...builtIn,
    executable: environment.ACP_AGENT_PATH?.trim() || builtIn.executable,
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
 * Where a provider takes system-level instructions for one session: the
 * instructions every Orkestrator provider receives and, when it does not load
 * the checkout itself, the repository's AGENTS.md (`sessionInstructions`).
 *
 * Grok reads `_meta.rules` on `session/new` ("Extra rules appended to the
 * system prompt") and keeps them with the session, so a `session/load` in a
 * new process still has them. Both verified live on 1.0.70. Its `--rules`
 * flag is not an alternative: under `agent stdio` it is ignored (also
 * verified live), and a command-line argument could not hold a large
 * AGENTS.md anyway.
 *
 * Any other provider gets them through standard ACP `systemPrompt` (stable
 * since schema 1.30, SDK 2.5.0) when its `initialize` advertises
 * `sessionCapabilities.systemPrompt`, in `append` mode, which every agent
 * advertising the capability must accept. ACP asks a client to send the same
 * value again on `session/load`, so the standard carrier rides on load too.
 * Grok 1.0.88 does not advertise the capability; while it is listed here its
 * verified `_meta.rules` path wins, so a release that starts advertising it
 * cannot get the instructions twice.
 *
 * Keyed by provider id for the same reason as `NETWORK_DENIED_ARGUMENTS`.
 */
const SESSION_RULES_META_FIELD: Readonly<Record<string, string>> = {
  grok: "rules",
};

/** Where one session lifecycle request carries the session instructions, if anywhere. */
export type SessionInstructionsCarrier = "rules-meta" | "system-prompt" | "antigravity-meta";

/**
 * Pick the carrier before reading the instructions, so a request that carries
 * none (a Grok `session/load`, an agent without the capability) never reads
 * AGENTS.md.
 */
export function sessionInstructionsCarrier(
  config: AcpProviderConfig,
  options: {
    lifecycle: "new" | "load" | "resume";
    systemPromptSupported: boolean;
    /** `initialize` declared `_meta.antigravity.systemPrompt.append` (`antigravity-acp.ts`). */
    antigravitySystemPromptAppend?: boolean;
  },
): SessionInstructionsCarrier | undefined {
  if (Object.hasOwn(SESSION_RULES_META_FIELD, config.id)) {
    // Grok keeps `_meta.rules` with the session, so a load needs none.
    return options.lifecycle === "new" ? "rules-meta" : undefined;
  }
  // The standard carrier wins wherever it is advertised, so an agy release
  // that adopts it cannot receive the instructions twice. agy 1.5.12
  // advertises only its own, which T3 sends on every session setup request.
  if (options.systemPromptSupported) return "system-prompt";
  if (config.id === "antigravity" && options.antigravitySystemPromptAppend) {
    return "antigravity-meta";
  }
  return undefined;
}

/** The fields a `session/new` or `session/load` adds for these instructions. */
export function sessionInstructionsParams(
  config: AcpProviderConfig,
  carrier: SessionInstructionsCarrier | undefined,
  instructions: string | undefined,
): { _meta: Record<string, unknown> } | { systemPrompt: SystemPrompt } | Record<string, never> {
  if (!carrier || !instructions) return {};
  if (carrier === "antigravity-meta") {
    return { _meta: antigravitySystemPromptMeta(instructions) };
  }
  if (carrier === "rules-meta") {
    const field = SESSION_RULES_META_FIELD[config.id];
    return field ? { _meta: { [field]: instructions } } : {};
  }
  return { systemPrompt: { mode: "append", content: [{ type: "text", text: instructions }] } };
}

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
 * `GROK_STORAGE_MODE=local` keeps a session out of Grok's writeback, which
 * syncs session history to code.grok.com once signed in. Grok 1.0.77 (re-checked
 * signed out on 1.0.88, unchanged) documents
 * the variable beside its hidden `--storage-mode` ("Session storage mode: local
 * or writeback"; `features.writeback` in the bundled config reference), and
 * `agent stdio` reads the variable, not the flag: signed out, `writeback` logs
 * "Writeback is disabled: requires auth with grok.com", while `local` behaves
 * exactly as unset (the session is created in JSONL under
 * `$GROK_HOME/sessions/<cwd>/<id>/`, which `session/load` reads). Remote
 * settings can also turn writeback on ("storage mode upgraded from remote
 * settings"); whether this value outranks them is unverified signed in, and
 * only a `requirements.toml` `features.writeback = false` is documented to.
 * See the Grok section of `docs/development/upgrade-agents.md`.
 *
 * Applied after the launcher record's own `env`, and keyed by provider id for
 * the same reason as `NETWORK_DENIED_ARGUMENTS`: the backend's serialized
 * record carries `env: {}`, and the policy must not depend on it.
 */
const POLICY_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  grok: { GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "false", GROK_STORAGE_MODE: "local" },
  // agy updates itself in place by default; the managed binary is pinned and
  // hash-verified, so a self-update would run a version the manifest does not
  // declare (variable observed in T3's launch environment; to be re-checked on
  // every bump, docs/development/upgrade-agents.md).
  antigravity: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
};

function projectTrust(config: AcpProviderConfig, trustProject: boolean | undefined) {
  return trustProject && Object.hasOwn(PROJECT_TRUST, config.id)
    ? PROJECT_TRUST[config.id]!
    : undefined;
}

let withheldGhConfigDir: string | undefined;

/** An empty `gh` configuration directory, created once per bridge process. */
export function emptyGhConfigDir(): string {
  withheldGhConfigDir ??= mkdtempSync(path.join(tmpdir(), "orkestrator-gh-withheld-"));
  return withheldGhConfigDir;
}

/**
 * The bridge's own control credentials: its HTTP token and the
 * environment-wide agent MCP credential. The bridge hands the agent its MCP
 * connection in `session/new` (`configuredAcpMcpServers`), so neither the
 * agent process nor a command it runs needs them (security report M13).
 */
export const BRIDGE_CONTROL_ENV_VARS: readonly string[] = Object.freeze([
  "ACP_BRIDGE_TOKEN",
  "ORKESTRATOR_AGENT_MCP_TOKEN",
  "ORKESTRATOR_AGENT_MCP_URL",
]);

export function withoutBridgeControlEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed = { ...env };
  for (const name of Object.keys(scrubbed)) {
    if (BRIDGE_CONTROL_ENV_VARS.includes(name) || name.endsWith("_BRIDGE_TOKEN")) {
      delete scrubbed[name];
    }
  }
  return scrubbed;
}

/**
 * The environment a provider child is spawned with. Each session runs its own
 * child, so `withholdGitHub` (a policy that denies `github.write`, every
 * graph agent node; item 209) strips the GitHub credential from that child
 * alone: token variables, `gh`'s stored login (`ghConfigDir` is an empty
 * directory) and Git's credential helpers.
 */
export function providerEnv(
  config: AcpProviderConfig,
  options: { trustProject?: boolean; withholdGitHub?: { ghConfigDir: string } },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...withoutBridgeControlEnvironment(base),
    ...config.env,
    ...(Object.hasOwn(POLICY_ENV, config.id) ? POLICY_ENV[config.id] : {}),
    ...projectTrust(config, options.trustProject)?.env,
  };
  return options.withholdGitHub
    ? (withheldGitHubCredentialEnvironment(env, options.withholdGitHub) as NodeJS.ProcessEnv)
    : env;
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
