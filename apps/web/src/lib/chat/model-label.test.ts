import { describe, expect, test } from "bun:test";
import { resolveCatalogModelLabel } from "./model-label";

describe("resolveCatalogModelLabel", () => {
  const models = [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "blank-name", name: "   " },
  ];

  test("uses the friendly catalog name for a known id", () => {
    expect(resolveCatalogModelLabel("anthropic/claude-sonnet-4", models))
      .toBe("Claude Sonnet 4");
  });

  test("preserves unknown ids and entries without a usable name", () => {
    expect(resolveCatalogModelLabel("provider/new-model", models))
      .toBe("provider/new-model");
    expect(resolveCatalogModelLabel("blank-name", models)).toBe("blank-name");
  });
});
