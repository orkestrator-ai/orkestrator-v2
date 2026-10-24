import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandContext, CommandHandler } from "./commands-context.js";
import {
  defaultProjectLocation,
  registerProjectCopyCommands,
} from "./commands-registry-project-copy.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function storage(projects: Array<{ localPath?: string }>, configured?: string) {
  return {
    loadConfig: async () =>
      ({
        global: configured ? { defaultProjectsDirectory: configured } : {},
      }) as never,
    loadProjects: async () => projects as never,
  };
}

describe("defaultProjectLocation", () => {
  test("uses the configured folder first", async () => {
    const result = await defaultProjectLocation(
      storage([{ localPath: "/work/a" }, { localPath: "/work/b" }], "/configured"),
      "site.git",
    );
    expect(result).toEqual({
      directory: "/configured",
      location: path.join("/configured", "site"),
      source: "setting",
    });
  });

  test("falls back to the most common parent of existing projects, then ~/Projects", async () => {
    const common = await defaultProjectLocation(
      storage([{ localPath: "/work/a" }, { localPath: "/work/b" }, { localPath: "/other/c" }]),
      "site",
    );
    expect(common).toMatchObject({ directory: "/work", source: "projects" });

    const home = await defaultProjectLocation(storage([]), "site");
    expect(home).toMatchObject({
      directory: path.join(os.homedir(), "Projects"),
      source: "home",
    });
  });

  test("picks the first free name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-default-location-"));
    roots.push(root);
    await mkdir(path.join(root, "site"));
    await mkdir(path.join(root, "site-2"));

    const result = await defaultProjectLocation(storage([], root), "site");

    expect(result.location).toBe(path.join(root, "site-3"));
  });

  test("continues beyond twenty occupied names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-default-location-"));
    roots.push(root);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mkdir(path.join(root, i === 0 ? "site" : `site-${i + 1}`)),
      ),
    );
    expect((await defaultProjectLocation(storage([], root), "site")).location).toBe(
      path.join(root, "site-21"),
    );
  });

  test("refuses names that would leave the folder", async () => {
    await expect(defaultProjectLocation(storage([], "/x"), "..")).rejects.toThrow();
    expect((await defaultProjectLocation(storage([], "/x"), "a/b")).location).toBe(
      path.join("/x", "a-b"),
    );
  });
});

describe("project clone jobs", () => {
  function commands(run: () => Promise<{ stdout: string; stderr: string }>) {
    const registry = new Map<string, CommandHandler>();
    registerProjectCopyCommands((name, handler) => registry.set(name, handler), {
      runProjectCreationCommand: run as never,
    });
    const context = {
      storage: {
        loadProjects: async () => [],
        withProjectCreationLock: async (_key: string, operation: () => Promise<unknown>) =>
          operation(),
      },
    } as unknown as CommandContext;
    return (name: string, args: Record<string, unknown>) => registry.get(name)!(args, context);
  }

  test("reports a failed clone without credentials, and refuses a reused key", async () => {
    const invoke = commands(async () => {
      throw new Error("clone of https://user:token@example.test/a.git failed");
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-clone-job-"));
    roots.push(root);
    const localPath = path.join(root, "site");

    const started = (await invoke("start_project_clone", {
      requestKey: "k1",
      gitUrl: "https://example.test/a.git",
      localPath,
    })) as { state: string };
    expect(started.state).toBe("running");
    let job = started as { state: string; error?: string };
    for (let index = 0; index < 50 && job.state === "running"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = (await invoke("get_project_clone", {
        requestKey: "k1",
      })) as typeof job;
    }
    expect(job.state).toBe("failed");
    expect(job.error).not.toContain("token");

    await expect(
      invoke("start_project_clone", {
        requestKey: "k1",
        gitUrl: "https://example.test/other.git",
        localPath,
      }),
    ).rejects.toThrow("different clone");
    expect(await invoke("get_project_clone", { requestKey: "nope" })).toEqual({
      requestKey: "nope",
      state: "unknown",
    });
  });

  test("finished jobs within the retention TTL do not use running capacity", async () => {
    const invoke = commands(async () => {
      throw new Error("clone failed");
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "ork-clone-capacity-"));
    roots.push(root);
    for (let i = 0; i < 50; i++) {
      await invoke("start_project_clone", {
        requestKey: `k${i}`,
        gitUrl: "https://example.test/a.git",
        localPath: path.join(root, `site-${i}`),
      });
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobs = (await Promise.all(
        Array.from({ length: 50 }, (_, i) => invoke("get_project_clone", { requestKey: `k${i}` })),
      )) as Array<{ state: string }>;
      if (jobs.every((job) => job.state !== "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await invoke("get_project_clone", { requestKey: "k49" })).toMatchObject({
      state: "failed",
    });
    expect(
      await invoke("start_project_clone", {
        requestKey: "next",
        gitUrl: "https://example.test/a.git",
        localPath: path.join(root, "next"),
      }),
    ).toMatchObject({ state: "running" });
  });

  test("refuses a relative location", async () => {
    const invoke = commands(async () => ({ stdout: "", stderr: "" }));
    await expect(
      invoke("start_project_clone", {
        requestKey: "k",
        gitUrl: "https://example.test/a.git",
        localPath: "relative/site",
      }),
    ).rejects.toThrow("absolute");
  });
});
