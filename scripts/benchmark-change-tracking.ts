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
 * One fixture for database growth: `measurement-rows` runs the same turn and
 * environment history through the whole service on a temporary database, and
 * reports the file rows written and kept and the database's size. It uses only
 * routes that predate the row cap, so one script measures both sides of a change.
 *
 * One fixture for the hourly retention pass (ST-20): `retention` stores
 * `--retention-snapshots` snapshots of `--retention-files` real blobs, each a
 * distinct tree, all still referenced, with the newest few manifests read as
 * open diff views would. It reports two passes' duration, their longest
 * event-loop stall, how many manifests each pass parsed or found cached, and
 * how long a capture's write waited while a sweep ran.
 *
 * One fixture for undoing a bulk turn (#2047): `restore-apply` runs one
 * turn that writes `--restore-files` new files through the whole service,
 * finalizes it (retrying a timed-out end capture as the backend would), then
 * times the restore preview and `apply` end to end. It reports the turn's end
 * capture, the apply's checkpoint and result captures with their deadlines
 * and outcomes, and how many files were restored. The writes go through one
 * conditional-write helper process per batch of 500 files (todo 7555; before
 * that, one per file, about 12 ms each on a quiet host).
 *
 * Fixture files are left to age `--settle-ms` before the first capture, so a
 * warm capture sees them as settled (see `STAT_SETTLE_WINDOW_MS` in capture.ts).
 *
 *   bun scripts/benchmark-change-tracking.ts [--sizes=100,1000,10000] [--runs=5]
 *     [--assets=20] [--asset-mib=8] [--changed=200] [--settle-ms=2500]
 *     [--blob-mib=16] [--durable-files=1000] [--manifest-entries=100000]
 *     [--bulk-files=20000] [--moving-passes=6] [--idle-passes=6] [--env-scans=12]
 *     [--retention-snapshots=400] [--retention-files=10000] [--live-views=8]
 *     [--restore-files=10000,20000] [--restore-cold] [--restore-finalization-ms=N]
 *     [--only=capture,assets,long-turn,sharing,counting,large-blob,durable-cold,manifest,measurement-rows,retention,restore-apply]
 *     [--json]
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
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
import { ChangeTrackingService } from "../apps/backend/src/core/change-tracking/service";
import { turnIdFor } from "../apps/backend/src/core/change-tracking/turn-boundaries";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  openChangeLedgerDatabase,
} from "../apps/backend/src/core/change-tracking/ledger-schema";

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
const bulkFiles = Number(arg("bulk-files", "20000"));
const movingPasses = Number(arg("moving-passes", "6"));
const idlePasses = Number(arg("idle-passes", "6"));
const envScans = Number(arg("env-scans", "12"));
const retentionSnapshots = Number(arg("retention-snapshots", "400"));
const retentionFiles = Number(arg("retention-files", "10000"));
const liveViews = Number(arg("live-views", "8"));
const restoreFiles = arg("restore-files", "10000,20000").split(",").map(Number);
/** Drop the owner's stat cache before the apply, as after an idle owner was swept. */
const restoreCold = process.argv.includes("--restore-cold");
/** A shorter turn finalization deadline, to exercise the end-capture recovery. */
const restoreFinalizationMs = Number(arg("restore-finalization-ms", "0")) || undefined;
const only = new Set(
  arg(
    "only",
    "capture,assets,long-turn,sharing,counting,large-blob,durable-cold,manifest,measurement-rows,retention,restore-apply",
  ).split(","),
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

/**
 * The workload called `measurement-rows`: one environment over a temporary
 * database. A turn adds `--bulk-files` small files under one directory (a
 * dependency install) and edits one source file, then runs `--moving-passes`
 * provisional passes that each move the tree and `--idle-passes` that do not,
 * and ends. The environment scan then reports the same bulk list `--env-scans`
 * times, one path changing per scan. Nothing reads a real data directory.
 */
async function benchMeasurementRows() {
  const repo = makeRepo(50);
  const dataDir = mkdtempSync(path.join(tmpdir(), "ork-bench-ledger-"));
  const database = openChangeLedgerDatabase(dataDir);
  const service = new ChangeTrackingService({
    dataDir,
    database: () => database,
    emit: () => undefined,
    environmentTarget: async () => ({ kind: "local", worktreePath: repo }),
    durable: false,
    manualScheduling: true,
    policy: { provisionalSpacingLocalMs: 0 },
  });
  service.start();
  const count = (table: string) =>
    (database.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const pragma = (name: string) => {
    const row = database.db.query(`PRAGMA ${name}`).get() as Record<string, number>;
    return row[name] ?? 0;
  };
  const size = () => {
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      fileMiB:
        Math.round(
          (statSync(path.join(dataDir, CHANGE_LEDGER_DATABASE_FILE)).size / 2 ** 20) * 10,
        ) / 10,
      freeMiB: Math.round(((pragma("freelist_count") * pragma("page_size")) / 2 ** 20) * 10) / 10,
    };
  };
  let rowsWritten = 0;
  let measurementsWritten = 0;
  let peakRows = 0;
  let peakFileMiB = 0;
  const insert = service.ledger.insertMeasurement.bind(service.ledger);
  service.ledger.insertMeasurement = (measurement, owner, files, seq) => {
    rowsWritten += files.length;
    measurementsWritten += 1;
    insert(measurement, owner, files, seq);
  };
  const sample = async () => {
    // Whatever a build defers runs before the sample, as it would between passes.
    const retention = service.retention as unknown as { idle?: () => Promise<void> };
    await retention.idle?.();
    peakRows = Math.max(peakRows, count("change_measurement_files"));
    peakFileMiB = Math.max(peakFileMiB, size().fileMiB);
  };
  try {
    const requestId = "bench";
    const session = { environmentId: "env", logicalSessionKey: "env-env:tab", requestId };
    await service.prepareTurnStart({ ...session, provider: "claude" });
    service.markTurnDispatched("env", "env-env:tab", requestId, "accepted");
    const bulk = path.join(repo, "vendor");
    mkdirSync(bulk, { recursive: true });
    for (let index = 0; index < bulkFiles; index++)
      writeFileSync(path.join(bulk, `dep${index}.js`), `module.exports = ${index};\n`);
    const identity = await service.registry.resolve({ kind: "local", worktreePath: repo });
    const owner = service.registry.owner(identity!);
    for (let pass = 0; pass < movingPasses; pass++) {
      writeFileSync(path.join(repo, "d0", "f0.ts"), `export const moved = ${pass};\n`);
      await service.turns.provisional("env", owner);
      await sample();
    }
    for (let pass = 0; pass < idlePasses; pass++) {
      await service.turns.provisional("env", owner);
      await sample();
    }
    await service.finalizeTurn(session);
    await sample();
    const target = {
      environmentId: "env",
      comparisonRef: "main",
      kind: "local" as const,
      worktreePath: repo,
    };
    for (let scan = 0; scan < envScans; scan++) {
      const changes = Array.from({ length: bulkFiles }, (_, index) => {
        const file = index === 0 ? `vendor/round${scan}.js` : `vendor/dep${index}.js`;
        return {
          path: file,
          filename: file,
          directory: "",
          additions: 1,
          deletions: 0,
          status: "?",
        };
      });
      const at = new Date().toISOString();
      service.onDiffScanEvent({
        kind: "scanned",
        target,
        result: {
          stats: { additions: bulkFiles, deletions: 0, filesChanged: bulkFiles, truncated: false },
          changes,
          baseOid: "a".repeat(40),
        },
        changed: true,
        at,
        startedAt: at,
      });
      await service.environments.idle();
      await sample();
    }
    const afterWorkload = { rows: count("change_measurement_files"), ...size() };
    await service.retention.run();
    rows.push({
      workload: `measurement-rows (${bulkFiles} bulk files, ${movingPasses} moving + ${idlePasses} idle provisional passes, ${envScans} scans)`,
      measurementsWritten,
      rowsWritten,
      peakRows,
      peakFileMiB,
      rowsAfterWorkload: afterWorkload.rows,
      fileMiBAfterWorkload: afterWorkload.fileMiB,
      rowsAfterRetention: count("change_measurement_files"),
      ...Object.fromEntries(
        Object.entries(size()).map(([key, value]) => [`${key}AfterRetention`, value]),
      ),
    });
  } finally {
    service.shutdown();
    database.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Undo a turn that wrote `files` new files: end capture, preview and apply. */
async function benchRestoreApply(files: number) {
  const repo = makeRepo(50);
  const dataDir = mkdtempSync(path.join(tmpdir(), "ork-bench-restore-"));
  const database = openChangeLedgerDatabase(dataDir);
  const service = new ChangeTrackingService({
    dataDir,
    database: () => database,
    emit: () => undefined,
    environmentTarget: async () => ({ kind: "local", worktreePath: repo }),
    durable: false,
    manualScheduling: true,
    policy: restoreFinalizationMs ? { finalizationDeadlineMs: restoreFinalizationMs } : {},
  });
  service.start();
  const load = () => Math.round(loadavg()[0]! * 10) / 10;
  const row: Row = { workload: `restore-apply (${files} files)`, cores: availableParallelism() };
  try {
    const requestId = "bench";
    const session = { environmentId: "env", logicalSessionKey: "env-env:tab", requestId };
    await service.prepareTurnStart({ ...session, provider: "claude" });
    service.markTurnDispatched("env", "env-env:tab", requestId, "accepted");
    const bulk = path.join(repo, "generated");
    mkdirSync(bulk, { recursive: true });
    for (let index = 0; index < files; index++)
      writeFileSync(path.join(bulk, `file${index}.txt`), `generated ${index}\n`);
    row.loadAtTurnEnd = load();
    let started = performance.now();
    await service.finalizeTurn(session);
    row.endCaptureMs = Math.round(performance.now() - started);
    const id = turnIdFor("env", "env-env:tab", requestId);
    row.turnEnd = `${service.ledger.turn(id)?.lifecycle}/${service.ledger.turn(id)?.reason ?? "-"}`;
    if (service.ledger.turn(id)?.reason === "capture-timeout") {
      started = performance.now();
      const recovered = await service.endRecovery.attempt(id);
      row.endRecoveryMs = Math.round(performance.now() - started);
      row.endRecovery = recovered.kind === "recovered" ? "recovered" : recovered.reason;
    }
    const measurement = service.ledger.latestMeasurement("turn", id, "turn-net");
    if (!measurement) throw new Error("no turn measurement");
    row.loadAtPreview = load();
    started = performance.now();
    const preview = await service.restore.prepare({ measurementId: measurement.measurementId });
    row.previewMs = Math.round(performance.now() - started);
    if (preview.kind !== "preview") {
      row.preview = preview.kind === "disabled" ? preview.reasonKey : preview.error.reasonKey;
      return;
    }
    row.planned = preview.files.filter((file) => file.action !== "skip").length;
    const owner = service.registry.ownerById(measurement.worktreeId)!;
    if (restoreCold) owner.invalidate();
    row.checkpointStatCache = restoreCold ? "cold" : "warm";
    const capture = owner.capture.bind(owner);
    owner.capture = async (options) => {
      const began = performance.now();
      const outcome = await capture(options);
      row[`${options.purpose}Ms`] = Math.round(performance.now() - began);
      row[`${options.purpose}DeadlineMs`] = options.deadlineMs;
      row[options.purpose] = outcome.kind === "published" ? "published" : outcome.reason;
      return outcome;
    };
    row.loadAtApply = load();
    started = performance.now();
    const applied = await service.restore.apply({
      actionToken: preview.actionToken,
      idempotencyKey: "bench",
    });
    row.applyMs = Math.round(performance.now() - started);
    row.loadAfterApply = load();
    if (applied.kind === "applied") {
      row.outcome = applied.outcome;
      row.restored = applied.completedPathIds.length;
      row.failed = applied.failedPathIds.length;
      const writesMs =
        Number(row.applyMs) -
        Number(row["restore-checkpointMs"] ?? 0) -
        Number(row["restore-resultMs"] ?? 0);
      row.writesMs = writesMs;
      row.msPerRestoredFile = Math.round((writesMs / Math.max(1, row.restored)) * 100) / 100;
    } else {
      row.outcome = applied.error.reasonKey;
    }
  } finally {
    rows.push(row);
    service.shutdown();
    database.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * The hourly pass over a history of distinct trees. Snapshot rows are written
 * straight to the ledger, every one referenced, so the pass removes nothing
 * and measures only its walks.
 */
async function benchRetention() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ork-bench-retention-"));
  const database = openChangeLedgerDatabase(dataDir);
  const service = new ChangeTrackingService({
    dataDir,
    database: () => database,
    emit: () => undefined,
    environmentTarget: async () => ({ kind: "local", worktreePath: dataDir }),
    durable: false,
    manualScheduling: true,
  });
  service.start();
  try {
    const store = service.objects;
    const batch = store.batch();
    const entries = [];
    for (let index = 0; index < retentionFiles; index++) {
      const bytes = new TextEncoder().encode(`export const value${index} = ${index};\n`);
      const { id } = await batch.put("blob", bytes);
      entries.push({
        p: encodePath(new TextEncoder().encode(`d${index % 50}/f${index}.ts`)),
        m: "100644" as const,
        o: id,
        s: bytes.length,
        t: 1 as const,
      });
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.p), Buffer.from(right.p)));
    const trees: string[] = [];
    for (let index = 0; index < retentionSnapshots; index++) {
      // One file changes per snapshot, so every tree is distinct.
      const changed = entries.map((entry, position) =>
        position === index % entries.length ? { ...entry, s: entry.s + index + 1 } : entry,
      );
      const manifest = { v: 1, root: "bench", entries: changed, omitted: [], unstable: [] };
      const { id } = await batch.put(
        "manifest",
        new TextEncoder().encode(JSON.stringify(manifest)),
      );
      trees.push(id);
      const at = new Date(Date.now() - (retentionSnapshots - index) * 1000).toISOString();
      service.ledger.insertSnapshot({
        id: `snap-${index}`,
        worktree_id: "bench",
        incarnation: "bench",
        tree_oid: id,
        object_format: "sha1",
        policy_id: "bench",
        capture_started_at: at,
        capture_finished_at: at,
        observation_epoch: 0,
        coverage_json: "{}",
        consistency_json: "{}",
        closure_verified: 1,
        file_count: retentionFiles,
        retained_bytes: 0,
        created_at: at,
      });
      service.ledger.addReference({
        ownerKind: "bench",
        ownerId: `owner-${index}`,
        snapshotId: `snap-${index}`,
        reason: "bench",
      });
    }
    await batch.flush();
    await batch.close();
    for (const id of trees.slice(-liveViews)) await readManifest(store, id);
    const passes: Row = {};
    for (const pass of [1, 2]) {
      const before = store.manifests.snapshot();
      const reachabilityBefore = service.retention.reachabilityStats?.().hits ?? 0;
      const { result, durationMs, stallMs } = await measureLoop(() =>
        service.retention.run(Date.now()),
      );
      const after = store.manifests.snapshot();
      passes[`pass${pass}Ms`] = Math.round(durationMs);
      passes[`pass${pass}StallMs`] = Math.round(stallMs * 10) / 10;
      passes[`pass${pass}ManifestsParsed`] = after.parses - before.parses;
      passes[`pass${pass}ManifestHits`] = after.hits - before.hits;
      // Absent before ST-20's reachability cache, so the script runs on both sides.
      passes[`pass${pass}ReachabilityHits`] =
        (service.retention.reachabilityStats?.().hits ?? 0) - reachabilityBefore;
      passes[`pass${pass}RemovedObjects`] = result.removedObjects;
    }
    // How long one capture write waits on the store while a sweep walks it.
    const reachable = new Set([...trees, ...entries.map((entry) => entry.o)]);
    const sweep = store.sweep(reachable, CHANGE_TRACKING_POLICY_V1.orphanGraceMs);
    const putStarted = performance.now();
    await store.put("blob", randomBytes(64));
    const putDuringSweepMs = performance.now() - putStarted;
    const sweepStarted = performance.now();
    await sweep;
    rows.push({
      workload: `retention over ${retentionSnapshots} snapshots of ${retentionFiles} files, ${liveViews} live views`,
      ...passes,
      putDuringSweepMs: Math.round(putDuringSweepMs * 10) / 10,
      sweepTailMs: Math.round(performance.now() - sweepStarted),
    });
  } finally {
    service.shutdown();
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
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
if (only.has("measurement-rows")) await benchMeasurementRows();
if (only.has("retention")) await benchRetention();
if (only.has("restore-apply")) for (const size of restoreFiles) await benchRestoreApply(size);
const peakRssDeltaMiB = Math.round((process.memoryUsage().rss - startedRss) / 1024 / 1024);

if (asJson) {
  console.log(JSON.stringify({ runs, peakRssDeltaMiB, rows }, null, 2));
} else {
  console.log(`change-tracking benchmark (runs=${runs}, rss delta ${peakRssDeltaMiB} MiB)`);
  for (const row of rows) console.log(JSON.stringify(row));
}
