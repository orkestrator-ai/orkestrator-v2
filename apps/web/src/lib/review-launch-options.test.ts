import { afterEach, describe, expect, test } from "bun:test";
import {
  buildReviewModelCatalog,
  includeMissingOpenCodeModels,
  resolveDefaultReviewTabType,
} from "./review-launch-options";
import { useConfigStore } from "@/stores/configStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { firstModelFor } from "@/lib/agent-launch";

const originalClaudeModels = useAgentModelCatalogStore.getState().claudeModels;
const originalCodexModels = useAgentModelCatalogStore.getState().codexModels;

afterEach(() => {
  useAgentModelCatalogStore.setState({
    claudeModels: originalClaudeModels,
    codexModels: originalCodexModels,
    cursorModels: [],
    grokModels: [],
    piModels: [],
  });
});

describe("buildReviewModelCatalog", () => {
  test("maps live models and effort metadata, with the unpinned OpenCode placeholder", () => {
    useAgentModelCatalogStore.setState({
      claudeModels: [
        {
          id: "claude-live",
          name: "Claude Live",
          description: "Live Claude model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "xhigh"],
        } as any,
      ],
    });
    useAgentModelCatalogStore.setState({
      codexModels: [
        {
          id: "codex-live",
          name: "Codex Live",
          description: "Live Codex model",
          reasoningEfforts: ["medium", "high"],
        } as any,
      ],
    });

    expect(buildReviewModelCatalog()).toEqual({
      claude: [
        {
          id: "claude-live",
          name: "Claude Live",
          description: "Live Claude model",
          reasoningEfforts: ["low", "xhigh"],
          supportsSpeed: true,
        },
      ],
      codex: [
        {
          id: "codex-live",
          name: "Codex Live",
          description: "Live Codex model",
          reasoningEfforts: ["medium", "high"],
          supportsSpeed: true,
        },
      ],
      cursor: [{ id: "default", name: "Cursor automatic", reasoningEfforts: [] }],
      grok: [{ id: "default", name: "Grok Build default", reasoningEfforts: [] }],
      pi: [{ id: "default", name: "Pi default", reasoningEfforts: [] }],
      // Concrete OpenCode models come from the durable project cache, which
      // project-aware launchers overlay on this placeholder.
      opencode: [{ id: "default", name: "Default", reasoningEfforts: [] }],
    });
  });

  test("derives Claude effort choices from live capability metadata", () => {
    useAgentModelCatalogStore.setState({
      claudeModels: [
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

    expect(buildReviewModelCatalog().claude).toEqual([
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

  test("defaults omitted Claude speed capability to supported and honours explicit false", () => {
    useAgentModelCatalogStore.setState({
      claudeModels: [
        { id: "default-allow", name: "Default allow" },
        { id: "explicit-deny", name: "Explicit deny", supportsFastMode: false },
      ] as any,
    });

    const [defaultAllow, explicitDeny] = buildReviewModelCatalog().claude;
    expect(defaultAllow?.supportsSpeed).toBe(true);
    expect(explicitDeny?.supportsSpeed).toBeUndefined();
  });

  test("uses the shared backend-hydrated Cursor, Grok, and Pi catalogues", () => {
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
        supportsSpeed: true,
      },
      {
        platform: "grok",
        id: "grok-4.6",
        label: "Grok 4.6",
        reasoning: [{ id: "xhigh", label: "Extra high" }],
      },
      {
        platform: "pi",
        id: "anthropic/claude-pi",
        label: "Claude Pi",
        description: "Pi model",
        reasoning: [{ id: "high", label: "High" }],
      },
    ]);

    const catalog = buildReviewModelCatalog();
    expect(catalog.cursor).toEqual([
      {
        id: "composer-2.5",
        name: "Composer 2.5",
        description: "Cursor model",
        reasoningEfforts: ["high"],
        supportsSpeed: true,
      },
    ]);
    expect(catalog.grok).toEqual([
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        description: undefined,
        reasoningEfforts: ["xhigh"],
      },
    ]);
    // No Pi row is marked as where a session starts, so Pi's own default leads.
    expect(catalog.pi).toEqual([
      { id: "default", name: "Pi default", reasoningEfforts: [] },
      {
        id: "anthropic/claude-pi",
        name: "Claude Pi",
        description: "Pi model",
        reasoningEfforts: ["high"],
      },
    ]);
  });

  test("offers Pi's own default when no connected row is marked, and opens on it", () => {
    useAgentModelCatalogStore.getState().setAcpModels([
      { platform: "pi", id: "openai/gpt-4", label: "GPT-4" },
      {
        platform: "pi",
        id: "openai/gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        sessionDefault: true,
        connected: false,
      },
    ]);

    const catalog = buildReviewModelCatalog();
    expect(catalog.pi?.map((model) => model.id)).toEqual([
      "default",
      "openai/gpt-4",
      "openai/gpt-6.1-sol",
    ]);
    expect(catalog.pi?.[2]?.connected).toBe(false);
    // The shared launch resolver leaves the model to Pi, as the backend does.
    expect(firstModelFor("pi", catalog)).toBe("default");
  });

  test("carries Pi's session-default mark so the Multi Review button picks it (0172)", () => {
    useAgentModelCatalogStore.getState().setAcpModels([
      { platform: "pi", id: "openai/gpt-4", label: "GPT-4" },
      { platform: "pi", id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", sessionDefault: true },
    ]);

    const catalog = buildReviewModelCatalog();
    expect(catalog.pi?.map((model) => model.sessionDefault ?? false)).toEqual([false, true]);
    expect(firstModelFor("pi", catalog)).toBe("openai/gpt-6.1-sol");
  });

  test("propagates the resolved Claude model used to match configured defaults", () => {
    useAgentModelCatalogStore.setState({
      claudeModels: [
        {
          id: "sonnet",
          name: "Sonnet",
          supportsEffort: true,
          resolvedModel: "claude-sonnet-resolved",
        } as any,
      ],
    });

    expect(buildReviewModelCatalog().claude).toEqual([
      expect.objectContaining({
        id: "sonnet",
        resolvedModel: "claude-sonnet-resolved",
      }),
    ]);
  });

  test("falls back to supported Codex efforts when live metadata omits them", () => {
    useAgentModelCatalogStore.setState({
      codexModels: [
        {
          id: "codex-without-efforts",
          name: "Codex without efforts",
        } as any,
      ],
    });

    expect(buildReviewModelCatalog().codex).toEqual([
      expect.objectContaining({
        id: "codex-without-efforts",
        reasoningEfforts: ["medium", "high"],
      }),
    ]);
  });

  test("uses safe fallbacks and does not expose stale configured models", () => {
    useAgentModelCatalogStore.setState({ claudeModels: [] });

    const catalog = buildReviewModelCatalog();

    expect(catalog.claude.length).toBeGreaterThan(0);
    expect(catalog.claude).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opus[1m]",
          name: "Opus (1M context)",
          description: expect.stringContaining("Opus 5"),
        }),
      ]),
    );
    expect(catalog.codex.length).toBeGreaterThan(0);
    expect(catalog.opencode).toEqual([
      {
        id: "default",
        name: "Default",
        reasoningEfforts: [],
      },
    ]);
    expect(
      Object.values(catalog)
        .flat()
        .map((model) => model.id),
    ).not.toContain("removed-provider/model");
  });
});

