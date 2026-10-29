import { describe, expect, test } from "bun:test";
import { gatedTemplate } from "./graph-designer-kinds.test-fixtures";
import { graphTemplateTypeLibrary } from "./graph-designer-model";
import {
  graphLoopPredicateScopeFor,
  graphNodePredicateScopeFor,
  graphPredicatePathSuggestions,
  pruneGraphOutletReferences,
  removeGraphOutlet,
  renameGraphOutlet,
} from "./graph-designer-scopes";

describe("graph-designer-scopes", () => {
  test("a node scope has its inputs, params and run; paths come from the schemas", () => {
    const template = gatedTemplate();
    const library = graphTemplateTypeLibrary(template);
    const gate = template.nodes.find((node) => node.id === "check")!;
    const scope = graphNodePredicateScopeFor(template, library, gate, null);
    expect(scope.kind).toBe("roots");
    if (scope.kind !== "roots") return;
    expect(scope.roots.map((root) => root.name)).toEqual(["report", "decision", "params", "run"]);
    const paths = graphPredicatePathSuggestions(scope).map((entry) => entry.path);
    expect(paths).toContain("report");
    expect(paths).toContain("report.issues");
    expect(paths).toContain("params.autoFix");
    expect(paths).toContain("run.iteration");
    // The producing port's choices narrow the decision's choice.
    const choice = graphPredicatePathSuggestions(scope).find(
      (entry) => entry.path === "decision.choice",
    );
    expect(choice?.type).toContain("ship | hold");
  });

  test("a loop scope names member outputs as node.port", () => {
    const template = gatedTemplate();
    const library = graphTemplateTypeLibrary(template);
    const scope = graphLoopPredicateScopeFor(template, library, template.loops![0]!);
    if (scope.kind !== "roots") throw new Error("expected roots");
    expect(scope.roots.map((root) => root.name)).toEqual([
      "review.report",
      "review.decision",
      "params",
      "run",
    ]);
    expect(graphPredicatePathSuggestions(scope).map((entry) => entry.path)).toContain(
      "review.report.issues",
    );
  });

  test("suggestions are bounded by depth and count", () => {
    const template = gatedTemplate();
    const library = graphTemplateTypeLibrary(template);
    const gate = template.nodes.find((node) => node.id === "check")!;
    const scope = graphNodePredicateScopeFor(template, library, gate, null);
    const shallow = graphPredicatePathSuggestions(scope, 1);
    expect(shallow.every((entry) => entry.path.split(".").length <= 2)).toBe(true);
    expect(graphPredicatePathSuggestions(scope).length).toBeLessThanOrEqual(400);
  });

  test("renaming an outlet rewrites the branch, edges and run outputs that read it", () => {
    let template = renameGraphOutlet(gatedTemplate(), "check", "findings", "issues");
    const gate = template.nodes.find((node) => node.id === "check")!;
    expect(gate.kind === "gate" && gate.branches[0]!.to).toBe("issues");
    expect(template.edges.find((edge) => edge.id === "check-approve")!.from).toEqual({
      node: "check",
      outlet: "issues",
      port: "report",
    });
    template = renameGraphOutlet(template, "check", "clean", "ok");
    expect(template.outputs![0]!.from).toEqual({ node: "check", outlet: "ok", port: "report" });
    const renamed = template.nodes.find((node) => node.id === "check")!;
    expect(renamed.kind === "gate" && renamed.otherwise).toBe("ok");
  });

  test("removing an outlet drops its readers; pruning drops readers of outlets that went away", () => {
    const removed = removeGraphOutlet(gatedTemplate(), "check", "findings");
    expect(removed.edges.map((edge) => edge.id)).toEqual(["review-check", "review-check-decision"]);
    const template = gatedTemplate();
    const gate = template.nodes.find((node) => node.id === "check")!;
    if (gate.kind === "gate") delete gate.otherwise;
    const pruned = pruneGraphOutletReferences(template, "check");
    expect(pruned.outputs).toEqual([]);
    expect(pruned.edges).toHaveLength(3);
    expect(pruneGraphOutletReferences(pruned, "check")).toBe(pruned);
  });
});
