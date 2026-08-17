import { afterEach, describe, expect, test } from "bun:test";
import {
  buildReviewModelCatalog,
  includeMissingOpenCodeModels,
  resolveDefaultReviewTabType,
} from "./review-launch-options";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

const originalClaudeModels = useClaudeStore.getState().models;
const originalCodexModels = useCodexStore.getState().models;
const originalOpenCodeModels = useOpenCodeStore.getState().models;

afterEach(() => {
  useClaudeStore.setState({ models: originalClaudeModels });
  useCodexStore.setState({ models: originalCodexModels });
  useOpenCodeStore.setState({ models: originalOpenCodeModels });
  useAgentModelCatalogStore.setState({ cursorModels: [], grokModels: [] });
});

describe("buildReviewModelCatalog", () => {
  test("maps live models, variants, and effort metadata for every agent", () => {
    useClaudeStore.setState({
      models: [{
        id: "claude-live",
        name: "Claude Live",
        description: "Live Claude model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh"],
      } as any],
    });
    useCodexStore.setState({
      models: [{
        id: "codex-live",
        name: "Codex Live",
        description: "Live Codex model",
        reasoningEfforts: ["medium", "high"],
      } as any],
    });
    useOpenCodeStore.getState().setModels("env-live", [{
      id: "provider/model-live",
      name: "OpenCode Live",
      provider: "Provider",
      variants: ["fast", "deep"],
    } as any]);

    expect(buildReviewModelCatalog("env-live")).toEqual({
      claude: [{
        id: "claude-live",
        name: "Claude Live",
        description: "Live Claude model",
        reasoningEfforts: ["low", "xhigh"],
      }],
      codex: [{
        id: "codex-live",
        name: "Codex Live",
        description: "Live Codex model",
        reasoningEfforts: ["medium", "high"],
      }],
      cursor: [{ id: "default", name: "Cursor automatic", reasoningEfforts: [] }],
      grok: [{ id: "default", name: "Grok Build default", reasoningEfforts: [] }],
      opencode: [{
        id: "provider/model-live",
        name: "OpenCode Live",
        description: "Provider",
        reasoningEfforts: ["fast", "deep"],
      }],
    });
  });

  test("derives Claude effort choices from live capability metadata", () => {
    useClaudeStore.setState({
      models: [
        {
          id: "supports-effort-without-levels",
          name: "Supports effort without levels",
          supportsEffort: true,
        },
        {
          id: "supports-effort-with-empty-levels",
          name: "Supports effort with empty levels",
          supportsEffort: true,
          supportedEffortLevels: [],
        },
        {
          id: "no-effort-without-levels",
          name: "No effort without levels",
          supportsEffort: false,
        },
        {
          id: "no-effort-with-empty-levels",
          name: "No effort with empty levels",
          supportsEffort: false,
          supportedEffortLevels: [],
        },
      ] as any,
    });

    expect(buildReviewModelCatalog(undefined).claude).toEqual([
      expect.objectContaining({
        id: "supports-effort-without-levels",
        reasoningEfforts: ["low", "medium", "high"],
      }),
      expect.objectContaining({
        id: "supports-effort-with-empty-levels",
        reasoningEfforts: ["low", "medium", "high"],
      }),
      expect.objectContaining({
        id: "no-effort-without-levels",
        reasoningEfforts: [],
      }),
      expect.objectContaining({
        id: "no-effort-with-empty-levels",
        reasoningEfforts: [],
      }),
    ]);
  });

  test("uses the shared backend-hydrated Cursor and Grok catalogues", () => {
    useAgentModelCatalogStore.getState().setAcpModels([
      {
        platform: "cursor",
        id: "composer-2.5",
        label: "Composer 2.5",
        description: "Cursor model",
        reasoning: [
          { id: "default", label: "Default" },
          { id: "high", label: "High" },
          { id: "high", label: "High duplicate" },
        ],
      },
      {
        platform: "grok",
        id: "grok-4.6",
        label: "Grok 4.6",
        reasoning: [{ id: "xhigh", label: "Extra high" }],
      },
    ]);

    const catalog = buildReviewModelCatalog(null);
    expect(catalog.cursor).toEqual([{
      id: "composer-2.5",
      name: "Composer 2.5",
      description: "Cursor model",
      reasoningEfforts: ["high"],
    }]);
    expect(catalog.grok).toEqual([{
      id: "grok-4.6",
      name: "Grok 4.6",
      description: undefined,
      reasoningEfforts: ["xhigh"],
    }]);
  });

  test("propagates the resolved Claude model used to match configured defaults", () => {
    useClaudeStore.setState({
      models: [{
        id: "sonnet",
        name: "Sonnet",
        supportsEffort: true,
        resolvedModel: "claude-sonnet-resolved",
      } as any],
    });

    expect(buildReviewModelCatalog(undefined).claude).toEqual([
      expect.objectContaining({
        id: "sonnet",
        resolvedModel: "claude-sonnet-resolved",
      }),
    ]);
  });

  test("falls back to supported Codex efforts when live metadata omits them", () => {
    useCodexStore.setState({
      models: [{
        id: "codex-without-efforts",
        name: "Codex without efforts",
      } as any],
    });

    expect(buildReviewModelCatalog(undefined).codex).toEqual([
      expect.objectContaining({
        id: "codex-without-efforts",
        reasoningEfforts: ["medium", "high"],
      }),
    ]);
  });

  test("uses safe fallbacks and does not expose stale configured models", () => {
    useClaudeStore.setState({ models: [] });
    useOpenCodeStore.setState({ models: new Map() });

    const catalog = buildReviewModelCatalog(undefined);

    expect(catalog.claude.length).toBeGreaterThan(0);
    expect(catalog.claude).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "opus[1m]",
        name: "Opus (1M context)",
        description: expect.stringContaining("Opus 5"),
      }),
    ]));
    expect(catalog.codex.length).toBeGreaterThan(0);
    expect(catalog.opencode).toEqual([{
      id: "default",
      name: "Default",
      reasoningEfforts: [],
    }]);
    expect(Object.values(catalog).flat().map((model) => model.id)).not.toContain(
      "removed-provider/model",
    );
  });

  test("keeps the environment-scoped catalog isolated from other environments", () => {
    // Only the no-environment (create-dialog) call aggregates. A review launched
    // inside an environment must never be offered a model that environment's own
    // OpenCode server does not serve.
    useOpenCodeStore.setState({ models: new Map() });
    useOpenCodeStore.getState().setModels("env-a", [
      { id: "provider/only-a", name: "Only A", provider: "Provider A", variants: [] } as any,
    ]);
    useOpenCodeStore.getState().setModels("env-b", [
      { id: "provider/only-b", name: "Only B", provider: "Provider B", variants: [] } as any,
    ]);

    expect(buildReviewModelCatalog("env-a").opencode.map((model) => model.id))
      .toEqual(["provider/only-a"]);
    expect(buildReviewModelCatalog("env-b").opencode.map((model) => model.id))
      .toEqual(["provider/only-b"]);
    // An environment with no cached catalog still falls back to the placeholder
    // rather than borrowing a sibling's models.
    expect(buildReviewModelCatalog("env-unknown").opencode)
      .toEqual([{ id: "default", name: "Default", reasoningEfforts: [] }]);
  });

  test("can explicitly suppress OpenCode aggregation for project-scoped callers", () => {
    useOpenCodeStore.setState({ models: new Map() });
    useOpenCodeStore.getState().setModels("env-other-project", [{
      id: "provider/other-project",
      name: "Other Project",
      provider: "Provider",
      variants: [],
    } as any]);

    expect(buildReviewModelCatalog(null).opencode)
      .toEqual([{ id: "default", name: "Default", reasoningEfforts: [] }]);
  });

  test("falls back to the placeholder when every cached catalog is empty", () => {
    useOpenCodeStore.setState({ models: new Map() });
    useOpenCodeStore.getState().setModels("env-a", []);
    useOpenCodeStore.getState().setModels("env-b", []);

    expect(buildReviewModelCatalog(undefined).opencode)
      .toEqual([{ id: "default", name: "Default", reasoningEfforts: [] }]);
  });

  test("aggregates and deduplicates cached OpenCode catalogs before an environment exists", () => {
    useOpenCodeStore.setState({ models: new Map() });
    useOpenCodeStore.getState().setModels("env-a", [
      {
        id: "provider/shared",
        name: "Shared",
        provider: "Provider A",
        variants: ["fast"],
      } as any,
      {
        id: "provider/only-a",
        name: "Only A",
        provider: "Provider A",
        variants: [],
      } as any,
    ]);
    useOpenCodeStore.getState().setModels("env-b", [
      {
        id: "provider/shared",
        name: "Duplicate Shared",
        provider: "Provider B",
        variants: ["deep"],
      } as any,
      {
        id: "provider/only-b",
        name: "Only B",
        provider: "Provider B",
        variants: ["deep"],
      } as any,
    ]);

    expect(buildReviewModelCatalog(undefined).opencode).toEqual([
      {
        id: "provider/shared",
        name: "Shared",
        description: "Provider A",
        reasoningEfforts: ["fast"],
      },
      {
        id: "provider/only-a",
        name: "Only A",
        description: "Provider A",
        reasoningEfforts: [],
      },
      {
        id: "provider/only-b",
        name: "Only B",
        description: "Provider B",
        reasoningEfforts: ["deep"],
      },
    ]);
  });
});

