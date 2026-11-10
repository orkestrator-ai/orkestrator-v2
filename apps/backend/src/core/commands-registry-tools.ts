import path from "node:path";
import type { CommandRegistrar } from "./commands-registry-types.js";
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
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import {
  type EnvironmentAgentSkillFileSchema,
  type EnvironmentAgentSkillScanSchema,
  cancelGithubCliLoginCommand,
  checkAnyAiCliCommand,
  checkClaudeCliCommand,
  checkClaudeConfigCommand,
  checkCodexCliCommand,
  checkCursorCliCommand,
  checkGithubCliCommand,
  checkGrokCliCommand,
  checkOpencodeCliCommand,
  checkPiCliCommand,
  getAvailableAiCliCommand,
  getContainerGithubCredentialStatusCommand,
  getGithubCliLoginCommand,
  getGithubCliStatusCommand,
  hasClaudeCredentialsCommand,
  listAgentPluginsCommand,
  listAgentSkillsCommand,
  listEnvironmentAgentSkillsCommand,
  readAgentSkillCommand,
  readEnvironmentAgentSkillCommand,
  startGithubCliLoginCommand,
} from "@orkestrator/protocol/contract/domains/agent-servers";
import {
  asString,
  asAgentSkillProvider,
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

export function registerToolingCommands(register: CommandRegistrar): void {
  register(listAgentSkillsCommand, async (args, context) => {
    const provider = asAgentSkillProvider(args.provider);
    if (context.runtimeFlavor === "agent-test") {
      return { provider, roots: [], skills: [], errors: [] };
    }
    return scanAgentSkills(provider);
  });
  register(listAgentPluginsCommand, async (args, context) => {
    const provider = asAgentSkillProvider(args.provider);
    if (context.runtimeFlavor === "agent-test") {
      return { agent: provider, plugins: [] };
    }
    return discoverAgentPlugins(provider, createHostExtensionCommandRunner(context));
  });
  register(readAgentSkillCommand, async (args, context) => {
    if (context.runtimeFlavor === "agent-test") {
      throw new Error("Host agent skills are unavailable in isolated agent-test profiles");
    }
    return readAgentSkillFile(
      asAgentSkillProvider(args.provider),
      asString(args.filePath, "filePath"),
    );
  });
  register(listEnvironmentAgentSkillsCommand, async (args, context) => {
    const environmentId = asString(args.environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return runEnvironmentAgentSkills(
      environment,
      context,
      asAgentSkillProvider(args.provider),
      "list",
    ) as Promise<(typeof EnvironmentAgentSkillScanSchema)["Type"]>;
  });
  register(readEnvironmentAgentSkillCommand, async (args, context) => {
    const environmentId = asString(args.environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return runEnvironmentAgentSkills(
      environment,
      context,
      asAgentSkillProvider(args.provider),
      "read",
      asString(args.filePath, "filePath"),
    ) as Promise<(typeof EnvironmentAgentSkillFileSchema)["Type"]>;
  });

  register(hasClaudeCredentialsCommand, (_args, context) => {
    const login = claudeLoginHome(context);
    if (!login) return false;
    return anyPathExists([
      ...(login.configDir ? [path.join(login.configDir, ".credentials.json")] : []),
      path.join(login.home, ".claude", ".credentials.json"),
      path.join(login.home, ".claude.json"),
    ]);
  });
  register(checkClaudeCliCommand, (_args, context) => checkHostTool(context, "claude"));
  register(checkClaudeConfigCommand, (_args, context) => {
    const login = claudeLoginHome(context);
    if (!login) return false;
    // Claude Code keeps `.claude.json` inside CLAUDE_CONFIG_DIR when it is set.
    return anyPathExists([
      ...(login.configDir ? [path.join(login.configDir, ".claude.json")] : []),
      path.join(login.home, ".claude.json"),
    ]);
  });
  register(checkOpencodeCliCommand, (_args, context) => {
    compatibilityPathUsage.record("retired-command.provider-cli-check");
    return checkHostTool(context, "opencode");
  });
  register(checkCodexCliCommand, (_args, context) => {
    compatibilityPathUsage.record("retired-command.provider-cli-check");
    return checkHostTool(context, "codex");
  });
  // Kept under the existing command name for protocol compatibility. Cursor
  // no longer has a CLI; availability means the SDK bridge is packaged.
  register(checkCursorCliCommand, (_args, context) => {
    compatibilityPathUsage.record("retired-command.provider-cli-check");
    return hasCursorSdkBridge(context);
  });
  register(checkGrokCliCommand, (_args, context) => {
    compatibilityPathUsage.record("retired-command.provider-cli-check");
    return hasManagedAcpBinary(context, "grok");
  });
  register(checkPiCliCommand, (_args, context) => {
    compatibilityPathUsage.record("retired-command.provider-cli-check");
    return checkHostTool(context, "pi");
  });
  register(checkGithubCliCommand, (_args, context) => checkHostTool(context, "gh"));
  register(getGithubCliStatusCommand, (_args, context) => getGitHubCliStatus(context));
  /**
   * Sign-in is split into start and poll like the agent account sign-in: it
   * waits on the user and must not hold a request open.
   */
  register(startGithubCliLoginCommand, (_args, context) => startGitHubCliLogin(context));
  register(getGithubCliLoginCommand, (_args, context) => gitHubCliLoginProgress(context));
  register(cancelGithubCliLoginCommand, (args, context) =>
    cancelGitHubCliLogin(context, args.operationId),
  );
  register(getContainerGithubCredentialStatusCommand, async (_args, context) =>
    getContainerGitHubCredentialStatus(
      (await context.storage.loadConfig()).global,
      context.runtime.gitHubCli,
    ),
  );
  register(
    checkAnyAiCliCommand,
    async (_args, context) =>
      (await checkHostTool(context, "claude")) ||
      (await checkHostTool(context, "opencode")) ||
      (await checkHostTool(context, "codex")) ||
      (await hasCursorSdkBridge(context)) ||
      (await hasManagedAcpBinary(context, "grok")) ||
      (await checkHostTool(context, "pi")),
  );
  register(getAvailableAiCliCommand, async (_args, context) =>
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
