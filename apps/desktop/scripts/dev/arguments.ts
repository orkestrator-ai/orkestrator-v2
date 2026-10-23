import type { RuntimeProfile } from "../../electron/runtime-profile.js";
import { AGENT_PLATFORMS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";

export type DevArguments = {
  profile?: string;
  fixture: boolean;
  fixtureEnvironments: Array<"local" | "container">;
  /**
   * Network mode of the `fixture-container` environment. Absent means
   * restricted; `full` lets real-stack checks run against a full-network
   * container, since the mode can only be chosen when an environment is created.
   */
  fixtureContainerNetwork?: "restricted" | "full";
  json: boolean;
  keepToolchains: boolean;
  stopFirst: boolean;
  agentCredentialsDisabled: boolean;
  credentialSources: RuntimeProfile["credentialSources"];
  agentPlatforms: RuntimeProfile["agentPlatforms"];
  /**
   * `dev:test` only: place a new profile's worktrees in the production app's
   * dev worktree folder. Agent-test profiles otherwise keep them under the
   * profile, so test fixtures and moves see the same layout on every host.
   */
  useDevWorktreeFolder?: boolean;
};

const ALL_AGENT_CREDENTIAL_SOURCES: RuntimeProfile["credentialSources"] = [...AGENT_PLATFORMS];
const ALL_AGENT_PLATFORMS: RuntimeProfile["agentPlatforms"] = [...AGENT_PLATFORMS];

type ParseOptions = {
  /**
   * Only `dev:test` consumes a platform selection or a worktree folder choice — Electron reads it for the
   * `agent-test` flavor alone, and the launcher seeds toolchains for that flavor
   * alone. Accepting the flag anywhere else would validate it, persist it into
   * the profile, and then quietly ignore it; honouring it instead would let a
   * `dev` run override the user's durable per-installation choice. A `dev`
   * profile always uses the configured dev worktree folder.
   */
  agentTest: boolean;
};

export function parseDevArguments(args: string[]): DevArguments {
  return parseArguments(args, { agentTest: false });
}

function parseArguments(args: string[], options: ParseOptions): DevArguments {
  const result: DevArguments = {
    fixture: false,
    fixtureEnvironments: [],
    json: false,
    keepToolchains: false,
    stopFirst: false,
    agentCredentialsDisabled: false,
    credentialSources: [],
    agentPlatforms: [],
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
    else if (argument === "--use-dev-worktree-folder") {
      if (!options.agentTest) {
        throw new Error("--use-dev-worktree-folder is only supported by mise run dev:test");
      }
      result.useDevWorktreeFolder = true;
    } else if (argument === "--fixture-environments") {
      const values = valueAfter(index++, argument).split(",").filter(Boolean);
      if (values.some((value) => value !== "local" && value !== "container")) {
        throw new Error("--fixture-environments accepts local,container");
      }
      result.fixtureEnvironments = [...new Set(values)] as DevArguments["fixtureEnvironments"];
      result.fixture = true;
    } else if (argument === "--fixture-network") {
      const value = valueAfter(index++, argument);
      if (value !== "restricted" && value !== "full") {
        throw new Error("--fixture-network accepts restricted or full");
      }
      result.fixtureContainerNetwork = value;
    } else if (argument === "--agent-platforms") {
      if (!options.agentTest) {
        throw new Error("--agent-platforms is only supported by mise run dev:test");
      }
      const values = valueAfter(index++, argument).split(",").filter(Boolean);
      if (values.some((value) => !isAgentPlatform(value))) {
        throw new Error(`--agent-platforms accepts ${AGENT_PLATFORMS.join(", ")}`);
      }
      result.agentPlatforms.push(...(values as RuntimeProfile["agentPlatforms"]));
    } else if (argument === "--credential-source") {
      const value = valueAfter(index++, argument);
      if (!isAgentPlatform(value)) {
        throw new Error(`--credential-source accepts ${AGENT_PLATFORMS.join(", ")}`);
      }
      result.credentialSources.push(value);
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`Unknown development option: ${argument}`);
    }
  }
  if (result.fixtureContainerNetwork && !result.fixtureEnvironments.includes("container")) {
    throw new Error("--fixture-network needs --fixture-environments with container");
  }
  result.credentialSources = [...new Set(result.credentialSources)];
  result.agentPlatforms = [...new Set(result.agentPlatforms)];
  if (result.agentCredentialsDisabled && result.credentialSources.length > 0) {
    throw new Error("--no-agent-credentials cannot be combined with --credential-source");
  }
  return result;
}

/**
 * Agent-driven QA is expected to exercise live providers. Keep `dev` itself
 * credential-free, while making `dev:test` useful for real agent sessions
 * without relying on every caller to remember three flags.
 *
 * Toolchains default the same way, and for a sharper reason than convenience:
 * Cursor and Grok resolve only through the managed toolchain, so a profile that
 * provisions nothing cannot start them at all — and the failure surfaces late,
 * as "enabled but not installed yet" during session creation, rather than as
 * anything a caller would connect to a missing flag. Seeding from the host
 * installation makes the default cheap; `--agent-platforms` narrows it.
 */
export function applyAgentTestDefaults(args: DevArguments): DevArguments {
  const agentPlatforms =
    args.agentPlatforms.length > 0 ? args.agentPlatforms : [...ALL_AGENT_PLATFORMS];
  if (args.agentCredentialsDisabled || args.credentialSources.length > 0) {
    return { ...args, agentPlatforms };
  }
  return {
    ...args,
    agentPlatforms,
    credentialSources: [...ALL_AGENT_CREDENTIAL_SOURCES],
  };
}

export function parseAgentTestArguments(args: string[]): DevArguments {
  return applyAgentTestDefaults(parseArguments(args, { agentTest: true }));
}

export type PruneArguments = {
  dryRun: boolean;
  force: boolean;
  json: boolean;
  keepToolchains: boolean;
  olderThanDays?: number;
};

export function parsePruneArguments(args: string[]): PruneArguments {
  const result: PruneArguments = {
    dryRun: false,
    force: false,
    json: false,
    keepToolchains: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--force") result.force = true;
    else if (argument === "--json") result.json = true;
    else if (argument === "--keep-toolchains") result.keepToolchains = true;
    else if (argument === "--older-than") {
      const value = args[++index];
      const days = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(days) || days < 0) {
        throw new Error("--older-than takes a whole number of days");
      }
      result.olderThanDays = days;
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`Unknown prune option: ${argument}`);
    }
  }
  return result;
}