describe("resolveDefaultReviewTabType", () => {
  const global = useConfigStore.getState().config.global;

  test("forces every Claude review into the SDK-native mode", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "sdk" },
      global,
    })).toBe("claude");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "tmux" },
      global,
    })).toBe("claude");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "terminal" },
      global,
    })).toBe("claude");
  });

  test("forces Codex and OpenCode reviews into native mode", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "codex",
      environment: { codexMode: "native" },
      global,
    })).toBe("codex");
    expect(resolveDefaultReviewTabType({
      defaultAgent: "opencode",
      environment: { opencodeMode: "terminal" },
      global,
    })).toBe("opencode");
  });
});

describe("includeMissingOpenCodeModels", () => {
  test("replaces the Default placeholder with favourited provider models", () => {
    expect(includeMissingOpenCodeModels(
      [{ id: "default", name: "Default", reasoningEfforts: [] }],
      ["opencode-go/deepseek-v4-flash", "opencode/claude-sonnet-5"],
      ["opencode", "opencode-go"],
    )).toEqual([
      {
        id: "opencode-go/deepseek-v4-flash",
        name: "deepseek-v4-flash",
        description: "opencode-go",
        reasoningEfforts: [],
      },
      {
        id: "opencode/claude-sonnet-5",
        name: "claude-sonnet-5",
        description: "opencode",
        reasoningEfforts: [],
      },
    ]);
  });

  test("does not add a provider the allowlist excludes", () => {
    expect(includeMissingOpenCodeModels(
      [{ id: "opencode/a", name: "A", description: "opencode", reasoningEfforts: [] }],
      ["openrouter/kimi"],
      ["opencode", "opencode-go"],
    )).toEqual([
      { id: "opencode/a", name: "A", description: "opencode", reasoningEfforts: [] },
    ]);
  });
});
