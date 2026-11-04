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
 * Three fixtures for the store's write and read paths (ST-5, ST-6), which fsync
 * for real: `large-blob` measures the longest event-loop stall while a capture
 * stores a changed `--blob-mib` file, `durable-cold` a cold capture's fsync cost
 * over `--durable-files` files, and `manifest` repeat manifest reads and a diff
 * page's row lookups over `--manifest-entries` entries. A tmpfs temporary
 * directory hides the fsync cost, so point TMPDIR at a real disk for these.
 *
 * Fixture files are left to age `--settle-ms` before the first capture, so a
 * warm capture sees them as settled (see `STAT_SETTLE_WINDOW_MS` in capture.ts).
 *
 *   bun scripts/benchmark-change-tracking.ts [--sizes=100,1000,10000] [--runs=5]
 *     [--assets=20] [--asset-mib=8] [--changed=200] [--settle-ms=2500]
 *     [--blob-mib=16] [--durable-files=1000] [--manifest-entries=100000]
 *     [--only=capture,assets,long-turn,sharing,counting,large-blob,durable-cold,manifest]
 *     [--json]
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countRawLineChanges } from "../packages/protocol/src/node/change-tracking/raw-line-diff";
import {
  captureWorktree,
  encodePath,
  findManifestEntry,
  HostCaptureExecutor,
  readManifest,
} from "../apps/backend/src/core/change-tracking/capture";
import { ObjectStore } from "../apps/backend/src/core/change-tracking/object-store";
import { CHANGE_TRACKING_POLICY_V1 } from "../apps/backend/src/core/change-tracking/policy-registry";
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
const blobMiB = Number(arg("blob-mib", "16"));
const durableFiles = Number(arg("durable-files", "1000"));
const manifestEntries = Number(arg("manifest-entries", "100000"));
const only = new Set(
  arg("only", "capture,assets,long-turn,sharing,counting,large-blob,durable-cold,manifest").split(
    ",",
  ),
);

const settle = () => new Promise((resolve) => setTimeout(resolve, settleMs));

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

