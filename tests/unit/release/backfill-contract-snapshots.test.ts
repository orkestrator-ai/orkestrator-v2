import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKFILL_WORK_DIRECTORY,
  backfillContractSnapshots,
  currentDomainOf,
  listRegistryInWorktree,
  parseArguments,
  parseRegistryListing,
  type BackfillRuntime,
  type RegistryListing,
} from "../../../scripts/backfill-contract-snapshots";
import {
  buildReleaseSnapshot,
  formatSnapshotJson,
  parseGitHubReleases,
  readReleaseIndex,
  readReleaseSnapshot,
  releaseInputFromRegistry,
  withReleaseIndexEntries,
  emptyReleaseIndex,
  type PublishedRelease,
} from "../../../scripts/contract-snapshots";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const published = (version: string, day: number): PublishedRelease => ({
  version,
  tag: `v${version}`,
  publishedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
});

/** Current-map commands (`get_status`, `list_nodes`, …) and their releases' registries. */
const domainOf = new Map([
  ["get_status", "system"],
  ["list_nodes", "nodes"],
  ["get_node", "nodes"],
]);

function fakeRuntime(
  contractsDirectory: string,
  releases: readonly PublishedRelease[],
  registries: Record<string, RegistryListing>,
  manifests: Record<string, string> = {},
) {
  const listed: string[] = [];
  const logs: string[] = [];
  const runtime: BackfillRuntime = {
    contractsDirectory,
    listPublishedReleases: () => releases,
    resolveTag: (tag) => `commit-${tag}`,
    manifestAt: (commit) => manifests[commit] ?? null,
    listRegistry: async (release) => {
      listed.push(release.version);
      const listing = registries[release.version];
      if (!listing) throw new Error(`no registry for ${release.version}`);
      return listing;
    },
    domainOf,
    log: (line) => {
      logs.push(line);
    },
  };
  return { runtime, listed, logs };
}

describe("published releases", () => {
  test("keeps non-draft releases from v2.21.0, sorted by version", () => {
    const releases = parseGitHubReleases(
      JSON.stringify([
        { tagName: "v2.36.2-beta", isDraft: false, publishedAt: "2026-11-04T14:37:11Z" },
        { tagName: "v2.36.1", isDraft: false, publishedAt: "2026-11-03T21:02:38Z" },
        // Drafts are not published, whatever npm carries.
        { tagName: "v2.26.0-alpha", isDraft: true, publishedAt: "0001-01-01T00:00:00Z" },
        { tagName: "v2.35.2-beta", isDraft: true, publishedAt: "0001-01-01T00:00:00Z" },
        { tagName: "v2.20.0", isDraft: false, publishedAt: "2026-10-01T00:00:00Z" },
        { tagName: "v2.30.0-rc.1", isDraft: false, publishedAt: "2026-10-24T00:00:00Z" },
        { tagName: "nightly", isDraft: false, publishedAt: "2026-10-24T00:00:00Z" },
        { tagName: "v2.21.0", isDraft: false, publishedAt: "2026-10-16T15:32:43Z" },
      ]),
    );
    expect(releases.map((release) => release.version)).toEqual(["2.21.0", "2.36.1", "2.36.2-beta"]);
    expect(releases[0]).toEqual({
      version: "2.21.0",
      tag: "v2.21.0",
      publishedAt: "2026-10-16T15:32:43Z",
    });
  });
  test("the index never replaces a known publication time with null", () => {
    let index = withReleaseIndexEntries(emptyReleaseIndex(), [
      { version: "2.36.1", publishedAt: "2026-11-03T21:02:38Z" },
      { version: "2.26.2-beta", publishedAt: null },
    ]);
    index = withReleaseIndexEntries(index, [
      { version: "2.36.1", publishedAt: null },
      { version: "2.26.2-beta", publishedAt: "2026-10-22T15:42:30Z" },
    ]);
    expect(index.releases).toEqual([
      { version: "2.26.2-beta", channel: "beta", publishedAt: "2026-10-22T15:42:30Z" },
      { version: "2.36.1", channel: "stable", publishedAt: "2026-11-03T21:02:38Z" },
    ]);
  });
  test("parses arguments", () => {
    expect(parseArguments([])).toEqual({ check: false, only: [] });
    expect(parseArguments(["--check", "--only", "v2.21.0", "--only", "2.23.0"])).toEqual({
      check: true,
      only: ["2.21.0", "2.23.0"],
    });
    expect(() => parseArguments(["--only"])).toThrow("usage");
    expect(() => parseArguments(["2.21.0"])).toThrow("usage");
  });
});

