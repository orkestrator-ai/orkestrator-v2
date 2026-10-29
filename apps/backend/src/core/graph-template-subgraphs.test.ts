/**
 * Sub-graph resolution in the template library (item 402): a template's
 * sub-graphs resolve over built-ins, user templates and the compile
 * project's trusted templates; a child edit recompiles its parents; an
 * untrusted project child never resolves as content.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import { graphBuiltinTemplates } from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateRef, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  createGraphTemplateFixture,
  sampleGraphTemplate,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";

let fixture: GraphTemplateFixture;

beforeEach(async () => {
  fixture = await createGraphTemplateFixture({ builtins: graphBuiltinTemplates });
});

afterEach(async () => {
  await fixture.close();
});

const PATH = ".orkestrator/graphs/child.graph.json";

/** A template whose only node inlines `ref` (a §9.1-shaped child) and returns its report. */
function wrapper(ref: GraphTemplateRef, id = "wrapper"): GraphTemplateV1 {
  const child = sampleGraphTemplate();
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id,
    revision: 0,
    name: "Wrapper",
    parameters: [],
    roles: child.roles,
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [{ name: "report", type: "review-report@1", from: { node: "inner", port: "report" } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "inner",
        kind: "subgraph",
        template: ref,
        inputs: [{ name: "target", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      { id: "target-inner", from: { input: "target" }, to: { node: "inner", port: "target" } },
    ],
    limits: child.limits,
  };
}

const codes = (response: { diagnostics: { code: string }[] }) =>
  response.diagnostics.map((diagnostic) => diagnostic.code);

describe("sub-graph resolution", () => {
  test("a user child resolves, and editing it recompiles the parent", async () => {
    const { service } = fixture;
    await service.save(sampleGraphTemplate("child"));
    await service.save(wrapper({ scope: "user", id: "child" }));
    const ref = { scope: "user" as const, id: "wrapper" };
    const first = await service.compile({ ref }, { includePlan: true });
    expect(first.ok).toBe(true);
    expect(first.plan!.subgraphs![0]!.template).toMatchObject({
      scope: "user",
      id: "child",
      revision: 1,
    });
    expect(first.plan!.order).toContain("inner/consolidate");

    const child = (await service.get({ scope: "user", id: "child" })).template;
    await service.save({ ...child, description: "Edited" }, { expectedRevision: 1 });
    const second = await service.compile({ ref }, { includePlan: true });
    expect(second.plan!.subgraphs![0]!.template.revision).toBe(2);
    expect(second.planDigest).not.toBe(first.planDigest);
  });

  test("a pinned child that changed is a compile error, not a silent change", async () => {
    const { service } = fixture;
    const saved = await service.save(sampleGraphTemplate("child"));
    await service.save(
      wrapper({ scope: "user", id: "child", digest: graphTemplateDigest(saved.template) }),
    );
    const ref = { scope: "user" as const, id: "wrapper" };
    expect((await service.compile({ ref })).ok).toBe(true);
    await service.save({ ...saved.template, description: "Edited" }, { expectedRevision: 1 });
    const stale = await service.compile({ ref });
    expect(stale.ok).toBe(false);
    expect(codes(stale)).toContain("subgraph-digest-mismatch");
  });

  test("a project child resolves only while it is trusted, and only inside its project", async () => {
    const { service, projectId } = fixture;
    await fixture.writeProjectTemplate("child.graph.json", sampleGraphTemplate("from-repo"));
    const draft = wrapper({ scope: "project", id: "from-repo", path: PATH });

    const untrusted = await service.compile({ template: draft }, { projectId });
    expect(untrusted.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-unresolved", detail: "untrusted" }),
    );

    const file = await service.get({ scope: "project", projectId, path: PATH });
    await service.trust({ projectId, path: PATH, action: "approve", digest: file.summary.digest });
    const trusted = await service.compile({ template: draft }, { projectId, includePlan: true });
    expect(trusted.ok).toBe(true);
    expect(trusted.plan!.subgraphs![0]!.template).toMatchObject({
      scope: "project",
      id: "from-repo",
      path: PATH,
    });

    const elsewhere = await service.compile({ template: draft });
    expect(elsewhere.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-unresolved", detail: "no-project" }),
    );

    // The file changes on disk: its approval no longer covers it.
    await fixture.writeProjectTemplate("child.graph.json", {
      ...sampleGraphTemplate("from-repo"),
      description: "Changed",
    });
    fixture.watch.fire();
    await fixture.service.projectTemplates.scan(projectId);
    const changed = await service.compile({ template: draft }, { projectId });
    expect(changed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "subgraph-unresolved", detail: "untrusted" }),
    );
  });

  test("the built-in Multi Review is usable as a block", async () => {
    const { service } = fixture;
    const response = await service.compile(
      { template: wrapper({ scope: "builtin", id: "multi-review" }) },
      { includePlan: true },
    );
    expect(response.ok).toBe(true);
    expect(codes(response)).toContain("subgraph-engine-copy");
    // The parent is a user graph: it runs on the graph runtime, not the engine.
    expect(response.plan!.template.engine).toBeUndefined();
    expect(response.plan!.subgraphs![0]!.template.engine).toBe("multi-review");
  });
});
