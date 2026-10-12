import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findDevProfiles,
  getEnvironmentDiskUsage,
  listDiskUsageEnvironments,
  measureEnvironmentDiskUsage,
  parseDuOutput,
  summarizeEntries,
  type DiskUsageProbes,
} from "./disk-usage.js";
import { emptyContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { StorageService, createProject } from "./storage.js";
import type { Environment } from "./models.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

async function writeProfile(
  profilesDirectory: string,
  id: string,
  repositoryRoot: string,
  worktreeDir = path.join(profilesDirectory, id, "worktrees"),
): Promise<string> {
  const profileRoot = path.join(profilesDirectory, id);
  await fs.mkdir(profileRoot, { recursive: true });
  await fs.writeFile(
    path.join(profileRoot, "profile.json"),
    JSON.stringify({ id, repositoryRoot, profileRoot, worktreeDir }),
  );
  return profileRoot;
}

/** A `du` that reports fixed kilobyte sizes for the directories it is asked about. */
function fakeDu(sizesKb: Record<string, Record<string, number>>): DiskUsageProbes["du"] {
  return async (args) => {
    // BSD (macOS) `du` treats -a, -s and -d as mutually exclusive.
    if (["-a", "-s", "-d"].filter((flag) => args.includes(flag)).length > 1) {
      throw new Error("du: usage");
    }
    const directory = args.at(-1)!;
    const children = sizesKb[directory];
    if (!children) return "";
    return Object.entries(children)
      .map(([name, kb]) => `${kb}\t${name === "." ? directory : path.join(directory, name)}`)
      .join("\n");
  };
}

function environment(overrides: Partial<Environment>): Environment {
  return {
    id: "e1",
    projectId: "p1",
    name: "feature",
    branch: "feature",
    containerId: null,
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    order: 0,
    environmentType: "local",
    ...overrides,
  } as Environment;
}

describe("disk usage parsing", () => {
  test("reads du kilobyte lines as bytes", () => {
    const sizes = parseDuOutput("12\t/w/a\n3\t/w/b c\nnot a line\n15\t/w\n");
    expect(sizes.get("/w/a")).toBe(12 * 1024);
    expect(sizes.get("/w/b c")).toBe(3 * 1024);
    expect(sizes.get("/w")).toBe(15 * 1024);
  });

  test("sums entries past the limit into one row", () => {
    const entries = [5, 4, 3, 2, 1].map((bytes) => ({ label: `e${bytes}`, path: null, bytes }));
    expect(summarizeEntries(entries, 2)).toEqual([
      { label: "e5", path: null, bytes: 5 },
      { label: "e4", path: null, bytes: 4 },
      { label: "3 more", path: null, bytes: 6 },
    ]);
  });
});

describe("dev profiles of an environment", () => {
  test("are matched by the repository they were started from", async () => {
    const profiles = await tempDir("ork-disk-profiles-");
    await writeProfile(profiles, "workspace-aaaa", "/w/project-feature");
    await writeProfile(profiles, "qa-run", "/w/project-feature/");
    await writeProfile(profiles, "workspace-bbbb", "/w/project-other");
    // A manifest whose id does not match its directory is not trusted.
    await writeProfile(profiles, "renamed", "/w/project-feature");
    const renamed = path.join(profiles, "renamed", "profile.json");
    await fs.writeFile(
      renamed,
      JSON.stringify({ ...JSON.parse(await fs.readFile(renamed, "utf8")), id: "other" }),
    );

    const found = await findDevProfiles("/w/project-feature", profiles);
    expect(found.map((profile) => profile.id)).toEqual(["qa-run", "workspace-aaaa"]);
  });
});

describe("measureEnvironmentDiskUsage", () => {
  test("itemises a worktree and the dev worktrees started from it", async () => {
    const worktree = await tempDir("ork-disk-worktree-");
    const profiles = await tempDir("ork-disk-profiles-");
    const external = await tempDir("ork-disk-dev-trees-");
    const insideRoot = await writeProfile(profiles, "workspace-aaaa", worktree);
    const outsideRoot = await writeProfile(
      profiles,
      "qa-run",
      worktree,
      path.join(external, "qa-run"),
    );
    for (const directory of [path.join(insideRoot, "worktrees"), path.join(external, "qa-run")]) {
      await fs.mkdir(directory, { recursive: true });
    }
    const du = fakeDu({
      // 5 kB of top-level files that `du -d 1` does not list.
      [worktree]: { ".": 105, node_modules: 70, ".git": 20, src: 10 },
      [insideRoot]: { ".": 50, worktrees: 30, data: 20 },
      [path.join(insideRoot, "worktrees")]: { ".": 30, "app-one": 30 },
      [outsideRoot]: { ".": 5, data: 5 },
      [path.join(external, "qa-run")]: { ".": 40, "app-two": 25, "app-three": 15 },
    });

    const usage = await measureEnvironmentDiskUsage(
      environment({ worktreePath: worktree }),
      {
        du,
        containerSize: async () => null,
        volumeSizes: async () => null,
        profilesDirectory: () => profiles,
      },
      () => new Date("2026-10-12T00:00:00.000Z"),
    );

    expect(usage.primary).toMatchObject({ kind: "worktree", path: worktree, bytes: 105 * 1024 });
    expect(usage.primary.items.map((item) => [item.label, item.bytes])).toEqual([
      ["node_modules", 70 * 1024],
      [".git", 20 * 1024],
      ["src", 10 * 1024],
      ["Other files", 5 * 1024],
    ]);
    const byId = Object.fromEntries(usage.dev.profiles.map((profile) => [profile.id, profile]));
    // Worktrees inside the profile are not counted twice.
    expect(byId["workspace-aaaa"]).toMatchObject({ stateBytes: 20 * 1024, bytes: 50 * 1024 });
    expect(byId["qa-run"]).toMatchObject({ stateBytes: 5 * 1024, bytes: 45 * 1024 });
    expect(byId["qa-run"]!.worktrees.map((item) => item.label)).toEqual(["app-two", "app-three"]);
    expect(usage.dev.worktreeBytes).toBe(70 * 1024);
    expect(usage.dev.bytes).toBe(95 * 1024);
    expect(usage.totalBytes).toBe(200 * 1024);
  });

  test("reports a local environment without a worktree as empty", async () => {
    const usage = await measureEnvironmentDiskUsage(environment({}), {
      du: async () => {
        throw new Error("du must not run");
      },
      containerSize: async () => null,
      volumeSizes: async () => null,
      profilesDirectory: () => null,
    });
    expect(usage.primary).toMatchObject({ bytes: 0, unavailable: expect.any(String) });
    expect(usage.totalBytes).toBe(0);
  });

  test("measures a container's writable layer", async () => {
    const probes = (size: number | null): DiskUsageProbes => ({
      du: async () => "",
      containerSize: async () => size,
      volumeSizes: async () => null,
      profilesDirectory: () => null,
    });
    const container = environment({ environmentType: "containerized", containerId: "c1" });

    const measured = await measureEnvironmentDiskUsage(container, probes(2_000));
    expect(measured.primary).toMatchObject({
      kind: "container",
      bytes: 2_000,
      items: [{ label: "Container writable layer", bytes: 2_000 }],
    });
    expect(measured.primary.unavailable).toBeUndefined();
    expect(measured.totalBytes).toBe(2_000);

    const unknown = await measureEnvironmentDiskUsage(container, probes(null));
    expect(unknown.primary).toMatchObject({ bytes: null, unavailable: expect.any(String) });
    expect(unknown.totalBytes).toBeNull();
  });
});

const probesFor = (du: DiskUsageProbes["du"], profiles: string | null = null): DiskUsageProbes => ({
  du,
  profilesDirectory: () => profiles,
  containerSize: async () => null,
  volumeSizes: async () => null,
});

test("totals include all 65 worktrees with bounded detail and loose files", async () => {
  const checkout = await tempDir("ork-disk-many-");
  const profiles = await tempDir("ork-disk-profiles-");
  const profileRoot = await writeProfile(profiles, "many", checkout);
  const trees = path.join(profileRoot, "worktrees");
  await fs.mkdir(trees);
  const children = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`tree-${i}`, 1]));
  const usage = await measureEnvironmentDiskUsage(
    environment({ worktreePath: checkout }),
    probesFor(
      fakeDu({
        [checkout]: { ".": 10 },
        [profileRoot]: { ".": 70 },
        [trees]: { ".": 67, ...children },
      }),
      profiles,
    ),
  );
  expect(usage.dev.worktreeBytes).toBe(67 * 1024);
  expect(usage.totalBytes).toBe(80 * 1024);
  const details = usage.dev.profiles[0]!.worktrees;
  expect(details.length).toBeLessThanOrEqual(64);
  expect(details.reduce((sum, entry) => sum + entry.bytes!, 0)).toBe(67 * 1024);
  expect(details.at(-1)?.label).toContain("more");
});

