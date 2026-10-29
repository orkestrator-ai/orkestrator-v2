import { describe, expect, test } from "bun:test";
import { compile } from "../compile.js";
import { GRAPH_TEMPLATE_ENGINES } from "../template-model.js";
import { validateGraphTemplate } from "../template.js";
import {
  GRAPH_BUILT_IN_TEMPLATE_IDS,
  graphBuiltInTemplate,
  graphBuiltInTemplates,
  isGraphBuiltInTemplateId,
} from "./index.js";

describe("the built-in template list", () => {
  test("one built-in per engine, in a stable order", () => {
    expect([...GRAPH_BUILT_IN_TEMPLATE_IDS]).toEqual([...GRAPH_TEMPLATE_ENGINES]);
    expect(
      graphBuiltInTemplates().map((entry) => [entry.id, entry.engine, entry.template.id]),
    ).toEqual(GRAPH_BUILT_IN_TEMPLATE_IDS.map((id) => [id, id, id]));
    expect(isGraphBuiltInTemplateId("multi-review")).toBe(true);
    expect(isGraphBuiltInTemplateId("design-bake-off")).toBe(false);
    expect(graphBuiltInTemplate("nope")).toBeUndefined();
  });

  test("every built-in passes the guard, compiles cleanly under default options and may launch", () => {
    for (const entry of graphBuiltInTemplates()) {
      expect(validateGraphTemplate(entry.template).ok).toBe(true);
      const result = compile(entry.template);
      expect({
        id: entry.id,
        errorsAndWarnings: result.diagnostics.filter((d) => d.severity !== "info"),
        info: result.diagnostics.filter((d) => d.severity === "info").map((d) => d.code),
      }).toEqual({ id: entry.id, errorsAndWarnings: [], info: [] });
      expect(result.ok).toBe(true);
      expect(result.launchable).toBe(true);
      expect(result.pendingAcknowledgements).toEqual([]);
      expect(result.plan!.template).toMatchObject({ id: entry.id, engine: entry.engine });
      expect(result.cost!.agentSessions.worst).toBeLessThanOrEqual(
        entry.template.limits.maxAgentSessions,
      );
    }
  });

  test("every node maps to an engine stage, and only nodes do", () => {
    for (const entry of graphBuiltInTemplates()) {
      expect(Object.keys(entry.stages).sort()).toEqual(
        entry.template.nodes.map((node) => node.id).sort(),
      );
    }
  });

  test("no agent node pushes or writes to GitHub (D12)", () => {
    for (const entry of graphBuiltInTemplates()) {
      const plan = compile(entry.template).plan!;
      for (const node of plan.nodes) {
        if (node.kind !== "agent") continue;
        expect(node.capabilities.denied).toEqual(
          expect.arrayContaining(["git.push", "github.write"]),
        );
      }
    }
  });

  test("templates are fresh copies with a stable digest", () => {
    const first = graphBuiltInTemplate("build-pipeline")!;
    first.template.nodes.length = 0;
    const second = graphBuiltInTemplate("build-pipeline")!;
    expect(second.template.nodes.length).toBeGreaterThan(0);
    // The stage maps are shared and frozen.
    for (const entry of graphBuiltInTemplates()) expect(Object.isFrozen(entry.stages)).toBe(true);
    for (const id of GRAPH_BUILT_IN_TEMPLATE_IDS) {
      expect(compile(graphBuiltInTemplate(id)!.template).plan!.digest).toBe(
        compile(graphBuiltInTemplate(id)!.template).plan!.digest,
      );
    }
  });
});
