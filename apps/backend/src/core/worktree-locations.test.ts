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

  test("rejects a symlink to the filesystem root", async () => {
    const service = await storage();
    const alias = path.join(service.getDataDir(), "root-alias");
    await fs.symlink(path.parse(service.getDataDir()).root, alias);
    expect(() => validateWorktreeLocation(alias, options)).toThrow("filesystem root");
  });

  test("rejects canonical paths ending in whitespace without trimming their destination", async () => {
    const fixture = await fs.mkdtemp(path.join(tmpdir(), "ork-whitespace-"));
    directories.push(fixture);
    for (const suffix of [" ", "\t"]) {
      const target = path.join(fixture, `trees${suffix}`);
      const alias = path.join(fixture, `alias-${suffix.length}-${suffix.charCodeAt(0)}`);
      await fs.mkdir(target);
      await fs.symlink(target, alias);
      expect(() => validateWorktreeLocation(alias, options)).toThrow("surrounding whitespace");
      expect(await fs.stat(path.join(fixture, "trees")).catch(() => null)).toBeNull();
    }
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

  test("preserve saved settings when aliases resolve to root or trailing whitespace", async () => {
    const service = await storage();
    const fixture = await fs.mkdtemp(path.join(tmpdir(), "ork-invalid-aliases-"));
    directories.push(fixture);
    const previous = {
      environments: path.join(await fs.realpath(fixture), "trees"),
      dev: path.join(await fs.realpath(fixture), "dev-trees"),
    };
    await updateWorktreeLocations(previous, { storage: service });
    const whitespaceTarget = path.join(fixture, "trees ");
    await fs.mkdir(whitespaceTarget);
    for (const [name, target, error] of [
      ["root", path.parse(fixture).root, "filesystem root"],
      ["whitespace", whitespaceTarget, "surrounding whitespace"],
    ] as const) {
      const alias = path.join(fixture, name);
      await fs.symlink(target, alias);
      for (const key of ["environments", "dev"] as const) {
        await expect(
          updateWorktreeLocations({ ...previous, [key]: alias }, { storage: service }),
        ).rejects.toThrow(error);
        expect((await service.loadConfig()).global.worktreeLocations).toEqual(previous);
        const reloaded = new StorageService(service.getDataDir());
        await reloaded.init();
        expect((await getWorktreeLocations({ storage: reloaded })).environments.configured).toBe(
          previous.environments,
        );
        expect((await getWorktreeLocations({ storage: reloaded })).dev.configured).toBe(
          previous.dev,
        );
      }
    }
  });

  test("save a folder chosen through a symlink as its real path", async () => {
    const service = await storage();
    const fixture = await fs.mkdtemp(path.join(tmpdir(), "ork-volume-"));
    directories.push(fixture);
    const volume = path.join(fixture, "volume");
    await fs.mkdir(volume);
    await fs.symlink(volume, path.join(fixture, "home-alias"));

    await updateWorktreeLocations(
      { environments: path.join(fixture, "home-alias", "trees"), dev: null },
      { storage: service },
    );
    expect((await service.loadConfig()).global.worktreeLocations).toEqual({
      environments: path.join(await fs.realpath(volume), "trees"),
    });
  });
});

test("rejects aliases to protected roots and resolves other aliases to the real folder", async () => {
  const service = await storage();
  const root = path.dirname(service.getDataDir());
  const fixture = await fs.mkdtemp(path.join(root, "ork-aliases-"));
  directories.push(fixture);
  const project = path.join(fixture, "project");
  await fs.mkdir(project);
  for (const [name, target] of [
    ["project", project],
    ["data", service.getDataDir()],
  ] as const) {
    const alias = path.join(fixture, `${name}-alias`);
    await fs.symlink(target, alias);
    for (const suffix of ["", "new/trailing/folder"]) {
      expect(() =>
        validateWorktreeLocation(path.join(alias, suffix), {
          label: "Environment",
          dataDir: service.getDataDir(),
          projectPath: project,
        }),
      ).toThrow();
      expect(() =>
        validateWorktreeLocation(path.join(alias, suffix), {
          label: "Dev",
          dataDir: service.getDataDir(),
          projectPath: project,
        }),
      ).toThrow();
    }
  }
  const ordinary = path.join(fixture, "ordinary");
  await fs.mkdir(ordinary);
  await fs.symlink(ordinary, path.join(fixture, "alias"));
  expect(
    validateWorktreeLocation(path.join(fixture, "alias", "new"), {
      label: "Location",
      dataDir: service.getDataDir(),
    }),
  ).toBe(path.join(await fs.realpath(ordinary), "new"));
});

test("rejects the profiles directory as a dev setting before saving", async () => {
  const service = await storage();
  const snapshot = await getWorktreeLocations({ storage: service });
  await expect(
    updateWorktreeLocations({ dev: snapshot.dev.defaultPath }, { storage: service }),
  ).rejects.toThrow("profiles directory");
  expect((await service.loadConfig()).global.worktreeLocations).toBeUndefined();
});

test("dev setting is read-only only in development-profile backends", async () => {
  const service = await storage();
  for (const runtimeFlavor of ["production", "development", "agent-test"] as const) {
    const value = await getWorktreeLocations({ storage: service, runtimeFlavor });
    expect(value.dev.readOnly).toBe(runtimeFlavor !== "production");
  }
});