test("overlapping checkout, profile and external dev roots contribute bytes once", async () => {
  const checkout = await tempDir("ork-disk-overlap-");
  const profiles = await tempDir("ork-disk-profiles-");
  const nestedTrees = path.join(checkout, "dev-trees", "qa");
  const outsideRoot = await writeProfile(profiles, "qa", checkout, nestedTrees);
  await fs.mkdir(nestedTrees, { recursive: true });
  const usage = await measureEnvironmentDiskUsage(
    environment({ worktreePath: checkout }),
    probesFor(
      fakeDu({
        [checkout]: { ".": 100 },
        [outsideRoot]: { ".": 5 },
        [nestedTrees]: { ".": 40, tree: 40 },
      }),
      profiles,
    ),
  );
  expect(usage.dev.worktreeBytes).toBe(40 * 1024);
  expect(usage.totalBytes).toBe(105 * 1024);
  const internalProfiles = path.join(checkout, "profiles");
  const internalRoot = await writeProfile(internalProfiles, "internal", checkout);
  await fs.mkdir(path.join(internalRoot, "worktrees"));
  const allNested = await measureEnvironmentDiskUsage(
    environment({ worktreePath: checkout }),
    probesFor(
      fakeDu({
        [checkout]: { ".": 100 },
        [internalRoot]: { ".": 50 },
        [path.join(internalRoot, "worktrees")]: { ".": 40 },
      }),
      internalProfiles,
    ),
  );
  expect(allNested.totalBytes).toBe(100 * 1024);
});

