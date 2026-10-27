import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  copyGithubRangesSeed,
  githubRangesSeed,
  parseGithubMeta,
  readGithubRangesSeed,
  validIpv4Cidr,
} from "../src/core/github-ranges-cache";
import { tempDir } from "./container-lifecycle-fixtures";

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
    expect(first).toBe(path.join(dir, "github-ranges.txt"));
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

  test("is copied into a created container, never bound, and a failed copy is not fatal", async () => {
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
});
