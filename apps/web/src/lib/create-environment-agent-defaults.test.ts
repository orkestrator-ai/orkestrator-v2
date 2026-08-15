import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { buildReviewModelCatalog } from "@/lib/review-launch-options";
import { useClaudeStore } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { resolveCreateEnvironmentAgentDefaults } from "./create-environment-agent-defaults";

const catalog: AgentModelCatalog = {
  claude: [
    { id: "sonnet", name: "Sonnet", reasoningEfforts: ["low", "high"] },
  ],
  codex: [
    { id: "gpt-default", name: "Default Codex", reasoningEfforts: ["medium"] },
    { id: "gpt-remembered", name: "Remembered Codex", reasoningEfforts: ["high", "xhigh"] },
  ],
  opencode: [
    { id: "open/default", name: "Open default", reasoningEfforts: [] },
  ],
};

const configured = {
  agent: "claude" as const,
  claudeMode: "terminal" as const,
  opencodeMode: "terminal" as const,
  codexMode: "native" as const,
  models: { claude: "sonnet", codex: "gpt-default" },
  reasoningEfforts: { codex: "medium" },
};

describe("resolveCreateEnvironmentAgentDefaults", () => {
  test("restores the last platform, mode, model, and reasoning selection", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog,
      enabledAgents: ["claude", "codex", "opencode"],
      configured,
      remembered: {
        platform: "codex",
        mode: "terminal",
        model: "gpt-remembered",
        reasoningEffort: "xhigh",
      },
    })).toEqual({
      agent: "codex",
      claudeMode: "terminal",
      opencodeMode: "terminal",
      codexMode: "terminal",
      model: "gpt-remembered",
      reasoningEffort: "xhigh",
    });
  });

  test("falls back to configured defaults when the remembered platform is disabled", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog,
      enabledAgents: ["claude", "opencode"],
      configured,
      remembered: {
        platform: "codex",
        mode: "terminal",
        model: "gpt-remembered",
        reasoningEffort: "xhigh",
      },
    })).toMatchObject({
      agent: "claude",
      claudeMode: "terminal",
      model: "sonnet",
      reasoningEffort: "default",
    });
  });

  // Regression: the disabled-platform fallback used to delegate straight to
  // `firstEnabledAgentPlatform(enabled, remembered.platform)`, which returns
  // `enabled[0]` for a platform that is not enabled. That silently discarded the
  // configured default agent. The case above cannot catch it because its
  // configured agent is also `enabledAgents[0]`, so pick a repository whose
  // default disagrees with the enabled ordering.
  test("prefers the configured default agent over the first enabled one when the remembered platform is disabled", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog,
      enabledAgents: ["claude", "codex"],
      configured: { ...configured, agent: "codex" },
      remembered: {
        platform: "opencode",
        mode: "native",
        model: "open/default",
      },
    })).toMatchObject({
      agent: "codex",
      codexMode: "native",
      model: "gpt-default",
      reasoningEffort: "medium",
    });
  });

  test("resolves a configured Claude model from its concrete id to the catalog alias", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog: {
        ...catalog,
        claude: [
          {
            id: "default",
            name: "Default",
            reasoningEfforts: [],
            resolvedModel: "claude-opus",
          },
          {
            id: "sonnet",
            name: "Sonnet",
            reasoningEfforts: ["high"],
            resolvedModel: "claude-sonnet",
          },
        ],
      },
      enabledAgents: ["claude"],
      configured: {
        ...configured,
        models: { claude: "claude-sonnet" },
      },
    })).toMatchObject({
      agent: "claude",
      model: "sonnet",
    });
  });

  test("uses safe current-catalog fallbacks for retired model controls", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog,
      enabledAgents: ["codex"],
      configured: { ...configured, agent: "codex" },
      remembered: {
        platform: "codex",
        mode: "native",
        model: "retired-model",
        reasoningEffort: "ultra",
      },
    })).toMatchObject({
      agent: "codex",
      model: "gpt-default",
      reasoningEffort: "default",
    });
  });

  test("preserves an explicit provider-default selection", () => {
    expect(resolveCreateEnvironmentAgentDefaults({
      catalog: {
        ...catalog,
        opencode: [
          { id: "default", name: "Provider default", reasoningEfforts: [] },
          ...catalog.opencode,
        ],
      },
      enabledAgents: ["opencode"],
      configured: {
        ...configured,
        agent: "opencode",
        models: { opencode: "open/default" },
      },
      remembered: {
        platform: "opencode",
        mode: "native",
      },
    })).toMatchObject({
      agent: "opencode",
      opencodeMode: "native",
      model: "default",
      reasoningEffort: "default",
    });
  });

  /**
   * Pins the shipped default. `global.claudeModel` defaults to `claude-sonnet-5`
   * and the fallback catalog lists that model under the id `sonnet`, so the
   * create dialog must preselect `sonnet` — the same answer the review, multi-
   * review and build launchers already give for the same preference. It must not
   * fall back to the catalog's first entry (`default`, which resolves to Opus).
   */
  test("honours the shipped global Claude preference exactly as the other launchers do", () => {
    useClaudeStore.setState({ models: [] });
    const shippedClaudeModel =
      useConfigStore.getInitialState().config.global.claudeModel;
    expect(shippedClaudeModel).toBe("claude-sonnet-5");

    const shippedCatalog = buildReviewModelCatalog(undefined);
    expect(shippedCatalog.claude[0]?.id).toBe("default");

    expect(resolveCreateEnvironmentAgentDefaults({
      catalog: shippedCatalog,
      enabledAgents: ["claude", "codex", "opencode"],
      configured: {
        ...configured,
        agent: "claude",
        models: { claude: shippedClaudeModel },
        reasoningEfforts: {},
      },
    })).toMatchObject({
      agent: "claude",
      model: "sonnet",
    });
  });
});
