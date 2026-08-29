import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "./models.js";
import { StorageService } from "./storage.js";
import { OrkestratorBackend } from "./index.js";

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

describe("StorageService project folders", () => {
  let dataDir: string;
  let storage: StorageService;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-project-folders-"));
    storage = new StorageService(dataDir);
    await storage.init();
    await storage.addProject(project("alpha"));
    await storage.addProject(project("beta"));
    await storage.addProject(project("gamma"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const readStoredProjects = async (): Promise<Project[]> =>
    JSON.parse(await fs.readFile(path.join(dataDir, "projects.json"), "utf8")) as Project[];

  test("applies order and folder membership in one write", async () => {
    const arranged = await storage.arrangeProjects(["gamma", "alpha", "beta"], {
      gamma: "Work",
      alpha: "Work",
    });
    expect(arranged.map(({ id, order, folder }) => ({ id, order, folder }))).toEqual([
      { id: "gamma", order: 0, folder: "Work" },
      { id: "alpha", order: 1, folder: "Work" },
      { id: "beta", order: 2, folder: undefined },
    ]);
    expect((await storage.loadProjects()).map(({ id }) => id)).toEqual(["gamma", "alpha", "beta"]);
  });

  test("normalizes a typed name before it is stored", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: "  Work   Projects \n" });
    expect((await storage.getProject("alpha"))?.folder).toBe("Work Projects");
  });

  test("clears membership without leaving a null on the record", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: "Work" });
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: null });

    const stored = await readStoredProjects();
    const alpha = stored.find((candidate) => candidate.id === "alpha");
    expect(alpha).toBeDefined();
    expect("folder" in alpha!).toBe(false);
  });

  test("a blank name means no folder rather than a folder called nothing", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { alpha: "   " });
    expect((await storage.getProject("alpha"))?.folder).toBeUndefined();
  });

  test("ignores an assignment for a project another client already deleted", async () => {
    await expect(
      storage.arrangeProjects(["alpha", "beta", "gamma"], { missing: "Work", beta: "Work" }),
    ).resolves.toBeDefined();
    expect((await storage.getProject("beta"))?.folder).toBe("Work");
  });

  test("update_project can move a single project between folders", async () => {
    await storage.updateProject("alpha", { folder: "Work" });
    expect((await storage.getProject("alpha"))?.folder).toBe("Work");
    await storage.updateProject("alpha", { folder: null });
    expect((await storage.getProject("alpha"))?.folder).toBeUndefined();
  });

  test("an update that does not mention the folder leaves membership alone", async () => {
    await storage.updateProject("alpha", { folder: "Work" });
    await storage.updateProject("alpha", { name: "renamed" });
    expect((await storage.getProject("alpha"))?.folder).toBe("Work");
  });

  test("reorderProjects still orders and preserves membership", async () => {
    await storage.arrangeProjects(["alpha", "beta", "gamma"], { beta: "Work" });
    const reordered = await storage.reorderProjects(["gamma", "beta"]);
    expect(reordered.map(({ id }) => id)).toEqual(["gamma", "beta", "alpha"]);
    expect(reordered.find((candidate) => candidate.id === "beta")?.folder).toBe("Work");
  });

  test("projects stored before folders existed load unchanged", async () => {
    await fs.writeFile(
      path.join(dataDir, "projects.json"),
      JSON.stringify([{ ...project("legacy"), order: 0 }]),
    );
    const legacyStorage = new StorageService(dataDir);
    await legacyStorage.init();
    const loaded = await legacyStorage.loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.folder).toBeUndefined();
  });
});

describe("arrange_projects command", () => {
  async function withBackend(run: (backend: OrkestratorBackend) => Promise<void>): Promise<void> {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-arrange-projects-"));
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
      startupReapers: {
        localServers: async () => [],
        claudeTmuxRuntimes: async () => [],
      },
    });
    try {
      await backend.init();
      await run(backend);
    } finally {
      await backend.shutdown().catch(() => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }

  test("orders projects and files them into folders", async () => {
    await withBackend(async (backend) => {
      const first = await backend.invoke<Project>("add_project", {
        gitUrl: "https://example.invalid/first.git",
      });
      const second = await backend.invoke<Project>("add_project", {
        gitUrl: "https://example.invalid/second.git",
      });

      const arranged = await backend.invoke<Project[]>("arrange_projects", {
        projectIds: [second.id, first.id],
        folders: { [second.id]: "Work" },
      });
      expect(arranged.map(({ id, folder }) => ({ id, folder }))).toEqual([
        { id: second.id, folder: "Work" },
        { id: first.id, folder: undefined },
      ]);
    });
  });

  test("accepts an omitted folders map and rejects unknown keys or bad values", async () => {
    await withBackend(async (backend) => {
      const project = await backend.invoke<Project>("add_project", {
        gitUrl: "https://example.invalid/only.git",
      });
      await expect(
        backend.invoke<Project[]>("arrange_projects", { projectIds: [project.id] }),
      ).resolves.toHaveLength(1);
      await expect(
        backend.invoke("arrange_projects", { projectIds: [project.id], unexpected: 1 }),
      ).rejects.toThrow();
      await expect(
        backend.invoke("arrange_projects", {
          projectIds: [project.id],
          folders: { [project.id]: 7 },
        }),
      ).rejects.toThrow(/must be a string or null/);
    });
  });
});