describe("snapshot files", () => {
  test("a pre-contract release keeps names, read where classified, and unmapped commands", () => {
    const { release, blobs } = buildReleaseSnapshot(
      releaseInputFromRegistry({
        version: "2.26.2-beta",
        commit: "abc",
        names: ["get_status", "list_nodes", "start_looped_review"],
        isRead: (command) => command === "get_status",
        domainOf,
      }),
    );
    expect(release).toMatchObject({
      version: "2.26.2-beta",
      channel: "beta",
      preContract: true,
      source: "registry",
      commit: "abc",
      readClassified: true,
      counts: { commands: 3, defined: 0, untyped: 3, unmapped: 1 },
    });
    expect(Object.keys(release.domains)).toEqual(["nodes", "system"]);
    expect(release.unmapped?.file).toMatch(/^domains\/unmapped-[0-9a-f]{16}\.json$/u);
    expect(JSON.parse(blobs.get(release.unmapped!.file)!)).toEqual({
      schemaVersion: 1,
      domain: null,
      commands: { start_looped_review: { untyped: true, read: false } },
    });
  });
  test("without a classifier, entries carry no read", () => {
    const { release, blobs } = buildReleaseSnapshot(
      releaseInputFromRegistry({ version: "2.21.0", names: ["get_status"], domainOf }),
    );
    expect(release.readClassified).toBe(false);
    expect(JSON.parse(blobs.get(release.domains.system!.file)!).commands).toEqual({
      get_status: { untyped: true },
    });
  });
  test("the formatter writes what bun fmt keeps", () => {
    const value = { b: { c: [] as string[], d: {} }, a: null, list: ["x", "y"] };
    expect(formatSnapshotJson(value)).toBe(
      '{\n  "b": {\n    "c": [],\n    "d": {}\n  },\n  "a": null,\n  "list": ["x", "y"]\n}\n',
    );
    const long = Array.from({ length: 12 }, (_, index) => `critical_field_${index}`);
    expect(formatSnapshotJson({ critical: long })).toBe(
      `{\n  "critical": [\n${long.map((item) => `    "${item}"`).join(",\n")}\n  ]\n}\n`,
    );
  });
  test("reading verifies each blob's digest", async () => {
    const contracts = tempDir("contract-snapshots-");
    const { runtime } = fakeRuntime(contracts, [published("2.21.0", 16)], {
      "2.21.0": { names: ["get_status", "list_nodes"], read: null },
    });
    expect(await backfillContractSnapshots({ check: false, only: [] }, runtime)).toBe(0);
    expect(readReleaseSnapshot(contracts, "2.21.0").commands).toEqual({
      get_status: { domain: "system", untyped: true },
      list_nodes: { domain: "nodes", untyped: true },
    });
    const release = JSON.parse(readFileSync(path.join(contracts, "releases/2.21.0.json"), "utf8"));
    const blob = path.join(contracts, release.domains.nodes.file);
    writeFileSync(blob, readFileSync(blob, "utf8").replace("list_nodes", "list_nodez"));
    expect(() => readReleaseSnapshot(contracts, "2.21.0")).toThrow("does not match its digest");
  });
});

