import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  readAgentSkillFile,
  scanAgentSkills,
  commandExists,
  homePath,
  pathExists,
} from "./commands-dependencies.js";
import {
  asString,
  asAgentSkillProvider,
  assertOnlyKeys,
  runEnvironmentAgentSkills,
  hasPackagedOrPathBinary,
  hasManagedAcpBinary,
  getContainerGitHubCredentialStatus,
} from "./commands-helpers.js";

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
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("claude"))
      return false;
    return pathExists(homePath(".claude", ".credentials.json")).then(
      async (exists) => exists || pathExists(homePath(".claude.json")),
    );
  });
  register("get_credential_status", async (_args, context) => ({
    available: await commands.get("has_claude_credentials")?.({}, context),
    expiresAt: null,
  }));
  register("check_claude_cli", (_args, context) => hasPackagedOrPathBinary(context, "claude"));
  register("check_claude_config", (_args, context) => {
    if (context.runtimeFlavor === "agent-test" && !context.credentialSources?.has("claude"))
      return false;
    return pathExists(homePath(".claude.json"));
  });
  register("check_opencode_cli", (_args, context) => hasPackagedOrPathBinary(context, "opencode"));
  register("check_codex_cli", (_args, context) => hasPackagedOrPathBinary(context, "codex"));
  // Cursor and Grok report only what this backend generation can actually
  // launch. Answering from PATH would advertise an agent whose bridge start
  // then refuses it — see `resolveManagedAcpBinary`.
  register("check_cursor_cli", (_args, context) => hasManagedAcpBinary(context, "cursor"));
  register("check_grok_cli", (_args, context) => hasManagedAcpBinary(context, "grok"));
  register("check_pi_cli", (_args, context) => hasPackagedOrPathBinary(context, "pi"));
  register("check_github_cli", () => commandExists("gh"));
  register("get_container_github_credential_status", async (_args, context) =>
    getContainerGitHubCredentialStatus((await context.storage.loadConfig()).global),
  );
  register(
    "check_any_ai_cli",
    async (_args, context) =>
      (await hasPackagedOrPathBinary(context, "claude")) ||
      (await hasPackagedOrPathBinary(context, "opencode")) ||
      (await hasPackagedOrPathBinary(context, "codex")) ||
      (await hasManagedAcpBinary(context, "cursor")) ||
      (await hasManagedAcpBinary(context, "grok")) ||
      (await hasPackagedOrPathBinary(context, "pi")),
  );
  register("get_available_ai_cli", async (_args, context) =>
    (await hasPackagedOrPathBinary(context, "claude"))
      ? "claude"
      : (await hasPackagedOrPathBinary(context, "opencode"))
        ? "opencode"
        : (await hasPackagedOrPathBinary(context, "codex"))
          ? "codex"
          : (await hasManagedAcpBinary(context, "cursor"))
            ? "cursor"
            : (await hasManagedAcpBinary(context, "grok"))
              ? "grok"
              : (await hasPackagedOrPathBinary(context, "pi"))
                ? "pi"
                : null,
  );
}
