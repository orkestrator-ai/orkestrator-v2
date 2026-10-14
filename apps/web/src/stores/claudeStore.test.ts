import { beforeEach, describe, expect, test } from "bun:test";
import { useClaudeStore } from "./claudeStore";

describe("claudeStore model catalogue", () => {
  beforeEach(() => {
    useClaudeStore.setState({ models: [], modelCatalogs: new Map() });
  });

  test("keeps authoritative model catalogs scoped to their environment", () => {
    const store = useClaudeStore.getState();
    store.setModels([{ id: "legacy", name: "Legacy" }]);
    store.setModelCatalog({
      environmentId: "env-1",
      models: [{ id: "opus", name: "Opus 5" }],
      source: "sdk",
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    });

    expect(store.getModels("env-1").map((model) => model.id)).toEqual(["opus"]);
    expect(store.getModels("env-2").map((model) => model.id)).toEqual(["legacy"]);
    expect(useClaudeStore.getState().models.map((model) => model.id)).toEqual(["legacy"]);
  });

  test("records environment model updates as a fresh SDK catalog", () => {
    const store = useClaudeStore.getState();
    store.setModels([{ id: "env-model", name: "Environment model" }], "env-1");
    expect(store.getModelCatalog("env-1")).toMatchObject({
      environmentId: "env-1",
      source: "sdk",
      stale: false,
    });
    expect(store.getModels("env-1").map((model) => model.id)).toEqual(["env-model"]);
    // An environment update never replaces the host-wide catalogue.
    expect(useClaudeStore.getState().models).toEqual([]);
    expect(store.getModelCatalog("env-2")).toBeUndefined();
  });
});
