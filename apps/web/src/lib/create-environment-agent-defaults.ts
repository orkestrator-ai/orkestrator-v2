import {
  defaultEffortFor,
  firstModelFor,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import type {
  AgentStyle,
  ClaudeMode,
  CodexMode,
  LastEnvironmentAgentSelection,
  OpenCodeMode,
} from "@/types";
import { firstEnabledAgentPlatform } from "@orkestrator/protocol/agent-platforms";

interface ConfiguredCreateEnvironmentAgentDefaults {
  agent: LaunchAgent;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  models: Partial<Record<LaunchAgent, string>>;
  reasoningEfforts: Partial<Record<LaunchAgent, string>>;
}

export interface CreateEnvironmentAgentDefaults {
  agent: LaunchAgent;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  model: string;
  reasoningEffort: string;
}

function withRememberedMode(
  configured: ConfiguredCreateEnvironmentAgentDefaults,
  remembered: LastEnvironmentAgentSelection | undefined,
): Pick<CreateEnvironmentAgentDefaults, "claudeMode" | "opencodeMode" | "codexMode"> {
  const modes = {
    claudeMode: configured.claudeMode,
    opencodeMode: configured.opencodeMode,
    codexMode: configured.codexMode,
  };
  if (!remembered) return modes;

  if (remembered.platform === "claude") modes.claudeMode = remembered.mode;
  if (remembered.platform === "opencode") modes.opencodeMode = remembered.mode;
  if (remembered.platform === "codex") modes.codexMode = remembered.mode;
  return modes;
}

/**
 * Resolve the initial agent controls independently from repository defaults.
 * A remembered selection covers the agent and its mode only, wins only for its
 * own platform, and only while that platform remains enabled. The model and
 * reasoning level always come from settings.
 *
 * Model resolution goes through `firstModelFor`, the same helper the review,
 * multi-review and build launchers use. That matters for Claude: configuration
 * stores `claude-sonnet-5` while the catalog lists that model under `sonnet`,
 * and only `firstModelFor` matches the two through `resolvedModel`. Matching on
 * the catalog id alone would silently ignore the configured Claude preference
 * and fall back to the catalog's first entry, which is what this dialog used to
 * do and what made it the one launcher that disagreed with the others.
 */
export function resolveCreateEnvironmentAgentDefaults(options: {
  catalog: AgentModelCatalog;
  enabledAgents: LaunchAgent[];
  configured: ConfiguredCreateEnvironmentAgentDefaults;
  remembered?: LastEnvironmentAgentSelection;
}): CreateEnvironmentAgentDefaults {
  const { catalog, configured, remembered } = options;
  // A remembered platform that has since been disabled must hand back to the
  // configured default agent, not to whichever platform happens to sort first.
  // `firstEnabledAgentPlatform` only takes one preference, so choose it here.
  const preferredPlatform =
    remembered && options.enabledAgents.includes(remembered.platform)
      ? remembered.platform
      : configured.agent;
  const agent = firstEnabledAgentPlatform(options.enabledAgents, preferredPlatform);
  const rememberedForAgent = remembered?.platform === agent ? remembered : undefined;
  // Model and reasoning come from settings only. They used to be remembered
  // from the last create, so a one-off choice in this dialog silently outranked
  // the configured default for every environment after it.
  const model = firstModelFor(agent, catalog, configured.models);
  const reasoningEffort = defaultEffortFor(agent, model, catalog, configured.reasoningEfforts);

  return {
    agent,
    ...withRememberedMode(configured, rememberedForAgent),
    model,
    reasoningEffort,
  };
}

export function selectedAgentMode(
  platform: LaunchAgent,
  modes: {
    claudeMode: ClaudeMode;
    opencodeMode: OpenCodeMode;
    codexMode: CodexMode;
  },
): AgentStyle {
  return platform === "claude"
    ? modes.claudeMode
    : platform === "opencode"
      ? modes.opencodeMode
      : platform === "codex"
        ? modes.codexMode
        : "native";
}
