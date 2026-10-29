import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { graphTemplateExportText } from "@orkestrator/protocol/graphs/library";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  builtInDetail,
  compileResponse,
  listResult,
  userDetail,
} from "@/components/graph-designer/graph-designer.test-fixtures";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { addGraphNode, blankGraphTemplate } from "@/components/graph-designer/graph-designer-edits";
import { GRAPH_DESIGNER_HISTORY_LIMIT } from "@/components/graph-designer/graph-designer-history";
import {
  graphDesignerTab,
  graphDraftDirty,
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

  describe("editor", () => {
    const mine = userDetail({ ...pipeline.template, id: "mine", name: "Mine" }, 4);
    const rename = (name: string) => (template: GraphTemplateV1) => ({ ...template, name });

    async function openMine() {
      install({
        graph_template_get: () => mine,
        graph_template_compile: () => compileResponse(mine.template),
      });
      await useGraphDesignerStore.getState().openTemplate("tab-1", mine.summary.ref, null);
      useGraphDesignerStore.getState().openEditor("tab-1");
    }

    test("opens only for user templates, on the stored revision", async () => {
      install({
        graph_template_get: () => pipeline,
        graph_template_compile: () => compileResponse(pipeline.template),
      });
      await useGraphDesignerStore.getState().openTemplate("tab-b", pipeline.summary.ref, null);
      useGraphDesignerStore.getState().openEditor("tab-b");
      expect(graphDesignerTab("tab-b").editor).toBeNull();

      await openMine();
      const editor = graphDesignerTab("tab-1").editor!;
      expect(editor).toMatchObject({ baseRevision: 4, isNew: false, conflict: false });
      expect(editor.draft).toBe(mine.template);
      expect(graphDraftDirty(editor)).toBe(false);
    });

    test("records each edit as an undo step, coalescing typing in one field", async () => {
      await openMine();
      const store = useGraphDesignerStore.getState();
      store.edit("tab-1", "Name", rename("M"), { coalesce: "name" });
      store.edit("tab-1", "Name", rename("Mi"), { coalesce: "name" });
      store.edit("tab-1", "Name", rename("Min"), { coalesce: "name" });
      store.edit("tab-1", "Description", (template) => ({ ...template, description: "x" }));
      let editor = graphDesignerTab("tab-1").editor!;
      expect(editor.history.past.map((entry) => entry.label)).toEqual(["Name", "Description"]);
      expect(graphDraftDirty(editor)).toBe(true);
      // A recipe that returns the same template is no edit.
      store.edit("tab-1", "Nothing", (template) => template);
      expect(graphDesignerTab("tab-1").editor!.history.past).toHaveLength(2);

      expect(store.undo("tab-1")).toBe("Description");
      expect(store.undo("tab-1")).toBe("Name");
      editor = graphDesignerTab("tab-1").editor!;
      expect(editor.draft.name).toBe("Mine");
      expect(editor.draft).toBe(mine.template);
      expect(graphDraftDirty(editor)).toBe(false);
      expect(store.undo("tab-1")).toBeNull();

      expect(store.redo("tab-1")).toBe("Name");
      expect(graphDesignerTab("tab-1").editor!.draft.name).toBe("Min");
      // A new edit after an undo drops the redo branch.
      store.edit("tab-1", "Other", rename("Other"));
      expect(graphDesignerTab("tab-1").editor!.history.future).toEqual([]);
      expect(store.redo("tab-1")).toBeNull();
    });

    test("bounds the undo history", async () => {
      await openMine();
      const store = useGraphDesignerStore.getState();
      for (let index = 0; index < GRAPH_DESIGNER_HISTORY_LIMIT + 25; index++) {
        store.edit("tab-1", `Edit ${index}`, rename(`Name ${index}`));
      }
      const past = graphDesignerTab("tab-1").editor!.history.past;
      expect(past).toHaveLength(GRAPH_DESIGNER_HISTORY_LIMIT);
      expect(past[0]!.label).toBe("Edit 25");
    });

    test("compiles the draft in the browser", async () => {
      await openMine();
      const store = useGraphDesignerStore.getState();
      store.edit("tab-1", "Bound", (template) => {
        const next = structuredClone(template);
        next.loops![0]!.maxIterations = 11;
        return next;
      });
      store.compileDraft("tab-1", { providers: ["claude", "codex"] });
      const tab = graphDesignerTab("tab-1");
      expect(tab.compile?.source).toBe("browser");
      expect(tab.compile?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "loop-bound-exceeded",
      );
      expect(tab.compile?.plan).toBeNull();
      // A refresh from the backend (a change, a safety check) keeps the draft's compile.
      install({
        graph_template_get: () => mine,
        graph_template_compile: () => compileResponse(mine.template),
      });
      await store.refreshTab("tab-1");
      expect(graphDesignerTab("tab-1")).toMatchObject({ compileStatus: "ready" });
      expect(graphDesignerTab("tab-1").compile?.source).toBe("browser");
    });

    test("saves with compare-and-swap on the base revision and continues on the stored template", async () => {
      await openMine();
      const saved = userDetail({ ...mine.template, name: "Renamed" }, 5);
      install({
        graph_template_save: () => saved,
        graph_templates_list: () => listResult([saved.summary]),
      });
      const store = useGraphDesignerStore.getState();
      store.edit("tab-1", "Name", rename("Renamed"));
      expect(await store.saveDraft("tab-1")).toEqual(saved);
      const save = calls("graph_template_save")[0]!;
      expect(save.expectedRevision).toBe(4);
      expect(save.template as GraphTemplateV1).toMatchObject({ name: "Renamed", revision: 4 });
      const tab = graphDesignerTab("tab-1");
      expect(tab.detail).toEqual(saved);
      expect(tab.editor).toMatchObject({ baseRevision: 5, conflict: false, saving: false });
      expect(graphDraftDirty(tab.editor)).toBe(false);
      // The history survives the save, so the edit can still be undone.
      expect(tab.editor!.history.past).toHaveLength(1);
    });

    test("keeps the draft on a conflict, then saves it as a copy", async () => {
      await openMine();
      const copy = userDetail({ ...mine.template, id: "mine-copy", name: "Ours (copy)" }, 1);
      install({
        graph_template_save: () => {
          throw new Error("Template mine is at revision 6, not 4; reload it before saving");
        },
        graph_template_import: () => ({ ok: true, detail: copy }),
        graph_templates_list: () => listResult([copy.summary]),
      });
      const store = useGraphDesignerStore.getState();
      store.edit("tab-1", "Name", rename("Ours"));
      expect(await store.saveDraft("tab-1")).toBeNull();
      let tab = graphDesignerTab("tab-1");
      expect(tab.editor).toMatchObject({ conflict: true, saving: false, baseRevision: 4 });
      expect(tab.editor!.draft.name).toBe("Ours");
      expect(tab.editor!.error).toContain("revision 4");

      expect(await store.saveDraftAsCopy("tab-1")).toEqual(copy);
      const imported = JSON.parse(calls("graph_template_import")[0]!.text as string);
      expect(imported).toMatchObject({ id: "mine-copy", name: "Ours (copy)", revision: 0 });
      tab = graphDesignerTab("tab-1");
      expect(tab.selected).toEqual(copy.summary.ref);
      expect(tab.editor).toMatchObject({ baseRevision: 1, conflict: false, isNew: false });
    });

    test("reload after a conflict starts again from the latest revision", async () => {
      await openMine();
      const latest = userDetail({ ...mine.template, name: "Theirs" }, 6);
      install({ graph_template_get: () => latest });
      const store = useGraphDesignerStore.getState();
      store.edit("tab-1", "Name", rename("Ours"));
      await store.reloadDraft("tab-1");
      const editor = graphDesignerTab("tab-1").editor!;
      expect(editor).toMatchObject({ baseRevision: 6, conflict: false });
      expect(editor.draft.name).toBe("Theirs");
      expect(editor.history.past).toEqual([]);
    });

    test("a new draft saves as a new template, and refuses to save while incomplete", async () => {
      install({});
      const store = useGraphDesignerStore.getState();
      store.openDraft("tab-n", blankGraphTemplate({ id: "fresh", name: "Fresh" }), "project-1");
      let tab = graphDesignerTab("tab-n");
      expect(tab.selected).toBeNull();
      expect(tab.editor).toMatchObject({ isNew: true, baseRevision: 0 });
      expect(graphDraftDirty(tab.editor)).toBe(true);
      // No nodes yet: the template guard refuses it before anything is sent.
      expect(await store.saveDraft("tab-n")).toBeNull();
      expect(calls("graph_template_save")).toHaveLength(0);
      expect(graphDesignerTab("tab-n").editor!.saveErrors.map((error) => error.path)).toContain(
        "nodes",
      );

      store.edit(
        "tab-n",
        "Add",
        (template) => addGraphNode(template, { kind: "agent" }, { x: 0, y: 0 }).template,
      );
      const saved = userDetail(graphDesignerTab("tab-n").editor!.draft, 1);
      install({
        graph_template_save: () => saved,
        graph_templates_list: () => listResult([saved.summary]),
      });
      expect(await store.saveDraft("tab-n")).toEqual(saved);
      expect(calls("graph_template_save")[0]).toMatchObject({
        expectedRevision: 0,
        projectId: "project-1",
      });
      tab = graphDesignerTab("tab-n");
      expect(tab.selected).toEqual(saved.summary.ref);
      expect(tab.editor).toMatchObject({ isNew: false, baseRevision: 1 });
    });

    test("a new draft whose id is taken offers a copy", async () => {
      install({
        graph_template_save: () => {
          throw new Error("Template fresh is at revision 2, not 0; reload it before saving");
        },
      });
      const store = useGraphDesignerStore.getState();
      store.openDraft(
        "tab-n",
        addGraphNode(blankGraphTemplate({ id: "fresh" }), { kind: "agent" }, { x: 0, y: 0 })
          .template,
        null,
      );
      expect(await store.saveDraft("tab-n")).toBeNull();
      expect(graphDesignerTab("tab-n").editor).toMatchObject({ conflict: true });
      expect(graphDesignerTab("tab-n").editor!.error).toContain("already exists");
    });

    test("records an acknowledgement against the warning's digest as an undoable edit", async () => {
      await openMine();
      const store = useGraphDesignerStore.getState();
      const digest = "a".repeat(64);
      store.acknowledge("tab-1", {
        kind: "taint",
        digest,
        code: "taint-reaches-side-effect",
        nodeId: "build",
      });
      const editor = graphDesignerTab("tab-1").editor!;
      expect(editor.draft.acknowledgements).toEqual([
        expect.objectContaining({ kind: "taint", digest, code: "taint-reaches-side-effect" }),
      ]);
      expect(editor.history.past.at(-1)!.label).toContain("Acknowledge");
      store.undo("tab-1");
      expect(graphDesignerTab("tab-1").editor!.draft.acknowledgements).toBeUndefined();
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
