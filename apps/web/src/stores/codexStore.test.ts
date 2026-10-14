import { beforeEach, describe, expect, test } from "bun:test";
import { CODEX_MODELS } from "@/lib/codex-models";
import { useCodexStore } from "./codexStore";

describe("codexStore model catalogue", () => {
  beforeEach(() => {
    useCodexStore.setState({ models: CODEX_MODELS });
  });

  test("setModels falls back to the bundled catalog for an empty list", () => {
    // An empty catalog would leave the model picker unusable, so the bundled one
    // is the floor.
    useCodexStore.getState().setModels([{ id: "custom", name: "Custom" }]);
    expect(useCodexStore.getState().models.map((model) => model.id)).toEqual(["custom"]);

    useCodexStore.getState().setModels([]);
    expect(useCodexStore.getState().models).toEqual(CODEX_MODELS);
  });
});
