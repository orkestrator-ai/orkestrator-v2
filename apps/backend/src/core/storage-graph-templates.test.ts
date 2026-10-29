import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRAPH_LIBRARY_BOUNDS } from "@orkestrator/protocol/graphs/library";
import { GraphTemplateError } from "./graph-template-errors.js";
import { recordGraphTemplateChanges, sampleGraphTemplate } from "./graph-template-test-support.js";
import { StorageService, createProject } from "./storage.js";
import { readStoredValue } from "./storage-test-support.js";

let root: string;
let storage: StorageService;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-graph-store-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
});

afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<GraphTemplateError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphTemplateError);
    return error as GraphTemplateError;
  }
  throw new Error("Expected a GraphTemplateError");
}

describe("user templates", () => {
  test("save creates at revision 1 and compare-and-swaps after that", async () => {
    const store = storage.graphTemplates;
    const first = await store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 0);
    expect(first.revision).toBe(1);
    expect(first.template.revision).toBe(1);
    const second = await store.saveGraphTemplateRecord({ ...first.template, name: "Renamed" }, 1);
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.getGraphTemplateRecord("a")?.template.name).toBe("Renamed");
  });

  test("a save at a stale revision conflicts and changes nothing", async () => {
    const store = storage.graphTemplates;
    await store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 0);
    await store.saveGraphTemplateRecord({ ...sampleGraphTemplate("a"), name: "Second" }, 1);
    const stale = await rejection(
      store.saveGraphTemplateRecord({ ...sampleGraphTemplate("a"), name: "Stale" }, 1),
    );
    expect(stale.code).toBe("revision-conflict");
    // Creating over an existing id is a stale revision too.
    expect((await rejection(store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 0))).code).toBe(
      "revision-conflict",
    );
    // Updating a template that does not exist.
    expect((await rejection(store.saveGraphTemplateRecord(sampleGraphTemplate("b"), 3))).code).toBe(
      "revision-conflict",
    );
    const stored = store.getGraphTemplateRecord("a");
    expect(stored?.revision).toBe(2);
    expect(stored?.template.name).toBe("Second");
  });

  test("delete honours an expected revision and announces", async () => {
    const store = storage.graphTemplates;
    const changes = recordGraphTemplateChanges(storage);
    await store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 0);
    expect((await rejection(() => store.deleteGraphTemplateRecord("a", 5))).code).toBe(
      "revision-conflict",
    );
    expect(store.deleteGraphTemplateRecord("a", 1)).toBe(true);
    expect(store.deleteGraphTemplateRecord("a")).toBe(false);
    expect(store.getGraphTemplateRecord("a")).toBeNull();
    expect(changes.ids).toEqual(["user:a", "user:a"]);
    changes.stop();
  });

  test("lists templates and bounds their number", async () => {
    const store = storage.graphTemplates;
    await store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 0);
    await store.saveGraphTemplateRecord(sampleGraphTemplate("b"), 0);
    expect((await store.listGraphTemplateRecords()).map((record) => record.id).sort()).toEqual([
      "a",
      "b",
    ]);
    const stored = readStoredValue<{ templates: Record<string, unknown> }>(
      storage.getDataDir(),
      "graph-templates.json",
    );
    expect(Object.keys(stored?.templates ?? {}).sort()).toEqual(["a", "b"]);

    for (let index = 2; index < GRAPH_LIBRARY_BOUNDS.maxUserTemplates; index += 1) {
      await store.saveGraphTemplateRecord(sampleGraphTemplate(`t-${index}`), 0);
    }
    expect(
      (await rejection(store.saveGraphTemplateRecord(sampleGraphTemplate("over"), 0))).code,
    ).toBe("limit");
    // Updating an existing template is still allowed at the bound.
    expect((await store.saveGraphTemplateRecord(sampleGraphTemplate("a"), 1)).revision).toBe(2);
  });
});

describe("project settings", () => {
  test("ceiling compare-and-swap, reset and removal with the project", async () => {
    const project = await storage.addProject(createProject("https://example.invalid/r.git"));
    const store = storage.graphTemplates;
    expect(store.getGraphProjectSettings(project.id)).toBeNull();
    const set = store.setGraphProjectCeiling(project.id, { deny: ["network"] }, 0);
    expect(set.ceiling).toEqual({ deny: ["network"] });
    expect(set.ceilingRevision).toBe(1);
    expect((await rejection(() => store.setGraphProjectCeiling(project.id, null, 0))).code).toBe(
      "revision-conflict",
    );
    const reset = store.setGraphProjectCeiling(project.id, null, 1);
    expect(reset.ceiling).toBeUndefined();
    expect(reset.ceilingRevision).toBe(2);

    store.approveGraphProjectTemplate(
      project.id,
      {
        path: ".orkestrator/graphs/a.graph.json",
        digest: "a".repeat(64),
        approvedAt: "2026-10-29T00:00:00.000Z",
      },
      new Set([".orkestrator/graphs/a.graph.json"]),
    );
    expect(store.getGraphProjectSettings(project.id)?.trust).toHaveLength(1);
    await storage.removeProject(project.id);
    expect(store.getGraphProjectSettings(project.id)).toBeNull();
  });

  test("approvals replace per path, drop vanished paths and can be revoked", () => {
    const store = storage.graphTemplates;
    const a = ".orkestrator/graphs/a.graph.json";
    const b = ".orkestrator/graphs/b.graph.json";
    const at = "2026-10-29T00:00:00.000Z";
    store.approveGraphProjectTemplate(
      "p1",
      { path: a, digest: "1".repeat(64), approvedAt: at },
      new Set([a, b]),
    );
    store.approveGraphProjectTemplate(
      "p1",
      { path: b, digest: "2".repeat(64), approvedAt: at },
      new Set([a, b]),
    );
    store.approveGraphProjectTemplate(
      "p1",
      { path: a, digest: "3".repeat(64), approvedAt: at },
      new Set([a, b]),
    );
    expect(
      store.getGraphProjectSettings("p1")?.trust.map((record) => [record.path, record.digest[0]]),
    ).toEqual([
      [a, "3"],
      [b, "2"],
    ]);
    // b's file is gone: approving a again forgets it.
    store.approveGraphProjectTemplate(
      "p1",
      { path: a, digest: "4".repeat(64), approvedAt: at },
      new Set([a]),
    );
    expect(store.getGraphProjectSettings("p1")?.trust.map((record) => record.path)).toEqual([a]);
    expect(store.revokeGraphProjectTemplate("p1", a).revoked).toBe(true);
    expect(store.revokeGraphProjectTemplate("p1", a).revoked).toBe(false);
    expect(store.getGraphProjectSettings("p1")?.trust).toEqual([]);
  });
});
