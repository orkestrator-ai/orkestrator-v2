import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { CODEX_MODELS, type CodexModel } from "@/lib/codex-client";
import type { ClaudeModel } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { hydrateAgentModelCatalogCache } from "./agent-model-catalog-cache";

const invokeMock = invoke as ReturnType<typeof mock>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("hydrateAgentModelCatalogCache", () => {
  beforeEach(() => {
    useClaudeStore.setState({ models: [] });
    useCodexStore.setState({ models: CODEX_MODELS });
    invokeMock.mockReset();
  });

  test("hydrates both model stores from the persisted host cache", async () => {
    const claudeModels: ClaudeModel[] = [{
      id: "claude-cached",
      name: "Claude Cached",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    }];
    const codexModels: CodexModel[] = [{
      id: "gpt-cached",
      name: "GPT Cached",
      reasoningEfforts: ["medium", "xhigh"],
      defaultReasoningEffort: "medium",
    }];
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      claude: { updatedAt: "2026-07-30T10:00:00.000Z", models: claudeModels },
      codex: { updatedAt: "2026-07-30T10:00:00.000Z", models: codexModels },
    });

    await hydrateAgentModelCatalogCache();

    expect(invokeMock).toHaveBeenCalledWith("get_agent_model_catalog_cache");
    expect(useClaudeStore.getState().models).toEqual(claudeModels);
    expect(useCodexStore.getState().models).toEqual(codexModels);
  });

  test("leaves fallback stores intact when a catalogue is absent", async () => {
    invokeMock.mockResolvedValue({ schemaVersion: 1 });

    await hydrateAgentModelCatalogCache();

    expect(useClaudeStore.getState().models).toEqual([]);
    expect(useCodexStore.getState().models).toEqual(CODEX_MODELS);
  });

  test("does not let a late disk read overwrite newer live catalogues", async () => {
    const cacheRead = deferred<{
      schemaVersion: 1;
      claude: { updatedAt: string; models: ClaudeModel[] };
      codex: { updatedAt: string; models: CodexModel[] };
    }>();
    invokeMock.mockImplementation(() => cacheRead.promise);
    const hydration = hydrateAgentModelCatalogCache();

    const liveClaude = [{ id: "claude-live", name: "Claude Live" }];
    const liveCodex = [{ id: "gpt-live", name: "GPT Live" }];
    useClaudeStore.getState().setModels(liveClaude);
    useCodexStore.getState().setModels(liveCodex);
    cacheRead.resolve({
      schemaVersion: 1,
      claude: {
        updatedAt: "2026-07-29T10:00:00.000Z",
        models: [{ id: "claude-stale", name: "Claude Stale" }],
      },
      codex: {
        updatedAt: "2026-07-29T10:00:00.000Z",
        models: [{ id: "gpt-stale", name: "GPT Stale" }],
      },
    });

    await hydration;

    expect(useClaudeStore.getState().models).toEqual(liveClaude);
    expect(useCodexStore.getState().models).toEqual(liveCodex);
  });
});
