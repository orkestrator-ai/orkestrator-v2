import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROJECT_ROOT_DROP_ID,
  parseProjectArrangementIntent,
  projectFolderDragId,
} from "@orkestrator/protocol/project-arrangement";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { Project } from "./models.js";
import { StorageService } from "./storage.js";

function project(id: string): Project {
  return {
    id,
    name: id,
    gitUrl: `https://example.invalid/${id}.git`,
    localPath: `/projects/${id}`,
    addedAt: new Date(0).toISOString(),
    order: 0,
  };
}

describe("arranging projects by intent", () => {
  let dataDir: string;
  let storage: StorageService;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-project-arrangement-"));
    storage = new StorageService(dataDir);
    await storage.init();
    for (const id of ["alpha", "beta", "gamma"]) await storage.addProject(project(id));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const summary = async () =>
    (await storage.loadProjects())
      .sort((a, b) => a.order - b.order)
      .map(({ id, folder }) => (folder ? `${id}:${folder}` : id));

  test("a rename reaches every current member, including one another client just added", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: "Work" });
    // Another client files beta into the folder after this client read its copy.
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { beta: "Work" });
    await storage.arrangeProjectsByIntent({
      kind: "rename-folder",
      folder: "work",
      name: "  Clients ",
    });
    expect(await summary()).toEqual(["alpha:Clients", "beta:Clients", "gamma"]);
  });

  test("a move is relative to the current order, keeping another client's reorder", async () => {
    await storage.arrangeProjects(["gamma", "alpha", "beta"]);
    await storage.arrangeProjectsByIntent({ kind: "move", activeId: "beta", overId: "gamma" });
    expect(await summary()).toEqual(["beta", "gamma", "alpha"]);
  });

  test("moves a project into, out of and to the end through drop targets", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: "Work" });
    await storage.arrangeProjectsByIntent({
      kind: "move",
      activeId: "gamma",
      overId: projectFolderDragId("Work"),
    });
    expect(await summary()).toEqual(["gamma:Work", "alpha:Work", "beta"]);
    await storage.arrangeProjectsByIntent({
      kind: "move",
      activeId: "gamma",
      overId: PROJECT_ROOT_DROP_ID,
    });
    expect(await summary()).toEqual(["alpha:Work", "beta", "gamma"]);
  });

  test("add, remove, sort and ungroup resolve against the store", async () => {
    await storage.arrangeProjectsByIntent({
      kind: "add-to-folder",
      projectId: "gamma",
      folder: "Work",
    });
    await storage.arrangeProjectsByIntent({
      kind: "add-to-folder",
      projectId: "alpha",
      folder: "WORK",
    });
    expect(await summary()).toEqual(["beta", "gamma:Work", "alpha:Work"]);
    await storage.arrangeProjectsByIntent({ kind: "sort-folder", folder: "Work" });
    expect(await summary()).toEqual(["beta", "alpha:Work", "gamma:Work"]);
    await storage.arrangeProjectsByIntent({ kind: "remove-from-folder", projectId: "alpha" });
    expect(await summary()).toEqual(["beta", "alpha", "gamma:Work"]);
    await storage.arrangeProjectsByIntent({ kind: "ungroup-folder", folder: "Work" });
    expect(await summary()).toEqual(["beta", "alpha", "gamma"]);
  });

  test("a gesture on a project or folder that is gone changes nothing", async () => {
    const before = await summary();
    for (const intent of [
      { kind: "move", activeId: "deleted", overId: "alpha" },
      { kind: "move", activeId: "alpha", overId: "alpha" },
      { kind: "rename-folder", folder: "Nope", name: "Other" },
      { kind: "ungroup-folder", folder: "Nope" },
      { kind: "sort-folder", folder: "Nope" },
      { kind: "remove-from-folder", projectId: "deleted" },
    ] as const) {
      const result = await storage.arrangeProjectsByIntent(intent);
      expect(result.map(({ id }) => id)).toEqual(["alpha", "beta", "gamma"]);
    }
    expect(await summary()).toEqual(before);
  });

  test("the command validates the intent and returns the ordered projects", async () => {
    const arrange = createCommandRegistry().get("arrange_projects_by_intent")!;
    const context = { storage } as unknown as CommandContext;
    const result = (await arrange(
      { intent: { kind: "move", activeId: "gamma", overId: "alpha" } },
      context,
    )) as Project[];
    expect(result.map(({ id }) => id)).toEqual(["gamma", "alpha", "beta"]);
    await expect(arrange({ intent: { kind: "explode" } }, context)).rejects.toThrow("intent.kind");
    await expect(arrange({ intent: { kind: "move" } }, context)).rejects.toThrow("activeId");
  });
});

describe("parseProjectArrangementIntent", () => {
  test("keeps only the fields of a known kind and bounds their length", () => {
    expect(
      parseProjectArrangementIntent({ kind: "sort-folder", folder: "Work", extra: true }),
    ).toEqual({ kind: "sort-folder", folder: "Work" });
    expect(() => parseProjectArrangementIntent(null)).toThrow();
    expect(() =>
      parseProjectArrangementIntent({ kind: "sort-folder", folder: "x".repeat(1025) }),
    ).toThrow();
  });
});