test("surviving profiles are measured even after their source checkout is gone", async () => {
  const profiles = await tempDir("ork-disk-survivors-");
  const missing = path.join(profiles, "gone");
  const profile = await writeProfile(profiles, "survivor", missing);
  const trees = path.join(profile, "worktrees");
  await fs.mkdir(trees);
  const result = await measureEnvironmentDiskUsage(
    environment({ worktreePath: missing }),
    probesFor(
      fakeDu({
        [profile]: { ".": 12 },
        [trees]: { ".": 8, tree: 8 },
      }),
      profiles,
    ),
  );
  expect(result.primary.bytes).toBe(0);
  expect(result.dev.profiles.map((row) => row.id)).toEqual(["survivor"]);
  expect(result.dev.worktreeBytes).toBe(8 * 1024);
  expect(result.totalBytes).toBe(12 * 1024);
});

test("partial du output stays unknown without a root total, and failed walks stay unknown", async () => {
  const checkout = await tempDir("ork-disk-partial-");
  for (const du of [
    async () => `3\t${path.join(checkout, "src")}`,
    async () => {
      throw new Error("unreadable");
    },
  ]) {
    const usage = await measureEnvironmentDiskUsage(
      environment({ worktreePath: checkout }),
      probesFor(du),
    );
    expect(usage.primary.bytes).toBeNull();
    expect(usage.primary.unavailable).toBeTruthy();
    expect(usage.totalBytes).toBeNull();
  }
});

