import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import { CODEX_MODELS } from "@/lib/codex-models";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { agentModelCatalogStore, type AgentModelCatalogState } from "./agentModelCatalogStore";

// Each test names its node scope, as converted code does (plan item 3003).
let windowScope: WindowScope;
let catalog: StoreApi<AgentModelCatalogState>;

beforeEach(() => {
  windowScope = new WindowScope();
  catalog = windowScope
    .open({ role: "command", client: new FakeNodeClient() })
    .store(agentModelCatalogStore);
});

afterEach(() => windowScope.dispose());

describe("agentModelCatalogStore Claude catalogue", () => {
  beforeEach(() => {
    catalog.setState({ claudeModels: [], claudeModelCatalogs: new Map() });
  });

  test("starts with an empty host-wide catalogue", () => {
    expect(catalog.getInitialState().claudeModels).toEqual([]);
    expect(catalog.getInitialState().claudeModelCatalogs.size).toBe(0);
  });

  test("keeps authoritative model catalogs scoped to their environment", () => {
    const store = catalog.getState();
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
    expect(catalog.getState().claudeModels.map((model) => model.id)).toEqual(["legacy"]);
  });

  test("records environment model updates as a fresh SDK catalog", () => {
    const store = catalog.getState();
    store.setClaudeModels([{ id: "env-model", name: "Environment model" }], "env-1");
    expect(store.getClaudeModelCatalog("env-1")).toMatchObject({
      environmentId: "env-1",
      source: "sdk",
      stale: false,
    });
    expect(store.getClaudeModels("env-1").map((model) => model.id)).toEqual(["env-model"]);
    // An environment update never replaces the host-wide catalogue.
    expect(catalog.getState().claudeModels).toEqual([]);
    expect(store.getClaudeModelCatalog("env-2")).toBeUndefined();
  });
});

describe("agentModelCatalogStore Codex catalogue", () => {
  beforeEach(() => {
    catalog.setState({ codexModels: CODEX_MODELS });
  });

  test("starts at the bundled catalog", () => {
    expect(catalog.getInitialState().codexModels).toBe(CODEX_MODELS);
  });

  test("setCodexModels falls back to the bundled catalog for an empty list", () => {
    // An empty catalog would leave the model picker unusable, so the bundled one
    // is the floor.
    catalog.getState().setCodexModels([{ id: "custom", name: "Custom" }]);
    expect(catalog.getState().codexModels.map((model) => model.id)).toEqual(["custom"]);

    catalog.getState().setCodexModels([]);
    expect(catalog.getState().codexModels).toBe(CODEX_MODELS);
  });
});