describe("backfill", () => {
  const releases = [published("2.21.0", 16), published("2.21.1", 16), published("2.23.0", 19)];
  const registries: Record<string, RegistryListing> = {
    "2.21.0": { names: ["get_status", "list_nodes"], read: null },
    "2.21.1": { names: ["get_status", "list_nodes"], read: null },
    "2.23.0": { names: ["get_node", "get_status", "list_nodes"], read: null },
  };

  test("snapshots every published release, sharing blobs per domain digest", async () => {
    const contracts = tempDir("contract-backfill-");
    const { runtime, listed } = fakeRuntime(contracts, releases, registries);
    expect(await backfillContractSnapshots({ check: false, only: [] }, runtime)).toBe(0);
    expect(listed).toEqual(["2.21.0", "2.21.1", "2.23.0"]);
    for (const { version } of releases) {
      expect(readReleaseSnapshot(contracts, version).preContract).toBe(true);
    }
    // nodes changed once and system never: three blobs for three releases of two domains.
    expect(readdirSync(path.join(contracts, "domains")).sort()).toHaveLength(3);
    const file = (version: string) =>
      JSON.parse(readFileSync(path.join(contracts, `releases/${version}.json`), "utf8")).domains;
    expect(file("2.21.1")).toEqual(file("2.21.0"));
    expect(file("2.23.0").system).toEqual(file("2.21.0").system);
    expect(file("2.23.0").nodes.file).not.toBe(file("2.21.0").nodes.file);
    expect(readReleaseIndex(contracts).releases).toEqual(
      releases.map(({ version, publishedAt }) => ({ version, channel: "stable", publishedAt })),
    );
  });
  test("a second run checks out nothing and writes nothing", async () => {
    const contracts = tempDir("contract-backfill-");
    expect(
      await backfillContractSnapshots(
        { check: false, only: [] },
        fakeRuntime(contracts, releases, registries).runtime,
      ),
    ).toBe(0);
    const before = readFileSync(path.join(contracts, "releases/index.json"), "utf8");
    const again = fakeRuntime(contracts, releases, registries);
    expect(await backfillContractSnapshots({ check: false, only: [] }, again.runtime)).toBe(0);
    expect(again.listed).toEqual([]);
    expect(readFileSync(path.join(contracts, "releases/index.json"), "utf8")).toBe(before);
    expect(await backfillContractSnapshots({ check: true, only: [] }, again.runtime)).toBe(0);
  });
  test("a release whose tag commits a manifest is split from it without a checkout", async () => {
    const contracts = tempDir("contract-backfill-");
    const manifest = {
      schemaVersion: 1,
      generatedBy: "test",
      counts: { commands: 1, defined: 0, untyped: 1 },
      untypedByDomain: { system: 1 },
      domains: {},
      commands: { get_status: { domain: "system", untyped: true, read: true } },
      events: {},
    };
    const { runtime, listed } = fakeRuntime(
      contracts,
      [published("2.37.0", 30)],
      {},
      { "commit-v2.37.0": JSON.stringify(manifest) },
    );
    expect(await backfillContractSnapshots({ check: false, only: [] }, runtime)).toBe(0);
    expect(listed).toEqual([]);
    expect(readReleaseSnapshot(contracts, "2.37.0")).toMatchObject({
      preContract: false,
      commands: { get_status: { domain: "system", untyped: true, read: true } },
    });
  });
  test("check reports missing snapshots and stale publication times without writing", async () => {
    const contracts = tempDir("contract-backfill-");
    const { runtime, listed, logs } = fakeRuntime(contracts, releases, registries);
    expect(await backfillContractSnapshots({ check: true, only: [] }, runtime)).toBe(1);
    expect(listed).toEqual([]);
    expect(existsSync(path.join(contracts, "releases"))).toBe(false);
    expect(logs.join("\n")).toContain("2.21.0 (published 2026-10-16T12:00:00Z) has no snapshot");
    expect(logs.join("\n")).toContain("does not record 2.23.0's publication");
  });
  test("--only limits the run and refuses an unpublished version", async () => {
    const contracts = tempDir("contract-backfill-");
    const { runtime, listed, logs } = fakeRuntime(contracts, releases, registries);
    expect(await backfillContractSnapshots({ check: false, only: ["2.24.0-alpha"] }, runtime)).toBe(
      1,
    );
    expect(logs.join("\n")).toContain("Not a published release: 2.24.0-alpha");
    expect(await backfillContractSnapshots({ check: false, only: ["2.21.1"] }, runtime)).toBe(0);
    expect(listed).toEqual(["2.21.1"]);
    expect(readReleaseIndex(contracts).releases.map((entry) => entry.version)).toEqual(["2.21.1"]);
  });
  test("the current domains include defined commands, which the domain map no longer lists", () => {
    const root = tempDir("contract-domains-");
    mkdirSync(path.join(root, "packages/protocol/contracts"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/protocol/contracts/manifest.json"),
      JSON.stringify({ commands: { converted_command: { domain: "nodes", since: 1 } } }),
    );
    // The real map is empty since 7009 defined its last commands: a map entry
    // the manifest lacks still answers.
    const domains = currentDomainOf(root, { nodes: ["list_nodes"] });
    expect(domains.get("converted_command")).toBe("nodes");
    expect(domains.get("list_nodes")).toBe("nodes");
  });
  test("refuses a malformed registry listing", () => {
    expect(() => parseRegistryListing('{"names":[],"read":null}')).toThrow("no valid");
    expect(() => parseRegistryListing('{"names":["a b"],"read":null}')).toThrow("no valid");
    expect(() => parseRegistryListing('{"names":["a"],"read":[1]}')).toThrow("invalid read");
    expect(parseRegistryListing('{"names":["b","a","a"],"read":["a","zz"]}')).toEqual({
      names: ["a", "b"],
      read: ["a"],
    });
  });
});

describe("registry listing in a worktree", () => {
  // Each test runs real Git (init, commit, worktree add and remove) and the
  // release's registry in a Bun subprocess: heavier than Bun's 5 s default
  // under aggregate load, with nothing to await but the processes.
  const REAL_PROCESS_BUDGET_MS = 30_000;
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@invalid.local", ...args],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  /** A repository whose one commit looks like a pre-contract release. */
  function releaseRepository(options: { classifier: boolean }) {
    const repo = tempDir("contract-backfill-repo-");
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
    };
    write("package.json", '{\n  "version": "2.21.0"\n}\n');
    write("mise.toml", '[tools]\nbun = "1.4.4"\n');
    // The registry reports whether it saw the sandbox or this host's HOME and variables.
    write(
      "apps/backend/src/core/commands-registry.ts",
      `export function createCommandRegistry() {
  const sandboxed = process.env.HOME?.includes("sandbox") && process.env.PATH?.includes("sandbox");
  const inherited = Object.keys(process.env).some((key) => key.startsWith("ORKESTRATOR_"));
  return new Map([
    ["get_status", () => null],
    ["list_nodes", () => null],
    [sandboxed && !inherited ? "env_sandboxed" : "env_leaked", () => null],
  ]);
}
`,
    );
    if (options.classifier) {
      write(
        "packages/protocol/src/command-nodes.ts",
        'export const isNodeReadCommand = (command: string) => command.startsWith("get_");\n',
      );
    }
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "release");
    return { repo, commit: git(repo, "rev-parse", "HEAD") };
  }

  test.each([true, false])(
    "lists the release's own registry in a sandbox and removes its worktree (classifier %s)",
    async (classifier) => {
      const { repo, commit } = releaseRepository({ classifier });
      const workDirectory = path.join(repo, BACKFILL_WORK_DIRECTORY);
      const installs: string[] = [];
      const listing = await listRegistryInWorktree(published("2.21.0", 16), commit, {
        repoRoot: repo,
        workDirectory,
        resolveBun: () => process.execPath,
        install: (_bun, tree) => {
          installs.push(tree);
          expect(existsSync(path.join(tree, "apps/backend/src/core/commands-registry.ts"))).toBe(
            true,
          );
        },
      });
      expect(listing).toEqual({
        names: ["env_sandboxed", "get_status", "list_nodes"],
        read: classifier ? ["get_status"] : null,
      });
      expect(installs).toHaveLength(1);
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(BACKFILL_WORK_DIRECTORY);
      expect(existsSync(workDirectory)).toBe(false);
    },
    REAL_PROCESS_BUDGET_MS,
  );
  test(
    "removes its worktree when the checkout is not the release",
    async () => {
      const { repo, commit } = releaseRepository({ classifier: false });
      await expect(
        listRegistryInWorktree(published("2.21.1", 16), commit, {
          repoRoot: repo,
          workDirectory: path.join(repo, BACKFILL_WORK_DIRECTORY),
          resolveBun: () => process.execPath,
          install: () => undefined,
        }),
      ).rejects.toThrow("is version 2.21.0");
      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(BACKFILL_WORK_DIRECTORY);
      expect(existsSync(path.join(repo, BACKFILL_WORK_DIRECTORY))).toBe(false);
    },
    REAL_PROCESS_BUDGET_MS,
  );
});