test("cache reuses, refreshes, and evicts failed or unavailable measurements", async () => {
  const checkout = await tempDir("ork-disk-cache-");
  const service = new StorageService(path.join(checkout, "data"));
  await service.init();
  const saved = await service.addEnvironment(
    environment({ id: crypto.randomUUID(), worktreePath: checkout }),
  );
  let calls = 0;
  let failed = false;
  const probes = probesFor(async () => {
    calls++;
    if (failed) throw new Error("walk failed");
    return `10\t${checkout}`;
  });
  const context = { storage: service };
  const first = await getEnvironmentDiskUsage(saved.id, context, { probes });
  expect(await getEnvironmentDiskUsage(saved.id, context, { probes })).toBe(first);
  expect(calls).toBe(1);
  await getEnvironmentDiskUsage(saved.id, context, { probes, refresh: true });
  expect(calls).toBe(2);
  failed = true;
  expect(
    (await getEnvironmentDiskUsage(saved.id, context, { probes, refresh: true })).totalBytes,
  ).toBeNull();
  failed = false;
  expect((await getEnvironmentDiskUsage(saved.id, context, { probes })).totalBytes).toBe(10 * 1024);
  expect(calls).toBe(4);
  await service.updateEnvironment(saved.id, {
    environmentType: "containerized",
    containerId: "c1",
  });
  const brokenProbes: DiskUsageProbes = {
    ...probes,
    containerSize: async () => {
      throw new Error("Docker offline");
    },
  };
  await expect(
    getEnvironmentDiskUsage(saved.id, context, { probes: brokenProbes }),
  ).rejects.toThrow("Docker offline");
  brokenProbes.containerSize = async () => 7;
  expect(
    (await getEnvironmentDiskUsage(saved.id, context, { probes: brokenProbes })).totalBytes,
  ).toBe(7);
});

test("overview projects local, container and home rows and excludes deleted projects", async () => {
  const root = await tempDir("ork-disk-list-");
  const service = new StorageService(root);
  await service.init();
  const project = await service.addProject(
    createProject("https://github.com/acme/app.git", "/checkout"),
  );
  for (const row of [
    environment({ id: "local", projectId: project.id, worktreePath: "/custom/tree" }),
    environment({ id: "container", projectId: project.id, environmentType: "containerized" }),
    environment({
      id: "home",
      projectId: project.id,
      worktreePath: "/checkout",
      projectHome: true,
    }),
    environment({ id: "orphan", projectId: "gone" }),
  ])
    await service.addEnvironment(row);
  const rows = await listDiskUsageEnvironments({ storage: service });
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.environmentId === "local")).toMatchObject({
    location: "/custom/tree",
    projectName: project.name,
  });
  expect(rows.find((row) => row.environmentId === "container")?.location).toBeNull();
  expect(rows.find((row) => row.environmentId === "home")?.projectHome).toBe(true);
});

test("container breakdown includes recovery copies and unique active and retained named volumes", async () => {
  const lifecycle = emptyContainerLifecycle();
  lifecycle.storage.volumes = [{ role: "workspace", name: "active-workspace" }];
  lifecycle.retainedStorage = [
    {
      storageSetId: "old",
      workspaceGeneration: 1,
      retainedAt: new Date().toISOString(),
      reason: "workspace-reset",
      volumes: [
        { role: "workspace", name: "retained-workspace" },
        { role: "shared", name: "active-workspace" },
      ],
    },
  ];
  lifecycle.retainedRuntimes = [
    { containerId: "recovery-container", runtimeGeneration: 1, owner: "test" },
  ];
  const env = environment({
    environmentType: "containerized",
    containerId: "active-container",
    containerLifecycle: lifecycle,
  });
  const probes: DiskUsageProbes = {
    ...probesFor(async () => ""),
    containerSize: async (id) => (id === "active-container" ? 10 : 20),
    volumeSizes: async () =>
      new Map([
        ["active-workspace", 30],
        ["retained-workspace", 40],
      ]),
  };
  const result = await measureEnvironmentDiskUsage(env, probes);
  expect(result.primary.items.map((item) => item.bytes)).toEqual([10, 20, 30, 40]);
  expect(result.primary.items.map((item) => item.label)).toEqual([
    "Container writable layer",
    "Recovery copy recovery-con",
    "Volume active-workspace",
    "Volume retained-workspace",
  ]);
  expect(result.totalBytes).toBe(100);
  probes.volumeSizes = async () => null;
  const partial = await measureEnvironmentDiskUsage(env, probes);
  expect(partial.primary.bytes).toBe(30);
  expect(partial.primary.items.slice(2).map((item) => item.bytes)).toEqual([null, null]);
  expect(partial.primary.unavailable).toBeTruthy();
  probes.containerSize = async () => null;
  expect((await measureEnvironmentDiskUsage(env, probes)).totalBytes).toBeNull();
});
