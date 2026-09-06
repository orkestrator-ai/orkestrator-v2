import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendTerminalHistory,
  configureTerminalHistory,
  flushTerminalHistories,
  getTerminalHistoryPage,
  getTerminalStateSnapshot,
  terminalHistoryTesting,
} from "../apps/backend/src/core/terminal-history";

type Measurement = {
  terminals: number;
  outputBytesPerTerminal: number;
  ingestMs: number;
  snapshotP50Ms: number;
  snapshotP95Ms: number;
  largestSnapshotBytes: number;
  largestPageBytes: number;
  diskBytes: number;
  estimatedStateBytes: number;
  rssDeltaBytes: number;
  heapDeltaBytes: number;
};

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

async function measure(terminals: number, outputBytesPerTerminal: number): Promise<Measurement> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-terminal-history-benchmark-"));
  terminalHistoryTesting.clear();
  Bun.gc(true);
  const before = process.memoryUsage();
  try {
    for (let index = 0; index < terminals; index += 1) {
      configureTerminalHistory({
        sessionId: `terminal-${index}`,
        dataDir,
        stableIdentity: `benchmark-terminal-${index}`,
        cols: 80,
        rows: 24,
      });
    }
    const line = `${"x".repeat(78)}\r\n`;
    const output = line.repeat(Math.ceil(outputBytesPerTerminal / Buffer.byteLength(line)));
    const ingestStarted = performance.now();
    if (outputBytesPerTerminal > 0) {
      for (let index = 0; index < terminals; index += 1) {
        appendTerminalHistory(`terminal-${index}`, output, 1, 1);
      }
    }
    await flushTerminalHistories();
    const ingestMs = performance.now() - ingestStarted;
    const snapshotTimes: number[] = [];
    let largestSnapshotBytes = 0;
    let largestPageBytes = 0;
    for (let index = 0; index < terminals; index += 1) {
      const started = performance.now();
      const snapshot = await getTerminalStateSnapshot(`terminal-${index}`);
      snapshotTimes.push(performance.now() - started);
      largestSnapshotBytes = Math.max(
        largestSnapshotBytes,
        Buffer.byteLength(`${snapshot?.output ?? ""}${snapshot?.pendingOutput ?? ""}`),
      );
      const page = await getTerminalHistoryPage(`terminal-${index}`);
      largestPageBytes = Math.max(
        largestPageBytes,
        Buffer.byteLength(JSON.stringify(page ?? null)),
      );
    }
    Bun.gc(true);
    const after = process.memoryUsage();
    return {
      terminals,
      outputBytesPerTerminal,
      ingestMs: Number(ingestMs.toFixed(1)),
      snapshotP50Ms: Number(percentile(snapshotTimes, 0.5).toFixed(2)),
      snapshotP95Ms: Number(percentile(snapshotTimes, 0.95).toFixed(2)),
      largestSnapshotBytes,
      largestPageBytes,
      diskBytes: await directoryBytes(dataDir),
      estimatedStateBytes: terminalHistoryTesting.stats().estimatedStateBytes,
      rssDeltaBytes: Math.max(0, after.rss - before.rss),
      heapDeltaBytes: Math.max(0, after.heapUsed - before.heapUsed),
    };
  } finally {
    terminalHistoryTesting.clear();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const results: Measurement[] = [];
for (const terminals of [1, 10, 50]) {
  results.push(await measure(terminals, 0));
  results.push(await measure(terminals, 256 * 1024));
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
