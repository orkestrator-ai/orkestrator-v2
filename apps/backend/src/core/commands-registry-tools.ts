import path from "node:path";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { readAgentSkillFile, scanAgentSkills } from "./agent-skills.js";
import { createHostExtensionCommandRunner } from "./commands-agent-support.js";
import { discoverAgentPlugins } from "./extension-discovery.js";
import { AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV } from "./agent-credential-files.js";
import {
  cancelGitHubCliLogin,
  getGitHubCliStatus,
  gitHubCliLoginProgress,
  startGitHubCliLogin,
} from "./github-cli-setup.js";
import { checkHostTool } from "./host-tools.js";
import { homePath, pathExists } from "./shell.js";
import {
  asString,
  asAgentSkillProvider,
  assertOnlyKeys,
  runEnvironmentAgentSkills,
  hasCursorSdkBridge,
  hasManagedAcpBinary,
  getContainerGitHubCredentialStatus,
} from "./commands-helpers.js";

/**
 * Where this runtime's Claude login would be, or null when it may not use one.
 *
 * An agent-test profile runs with an isolated HOME. When it is allowed the
 * host's Claude login, launches are pointed at the host's home and config
 * directory, so the login check has to look there too.
 */
function claudeLoginHome(
  context: CommandContext,
): { home: string; configDir: string | undefined } | null {
  if (context.runtimeFlavor !== "agent-test") return { home: homePath(), configDir: undefined };
  if (!context.credentialSources?.has("claude")) return null;
  return {
    home: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim() || homePath(),
    configDir: process.env[AGENT_TEST_HOST_CLAUDE_CONFIG_DIR_ENV]?.trim() || undefined,
  };
}

async function anyPathExists(candidates: string[]): Promise<boolean> {
  for (const candidate of candidates) if (await pathExists(candidate)) return true;
  return false;
}

export function registerToolingCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { commands } = dependencies;
  register("list_agent_skills", async (args, context) => {
    assertOnlyKeys(args, ["provider"], "list_agent_skills argument");
    const provider = asAgentSkillProvider(args.provider);
    if (context.runtimeFlavor === "agent-test") {
      return { provider, roots: [], skills: [], errors: [] };
    }
    return scanAgentSkills(provider);
  });
  register("list_agent_plugins", async (args, context) => {
    assertOnlyKeys(args, ["provider"], "list_agent_plugins argument");
    const provider = asAgentSkillProvider(args.provider);
    if (context.runtimeFlavor === "agent-test") {
      return { agent: provider, plugins: [] };
    }
    return discoverAgentPlugins(provider, createHostExtensionCommandRunner(context));
  });
  register("read_agent_skill", async (args, context) => {
    assertOnlyKeys(args, ["provider", "filePath"], "read_agent_skill argument");
    if (context.runtimeFlavor === "agent-test") {
      throw new Error("Host agent skills are unavailable in isolated agent-test profiles");
    }
    return readAgentSkillFile(
      asAgentSkillProvider(args.provider),
      asString(args.filePath, "filePath"),
    );
  });
  register("list_environment_agent_skills", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "provider"], "list_environment_agent_skills argument");
    const environmentId = asString(args.environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return runEnvironmentAgentSkills(
      environment,
      context,
      asAgentSkillProvider(args.provider),
      "list",
    );
  });
  register("read_environment_agent_skill", async (args, context) => {
    assertOnlyKeys(
      args,
      ["environmentId", "provider", "filePath"],
      "read_environment_agent_skill argument",
    );
    const environmentId = asString(args.environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return runEnvironmentAgentSkills(
      environment,
      context,
      asAgentSkillProvider(args.provider),
      "read",
      asString(args.filePath, "filePath"),
    );
  });

  register("has_claude_credentials", (_args, context) => {
    const login = claudeLoginHome(context);
    if (!login) return false;
    return anyPathExists([
      ...(login.configDir ? [path.join(login.configDir, ".credentials.json")] : []),
      path.join(login.home, ".claude", ".credentials.json"),
      path.join(login.home, ".claude.json"),
    ]);
  });
  register("get_credential_status", async (_args, context) => ({
    available: await commands.get("has_claude_credentials")?.({}, context),
    expiresAt: null,
  }));
  register("check_claude_cli", (_args, context) => checkHostTool(context, "claude"));
  register("check_claude_config", (_args, context) => {
    const login = claudeLoginHome(context);
    if (!login) return false;
    // Claude Code keeps `.claude.json` inside CLAUDE_CONFIG_DIR when it is set.
    return anyPathExists([
      ...(login.configDir ? [path.join(login.configDir, ".claude.json")] : []),
      path.join(login.home, ".claude.json"),
    ]);
  });
  register("check_opencode_cli", (_args, context) => checkHostTool(context, "opencode"));
  register("check_codex_cli", (_args, context) => checkHostTool(context, "codex"));
  // Kept under the existing command name for protocol compatibility. Cursor
  // no longer has a CLI; availability means the SDK bridge is packaged.
  register("check_cursor_cli", (_args, context) => hasCursorSdkBridge(context));
  register("check_grok_cli", (_args, context) => hasManagedAcpBinary(context, "grok"));
  register("check_pi_cli", (_args, context) => checkHostTool(context, "pi"));
  register("check_github_cli", (_args, context) => checkHostTool(context, "gh"));
  register("get_github_cli_status", (args, context) => {
    assertOnlyKeys(args, [], "get_github_cli_status argument");
    return getGitHubCliStatus(context);
  });
  /**
   * Sign-in is split into start and poll like the agent account sign-in: it
   * waits on the user and must not hold a request open.
   */
  register("start_github_cli_login", (args, context) => {
    assertOnlyKeys(args, [], "start_github_cli_login argument");
    return startGitHubCliLogin(context);
  });
  register("get_github_cli_login", (args, context) => {
    assertOnlyKeys(args, [], "get_github_cli_login argument");
    return gitHubCliLoginProgress(context);
  });
  register("cancel_github_cli_login", (args, context) => {
    assertOnlyKeys(args, ["operationId"], "cancel_github_cli_login argument");
    return cancelGitHubCliLogin(
      context,
      args.operationId === undefined ? undefined : asString(args.operationId, "operationId"),
    );
  });
  register("get_container_github_credential_status", async (_args, context) =>
    getContainerGitHubCredentialStatus((await context.storage.loadConfig()).global),
  );
  register(
    "check_any_ai_cli",
    async (_args, context) =>
      (await checkHostTool(context, "claude")) ||
      (await checkHostTool(context, "opencode")) ||
      (await checkHostTool(context, "codex")) ||
      (await hasCursorSdkBridge(context)) ||
      (await hasManagedAcpBinary(context, "grok")) ||
      (await checkHostTool(context, "pi")),
  );
  register("get_available_ai_cli", async (_args, context) =>
    (await checkHostTool(context, "claude"))
      ? "claude"
      : (await checkHostTool(context, "opencode"))
        ? "opencode"
        : (await checkHostTool(context, "codex"))
          ? "codex"
          : (await hasCursorSdkBridge(context))
            ? "cursor"
            : (await hasManagedAcpBinary(context, "grok"))
              ? "grok"
              : (await checkHostTool(context, "pi"))
                ? "pi"
                : null,
  );
}
