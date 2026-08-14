import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "@/lib/agent-launch";
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
});
