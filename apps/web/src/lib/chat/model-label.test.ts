import { describe, expect, test } from "bun:test";
import { resolveCatalogModelLabel } from "./model-label";

describe("resolveCatalogModelLabel", () => {
  const models = [
    {
      id: "sonnet",
      resolvedModel: "anthropic/claude-sonnet-4",
      aliases: ["claude-sonnet-latest"],
      name: "Claude Sonnet 4",
    },
    { id: "blank-name", name: "   " },
  ];

  test("uses the friendly catalog name for a known id", () => {
    expect(resolveCatalogModelLabel("sonnet", models)).toBe("Claude Sonnet 4");
  });

  test("uses a unique resolved model or alias for provider-confirmed ids", () => {
    expect(resolveCatalogModelLabel("anthropic/claude-sonnet-4", models)).toBe("Claude Sonnet 4");
    expect(resolveCatalogModelLabel("claude-sonnet-latest", models)).toBe("Claude Sonnet 4");
  });

  test("prefers an exact catalog id over another entry's alias", () => {
    const overlappingModels = [
      { id: "confirmed-id", name: "Exact" },
      { id: "selector", aliases: ["confirmed-id"], name: "Alias" },
      { id: "blank-exact", name: "   " },
      { id: "blank-selector", aliases: ["blank-exact"], name: "Wrong alias" },
    ];

    expect(resolveCatalogModelLabel("confirmed-id", overlappingModels)).toBe("Exact");
    expect(resolveCatalogModelLabel("blank-exact", overlappingModels)).toBe("blank-exact");
  });

  test("preserves an id when multiple catalog entries claim the same alias", () => {
    const ambiguousModels = [
      {
        id: "default",
        resolvedModel: "claude-opus-5[1m]",
        name: "Default (recommended)",
      },
      {
        id: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        name: "Opus (1M context)",
      },
    ];

    expect(resolveCatalogModelLabel("claude-opus-5[1m]", ambiguousModels)).toBe(
      "claude-opus-5[1m]",
    );
  });

  test("preserves unknown ids and entries without a usable name", () => {
    expect(resolveCatalogModelLabel("provider/new-model", models)).toBe("provider/new-model");
    expect(resolveCatalogModelLabel("blank-name", models)).toBe("blank-name");
  });
});
