import type { RuntimeProfile } from "../../electron/runtime-profile.js";

export type DevArguments = {
  profile?: string;
  fixture: boolean;
  fixtureEnvironments: Array<"local" | "container">;
  json: boolean;
  keepToolchains: boolean;
  stopFirst: boolean;
  agentCredentialsDisabled: boolean;
  credentialSources: RuntimeProfile["credentialSources"];
};

const ALL_AGENT_CREDENTIAL_SOURCES: RuntimeProfile["credentialSources"] = [
  "claude",
  "codex",
  "opencode",
];

export function parseDevArguments(args: string[]): DevArguments {
  const result: DevArguments = {
    fixture: false,
    fixtureEnvironments: [],
    json: false,
    keepToolchains: false,
    stopFirst: false,
    agentCredentialsDisabled: false,
    credentialSources: [],
  };
  const valueAfter = (index: number, name: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--profile") result.profile = valueAfter(index++, argument);
    else if (argument === "--fixture") result.fixture = true;
    else if (argument === "--json") result.json = true;
    else if (argument === "--keep-toolchains") result.keepToolchains = true;
    else if (argument === "--stop-first") result.stopFirst = true;
    else if (argument === "--no-agent-credentials") result.agentCredentialsDisabled = true;
    else if (argument === "--fixture-environments") {
      const values = valueAfter(index++, argument).split(",").filter(Boolean);
      if (values.some((value) => value !== "local" && value !== "container")) {
        throw new Error("--fixture-environments accepts local,container");
      }
      result.fixtureEnvironments = [...new Set(values)] as DevArguments["fixtureEnvironments"];
      result.fixture = true;
    } else if (argument === "--credential-source") {
      const value = valueAfter(index++, argument);
      if (value !== "claude" && value !== "codex" && value !== "opencode") {
        throw new Error("--credential-source accepts claude, codex, or opencode");
      }
      result.credentialSources.push(value);
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`Unknown development option: ${argument}`);
    }
  }
  result.credentialSources = [...new Set(result.credentialSources)];
  if (result.agentCredentialsDisabled && result.credentialSources.length > 0) {
    throw new Error("--no-agent-credentials cannot be combined with --credential-source");
  }
  return result;
}

/**
 * Agent-driven QA is expected to exercise live providers. Keep `dev` itself
 * credential-free, while making `dev:test` useful for real agent sessions
 * without relying on every caller to remember three flags.
 */
export function applyAgentTestDefaults(args: DevArguments): DevArguments {
  if (args.agentCredentialsDisabled || args.credentialSources.length > 0) return args;
  return { ...args, credentialSources: [...ALL_AGENT_CREDENTIAL_SOURCES] };
}