/** `work`'s duration and the longest stretch it left a 1 ms timer waiting. */
async function measureLoop<T>(work: () => Promise<T>) {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stallMs = 0;
  last = performance.now();
  const started = performance.now();
  const result = await work();
  const durationMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  clearInterval(timer);
  return { result, durationMs, stallMs };
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

/** The store as the service opens it, so a reuse sees the real orphan grace. */
function openStore(root: string, durable = false): ObjectStore {
  return new ObjectStore({
    root,
    durable,
    orphanGraceMs: () => CHANGE_TRACKING_POLICY_V1.orphanGraceMs,
  });
}

type Row = Record<string, string | number>;
const rows: Row[] = [];

async function benchCapture(files: number) {
  const repo = makeRepo(files);
  await settle();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = openStore(storeRoot);
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
    const store = openStore(storeRoot);
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
    const store = openStore(storeRoot);
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

/** Half random and half repetitive, so zlib does real work on it. */
function largeBlob(mib: number): Buffer {
  const bytes = Buffer.alloc(mib * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    randomBytes(4096).copy(bytes, offset);
    bytes.fill(offset % 251, offset + 4096, Math.min(offset + 8192, bytes.length));
  }
  return bytes;
}

/** A changed large file captured durably, as a real capture stores it. */
async function benchLargeBlob() {
  const repo = makeRepo(100);
  const blob = largeBlob(blobMiB);
  await settle();
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = openStore(storeRoot, true);
    const executor = new HostCaptureExecutor(repo);
    let previous = await captureWorktree({ executor, store });
    if (previous.kind !== "captured") throw new Error(`capture failed: ${previous.reason}`);
    const stalls: number[] = [];
    const durations: number[] = [];
    for (let run = 0; run < runs; run++) {
      blob.writeUInt32LE(run + 1, 0);
      writeFileSync(path.join(repo, "large.bin"), blob);
      const { result, durationMs, stallMs } = await measureLoop(() =>
        captureWorktree({
          executor,
          store,
          previous: previous.kind === "captured" ? previous.manifest : null,
          statCache: previous.kind === "captured" ? previous.statCache : undefined,
        }),
      );
      if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
      stalls.push(stallMs);
      durations.push(durationMs);
      previous = result;
    }
    rows.push({
      workload: `${blobMiB} MiB changed file captured durably`,
      longestStallP50Ms: Math.round(percentile(stalls, 0.5) * 10) / 10,
      longestStallMaxMs: Math.round(Math.max(...stalls) * 10) / 10,
      captureP50Ms: Math.round(percentile(durations, 0.5)),
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  }
}

/** Every file is a new object: the most fsyncs one capture can make. */
async function benchDurableCold() {
  const repo = makeRepo(durableFiles);
  await settle();
  const stalls: number[] = [];
  const durations: number[] = [];
  try {
    for (let run = 0; run < runs; run++) {
      const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
      try {
        const store = openStore(storeRoot, true);
        const executor = new HostCaptureExecutor(repo);
        const { result, durationMs, stallMs } = await measureLoop(() =>
          captureWorktree({ executor, store }),
        );
        if (result.kind !== "captured") throw new Error(`capture failed: ${result.reason}`);
        stalls.push(stallMs);
        durations.push(durationMs);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    }
    rows.push({
      workload: `${durableFiles} files, cold durable capture`,
      captureP50Ms: Math.round(percentile(durations, 0.5)),
      longestStallP50Ms: Math.round(percentile(stalls, 0.5) * 10) / 10,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Repeat reads of one manifest, and the lookups of one 20-row diff page. */
async function benchManifest() {
  const storeRoot = mkdtempSync(path.join(tmpdir(), "ork-bench-store-"));
  try {
    const store = openStore(storeRoot);
    const paths = Array.from({ length: manifestEntries }, (_, index) =>
      encodePath(
        new TextEncoder().encode(
          `packages/area-${index % 50}/src/d${index % 500}/file-${index}.ts`,
        ),
      ),
    ).toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const manifest = {
      v: 1,
      root: "bench",
      entries: paths.map((p, index) => ({
        p,
        m: "100644",
        o: index.toString(16).padStart(40, "0"),
        s: index,
        t: 1,
      })),
      omitted: [],
      unstable: [],
    };
    const { id } = await store.put("manifest", new TextEncoder().encode(JSON.stringify(manifest)));
    const firstStarted = performance.now();
    const first = await readManifest(store, id);
    const firstMs = performance.now() - firstStarted;
    if (!first) throw new Error("manifest unreadable");
    const reads: number[] = [];
    for (let run = 0; run < Math.max(runs, 10); run++) {
      const started = performance.now();
      await readManifest(store, id);
      reads.push(performance.now() - started);
    }
    const page = Array.from(
      { length: 20 },
      (_, index) => paths[Math.floor(((index + 0.5) / 20) * paths.length)]!,
    );
    const lookups: number[] = [];
    for (let run = 0; run < Math.max(runs, 10); run++) {
      const started = performance.now();
      for (const pathId of page)
        if (!findManifestEntry(first.entries, pathId)) throw new Error("?");
      lookups.push(performance.now() - started);
    }
    rows.push({
      workload: `manifest of ${manifestEntries} entries`,
      firstReadMs: Math.round(firstMs * 10) / 10,
      repeatReadP50Ms: Math.round(percentile(reads, 0.5) * 100) / 100,
      pageLookupsP50Ms: Math.round(percentile(lookups, 0.5) * 100) / 100,
    });
  } finally {
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
if (only.has("large-blob")) await benchLargeBlob();
if (only.has("durable-cold")) await benchDurableCold();
if (only.has("manifest")) await benchManifest();
const peakRssDeltaMiB = Math.round((process.memoryUsage().rss - startedRss) / 1024 / 1024);

if (asJson) {
  console.log(JSON.stringify({ runs, peakRssDeltaMiB, rows }, null, 2));
} else {
  console.log(`change-tracking benchmark (runs=${runs}, rss delta ${peakRssDeltaMiB} MiB)`);
  for (const row of rows) console.log(JSON.stringify(row));
}
