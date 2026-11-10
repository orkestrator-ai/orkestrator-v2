/**
 * Writes a GitHub ranges seed, in the backend's own format, from a saved
 * `api.github.com/meta` answer:
 *
 *   gh api meta > meta.json
 *   bun apps/backend/scripts/github-ranges-seed.ts meta.json github-ranges.txt
 *
 * The container live qualification workflow fetches `/meta` once with the
 * job's token and hands the seed to every live suite through
 * `ORKESTRATOR_LIVE_GITHUB_RANGES_SEED`. Without it each suite's fresh data
 * directory asks GitHub unauthenticated, and a hosted runner's shared address
 * has often spent that quota (60 an hour), so restricted firewalls fail
 * closed and the gateway reports `not-ready`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { formatGithubRangesSeed, parseGithubMeta } from "../src/core/github-ranges-cache.js";

/** Returns how many ranges were written; throws when the answer is unusable. */
export async function writeGithubRangesSeed(
  metaFile: string,
  seedFile: string,
  now: number = Date.now(),
): Promise<number> {
  const ranges = parseGithubMeta((await readFile(metaFile, "utf8")).slice(0, 1024 * 1024));
  if (!ranges) throw new Error("the /meta answer has no usable web, api and git ranges");
  await writeFile(seedFile, formatGithubRangesSeed(ranges, now), { mode: 0o644 });
  return ranges.length;
}

if (import.meta.main) {
  const [metaFile, seedFile] = process.argv.slice(2);
  if (!metaFile || !seedFile) {
    console.error("usage: github-ranges-seed.ts <meta.json> <seed-file>");
    process.exit(2);
  }
  try {
    const count = await writeGithubRangesSeed(metaFile, seedFile);
    console.log(`wrote ${count} GitHub ranges`);
  } catch (error) {
    console.error(`github-ranges-seed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
