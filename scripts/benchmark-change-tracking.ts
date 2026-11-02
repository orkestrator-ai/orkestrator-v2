/**
 * Change-tracking architecture benchmark (docs/architecture/change-tracking.md).
 *
 * Measures the questions of the implementation guide's §13.3 on this machine:
 * capture cost by repository size with one changed file (cold and warm),
 * comparison cost, physical sharing across clients and aliases, raw-lines
 * counting budgets, and the evidence read path. Results are local
 * measurements for tuning policies, not guarantees.
 *
 * Two fixtures from the 2026-10-27 efficiency report: a repository with large
 * unchanged assets (the warm capture's read and hash cost), and a long turn
 * with 200 changed files compared against the turn start on every
 * provisional pass (the line-count cost).
 *
 * Fixture files are left to age `--settle-ms` before the first capture, so a
 * warm capture sees them as settled (see `STAT_SETTLE_WINDOW_MS` in capture.ts).
 *
 *   bun scripts/benchmark-change-tracking.ts [--sizes=100,1000,10000] [--runs=5]
 *     [--assets=20] [--asset-mib=8] [--changed=200] [--settle-ms=2500]
 *     [--only=capture,assets,long-turn,sharing,counting] [--json]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countRawLineChanges } from "../packages/protocol/src/node/change-tracking/raw-line-diff";
import {
  captureWorktree,
  HostCaptureExecutor,
} from "../apps/backend/src/core/change-tracking/capture";
import { ObjectStore } from "../apps/backend/src/core/change-tracking/object-store";
import { compareManifests } from "../apps/backend/src/core/change-tracking/snapshot-diff";
import { SharedScanQueue } from "../apps/backend/src/core/change-tracking/shared-physical-work";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const sizes = arg("sizes", "100,1000,10000").split(",").map(Number);
const runs = Number(arg("runs", "5"));
const asJson = process.argv.includes("--json");
const assetCount = Number(arg("assets", "20"));
const assetMiB = Number(arg("asset-mib", "8"));
const changedCount = Number(arg("changed", "200"));
const settleMs = Number(arg("settle-ms", "2500"));
const only = new Set(arg("only", "capture,assets,long-turn,sharing,counting").split(","));

const settle = () => new Promise((resolve) => setTimeout(resolve, settleMs));

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "b",
      GIT_AUTHOR_EMAIL: "b@e",
      GIT_COMMITTER_NAME: "b",
      GIT_COMMITTER_EMAIL: "b@e",
    },
  });
}

function makeRepo(files: number): string {
  const root = mkdtempSync(path.join(tmpdir(), `ork-bench-${files}-`));
  git(root, "init", "-q", "-b", "main");
  for (let index = 0; index < files; index++) {
    const directory = path.join(root, `d${index % 50}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `f${index}.ts`),
      `export const value${index} = ${index};\n`.repeat(20),
    );
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

type Row = Record<string, string | number>;
const rows: Row[] = [];

async function benchCapture(files: number) {
  const repo = makeRepo(files);
  await settle();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = new ObjectStore({ root: storeRoot, durable: false });
    const executor = new HostCaptureExecutor(repo);
    let started = performance.now();
    const cold = await captureWorktree({ executor, store });
    const coldMs = performance.now() - started;
    if (cold.kind !== "captured") throw new Error(`capture failed: ${cold.reason}`);
    const warm: number[] = [];
    const compare: number[] = [];
    let previous = cold;
    for (let run = 0; run < runs; run++) {
      writeFileSync(path.join(repo, "d0", "f0.ts"), `export const value0 = ${run + 1000};\n`);
      started = performance.now();
      const next = await captureWorktree({
        executor,
        store,
        previous: previous.manifest,
        statCache: previous.statCache,
      });
      warm.push(performance.now() - started);
      if (next.kind !== "captured") throw new Error("warm capture failed");
      started = performance.now();
      await compareManifests(store, previous.manifest, next.manifest);
      compare.push(performance.now() - started);
      previous = next;
    }
    rows.push({
      workload: `${files} files, one changed`,
      coldCaptureMs: Math.round(coldMs),
      warmCaptureP50Ms: Math.round(percentile(warm, 0.5)),
      warmCaptureP95Ms: Math.round(percentile(warm, 0.95)),
      compareP50Ms: Math.round(percentile(compare, 0.5) * 10) / 10,
      newObjectsWarm: previous.kind === "captured" ? previous.coverage.newObjects : 0,
      metadataReused: previous.kind === "captured" ? previous.coverage.metadataReused : 0,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

/** Large unchanged assets beside small source files; one source file changes per pass. */
async function benchAssets() {
  const repo = makeRepo(200);
  const assets = path.join(repo, "assets");
  mkdirSync(assets, { recursive: true });
  for (let index = 0; index < assetCount; index++) {
    const bytes = Buffer.alloc(assetMiB * 1024 * 1024);
    for (let offset = 0; offset < bytes.length; offset += 4096) bytes.writeUInt32LE(index, offset);
    writeFileSync(path.join(assets, `asset${index}.bin`), bytes);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "assets");
  await settle();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = new ObjectStore({ root: storeRoot, durable: false });
    const executor = new HostCaptureExecutor(repo);
    let started = performance.now();
    let previous = await captureWorktree({ executor, store });
    const coldMs = performance.now() - started;
    if (previous.kind !== "captured") throw new Error(`capture failed: ${previous.reason}`);
    const warm: number[] = [];
    for (let run = 0; run < runs; run++) {
      writeFileSync(path.join(repo, "d0", "f0.ts"), `export const value0 = ${run + 1000};\n`);
      started = performance.now();
      const next = await captureWorktree({
        executor,
        store,
        previous: previous.manifest,
        statCache: previous.statCache,
      });
      warm.push(performance.now() - started);
      if (next.kind !== "captured") throw new Error("warm capture failed");
      previous = next;
    }
    rows.push({
      workload: `200 files + ${assetCount} x ${assetMiB} MiB assets, one changed`,
      coldCaptureMs: Math.round(coldMs),
      warmCaptureP50Ms: Math.round(percentile(warm, 0.5)),
      warmCaptureP95Ms: Math.round(percentile(warm, 0.95)),
      retainedBytesWarm: previous.kind === "captured" ? previous.coverage.retainedBytes : 0,
      metadataReused: previous.kind === "captured" ? previous.coverage.metadataReused : 0,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

/**
 * A long turn: `--changed` files already differ from the turn start, and each
 * provisional pass edits one of them again and compares start to now.
 */
async function benchLongTurn() {
  const files = 1000;
  const repo = makeRepo(files);
  const lines = 400;
  const body = (index: number, revision: number) =>
    Array.from({ length: lines }, (_, line) =>
      line % 37 === 0
        ? `// rev ${revision} line ${line}\n`
        : `export const v${index}_${line} = ${line};\n`,
    ).join("");
  for (let index = 0; index < files; index++)
    writeFileSync(path.join(repo, `d${index % 50}`, `f${index}.ts`), body(index, 0));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "long");
  await settle();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = new ObjectStore({ root: storeRoot, durable: false });
    const executor = new HostCaptureExecutor(repo);
    const start = await captureWorktree({ executor, store });
    if (start.kind !== "captured") throw new Error(`capture failed: ${start.reason}`);
    for (let index = 0; index < changedCount; index++)
      writeFileSync(path.join(repo, `d${index % 50}`, `f${index}.ts`), body(index, 1));
    let previous = await captureWorktree({
      executor,
      store,
      previous: start.manifest,
      statCache: start.statCache,
    });
    if (previous.kind !== "captured") throw new Error("capture failed");
    const compare: number[] = [];
    let changedFiles = 0;
    let additions = "";
    for (let run = 0; run < runs; run++) {
      const index = run % changedCount;
      writeFileSync(path.join(repo, `d${index % 50}`, `f${index}.ts`), body(index, run + 2));
      const next = await captureWorktree({
        executor,
        store,
        previous: previous.manifest,
        statCache: previous.statCache,
      });
      if (next.kind !== "captured") throw new Error("capture failed");
      const started = performance.now();
      const comparison = await compareManifests(store, start.manifest, next.manifest);
      compare.push(performance.now() - started);
      changedFiles = comparison.changedFiles;
      additions = `+${comparison.additions.value ?? "?"}/-${comparison.deletions.value ?? "?"}`;
      previous = next;
    }
    rows.push({
      workload: `long turn, ${changedCount} changed files vs turn start`,
      compareP50Ms: Math.round(percentile(compare, 0.5) * 10) / 10,
      compareP95Ms: Math.round(percentile(compare, 0.95) * 10) / 10,
      changedFiles,
      lastCounts: additions,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

async function benchSharing() {
  const queue = new SharedScanQueue<number>();
  let physical = 0;
  const scan = async () => {
    physical++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return physical;
  };
  // One client, then ten clients with equal demand during one running pass.
  await queue.run("w", scan);
  const single = physical;
  physical = 0;
  const first = queue.run("w", scan);
  await Promise.all([first, ...Array.from({ length: 10 }, () => queue.run("w", scan))]);
  rows.push({
    workload: "ten equal-demand clients",
    physicalScansOneClient: single,
    physicalScansTenClients: physical,
  });

  const repo = makeRepo(10);
  const aliasRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-alias-"));
  try {
    const { PhysicalKeyResolver } =
      await import("../apps/backend/src/core/change-tracking/shared-physical-work");
    const keys = new PhysicalKeyResolver();
    const aliases = Array.from({ length: 10 }, (_, index) => {
      const alias = path.join(aliasRoot, `alias${index}`);
      symlinkSync(repo, alias);
      return alias;
    });
    const distinct = new Set(
      aliases.map((alias) => keys.key({ kind: "local", worktreePath: alias })),
    );
    rows.push({
      workload: "ten environment aliases",
      aliases: aliases.length,
      physicalOwners: distinct.size,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
}

function benchCounting() {
  const encoder = new TextEncoder();
  for (const lines of [1_000, 20_000, 100_000]) {
    const before = encoder.encode(Array.from({ length: lines }, (_, i) => `line ${i}\n`).join(""));
    const after = encoder.encode(
      Array.from({ length: lines }, (_, i) =>
        i % 97 === 0 ? `changed ${i}\n` : `line ${i}\n`,
      ).join(""),
    );
    const times: number[] = [];
    let result: ReturnType<typeof countRawLineChanges> | null = null;
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      result = countRawLineChanges(before, after);
      times.push(performance.now() - started);
    }
    rows.push({
      workload: `raw-lines count, ${lines} lines, ~1% changed`,
      p50Ms: Math.round(percentile(times, 0.5) * 10) / 10,
      p95Ms: Math.round(percentile(times, 0.95) * 10) / 10,
      outcome:
        result?.kind === "counted"
          ? `+${result.additions}/-${result.deletions}`
          : (result?.reason ?? "?"),
    });
  }
}

const startedRss = process.memoryUsage().rss;
if (only.has("capture")) for (const size of sizes) await benchCapture(size);
if (only.has("assets")) await benchAssets();
if (only.has("long-turn")) await benchLongTurn();
if (only.has("sharing")) await benchSharing();
if (only.has("counting")) benchCounting();
const peakRssDeltaMiB = Math.round((process.memoryUsage().rss - startedRss) / 1024 / 1024);

if (asJson) {
  console.log(JSON.stringify({ runs, peakRssDeltaMiB, rows }, null, 2));
} else {
  console.log(`change-tracking benchmark (runs=${runs}, rss delta ${peakRssDeltaMiB} MiB)`);
  for (const row of rows) console.log(JSON.stringify(row));
}
