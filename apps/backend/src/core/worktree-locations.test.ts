import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StorageService } from "./storage.js";
import {
  getWorktreeBaseDir,
  getWorktreeLocations,
  resolveEnvironmentWorktreeRoot,
  updateWorktreeLocations,
  validateWorktreeLocation,
} from "./worktree-locations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function storage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-worktree-locations-"));
  directories.push(dataDir);
  const service = new StorageService(dataDir);
  await service.init();
  return service;
}

describe("validateWorktreeLocation", () => {
  const options = { label: "Location", dataDir: "/data/orkestrator", projectPath: "/code/app" };

  test("resolves an absolute folder", () => {
    expect(validateWorktreeLocation(" /code/worktrees/../trees ", options)).toBe("/code/trees");
  });

  test("refuses folders a deletion could damage", () => {
    expect(() => validateWorktreeLocation("relative/path", options)).toThrow("absolute");
    expect(() => validateWorktreeLocation("/", options)).toThrow("filesystem root");
    expect(() => validateWorktreeLocation("/data/orkestrator/trees", options)).toThrow(
      "data directory",
    );
    expect(() => validateWorktreeLocation("/code/app/.trees", options)).toThrow("project checkout");
    expect(() => validateWorktreeLocation("/code/a\0b", options)).toThrow("NUL");
    expect(() => validateWorktreeLocation(42, options)).toThrow("string");
  });
});

describe("worktree location settings", () => {
  test("place new environments unless a startup directory overrides them", async () => {
    const service = await storage();
    expect(await resolveEnvironmentWorktreeRoot({ storage: service })).toBe(getWorktreeBaseDir());

    await updateWorktreeLocations({ environments: "/srv/trees", dev: null }, { storage: service });
    expect(await resolveEnvironmentWorktreeRoot({ storage: service })).toBe("/srv/trees");
    expect(
      await resolveEnvironmentWorktreeRoot({ storage: service, worktreeDir: "/profile/trees" }),
    ).toBe("/profile/trees");

    const snapshot = await getWorktreeLocations({
      storage: service,
      worktreeDir: "/profile/trees",
    });
    expect(snapshot.environments).toMatchObject({
      configured: "/srv/trees",
      effective: "/profile/trees",
      startupOverride: "/profile/trees",
    });
    expect(snapshot.dev.configured).toBeNull();
  });

  test("survive a renderer settings save and clear back to the default", async () => {
    const service = await storage();
    await updateWorktreeLocations(
      { environments: "/srv/trees", dev: "/srv/dev-trees" },
      { storage: service },
    );
    const { worktreeLocations: _omitted, ...rendererGlobal } = (await service.loadConfig()).global;
    await service.updateGlobalConfig(rendererGlobal);
    expect((await service.loadConfig()).global.worktreeLocations).toEqual({
      environments: "/srv/trees",
      dev: "/srv/dev-trees",
    });

    await updateWorktreeLocations({ environments: "", dev: null }, { storage: service });
    expect((await service.loadConfig()).global.worktreeLocations).toBeUndefined();
  });

  test("reject an invalid folder without saving", async () => {
    const service = await storage();
    await expect(
      updateWorktreeLocations({ environments: "trees", dev: null }, { storage: service }),
    ).rejects.toThrow("absolute");
    expect((await service.loadConfig()).global.worktreeLocations).toBeUndefined();
  });
});
