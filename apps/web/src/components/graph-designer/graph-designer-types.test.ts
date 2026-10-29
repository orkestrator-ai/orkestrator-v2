import { describe, expect, test } from "bun:test";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { validateGraphSchemaSubset } from "@orkestrator/protocol/graphs/schema-subset";
import { blankGraphTemplate } from "./graph-designer-edits";
import {
  blankGraphCustomType,
  graphCustomTypeIssues,
  graphSchemaArrayPaths,
  graphTypeUses,
  renameGraphTypeRef,
} from "./graph-designer-types";

describe("graph-designer-types", () => {
  test("a blank custom type is valid under a free name", () => {
    const def = blankGraphCustomType(["custom-type"]);
    expect(def.name).toBe("custom-type-2");
    expect(validateGraphSchemaSubset(def.schema).ok).toBe(true);
    expect(graphCustomTypeIssues(def, { types: [def] }).issues).toEqual([]);
  });

  test("renames a type reference in ports, run inputs and outputs, through list wrappers", () => {
    const template = graphTemplateExample("design-bake-off");
    template.inputs.push({ name: "seed", type: "design-brief@1" });
    const renamed = renameGraphTypeRef(template, "design-brief@1", "proposal@2");
    const judge = renamed.nodes.find((node) => node.id === "judge")!;
    expect(judge.inputs!.find((port) => port.name === "briefs")!.type).toBe("list<proposal@2>");
    expect("outputs" in judge && judge.outputs!.find((port) => port.name === "brief")!.type).toBe(
      "proposal@2",
    );
    expect(renamed.inputs.find((input) => input.name === "seed")!.type).toBe("proposal@2");
    // Unrelated ports are untouched, and the input template is not mutated.
    expect(judge.inputs!.find((port) => port.name === "ticket")!.type).toBe("ticket@1");
    expect(
      template.nodes
        .find((node) => node.id === "judge")!
        .inputs!.find((port) => port.name === "briefs")!.type,
    ).toBe("list<design-brief@1>");
    expect(graphTypeUses(renamed, "design-brief@1")).toEqual([]);
    expect(graphTypeUses(renamed, "proposal@2")).toContain("judge.briefs");
    expect(renameGraphTypeRef(template, "x@1", "x@1")).toBe(template);
  });

  test("reports guard issues, built-in names, duplicates and an example that does not fit", () => {
    const def = blankGraphCustomType([]);
    const bad = { ...def, name: "ticket", example: { summary: 3 } };
    const { issues } = graphCustomTypeIssues(bad, { types: [bad] });
    expect(issues.map((issue) => issue.code)).toContain("built_in_type");
    expect(issues.filter((issue) => issue.code === "built_in_type")).toHaveLength(1);
    expect(issues.some((issue) => issue.path.startsWith("example"))).toBe(true);

    const twin = graphCustomTypeIssues(def, { types: [def, { ...def }] });
    expect(twin.issues.map((issue) => issue.code)).toContain("duplicate");

    const loose = { ...def, schema: { ...def.schema, pattern: "x" } };
    expect(
      graphCustomTypeIssues(loose, { types: [loose] }).issues.map((issue) => issue.code),
    ).toContain("unsupported_keyword");
    expect(graphCustomTypeIssues(def, blankGraphTemplate()).issues).toEqual([]);
  });

  test("lists array fields for items paths", () => {
    const brief = graphTemplateExample("design-bake-off").types![0]!;
    expect(graphSchemaArrayPaths(brief.schema)).toEqual(["risks", "filesTouched"]);
  });
});
