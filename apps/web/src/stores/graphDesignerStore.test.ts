import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { graphTemplateExportText } from "@orkestrator/protocol/graphs/library";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  builtInDetail,
  compileResponse,
  listResult,
  userDetail,
} from "@/components/graph-designer/graph-designer.test-fixtures";
import {
  graphDesignerTab,
  isGraphRevisionConflict,
  parseGraphDraft,
  useGraphDesignerStore,
} from "./graphDesignerStore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
type Handler = (args: Record<string, unknown>) => unknown;

function install(handlers: Record<string, Handler>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler(args);
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function calls(command: string) {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

const pipeline = builtInDetail("build-pipeline");

beforeEach(() => {
  useGraphDesignerStore.setState({ libraries: new Map(), tabs: new Map() });
});

afterEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("graphDesignerStore", () => {
  test("loads the library per project and keeps the last result on a failed reload", async () => {
    const list = listResult([pipeline.summary]);
    install({ graph_templates_list: () => list });
    await useGraphDesignerStore.getState().loadLibrary("project-1");
    expect(calls("graph_templates_list")).toEqual([{ projectId: "project-1" }]);
    expect(useGraphDesignerStore.getState().libraries.get("project-1")).toEqual({
      status: "ready",
      result: list,
      error: null,
    });
    install({
      graph_templates_list: () => {
        throw new Error("backend offline");
      },
    });
    await useGraphDesignerStore.getState().loadLibrary("project-1");
    expect(useGraphDesignerStore.getState().libraries.get("project-1")).toEqual({
      status: "error",
      result: list,
      error: "backend offline",
    });
  });

  test("opens a template: reads it and compiles it in the backend with the plan, under the project", async () => {
    install({
      graph_template_get: () => pipeline,
      graph_template_compile: () => compileResponse(pipeline.template),
    });
    await useGraphDesignerStore.getState().openTemplate("tab-1", pipeline.summary.ref, "project-1");
    expect(calls("graph_template_get")).toEqual([
      { ref: pipeline.summary.ref, projectId: "project-1" },
    ]);
    expect(calls("graph_template_compile")).toEqual([
      { ref: pipeline.summary.ref, projectId: "project-1", includePlan: true },
    ]);
    const tab = graphDesignerTab("tab-1");
    expect(tab.detail).toEqual(pipeline);
    expect(tab.detailStatus).toBe("ready");
    expect(tab.compile?.source).toBe("backend");
    expect(tab.compile?.plan?.digest).toBeString();
    expect(tab.compileStatus).toBe("ready");
  });

  test("drops a slower response for a template the tab no longer shows", async () => {
    const multi = builtInDetail("multi-review");
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    install({
      graph_template_get: async (args) => {
        const ref = args.ref as { id: string };
        if (ref.id === "build-pipeline") await firstGate;
        return ref.id === "build-pipeline" ? pipeline : multi;
      },
      graph_template_compile: (args) =>
        compileResponse(
          ((args.ref as { id: string }).id === "build-pipeline" ? pipeline : multi).template,
        ),
    });
    const store = useGraphDesignerStore.getState();
    const first = store.openTemplate("tab-1", pipeline.summary.ref, null);
    await store.openTemplate("tab-1", multi.summary.ref, null);
    releaseFirst();
    await first;
    expect(graphDesignerTab("tab-1").detail?.summary.id).toBe("multi-review");
  });

  test("records load failures per part", async () => {
    install({
      graph_template_get: () => {
        throw new Error("not-found: no such template");
      },
      graph_template_compile: () => {
        throw new Error("compile failed");
      },
    });
    await useGraphDesignerStore
      .getState()
      .openTemplate("tab-1", { scope: "user", id: "gone" }, null);
    const tab = graphDesignerTab("tab-1");
    expect(tab.detailStatus).toBe("error");
    expect(tab.detailError).toContain("no such template");
    expect(tab.compileStatus).toBe("error");
  });

  test("imports JSON: an accepted template reloads the library and opens; a refused one returns its errors", async () => {
    const imported = userDetail(pipeline.template);
    install({
      graph_template_import: (args) =>
        (args.text as string).includes("format")
          ? { ok: true, detail: imported }
          : {
              ok: false,
              errors: [{ path: "$", code: "invalid_json", message: "bad" }],
              omittedErrors: 0,
            },
      graph_templates_list: () => listResult([pipeline.summary, imported.summary]),
      graph_template_get: () => imported,
      graph_template_compile: () => compileResponse(imported.template),
    });
    const store = useGraphDesignerStore.getState();
    const refused = await store.importTemplate("tab-1", "{", null);
    expect(refused).toMatchObject({ ok: false, errors: [{ code: "invalid_json" }] });
    expect(calls("graph_templates_list")).toHaveLength(0);
    const accepted = await store.importTemplate(
      "tab-1",
      graphTemplateExportText(imported.template),
      null,
    );
    expect(accepted.ok).toBe(true);
    expect(calls("graph_templates_list")).toHaveLength(1);
    expect(graphDesignerTab("tab-1").selected).toEqual({ scope: "user", id: imported.template.id });
  });

  test("duplicates with the reviewed digest for project templates only", async () => {
    const copy = userDetail({ ...pipeline.template, id: "build-pipeline-copy" });
    install({
      graph_template_duplicate: () => copy,
      graph_templates_list: () => listResult([]),
      graph_template_get: () => copy,
      graph_template_compile: () => compileResponse(copy.template),
    });
    const store = useGraphDesignerStore.getState();
    await store.duplicateTemplate("tab-1", pipeline.summary, "project-1");
    expect(calls("graph_template_duplicate")[0]).toEqual({
      ref: pipeline.summary.ref,
      projectId: "project-1",
    });
    const projectSummary = {
      ...pipeline.summary,
      scope: "project" as const,
      ref: {
        scope: "project" as const,
        projectId: "project-1",
        path: ".orkestrator/graphs/x.graph.json",
      },
      trust: "untrusted" as const,
    };
    await store.duplicateTemplate("tab-1", projectSummary, "project-1");
    expect(calls("graph_template_duplicate")[1]).toEqual({
      ref: projectSummary.ref,
      digest: projectSummary.digest,
      projectId: "project-1",
    });
    expect(graphDesignerTab("tab-1").selected).toEqual(copy.summary.ref);
  });

  test("approves a project template at the digest shown and revokes without one", async () => {
    install({
      graph_template_trust: (args) => ({ ...args, trust: "trusted", digest: "d", records: [] }),
      graph_templates_list: () => listResult([]),
    });
    const summary = {
      ...pipeline.summary,
      scope: "project" as const,
      ref: { scope: "project" as const, projectId: "p", path: ".orkestrator/graphs/a.graph.json" },
      trust: "untrusted" as const,
      digest: "abc",
    };
    await useGraphDesignerStore.getState().setTrust(summary, "approve");
    await useGraphDesignerStore.getState().setTrust(summary, "revoke");
    expect(calls("graph_template_trust")).toEqual([
      {
        projectId: "p",
        path: ".orkestrator/graphs/a.graph.json",
        action: "approve",
        digest: "abc",
      },
      { projectId: "p", path: ".orkestrator/graphs/a.graph.json", action: "revoke" },
    ]);
    expect(calls("graph_templates_list")).toEqual([{ projectId: "p" }, { projectId: "p" }]);
  });

  describe("JSON editor", () => {
    const mine = userDetail({ ...pipeline.template, id: "mine", name: "Mine" }, 4);

    async function openMine() {
      install({
        graph_template_get: () => mine,
        graph_template_compile: () => compileResponse(mine.template),
      });
      await useGraphDesignerStore.getState().openTemplate("tab-1", mine.summary.ref, null);
    }

    test("opens only for user templates, on the stored revision's canonical text", async () => {
      install({
        graph_template_get: () => pipeline,
        graph_template_compile: () => compileResponse(pipeline.template),
      });
      await useGraphDesignerStore.getState().openTemplate("tab-b", pipeline.summary.ref, null);
      useGraphDesignerStore.getState().openEditor("tab-b");
      expect(graphDesignerTab("tab-b").editor).toBeNull();

      await openMine();
      useGraphDesignerStore.getState().openEditor("tab-1");
      expect(graphDesignerTab("tab-1").editor).toMatchObject({
        text: graphTemplateExportText(mine.template),
        baseRevision: 4,
        conflict: false,
      });
    });

    test("compiles the draft in the browser, reporting JSON errors and schema errors apart", async () => {
      await openMine();
      const store = useGraphDesignerStore.getState();
      store.openEditor("tab-1");
      const broken = structuredClone(mine.template);
      broken.loops![0]!.maxIterations = 11;
      store.editDraft("tab-1", JSON.stringify(broken));
      store.compileDraft("tab-1", { providers: ["claude", "codex"] });
      let tab = graphDesignerTab("tab-1");
      expect(tab.compile?.source).toBe("browser");
      expect(tab.compile?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "loop-bound-exceeded",
      );
      expect(tab.compile?.plan).toBeNull();

      store.editDraft("tab-1", '{"format": ');
      store.compileDraft("tab-1", {});
      tab = graphDesignerTab("tab-1");
      expect(tab.editor?.parseErrors[0]?.code).toBe("invalid_json");
      // The last compile stays until the text parses again.
      expect(tab.compile?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "loop-bound-exceeded",
      );

      store.editDraft("tab-1", JSON.stringify({ ...mine.template, nodes: "nope" }));
      store.compileDraft("tab-1", {});
      tab = graphDesignerTab("tab-1");
      expect(tab.editor?.parseErrors).toEqual([]);
      expect(tab.compile?.diagnostics[0]?.code).toBe("template-invalid");
    });

    test("saves with compare-and-swap on the base revision and rebases on success", async () => {
      await openMine();
      const saved = userDetail({ ...mine.template, name: "Renamed" }, 5);
      install({
        graph_template_save: () => saved,
        graph_templates_list: () => listResult([saved.summary]),
      });
      const store = useGraphDesignerStore.getState();
      store.openEditor("tab-1");
      store.editDraft("tab-1", JSON.stringify({ ...mine.template, name: "Renamed" }));
      expect(await store.saveDraft("tab-1")).toBe(true);
      const save = calls("graph_template_save")[0]!;
      expect(save.expectedRevision).toBe(4);
      expect((save.template as { name: string }).name).toBe("Renamed");
      const tab = graphDesignerTab("tab-1");
      expect(tab.detail).toEqual(saved);
      expect(tab.editor).toMatchObject({ baseRevision: 5, conflict: false, saving: false });
    });

    test("keeps the text and reports a conflict when someone saved first", async () => {
      await openMine();
      const latest = userDetail({ ...mine.template, name: "Theirs" }, 6);
      install({
        graph_template_save: () => {
          throw Object.assign(
            new Error("Template mine is at revision 6, not 4; reload it before saving"),
            { code: "revision-conflict" },
          );
        },
        graph_template_get: () => latest,
      });
      const store = useGraphDesignerStore.getState();
      store.openEditor("tab-1");
      const text = JSON.stringify({ ...mine.template, name: "Ours" });
      store.editDraft("tab-1", text);
      expect(await store.saveDraft("tab-1")).toBe(false);
      let tab = graphDesignerTab("tab-1");
      expect(tab.editor).toMatchObject({ text, conflict: true, saving: false, baseRevision: 4 });
      expect(tab.editor?.error).toContain("revision 4");

      await store.reloadDraft("tab-1");
      tab = graphDesignerTab("tab-1");
      expect(tab.editor).toMatchObject({
        text: graphTemplateExportText(latest.template),
        baseRevision: 6,
        conflict: false,
      });
    });

    test("refuses to save text that is not a template", async () => {
      await openMine();
      install({});
      const store = useGraphDesignerStore.getState();
      store.openEditor("tab-1");
      store.editDraft("tab-1", "not json");
      expect(await store.saveDraft("tab-1")).toBe(false);
      expect(calls("graph_template_save")).toHaveLength(0);
      expect(graphDesignerTab("tab-1").editor?.error).toBe("Fix the errors before saving.");
    });
  });

  test("recognises revision conflicts with or without the forwarded code", () => {
    expect(
      isGraphRevisionConflict(Object.assign(new Error("x"), { code: "revision-conflict" })),
    ).toBe(true);
    expect(
      isGraphRevisionConflict(new Error("Template a is at revision 3, not 2; reload it")),
    ).toBe(true);
    expect(isGraphRevisionConflict(new Error("limit reached"))).toBe(false);
  });

  test("parseGraphDraft separates syntax from schema errors", () => {
    expect(parseGraphDraft("{").ok).toBe(false);
    expect((parseGraphDraft("{") as { value?: unknown }).value).toBeUndefined();
    expect((parseGraphDraft('{"a": 1}') as { value?: unknown }).value).toEqual({ a: 1 });
    expect(parseGraphDraft(graphTemplateExportText(pipeline.template)).ok).toBe(true);
  });
});
