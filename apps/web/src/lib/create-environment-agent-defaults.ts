import {
  defaultEffortFor,
  firstModelFor,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import type { AgentStyle, ClaudeMode, CodexMode, OpenCodeMode } from "@/types";
import { firstEnabledAgentPlatform } from "@orkestrator/protocol/agent-platforms";

interface ConfiguredCreateEnvironmentAgentDefaults {
  agent: LaunchAgent;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  cursorMode: AgentStyle;
  grokMode: AgentStyle;
  piMode: AgentStyle;
  models: Partial<Record<LaunchAgent, string>>;
  reasoningEfforts: Partial<Record<LaunchAgent, string>>;
}

export interface CreateEnvironmentAgentDefaults {
  agent: LaunchAgent;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  cursorMode: AgentStyle;
  grokMode: AgentStyle;
  piMode: AgentStyle;
  model: string;
  reasoningEffort: string;
}

/**
 * Resolve the initial agent controls from the configured settings tiers.
 * Agent, mode, model, and reasoning all come from Settings; a one-off choice in
 * an earlier create dialog must not become an implicit default for later ones.
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
}): CreateEnvironmentAgentDefaults {
  const { catalog, configured } = options;
  const agent = firstEnabledAgentPlatform(options.enabledAgents, configured.agent);
  const model = firstModelFor(agent, catalog, configured.models);
  const reasoningEffort = defaultEffortFor(agent, model, catalog, configured.reasoningEfforts);

  return {
    agent,
    claudeMode: configured.claudeMode,
    opencodeMode: configured.opencodeMode,
    codexMode: configured.codexMode,
    cursorMode: configured.cursorMode,
    grokMode: configured.grokMode,
    piMode: configured.piMode,
    model,
    reasoningEffort,
  };
}
