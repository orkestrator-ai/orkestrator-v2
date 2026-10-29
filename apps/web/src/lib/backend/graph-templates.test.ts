import { afterEach, describe, expect, test, type Mock } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  compileGraphTemplateInBackend,
  deleteGraphTemplate,
  duplicateGraphTemplate,
  exportGraphTemplate,
  getGraphCapabilityCeiling,
  getGraphTemplate,
  importGraphTemplate,
  listGraphTemplates,
  saveGraphTemplate,
  setGraphCapabilityCeiling,
  setGraphTemplateTrust,
} from "./graph-templates";

// `@/lib/native/backend` is replaced once for every suite in tests/setup.ts.
const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const ref = { scope: "user" as const, id: "mine" };
const projectRef = {
  scope: "project" as const,
  projectId: "p1",
  path: ".orkestrator/graphs/a.graph.json",
};

describe("graph template wrappers", () => {
  test("call the item 109 backend commands with their arguments", async () => {
    const template = { id: "mine", revision: 0 } as never;
    const calls: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => listGraphTemplates(), "graph_templates_list", {}],
      [() => listGraphTemplates({ projectId: "p1" }), "graph_templates_list", { projectId: "p1" }],
      [
        () => getGraphTemplate(ref, { projectId: "p1" }),
        "graph_template_get",
        { ref, projectId: "p1" },
      ],
      [() => saveGraphTemplate(template), "graph_template_save", { template }],
      [
        () => saveGraphTemplate(template, { expectedRevision: 3 }),
        "graph_template_save",
        { template, expectedRevision: 3 },
      ],
      [() => deleteGraphTemplate("mine"), "graph_template_delete", { id: "mine" }],
      [
        () => deleteGraphTemplate("mine", 2),
        "graph_template_delete",
        { id: "mine", expectedRevision: 2 },
      ],
      [
        () => duplicateGraphTemplate(projectRef, { digest: "d" }),
        "graph_template_duplicate",
        { ref: projectRef, digest: "d" },
      ],
      [
        () => compileGraphTemplateInBackend({ ref }, { projectId: "p1", includePlan: true }),
        "graph_template_compile",
        { ref, projectId: "p1", includePlan: true },
      ],
      [() => compileGraphTemplateInBackend({ template }), "graph_template_compile", { template }],
      [() => importGraphTemplate("{}"), "graph_template_import", { text: "{}" }],
      [() => exportGraphTemplate(ref), "graph_template_export", { ref }],
      [
        () =>
          setGraphTemplateTrust({
            projectId: "p1",
            path: projectRef.path,
            action: "approve",
            digest: "d",
          }),
        "graph_template_trust",
        { projectId: "p1", path: projectRef.path, action: "approve", digest: "d" },
      ],
      [() => getGraphCapabilityCeiling("p1"), "graph_capability_ceiling_get", { projectId: "p1" }],
      [
        () => setGraphCapabilityCeiling("p1", { deny: ["network"] }, 1),
        "graph_capability_ceiling_set",
        { projectId: "p1", ceiling: { deny: ["network"] }, expectedRevision: 1 },
      ],
      [
        () => setGraphCapabilityCeiling("p1", null),
        "graph_capability_ceiling_set",
        { projectId: "p1", ceiling: null },
      ],
    ];
    for (const [call, command, args] of calls) {
      await call();
      expect(invokeMock).toHaveBeenLastCalledWith(command, args);
    }
  });

  test("pass the backend's answer through", async () => {
    const answer = { templates: [], project: null, ceiling: { deny: [] } };
    invokeMock.mockImplementation(async () => answer);
    await expect(listGraphTemplates()).resolves.toBe(answer);
  });
});
