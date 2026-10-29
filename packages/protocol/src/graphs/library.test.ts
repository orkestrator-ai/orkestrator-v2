import { describe, expect, test } from "bun:test";
import { graphTemplateExample } from "./examples.js";
import {
  graphBuiltinTemplates,
  graphProjectTemplatePath,
  graphTemplateExportFileName,
  graphTemplateExportText,
  graphTemplateRefKey,
  graphTemplateTrustState,
  isGraphProjectTemplatePath,
  parseGraphTemplateRef,
} from "./library.js";
import { validateGraphTemplate } from "./template.js";

describe("template references", () => {
  test("parses the three scopes", () => {
    expect(parseGraphTemplateRef({ scope: "builtin", id: "multi-review" })).toEqual({
      scope: "builtin",
      id: "multi-review",
    });
    expect(parseGraphTemplateRef({ scope: "user", id: "mine-2" })).toEqual({
      scope: "user",
      id: "mine-2",
    });
    expect(
      parseGraphTemplateRef({
        scope: "project",
        projectId: "p-1",
        path: ".orkestrator/graphs/a.graph.json",
      }),
    ).toEqual({ scope: "project", projectId: "p-1", path: ".orkestrator/graphs/a.graph.json" });
  });

  test("refuses anything else", () => {
    for (const value of [
      null,
      [],
      "user:mine",
      { scope: "team", id: "a" },
      { scope: "user", id: "Mine" },
      { scope: "user", id: "a".repeat(65) },
      { scope: "user", id: "a", extra: 1 },
      { scope: "project", projectId: "p", path: "a.graph.json" },
      { scope: "project", projectId: "p", path: ".orkestrator/graphs/../x.graph.json" },
      { scope: "project", projectId: "p", path: ".orkestrator/graphs/sub/x.graph.json" },
      { scope: "project", projectId: "", path: ".orkestrator/graphs/x.graph.json" },
    ]) {
      expect(parseGraphTemplateRef(value)).toHaveProperty("error");
    }
  });

  test("keys are stable per scope", () => {
    expect(graphTemplateRefKey({ scope: "user", id: "a" })).toBe("user:a");
    expect(
      graphTemplateRefKey({
        scope: "project",
        projectId: "p",
        path: ".orkestrator/graphs/a.graph.json",
      }),
    ).toBe("project:p:.orkestrator/graphs/a.graph.json");
  });
});

describe("project template paths", () => {
  test("one file name ending in .graph.json", () => {
    expect(graphProjectTemplatePath("review.graph.json")).toBe(
      ".orkestrator/graphs/review.graph.json",
    );
    for (const name of [
      ".hidden.graph.json",
      "a b.graph.json",
      "a/b.graph.json",
      "a.json",
      `${"a".repeat(128)}.graph.json`,
    ]) {
      expect(graphProjectTemplatePath(name)).toBeNull();
    }
    expect(isGraphProjectTemplatePath(".orkestrator/graphs/review.graph.json")).toBe(true);
    expect(isGraphProjectTemplatePath("review.graph.json")).toBe(false);
    expect(isGraphProjectTemplatePath(5)).toBe(false);
  });
});

describe("trust", () => {
  test("a record covers exactly its digest", () => {
    const record = {
      path: ".orkestrator/graphs/a.graph.json",
      digest: "a".repeat(64),
      approvedAt: "x",
    };
    expect(graphTemplateTrustState(undefined, "a".repeat(64))).toBe("untrusted");
    expect(graphTemplateTrustState(record, "a".repeat(64))).toBe("trusted");
    expect(graphTemplateTrustState(record, "b".repeat(64))).toBe("changed");
  });
});

describe("export", () => {
  test("canonical text: sorted keys, two-space indentation, trailing newline, any input order", () => {
    const template = graphTemplateExample("multi-review");
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(template).reverse())),
    );
    const text = graphTemplateExportText(template);
    expect(graphTemplateExportText(reordered)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "description"')).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(template)));
    expect(graphTemplateExportFileName(template)).toBe("multi-review.graph.json");
  });
});

describe("built-in registry", () => {
  test("returns fresh, valid copies", () => {
    const first = graphBuiltinTemplates();
    for (const template of first) expect(validateGraphTemplate(template).ok).toBe(true);
    expect(new Set(first.map((template) => template.id)).size).toBe(first.length);
    const second = graphBuiltinTemplates();
    expect(second).toEqual(first);
    if (first[0]) expect(second[0]).not.toBe(first[0]);
  });
});
