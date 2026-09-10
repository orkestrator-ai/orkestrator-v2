import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { buildReviewModelCatalog } from "@/lib/review-launch-options";
import { useClaudeStore } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { resolveCreateEnvironmentAgentDefaults } from "./create-environment-agent-defaults";

const catalog: AgentModelCatalog = {
  claude: [{ id: "sonnet", name: "Sonnet", reasoningEfforts: ["low", "high"] }],
  codex: [{ id: "gpt-default", name: "Default Codex", reasoningEfforts: ["medium"] }],
  opencode: [{ id: "open/default", name: "Open default", reasoningEfforts: [] }],
};

const configured = {
  agent: "claude" as const,
  claudeMode: "terminal" as const,
  opencodeMode: "terminal" as const,
  codexMode: "native" as const,
  grokMode: "native" as const,
  piMode: "terminal" as const,
  models: { claude: "sonnet", codex: "gpt-default" },
  reasoningEfforts: { codex: "medium" },
};

const speedCatalog: AgentModelCatalog = {
  claude: [
    { id: "sonnet", name: "Sonnet", reasoningEfforts: ["low", "high"], supportsSpeed: true },
    { id: "slow-only", name: "Slow only", reasoningEfforts: [] },
  ],
  codex: [{ id: "gpt-default", name: "Default Codex", reasoningEfforts: ["medium"] }],
  opencode: [{ id: "open/default", name: "Open default", reasoningEfforts: [] }],
};

describe("resolveCreateEnvironmentAgentDefaults speed", () => {
  test("carries the configured Fast choice for the chosen platform", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: speedCatalog,
        enabledAgents: ["claude"],
        configured: { ...configured, fastModes: { claude: true } },
      }).fastMode,
    ).toBe(true);
  });

  test("keeps an explicit Normal rather than dropping it", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: speedCatalog,
        enabledAgents: ["claude"],
        configured: { ...configured, fastModes: { claude: false } },
      }).fastMode,
    ).toBe(false);
  });

  test("omits speed entirely when nothing configures it", () => {
    // Absence is what lets the provider keep its own default, so the key must
    // not be present at all rather than present and undefined.
    const defaults = resolveCreateEnvironmentAgentDefaults({
      catalog: speedCatalog,
      enabledAgents: ["claude"],
      configured,
    });

    expect(defaults).not.toHaveProperty("fastMode");
  });

  test("omits speed when the resolved model has no speed axis", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: speedCatalog,
        enabledAgents: ["claude"],
        configured: {
          ...configured,
          models: { claude: "slow-only" },
          fastModes: { claude: true },
        },
      }),
    ).not.toHaveProperty("fastMode");
  });

  test("omits speed when the chosen platform owns no speed surface", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: speedCatalog,
        enabledAgents: ["opencode"],
        configured: { ...configured, agent: "opencode", fastModes: { opencode: true } },
      }),
    ).not.toHaveProperty("fastMode");
  });

  test("reads the platform actually chosen, not the configured-but-disabled one", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: speedCatalog,
        enabledAgents: ["opencode"],
        configured: { ...configured, fastModes: { claude: true } },
      }),
    ).not.toHaveProperty("fastMode");
  });
});

describe("resolveCreateEnvironmentAgentDefaults", () => {
  test("takes agent, modes, model, and reasoning from configured settings", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog,
        enabledAgents: ["claude", "codex", "opencode"],
        configured,
      }),
    ).toEqual({
      agent: "claude",
      claudeMode: "terminal",
      opencodeMode: "terminal",
      codexMode: "native",
      grokMode: "native",
      piMode: "terminal",
      model: "sonnet",
      reasoningEffort: "default",
    });
  });

  test("prefers the configured default agent over the first enabled one", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog,
        enabledAgents: ["claude", "codex"],
        configured: { ...configured, agent: "codex" },
      }),
    ).toMatchObject({
      agent: "codex",
      codexMode: "native",
      model: "gpt-default",
      reasoningEffort: "medium",
    });
  });

  // The configured default agent is only a preference: `firstEnabledAgentPlatform`
  // hands back `enabled[0]` when that platform has since been disabled, and the
  // model and reasoning must then be resolved for the platform actually chosen
  // rather than left pointing at the disabled one's column.
  test("falls back to the first enabled platform when the configured agent is disabled", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog,
        enabledAgents: ["codex", "claude"],
        configured: { ...configured, agent: "opencode" },
      }),
    ).toMatchObject({
      agent: "codex",
      codexMode: "native",
      model: "gpt-default",
      reasoningEffort: "medium",
    });
  });

  test("resolves a configured Claude model from its concrete id to the catalog alias", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
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
      }),
    ).toMatchObject({
      agent: "claude",
      model: "sonnet",
    });
  });

  test("uses safe current-catalog fallbacks for a retired configured model", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog,
        enabledAgents: ["codex"],
        configured: {
          ...configured,
          agent: "codex",
          // Neither survives in the current catalogue.
          models: { codex: "retired-model" },
          reasoningEfforts: { codex: "ultra" },
        },
      }),
    ).toMatchObject({
      agent: "codex",
      model: "gpt-default",
      reasoningEffort: "default",
    });
  });

  test("preserves an explicit provider-default selection", () => {
    expect(
      resolveCreateEnvironmentAgentDefaults({
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
          // The literal provider-default id, which must survive rather than
          // being resolved to a concrete model.
          models: { opencode: "default" },
        },
      }),
    ).toMatchObject({
      agent: "opencode",
      opencodeMode: "terminal",
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
      useConfigStore.getInitialState().config.global.agentSettings?.platforms?.claude?.model;
    expect(shippedClaudeModel).toBe("claude-sonnet-5");

    const shippedCatalog = buildReviewModelCatalog(undefined);
    expect(shippedCatalog.claude[0]?.id).toBe("default");

    expect(
      resolveCreateEnvironmentAgentDefaults({
        catalog: shippedCatalog,
        enabledAgents: ["claude", "codex", "opencode"],
        configured: {
          ...configured,
          agent: "claude",
          models: { claude: shippedClaudeModel },
          reasoningEfforts: {},
        },
      }),
    ).toMatchObject({
      agent: "claude",
      model: "sonnet",
    });
  });
});