describe("resolveDefaultReviewTabType", () => {
  const global = useConfigStore.getState().config.global;

  test("forces every Claude review into the SDK-native mode", () => {
    expect(
      resolveDefaultReviewTabType({
        defaultAgent: "claude",
        environment: {
          agentSettings: { platforms: { claude: { mode: "native", claudeNativeBackend: "sdk" } } },
        },
        global,
      }),
    ).toBe("claude");

    expect(
      resolveDefaultReviewTabType({
        defaultAgent: "claude",
        environment: {
          agentSettings: { platforms: { claude: { mode: "native", claudeNativeBackend: "tmux" } } },
        },
        global,
      }),
    ).toBe("claude");

    expect(
      resolveDefaultReviewTabType({
        defaultAgent: "claude",
        environment: { agentSettings: { platforms: { claude: { mode: "terminal" } } } },
        global,
      }),
    ).toBe("claude");
  });

  test("forces Codex and OpenCode reviews into native mode", () => {
    expect(
      resolveDefaultReviewTabType({
        defaultAgent: "codex",
        environment: { agentSettings: { platforms: { codex: { mode: "native" } } } },
        global,
      }),
    ).toBe("codex");
    expect(
      resolveDefaultReviewTabType({
        defaultAgent: "opencode",
        environment: { agentSettings: { platforms: { opencode: { mode: "terminal" } } } },
        global,
      }),
    ).toBe("opencode");
  });
});

describe("includeMissingOpenCodeModels", () => {
  test("replaces the Default placeholder with favourited provider models", () => {
    expect(
      includeMissingOpenCodeModels(
        [{ id: "default", name: "Default", reasoningEfforts: [] }],
        ["opencode-go/deepseek-v4-flash", "opencode/claude-sonnet-5"],
        ["opencode", "opencode-go"],
      ),
    ).toEqual([
      {
        id: "opencode-go/deepseek-v4-flash",
        name: "deepseek-v4-flash",
        providerLabel: "opencode-go",
        description: "opencode-go",
        reasoningEfforts: [],
      },
      {
        id: "opencode/claude-sonnet-5",
        name: "claude-sonnet-5",
        providerLabel: "opencode",
        description: "opencode",
        reasoningEfforts: [],
      },
    ]);
  });

  test("does not add a provider the allowlist excludes", () => {
    expect(
      includeMissingOpenCodeModels(
        [{ id: "opencode/a", name: "A", description: "opencode", reasoningEfforts: [] }],
        ["openrouter/kimi"],
        ["opencode", "opencode-go"],
      ),
    ).toEqual([{ id: "opencode/a", name: "A", description: "opencode", reasoningEfforts: [] }]);
  });
});
