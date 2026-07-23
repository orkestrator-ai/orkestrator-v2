import { afterEach, describe, expect, test } from "bun:test";
import { buildReviewModelCatalog, resolveDefaultReviewTabType } from "./review-launch-options";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";

const originalClaudeModels = useClaudeStore.getState().models;
const originalCodexModels = useCodexStore.getState().models;
const originalOpenCodeModels = useOpenCodeStore.getState().models;

afterEach(() => {
  useClaudeStore.setState({ models: originalClaudeModels });
  useCodexStore.setState({ models: originalCodexModels });
  useOpenCodeStore.setState({ models: originalOpenCodeModels });
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
      opencode: [{
        id: "provider/model-live",
        name: "OpenCode Live",
        description: "Provider",
        reasoningEfforts: ["fast", "deep"],
      }],
    });
  });

  test("uses safe fallbacks and does not expose stale configured models", () => {
    useClaudeStore.setState({ models: [] });
    useOpenCodeStore.setState({ models: new Map() });

    const catalog = buildReviewModelCatalog(undefined);

    expect(catalog.claude.length).toBeGreaterThan(0);
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
});

describe("resolveDefaultReviewTabType", () => {
  const global = useConfigStore.getState().config.global;

  test("resolves Claude SDK, tmux, and terminal defaults", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "sdk" },
      global,
    })).toBe("claude-native");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "tmux" },
      global,
    })).toBe("claude-tmux");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "terminal" },
      global,
    })).toBe("claude-cli");
  });

  test("resolves Codex and OpenCode modes", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "codex",
      environment: { codexMode: "native" },
      global,
    })).toBe("codex-native");
    expect(resolveDefaultReviewTabType({
      defaultAgent: "opencode",
      environment: { opencodeMode: "terminal" },
      global,
    })).toBe("opencode-cli");
  });
});
