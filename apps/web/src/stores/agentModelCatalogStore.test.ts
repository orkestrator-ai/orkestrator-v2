import { beforeEach, describe, expect, test } from "bun:test";
import { CODEX_MODELS } from "@/lib/codex-models";
import { useAgentModelCatalogStore } from "./agentModelCatalogStore";

describe("agentModelCatalogStore Claude catalogue", () => {
  beforeEach(() => {
    useAgentModelCatalogStore.setState({ claudeModels: [], claudeModelCatalogs: new Map() });
  });

  test("starts with an empty host-wide catalogue", () => {
    expect(useAgentModelCatalogStore.getInitialState().claudeModels).toEqual([]);
    expect(useAgentModelCatalogStore.getInitialState().claudeModelCatalogs.size).toBe(0);
  });

  test("keeps authoritative model catalogs scoped to their environment", () => {
    const store = useAgentModelCatalogStore.getState();
    store.setClaudeModels([{ id: "legacy", name: "Legacy" }]);
    store.setClaudeModelCatalog({
      environmentId: "env-1",
      models: [{ id: "opus", name: "Opus 5" }],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });

    expect(store.getClaudeModels("env-1").map((model) => model.id)).toEqual(["opus"]);
    expect(store.getClaudeModels("env-2").map((model) => model.id)).toEqual(["legacy"]);
    expect(useAgentModelCatalogStore.getState().claudeModels.map((model) => model.id)).toEqual([
      "legacy",
    ]);
  });

  test("records environment model updates as a fresh SDK catalog", () => {
    const store = useAgentModelCatalogStore.getState();
    store.setClaudeModels([{ id: "env-model", name: "Environment model" }], "env-1");
    expect(store.getClaudeModelCatalog("env-1")).toMatchObject({
      environmentId: "env-1",
      source: "sdk",
      stale: false,
    });
    expect(store.getClaudeModels("env-1").map((model) => model.id)).toEqual(["env-model"]);
    // An environment update never replaces the host-wide catalogue.
    expect(useAgentModelCatalogStore.getState().claudeModels).toEqual([]);
    expect(store.getClaudeModelCatalog("env-2")).toBeUndefined();
  });
});

describe("agentModelCatalogStore Codex catalogue", () => {
  beforeEach(() => {
    useAgentModelCatalogStore.setState({ codexModels: CODEX_MODELS });
  });

  test("starts at the bundled catalog", () => {
    expect(useAgentModelCatalogStore.getInitialState().codexModels).toBe(CODEX_MODELS);
  });

  test("setCodexModels falls back to the bundled catalog for an empty list", () => {
    // An empty catalog would leave the model picker unusable, so the bundled one
    // is the floor.
    useAgentModelCatalogStore.getState().setCodexModels([{ id: "custom", name: "Custom" }]);
    expect(useAgentModelCatalogStore.getState().codexModels.map((model) => model.id)).toEqual([
      "custom",
    ]);

    useAgentModelCatalogStore.getState().setCodexModels([]);
    expect(useAgentModelCatalogStore.getState().codexModels).toBe(CODEX_MODELS);
  });
});
