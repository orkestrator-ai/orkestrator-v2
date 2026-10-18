import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { CODEX_MODELS, type CodexModel } from "@/lib/codex-models";
import type { ClaudeModel } from "@/lib/claude-types";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
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
    useAgentModelCatalogStore.setState({
      claudeModels: [],
      codexModels: CODEX_MODELS,
      cursorModels: [],
      grokModels: [],
      piModels: [],
    });
    invokeMock.mockReset();
  });

  test("asks the backend to download missing catalogues only when seeding", async () => {
    invokeMock.mockResolvedValue({ schemaVersion: 1 });
    await hydrateAgentModelCatalogCache({ seed: true });
    expect(invokeMock).toHaveBeenCalledWith("get_agent_model_catalog_cache", { seed: true });
  });

  test("hydrates every shared model store from the persisted backend cache", async () => {
    const claudeModels: ClaudeModel[] = [
      {
        id: "claude-cached",
        name: "Claude Cached",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ];
    const codexModels: CodexModel[] = [
      {
        id: "gpt-cached",
        name: "GPT Cached",
        reasoningEfforts: ["medium", "xhigh"],
        defaultReasoningEffort: "medium",
      },
    ];
    const cursorModels = [
      {
        platform: "cursor" as const,
        id: "cursor-cached",
        label: "Cursor Cached",
        reasoning: [{ id: "high", label: "High" }],
      },
    ];
    const grokModels = [
      {
        platform: "grok" as const,
        id: "grok-cached",
        label: "Grok Cached",
      },
    ];
    const piModels = [
      {
        platform: "pi" as const,
        id: "anthropic/claude-pi",
        label: "Claude Pi",
        reasoning: [{ id: "high", label: "High" }],
      },
    ];
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      claude: { updatedAt: "2026-07-30T10:00:00.000Z", models: claudeModels },
      codex: { updatedAt: "2026-07-30T10:00:00.000Z", models: codexModels },
      cursor: { updatedAt: "2026-07-30T10:00:00.000Z", models: cursorModels },
      grok: { updatedAt: "2026-07-30T10:00:00.000Z", models: grokModels },
      pi: { updatedAt: "2026-07-30T10:00:00.000Z", models: piModels },
    });

    await hydrateAgentModelCatalogCache();

    expect(invokeMock).toHaveBeenCalledWith("get_agent_model_catalog_cache");
    expect(useAgentModelCatalogStore.getState().claudeModels).toEqual(claudeModels);
    expect(useAgentModelCatalogStore.getState().codexModels).toEqual(codexModels);
    expect(useAgentModelCatalogStore.getState().cursorModels).toEqual(cursorModels);
    expect(useAgentModelCatalogStore.getState().grokModels).toEqual(grokModels);
    expect(useAgentModelCatalogStore.getState().piModels).toEqual(piModels);
  });

  test("leaves fallback stores intact when a catalogue is absent", async () => {
    invokeMock.mockResolvedValue({ schemaVersion: 1 });

    await hydrateAgentModelCatalogCache();

    expect(useAgentModelCatalogStore.getState().claudeModels).toEqual([]);
    expect(useAgentModelCatalogStore.getState().codexModels).toEqual(CODEX_MODELS);
    expect(useAgentModelCatalogStore.getState().cursorModels).toEqual([]);
    expect(useAgentModelCatalogStore.getState().grokModels).toEqual([]);
    expect(useAgentModelCatalogStore.getState().piModels).toEqual([]);
  });

  test("hydrates an available agent without disturbing the absent agent", async () => {
    const claudeModels: ClaudeModel[] = [
      {
        id: "claude-only",
        name: "Claude Only",
      },
    ];
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      claude: {
        updatedAt: "2026-07-30T10:00:00.000Z",
        models: claudeModels,
      },
    });

    await hydrateAgentModelCatalogCache();

    expect(useAgentModelCatalogStore.getState().claudeModels).toEqual(claudeModels);
    expect(useAgentModelCatalogStore.getState().codexModels).toEqual(CODEX_MODELS);
  });

  test("treats explicit empty catalogues as missing cached data", async () => {
    const existingClaude: ClaudeModel[] = [
      {
        id: "claude-existing",
        name: "Claude Existing",
      },
    ];
    const existingCodex: CodexModel[] = [
      {
        id: "gpt-existing",
        name: "GPT Existing",
      },
    ];
    useAgentModelCatalogStore.setState({
      claudeModels: existingClaude,
      codexModels: existingCodex,
    });
    invokeMock.mockResolvedValue({
      schemaVersion: 1,
      claude: {
        updatedAt: "2026-07-30T10:00:00.000Z",
        models: [],
      },
      codex: {
        updatedAt: "2026-07-30T10:00:00.000Z",
        models: [],
      },
    });

    await hydrateAgentModelCatalogCache();

    expect(useAgentModelCatalogStore.getState().claudeModels).toBe(existingClaude);
    expect(useAgentModelCatalogStore.getState().codexModels).toBe(existingCodex);
  });

  test("propagates a backend read failure without changing either store", async () => {
    const existingClaude = useAgentModelCatalogStore.getState().claudeModels;
    const existingCodex = useAgentModelCatalogStore.getState().codexModels;
    invokeMock.mockRejectedValue(new Error("cache unavailable"));

    await expect(hydrateAgentModelCatalogCache()).rejects.toThrow("cache unavailable");

    expect(useAgentModelCatalogStore.getState().claudeModels).toBe(existingClaude);
    expect(useAgentModelCatalogStore.getState().codexModels).toBe(existingCodex);
  });

  test("does not let a late backend read overwrite newer live catalogues", async () => {
    const cacheRead = deferred<{
      schemaVersion: 1;
      claude: { updatedAt: string; models: ClaudeModel[] };
      codex: { updatedAt: string; models: CodexModel[] };
      cursor: {
        updatedAt: string;
        models: Array<{ platform: "cursor"; id: string; label: string }>;
      };
    }>();
    invokeMock.mockImplementation(() => cacheRead.promise);
    const hydration = hydrateAgentModelCatalogCache();

    const liveClaude = [{ id: "claude-live", name: "Claude Live" }];
    const liveCodex = [{ id: "gpt-live", name: "GPT Live" }];
    const liveCursor = [{ platform: "cursor" as const, id: "cursor-live", label: "Cursor Live" }];
    useAgentModelCatalogStore.getState().setClaudeModels(liveClaude);
    useAgentModelCatalogStore.getState().setCodexModels(liveCodex);
    useAgentModelCatalogStore.getState().setAcpModels(liveCursor);
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
      cursor: {
        updatedAt: "2026-07-29T10:00:00.000Z",
        models: [{ platform: "cursor", id: "cursor-stale", label: "Cursor Stale" }],
      },
    });

    await hydration;

    expect(useAgentModelCatalogStore.getState().claudeModels).toEqual(liveClaude);
    expect(useAgentModelCatalogStore.getState().codexModels).toEqual(liveCodex);
    expect(useAgentModelCatalogStore.getState().cursorModels).toEqual(liveCursor);
  });
});
