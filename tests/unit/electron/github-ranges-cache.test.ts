import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  githubRangesSeed,
  parseGithubMeta,
  readGithubRangesSeed,
  validIpv4Cidr,
} from "../../../apps/backend/src/core/github-ranges-cache";
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
});
