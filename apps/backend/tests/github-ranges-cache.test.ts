import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GITHUB_RANGES_RETRY_AFTER_FAILURE_MS,
  LEGACY_GITHUB_RANGES_FILE,
  copyGithubRangesSeed,
  formatGithubRangesSeed,
  githubRangesSeed,
  githubRangesSeedDirectory,
  githubRangesSeedFile,
  githubRangesSeedMountArguments,
  parseGithubMeta,
  prepareGithubRangesSeedBind,
  readGithubRangesSeed,
  validIpv4Cidr,
} from "../src/core/github-ranges-cache";
import { CommandFailedError } from "../src/core/shell";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { writeGithubRangesSeed } from "../scripts/github-ranges-seed";
import { seedLiveGithubRanges, tempDir } from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const META = JSON.stringify({
  web: ["192.30.252.0/22", "2a0a:a440::/29"],
  api: ["192.30.252.0/22", "140.82.112.0/20"],
  git: ["140.82.112.0/20", "not-a-cidr", "300.1.1.1/8"],
});

describe("GitHub ranges seed", () => {
  test("keeps only valid IPv4 web/api/git CIDRs", () => {
    expect(validIpv4Cidr("10.0.0.0/8")).toBe(true);
    expect(validIpv4Cidr("256.0.0.0/8")).toBe(false);
    expect(validIpv4Cidr("10.0.0.0/33")).toBe(false);
    expect(parseGithubMeta(META)).toEqual(["192.30.252.0/22", "140.82.112.0/20"]);
    expect(parseGithubMeta('{"web":[]}')).toBeNull();
    expect(parseGithubMeta("nope")).toBeNull();
  });

  test("the CI seed script writes the format the backend serves, and live suites pick it up", async () => {
    const dir = await tempDir("ork-gh-ci-seed-");
    cleanup.push(dir);
    const meta = path.join(dir, "meta.json");
    const seed = path.join(dir, "seed.txt");
    await fs.writeFile(meta, META);
    expect(await writeGithubRangesSeed(meta, seed, Date.parse("2026-11-10T00:00:00.000Z"))).toBe(2);
    expect(await readGithubRangesSeed(seed)).toEqual({
      fetchedAt: "2026-11-10T00:00:00.000Z",
      ranges: ["192.30.252.0/22", "140.82.112.0/20"],
    });
    await fs.writeFile(meta, '{"web":[]}');
    await expect(writeGithubRangesSeed(meta, path.join(dir, "bad.txt"))).rejects.toThrow(
      "no usable",
    );

    // A live suite's data directory gets the seed once, and only when one is named.
    const dataDir = path.join(dir, "data");
    await fs.mkdir(dataDir);
    expect(seedLiveGithubRanges(dataDir, "")).toBe(false);
    expect(seedLiveGithubRanges(dataDir, seed)).toBe(true);
    expect(seedLiveGithubRanges(dataDir, seed)).toBe(false);
    // The backend serves a fresh copied seed without fetching.
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      throw new Error("must not fetch");
    };
    const served = await githubRangesSeed(dataDir, { fetcher });
    expect(served).toBe(githubRangesSeedFile(dataDir));
    expect((await readGithubRangesSeed(served!))?.ranges).toHaveLength(2);
    expect(calls).toBe(0);
  });

  test("an unavailable CI seed falls back to fetching ranges", async () => {
    const dir = await tempDir("ork-gh-missing-ci-seed-");
    cleanup.push(dir);
    // A missing source makes the real copyFileSync throw, without global mocks.
    expect(seedLiveGithubRanges(dir, path.join(dir, "missing.txt"))).toBe(false);
    expect(await readGithubRangesSeed(githubRangesSeedFile(dir))).toBeNull();
    let calls = 0;
    const served = await githubRangesSeed(dir, {
      fetcher: async () => {
        calls += 1;
        return new Response(META);
      },
    });
    expect(calls).toBe(1);
    expect(served).toBe(githubRangesSeedFile(dir));
    expect((await readGithubRangesSeed(served!))?.ranges).toEqual([
      "192.30.252.0/22",
      "140.82.112.0/20",
    ]);
  });

  test("fetches at most hourly and keeps the last seed while GitHub is unavailable", async () => {
    const dir = await tempDir("ork-gh-seed-");
    cleanup.push(dir);
    let calls = 0;
    let up = true;
    let now = Date.now();
    const fetcher = async () => {
      calls += 1;
      return up ? new Response(META) : new Response("rate limited", { status: 403 });
    };
    const first = await githubRangesSeed(dir, { fetcher, now: () => now });
    expect(first).toBe(githubRangesSeedFile(dir));
    expect((await readGithubRangesSeed(first!))?.ranges).toEqual([
      "192.30.252.0/22",
      "140.82.112.0/20",
    ]);
    await githubRangesSeed(dir, { fetcher, now: () => now + 30 * 60_000 });
    expect(calls).toBe(1);
    // After an hour it refreshes; a failure keeps serving the previous seed.
    up = false;
    now += 2 * 60 * 60_000;
    expect(await githubRangesSeed(dir, { fetcher, now: () => now })).toBe(first);
    expect(calls).toBe(2);
    // Past a week, a seed that cannot be refreshed is not offered.
    now += 8 * 24 * 60 * 60_000;
    expect(await githubRangesSeed(dir, { fetcher, now: () => now })).toBeNull();
  });

  test("lives alone in a world-readable directory, written by an atomic rename into it", async () => {
    const dir = await tempDir("ork-gh-seed-dir-");
    cleanup.push(dir);
    const served = await githubRangesSeed(dir, { fetcher: async () => new Response(META) });
    const directory = githubRangesSeedDirectory(dir);
    expect(served).toBe(path.join(directory, "github-ranges"));
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(served!)).mode & 0o777).toBe(0o644);
    // The bound directory never holds a partial or temporary file.
    expect(await fs.readdir(directory)).toEqual(["github-ranges"]);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(githubRangesSeedMountArguments(directory)).toEqual([
      "--mount",
      `type=bind,src=${directory},dst=/etc/orkestrator-seed,readonly`,
    ]);
  });

  test("moves an older backend's top-level seed into the directory, keeping its age", async () => {
    const dir = await tempDir("ork-gh-seed-legacy-");
    cleanup.push(dir);
    const legacy = path.join(dir, LEGACY_GITHUB_RANGES_FILE);
    await fs.writeFile(legacy, formatGithubRangesSeed(["192.30.252.0/22"], Date.now()));
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(META);
    };
    const served = await githubRangesSeed(dir, { fetcher });
    expect(served).toBe(githubRangesSeedFile(dir));
    expect(calls).toBe(0);
    expect((await readGithubRangesSeed(served!))?.ranges).toEqual(["192.30.252.0/22"]);
    await expect(fs.stat(legacy)).rejects.toThrow();

    // A legacy seed past the hour is still refreshed after the move.
    const old = await tempDir("ork-gh-seed-legacy-old-");
    cleanup.push(old);
    const oldLegacy = path.join(old, LEGACY_GITHUB_RANGES_FILE);
    await fs.writeFile(oldLegacy, formatGithubRangesSeed(["192.30.252.0/22"], 0));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(oldLegacy, twoHoursAgo, twoHoursAgo);
    await githubRangesSeed(old, { fetcher });
    expect(calls).toBe(1);
    expect((await readGithubRangesSeed(githubRangesSeedFile(old)))?.ranges).toEqual([
      "192.30.252.0/22",
      "140.82.112.0/20",
    ]);
  });

  test("concurrent requests share one fetch, and a failed fetch is not repeated for a while", async () => {
    const dir = await tempDir("ork-gh-seed-flight-");
    cleanup.push(dir);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      calls += 1;
      await gate;
      return new Response(META);
    };
    const together = [1, 2, 3].map(() => githubRangesSeed(dir, { fetcher: slow }));
    release();
    expect(new Set(await Promise.all(together))).toEqual(new Set([githubRangesSeedFile(dir)]));
    expect(calls).toBe(1);

    const failing = await tempDir("ork-gh-seed-backoff-");
    cleanup.push(failing);
    let failures = 0;
    let now = Date.now();
    const refused = async () => {
      failures += 1;
      return new Response("rate limited", { status: 403 });
    };
    expect(await githubRangesSeed(failing, { fetcher: refused, now: () => now })).toBeNull();
    now += GITHUB_RANGES_RETRY_AFTER_FAILURE_MS - 1;
    expect(await githubRangesSeed(failing, { fetcher: refused, now: () => now })).toBeNull();
    expect(failures).toBe(1);
    now += 1;
    expect(
      await githubRangesSeed(failing, { fetcher: async () => new Response(META), now: () => now }),
    ).toBe(githubRangesSeedFile(failing));
    expect(failures).toBe(1);
  });

  test("a new container's bind is the directory, even when no seed could be fetched", async () => {
    const dir = await tempDir("ork-gh-seed-bind-");
    cleanup.push(dir);
    const directory = await prepareGithubRangesSeedBind(dir, {
      fetcher: async () => new Response("rate limited", { status: 403 }),
    });
    expect(directory).toBe(githubRangesSeedDirectory(dir));
    expect(await fs.readdir(directory!)).toEqual([]);
    // A data directory that cannot hold it gives no bind, and the firewall fetches.
    const file = path.join(dir, "not-a-directory");
    await fs.writeFile(file, "");
    expect(await prepareGithubRangesSeedBind(file)).toBeNull();
  });

  test("is copied into a container created before the bind, and a failed copy is not fatal", async () => {
    const dir = await tempDir("ork-github-seed-copy-");
    cleanup.push(dir);
    const seed = path.join(dir, "github-ranges.txt");
    await fs.writeFile(seed, "# github-ranges 2026-10-26T00:00:00.000Z\n192.30.252.0/22\n");
    const copied: { args: string[]; file: string; mode: number }[] = [];
    const run = (async (_command: string, args: string[] = []) => {
      const source = args[1]!.replace(/\/\.$/, "");
      const file = await fs.readFile(path.join(source, "github-ranges"), "utf8");
      const mode = (await fs.stat(path.join(source, "github-ranges"))).mode & 0o777;
      copied.push({ args, file, mode });
      return { stdout: "", stderr: "" };
    }) as unknown as Parameters<typeof copyGithubRangesSeed>[2];
    expect(await copyGithubRangesSeed("abc123", seed, run)).toBe(true);
    expect(copied[0]?.args[0]).toBe("cp");
    expect(copied[0]?.args[2]).toBe("abc123:/etc/orkestrator-seed");
    expect(copied[0]?.file).toContain("192.30.252.0/22");
    expect(copied[0]?.mode).toBe(0o644);
    // The staging directory is removed afterwards.
    await expect(fs.stat(copied[0]!.args[1]!.replace(/\/\.$/, ""))).rejects.toThrow();

    const failing = (async () => {
      throw new Error("No such container");
    }) as unknown as Parameters<typeof copyGithubRangesSeed>[2];
    expect(await copyGithubRangesSeed("gone", seed, failing)).toBe(false);
  });

  test("a copy the daemon refuses is logged as that refusal, still not fatal", async () => {
    const dir = await tempDir("ork-github-seed-refused-");
    cleanup.push(dir);
    const seed = path.join(dir, "github-ranges.txt");
    await fs.writeFile(seed, "# github-ranges 2026-10-26T00:00:00.000Z\n192.30.252.0/22\n");
    const calls: string[][] = [];
    // The directory copy's own message hides the refusal; the probe shows it.
    const refused = (async (_command: string, args: string[] = []) => {
      calls.push(args);
      const stderr =
        args[1]?.startsWith("abc123:") === true
          ? "Error response from daemon: remount-ro /d/rootfs/overlayfs/1/git, flags: 0x1021: operation not permitted"
          : "no such directory";
      throw new CommandFailedError(stderr, { stderr });
    }) as unknown as Parameters<typeof copyGithubRangesSeed>[2];
    const logs = captureLogs();
    try {
      expect(await copyGithubRangesSeed("abc123", seed, refused)).toBe(false);
    } finally {
      logs.restore();
    }
    expect(calls.map((args) => args[0])).toEqual(["cp", "cp"]);
    expect(logs.records()).toMatchObject([
      { event: "github-ranges.seed-not-copied", fields: { refusal: "read-only-bind-remount" } },
    ]);
  });
  test("a seed copy the daemon refuses as busy is retried, then delivered or logged as that refusal", async () => {
    const dir = await tempDir("ork-github-seed-busy-");
    cleanup.push(dir);
    const seed = path.join(dir, "github-ranges.txt");
    await fs.writeFile(seed, "# github-ranges 2026-10-26T00:00:00.000Z\n192.30.252.0/22\n");
    const busy =
      'Error response from daemon: failed to mount /d/rootfs/overlayfs/1: mount source: "overlay", fstype: overlay, flags: 0, data: "workdir=w", err: device or resource busy';
    const scripted = (failures: number) => {
      let calls = 0;
      const run = (async () => {
        calls += 1;
        if (calls <= failures) throw new CommandFailedError(busy, { stderr: busy });
        return { stdout: "", stderr: "" };
      }) as unknown as Parameters<typeof copyGithubRangesSeed>[2];
      return { run, calls: () => calls };
    };
    const noPause = async () => undefined;
    const transient = scripted(1);
    expect(await copyGithubRangesSeed("abc123", seed, transient.run, noPause)).toBe(true);
    expect(transient.calls()).toBe(2);

    const stuck = scripted(Number.POSITIVE_INFINITY);
    const logs = captureLogs();
    try {
      expect(await copyGithubRangesSeed("abc123", seed, stuck.run, noPause)).toBe(false);
    } finally {
      logs.restore();
    }
    expect(logs.records().filter((r) => r.event === "github-ranges.seed-not-copied")).toMatchObject(
      [{ fields: { refusal: "snapshot-busy" } }],
    );
  });
});
