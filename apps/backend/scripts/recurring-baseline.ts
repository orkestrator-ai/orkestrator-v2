import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compareBaselines,
  runBaseline,
  type BaselineArtifact,
} from "./recurring-baseline-harness.js";

/**
 * Recurring-work baseline CLI.
 *
 *   mise exec -- bun apps/backend/scripts/recurring-baseline.ts \
 *     [--out <file.json>] [--compare <stored.json>] [--fail-on-change] [--overhead]
 *
 * Writes the deterministic call-count artifact (to stdout when `--out` is
 * omitted). With `--compare`, prints every counter that differs from a stored
 * artifact; `--fail-on-change` turns any difference into exit status 1 so a
 * reviewer can prove a change is observation-only. `--overhead` adds a
 * real-time enabled/disabled recorder measurement, which comparisons ignore.
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function currentCommit(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
    cwd: path.resolve(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "ignore",
  });
  const commit = result.stdout.toString().trim();
  return result.exitCode === 0 && /^[0-9a-f]+$/.test(commit) ? commit : "unknown";
}

async function main(): Promise<number> {
  const artifact = await runBaseline({
    environment: {
      commit: currentCommit(),
      platform: process.platform,
      arch: os.arch(),
      runtime: `bun ${Bun.version}`,
    },
    overhead: process.argv.includes("--overhead"),
  });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const out = argument("--out");
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, serialized);
    console.error(`[recurring-baseline] wrote ${artifact.scenarios.length} scenarios to ${out}`);
  } else if (!argument("--compare")) {
    process.stdout.write(serialized);
  }

  const comparePath = argument("--compare");
  if (!comparePath) return 0;
  const stored = JSON.parse(await readFile(comparePath, "utf8")) as BaselineArtifact;
  const differences = compareBaselines(stored, artifact);
  if (differences.length === 0) {
    console.log(`[recurring-baseline] no counter differs from ${comparePath}`);
    return 0;
  }
  console.log(`[recurring-baseline] ${differences.length} counter(s) differ from ${comparePath}:`);
  for (const entry of differences) {
    const delta = entry.candidate - entry.baseline;
    console.log(
      `  ${entry.scenario} ${entry.phase} ${entry.kind} ${entry.field}: ${entry.baseline} -> ${entry.candidate} (${delta > 0 ? "+" : ""}${delta})`,
    );
  }
  return process.argv.includes("--fail-on-change") ? 1 : 0;
}

process.exitCode = await main();
