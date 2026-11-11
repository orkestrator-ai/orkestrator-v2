import os from "node:os";
import path from "node:path";
import { selectSegments } from "../src/core/self-improvement/insights/prepare.js";
import { defaultSources } from "../src/core/self-improvement/insights/transcripts.js";

/**
 * How long the self-improvement conversation scan holds the event loop:
 *
 *   mise exec -- bun apps/backend/scripts/self-improvement-scan-stall.ts \
 *     [--data-dir <dir>] [--json]
 *
 * Runs `selectSegments` over this machine's Claude and Codex histories (the
 * sources a run reads: `~/.claude/projects`, the data directory's managed
 * Claude accounts and `~/.codex/sessions`) twice: `unsliced` passes a slicer
 * that never yields, which is what a run did before the scan was sliced, and
 * `sliced` uses the default one. Each records the longest event-loop stall, the
 * lateness of a 2 ms timer chain (the backend's stall monitor at a finer
 * interval). The data directory defaults to the macOS one and is only read to
 * find the managed accounts.
 *
 * Read-only, and the output is counts and milliseconds only: no path, project
 * or conversation text. Measured on 2026-11-10 on a Mac with 8,983 history
 * files: unsliced 7,076 ms of stall (the backend logged 7,385 ms during a dry
 * run that day), sliced 38 ms, with the same 30 parts selected.
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dataDir =
  argument("data-dir") ??
  path.join(os.homedir(), "Library", "Application Support", "orkestrator-v2");
const sources = defaultSources(dataDir);

async function measure(slice: (() => Promise<void>) | undefined) {
  let worst = 0;
  let expected = performance.now() + 2;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    worst = Math.max(worst, now - expected);
    expected = now + 2;
    setTimeout(tick, 2);
  };
  setTimeout(tick, 2);
  const started = performance.now();
  const selection = await selectSegments({
    sources,
    cursor: { schemaVersion: 1, conversations: {} },
    now: Date.now(),
    excludeDirs: [path.resolve(dataDir)],
    ...(slice ? { slice } : {}),
  });
  const durationMs = Math.round(performance.now() - started);
  // Let the chain observe the last block before stopping it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  stopped = true;
  return {
    durationMs,
    longestStallMs: Math.round(worst),
    segments: selection.segments.length,
    waiting: selection.waiting,
  };
}

const results = {
  unsliced: await measure(async () => undefined),
  sliced: await measure(undefined),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(results));
else for (const [mode, row] of Object.entries(results)) console.log(mode, row);
