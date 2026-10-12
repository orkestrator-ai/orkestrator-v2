import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findDevProfiles,
  measureEnvironmentDiskUsage,
  parseDuOutput,
  summarizeEntries,
  type DiskUsageProbes,
} from "./disk-usage.js";
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
