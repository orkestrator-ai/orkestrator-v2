/**
 * Raw-byte worktree capture into the backend object store.
 *
 * A capture is a sequential observation, not an atomic filesystem snapshot:
 * every file is lstat'ed, read and lstat'ed again, and the inventory is listed
 * before and after the pass. A file that changed while it was read is retried
 * once and otherwise recorded as unstable; the result then says
 * `changed-during-capture` rather than pretending to be a point-in-time image.
 *
 * Candidates are the union of the previous capture's paths, the index and
 * eligible untracked files, so a new ignore rule cannot hide a tracked path
 * that the history still owes. Bytes are hashed exactly as read — no Git
 * filter, attribute, hook or fsmonitor runs. Git is used only to list paths,
 * with `core.fsmonitor` disabled.
 *
 * The same capture policy runs for a host worktree (in process) and for a
 * container (a bounded helper executed beside the files, which hashes in
 * place so only missing blobs cross the boundary).
 */

import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { CommandFailedError, runCommandBuffer } from "../shell.js";
import { objectId, type ObjectStore } from "./object-store.js";

/** Git tree kinds supported by manifest v1. */
export type ManifestMode = "100644" | "100755" | "120000" | "160000";

export interface ManifestEntry {
  /** Encoded path id (see {@link encodePath}). */
  p: string;
  m: ManifestMode;
  /** Blob id, or the gitlink commit for mode 160000. */
  o: string;
  s: number;
  /** Tracked in the index at capture time. */
  t: 0 | 1;
}

export interface ManifestOmission {
  p: string;
  reason:
    | "too-large"
    | "unreadable"
    | "capture-byte-budget"
    | "inventory-limit"
    | "unsupported-kind";
  size: number | null;
  /** size:mtime:ctime:ino, to notice changes between omitted endpoints. */
  stamp: string | null;
}

export interface Manifest {
  v: 1;
  root: string;
  entries: ManifestEntry[];
  omitted: ManifestOmission[];
  unstable: string[];
}

export interface CaptureLimits {
  maxCandidates: number;
  maxFileBytes: number;
  maxCaptureBytes: number;
  readers: number;
  stableReadAttempts: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxCandidates: 100_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxCaptureBytes: 256 * 1024 * 1024,
  readers: 8,
  stableReadAttempts: 2,
};

export const MANIFEST_POLICY_ID = "raw-bytes-v1/manifest-v1";
export const OBJECT_FORMAT = "git-loose-sha1+manifest-json-v1";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8", { fatal: false });

/** Reversible path id: `u:` + UTF-8 text, or `b:` + base64 for other bytes. */
export function encodePath(bytes: Uint8Array): string {
  try {
    const text = utf8.decode(bytes);
    if (!text.includes("\0")) return `u:${text}`;
  } catch {
    // Not valid UTF-8: keep the bytes.
  }
  return `b:${Buffer.from(bytes).toString("base64")}`;
}

export function decodePath(id: string): Uint8Array {
  if (id.startsWith("u:")) return new TextEncoder().encode(id.slice(2));
  if (id.startsWith("b:")) return new Uint8Array(Buffer.from(id.slice(2), "base64"));
  return new TextEncoder().encode(id);
}

/** Display spelling; non-UTF-8 bytes become replacement characters. */
export function displayPath(id: string): string {
  if (id.startsWith("u:")) return id.slice(2);
  return lossy.decode(decodePath(id));
}

function comparePathIds(left: string, right: string): number {
  const a = decodePath(left);
  const b = decodePath(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export interface InventoryRecord {
  pathId: string;
  tracked: boolean;
  /** Index gitlink commit, for submodules. */
  gitlink?: string;
}

export interface Inventory {
  records: InventoryRecord[];
  truncated: boolean;
  /** HEAD at listing time, when the worktree is a Git checkout. */
  head: string | null;
}

export type ReadRecord =
  | { pathId: string; kind: "missing" }
  | {
      pathId: string;
      kind: "file" | "symlink";
      mode: ManifestMode;
      size: number;
      stamp: string;
      oid: string;
      /** Bytes, when transferred; absent when only the hash crossed. */
      bytes?: Uint8Array;
      stable: boolean;
    }
  | {
      pathId: string;
      kind: "omitted";
      reason: ManifestOmission["reason"];
      size: number | null;
      stamp: string | null;
    };

export interface CaptureExecutor {
  readonly kind: "host-worker" | "container-worker";
  /** Stable runtime identity for logs and routing (never a content value). */
  readonly label: string;
  inventory(limits: CaptureLimits, signal: AbortSignal): Promise<Inventory>;
  /** Stat, hash (and for the host, read) the given paths. */
  describe(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
    statCache?: ReadonlyMap<string, { stamp: string; oid: string; mode: ManifestMode }>,
  ): Promise<ReadRecord[]>;
  /** Transfer bytes for records whose blobs are missing from the store. */
  fetch(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
  ): Promise<ReadRecord[]>;
}

/** Git invocation hardened against repository-configured programs. */
export const SAFE_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function splitNulBuffer(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0) {
      if (index > start) parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

/** Parse `git ls-files -z -s` (`<mode> <oid> <stage>\t<path>`). */
export function parseLsFilesStage(
  output: Buffer,
): Array<{ path: Buffer; mode: string; oid: string; stage: number }> {
  const records: Array<{ path: Buffer; mode: string; oid: string; stage: number }> = [];
  for (const record of splitNulBuffer(output)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const [mode, oid, stage] = record.subarray(0, tab).toString("latin1").split(" ");
    if (!mode || !oid) continue;
    records.push({ path: record.subarray(tab + 1), mode, oid, stage: Number(stage ?? 0) });
  }
  return records;
}

function statStamp(info: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${info.size}:${Math.trunc(info.mtimeMs * 1000)}:${Math.trunc(info.ctimeMs * 1000)}:${info.ino}`;
}

export class HostCaptureExecutor implements CaptureExecutor {
  readonly kind = "host-worker" as const;
  readonly label: string;

  constructor(private readonly root: string) {
    this.label = `host:${root}`;
  }

  private git(args: string[], timeoutMs: number) {
    return runCommandBuffer("git", [...SAFE_GIT_CONFIG, ...args], {
      cwd: this.root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs,
    });
  }

  async inventory(limits: CaptureLimits): Promise<Inventory> {
    const [staged, untracked, head] = await Promise.all([
      this.git(["ls-files", "-z", "-s"], 30_000),
      this.git(["ls-files", "-z", "--others", "--exclude-standard"], 30_000),
      this.git(["rev-parse", "--verify", "-q", "HEAD"], 10_000).then(
        (result) => result.stdout.toString().trim() || null,
        () => null,
      ),
    ]);
    const byPath = new Map<string, InventoryRecord>();
    for (const entry of parseLsFilesStage(staged.stdout)) {
      const pathId = encodePath(entry.path);
      if (byPath.has(pathId)) continue; // conflict stages share one path
      byPath.set(pathId, {
        pathId,
        tracked: true,
        ...(entry.mode === "160000" ? { gitlink: entry.oid } : {}),
      });
    }
    for (const path of splitNulBuffer(untracked.stdout)) {
      const pathId = encodePath(path);
      if (!byPath.has(pathId)) byPath.set(pathId, { pathId, tracked: false });
    }
    const records = [...byPath.values()];
    const truncated = records.length > limits.maxCandidates;
    return {
      records: truncated ? records.slice(0, limits.maxCandidates) : records,
      truncated,
      head,
    };
  }

  async describe(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
    statCache?: ReadonlyMap<string, { stamp: string; oid: string; mode: ManifestMode }>,
  ): Promise<ReadRecord[]> {
    return mapBounded(pathIds, limits.readers, signal, (pathId) =>
      this.readOne(pathId, limits, statCache),
    );
  }

  fetch(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
  ): Promise<ReadRecord[]> {
    return mapBounded(pathIds, limits.readers, signal, (pathId) => this.readOne(pathId, limits));
  }

  private async readOne(
    pathId: string,
    limits: CaptureLimits,
    statCache?: ReadonlyMap<string, { stamp: string; oid: string; mode: ManifestMode }>,
  ): Promise<ReadRecord> {
    // A Buffer path keeps non-UTF-8 names byte-exact.
    const absolute = Buffer.concat([Buffer.from(`${this.root}/`), Buffer.from(decodePath(pathId))]);
    for (let attempt = 0; attempt < limits.stableReadAttempts; attempt++) {
      const before = await lstat(absolute).catch(() => null);
      if (!before) return { pathId, kind: "missing" };
      if (before.isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: "buffer" }).catch(() => null);
        const after = await lstat(absolute).catch(() => null);
        if (!target)
          return { pathId, kind: "omitted", reason: "unreadable", size: null, stamp: null };
        const bytes = new Uint8Array(target);
        const stable = !!after && statStamp(after) === statStamp(before);
        if (!stable && attempt + 1 < limits.stableReadAttempts) continue;
        return {
          pathId,
          kind: "symlink",
          mode: "120000",
          size: bytes.length,
          stamp: statStamp(before),
          oid: objectId("blob", bytes),
          bytes,
          stable,
        };
      }
      if (!before.isFile()) {
        return {
          pathId,
          kind: "omitted",
          reason: "unsupported-kind",
          size: null,
          stamp: statStamp(before),
        };
      }
      // Metadata reuse: an unchanged size/mtime/ctime/inode keeps the blob read
      // last time. Recorded in coverage; a rewrite preserving all four is the
      // known limitation of this optimisation.
      const cached = statCache?.get(pathId);
      if (cached && cached.stamp === statStamp(before)) {
        return {
          pathId,
          kind: "file",
          mode: cached.mode,
          size: before.size,
          stamp: cached.stamp,
          oid: cached.oid,
          stable: true,
        };
      }
      if (before.size > limits.maxFileBytes) {
        return {
          pathId,
          kind: "omitted",
          reason: "too-large",
          size: before.size,
          stamp: statStamp(before),
        };
      }
      let bytes: Uint8Array;
      try {
        const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          bytes = new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
      } catch {
        return {
          pathId,
          kind: "omitted",
          reason: "unreadable",
          size: before.size,
          stamp: statStamp(before),
        };
      }
      const after = await lstat(absolute).catch(() => null);
      const stable =
        !!after && statStamp(after) === statStamp(before) && bytes.length === before.size;
      if (!stable && attempt + 1 < limits.stableReadAttempts) continue;
      return {
        pathId,
        kind: "file",
        mode: (before.mode & 0o111) !== 0 ? "100755" : "100644",
        size: bytes.length,
        stamp: statStamp(before),
        oid: objectId("blob", bytes),
        bytes,
        stable,
      };
    }
    return { pathId, kind: "omitted", reason: "unreadable", size: null, stamp: null };
  }
}

/**
 * Helper run inside a container with `node -e`. Modes:
 *   inventory               → JSON {records, truncated, head}
 *   describe <base64 list>  → JSON lines of stat + blob hash (no bytes)
 *   fetch <base64 list>     → JSON lines including base64 bytes
 * Paths arrive base64-encoded on stdin, NUL separated.
 */
export const CONTAINER_CAPTURE_HELPER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const root = path.resolve(process.argv[1]);
const mode = process.argv[2];
const maxFile = Number(process.argv[3]);
const maxCandidates = Number(process.argv[4]);
const attempts = Number(process.argv[5]) || 2;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const git = (args) => cp.execFileSync("git", ["-c","core.fsmonitor=false","-c","core.untrackedCache=false","-c","core.hooksPath=/dev/null", ...args], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 256 * 1024 * 1024 });
const split = (buffer) => { const parts = []; let start = 0; for (let i = 0; i < buffer.length; i++) { if (buffer[i] === 0) { if (i > start) parts.push(buffer.subarray(start, i)); start = i + 1; } } if (start < buffer.length) parts.push(buffer.subarray(start)); return parts; };
const stamp = (s) => s.size + ":" + Math.trunc(s.mtimeMs * 1000) + ":" + Math.trunc(s.ctimeMs * 1000) + ":" + s.ino;
const blobId = (bytes) => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
if (mode === "inventory") {
  const seen = new Map();
  for (const record of split(git(["ls-files", "-z", "-s"]))) {
    const tab = record.indexOf(9); if (tab < 0) continue;
    const [m, oid] = record.subarray(0, tab).toString("latin1").split(" ");
    const p = record.subarray(tab + 1).toString("base64");
    if (!seen.has(p)) seen.set(p, { p, t: 1, g: m === "160000" ? oid : undefined });
  }
  for (const record of split(git(["ls-files", "-z", "--others", "--exclude-standard"]))) {
    const p = record.toString("base64"); if (!seen.has(p)) seen.set(p, { p, t: 0 });
  }
  let head = null; try { head = git(["rev-parse", "--verify", "-q", "HEAD"]).toString().trim() || null; } catch {}
  const records = [...seen.values()];
  out({ records: records.slice(0, maxCandidates), truncated: records.length > maxCandidates, head });
} else {
  const input = fs.readFileSync(0);
  for (const encoded of split(input)) {
    const p = encoded.toString("latin1");
    const file = Buffer.concat([Buffer.from(root + "/"), Buffer.from(p, "base64")]);
    let result = null;
    for (let attempt = 0; attempt < attempts && !result; attempt++) {
      let before; try { before = fs.lstatSync(file); } catch { result = { p, k: "missing" }; break; }
      if (before.isSymbolicLink()) {
        let target; try { target = fs.readlinkSync(file, { encoding: "buffer" }); } catch { result = { p, k: "omitted", r: "unreadable" }; break; }
        let after = null; try { after = fs.lstatSync(file); } catch {}
        const stable = !!after && stamp(after) === stamp(before);
        if (!stable && attempt + 1 < attempts) continue;
        result = { p, k: "symlink", m: "120000", s: target.length, st: stamp(before), o: blobId(target), ok: stable, b: mode === "fetch" ? target.toString("base64") : undefined };
        break;
      }
      if (!before.isFile()) { result = { p, k: "omitted", r: "unsupported-kind", st: stamp(before) }; break; }
      if (before.size > maxFile) { result = { p, k: "omitted", r: "too-large", s: before.size, st: stamp(before) }; break; }
      let bytes; try { bytes = fs.readFileSync(file, { flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }); } catch { result = { p, k: "omitted", r: "unreadable", s: before.size, st: stamp(before) }; break; }
      let after = null; try { after = fs.lstatSync(file); } catch {}
      const stable = !!after && stamp(after) === stamp(before) && bytes.length === before.size;
      if (!stable && attempt + 1 < attempts) continue;
      result = { p, k: "file", m: (before.mode & 0o111) ? "100755" : "100644", s: bytes.length, st: stamp(before), o: blobId(bytes), ok: stable, b: mode === "fetch" ? bytes.toString("base64") : undefined };
    }
    out(result || { p, k: "omitted", r: "unreadable" });
  }
}
`;

/** Paths per helper invocation; bounded so stdout stays under the 50 MiB cap. */
const CONTAINER_DESCRIBE_BATCH = 5_000;
const CONTAINER_FETCH_BATCH_BYTES = 24 * 1024 * 1024;

export class ContainerCaptureExecutor implements CaptureExecutor {
  readonly kind = "container-worker" as const;
  readonly label: string;

  constructor(
    private readonly containerId: string,
    private readonly root = "/workspace",
  ) {
    this.label = `container:${containerId}`;
  }

  private async helper(
    mode: string,
    limits: CaptureLimits,
    stdin: Buffer | undefined,
    timeoutMs: number,
  ) {
    try {
      const result = await runCommandBuffer(
        "docker",
        [
          "exec",
          ...(stdin ? ["-i"] : []),
          this.containerId,
          "node",
          "-e",
          CONTAINER_CAPTURE_HELPER,
          "--",
          this.root,
          mode,
          String(limits.maxFileBytes),
          String(limits.maxCandidates),
          String(limits.stableReadAttempts),
        ],
        { ...(stdin ? { stdin } : {}), timeoutMs },
      );
      return result.stdout.toString("utf8");
    } catch (error) {
      if (error instanceof CommandFailedError && error.timedOut) throw new Error("capture-timeout");
      throw new Error("capture-executor-unavailable");
    }
  }

  async inventory(limits: CaptureLimits): Promise<Inventory> {
    const parsed = JSON.parse(await this.helper("inventory", limits, undefined, 60_000)) as {
      records: Array<{ p: string; t: 0 | 1; g?: string }>;
      truncated: boolean;
      head: string | null;
    };
    return {
      records: parsed.records.map((record) => ({
        pathId: encodePath(Buffer.from(record.p, "base64")),
        tracked: record.t === 1,
        ...(record.g ? { gitlink: record.g } : {}),
      })),
      truncated: parsed.truncated,
      head: parsed.head,
    };
  }

  private input(pathIds: readonly string[]): Buffer {
    return Buffer.concat(
      pathIds.map((id) =>
        Buffer.concat([
          Buffer.from(Buffer.from(decodePath(id)).toString("base64"), "latin1"),
          Buffer.from([0]),
        ]),
      ),
    );
  }

  private parse(output: string): ReadRecord[] {
    const records: ReadRecord[] = [];
    for (const line of output.split("\n")) {
      if (!line) continue;
      const raw = JSON.parse(line) as {
        p: string;
        k: string;
        m?: ManifestMode;
        s?: number;
        st?: string;
        o?: string;
        ok?: boolean;
        b?: string;
        r?: ManifestOmission["reason"];
      };
      const pathId = encodePath(Buffer.from(raw.p, "base64"));
      if (raw.k === "missing") records.push({ pathId, kind: "missing" });
      else if (raw.k === "omitted") {
        records.push({
          pathId,
          kind: "omitted",
          reason: raw.r ?? "unreadable",
          size: raw.s ?? null,
          stamp: raw.st ?? null,
        });
      } else {
        const bytes =
          raw.b !== undefined ? new Uint8Array(Buffer.from(raw.b, "base64")) : undefined;
        records.push({
          pathId,
          kind: raw.k === "symlink" ? "symlink" : "file",
          mode: raw.m ?? "100644",
          size: raw.s ?? 0,
          stamp: raw.st ?? "",
          oid: raw.o ?? "",
          ...(bytes ? { bytes } : {}),
          stable: raw.ok === true,
        });
      }
    }
    return records;
  }

  async describe(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
  ): Promise<ReadRecord[]> {
    const records: ReadRecord[] = [];
    for (let index = 0; index < pathIds.length; index += CONTAINER_DESCRIBE_BATCH) {
      if (signal.aborted) throw new Error("capture-timeout");
      const batch = pathIds.slice(index, index + CONTAINER_DESCRIBE_BATCH);
      records.push(
        ...this.parse(await this.helper("describe", limits, this.input(batch), 120_000)),
      );
    }
    return records;
  }

  /** Fetch bytes in batches whose declared sizes fit the transfer budget. */
  async fetch(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
    sizes?: ReadonlyMap<string, number>,
  ): Promise<ReadRecord[]> {
    const records: ReadRecord[] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      if (signal.aborted) throw new Error("capture-timeout");
      records.push(...this.parse(await this.helper("fetch", limits, this.input(batch), 120_000)));
      batch = [];
      batchBytes = 0;
    };
    for (const pathId of pathIds) {
      const size = sizes?.get(pathId) ?? limits.maxFileBytes;
      if (batch.length > 0 && batchBytes + size > CONTAINER_FETCH_BATCH_BYTES) await flush();
      batch.push(pathId);
      batchBytes += size;
    }
    await flush();
    return records;
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        if (signal.aborted) throw new Error("capture-timeout");
        const index = next++;
        results[index] = await work(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureCoverage {
  files: "complete" | "partial";
  candidateCount: number;
  inventoryTruncated: boolean;
  omitted: number;
  unstable: number;
  metadataReused: number;
  retainedBytes: number;
  newObjects: number;
  head: string | null;
  inventoryChanged: boolean;
}

export type CaptureResult =
  | {
      kind: "captured";
      manifestId: string;
      manifest: Manifest;
      coverage: CaptureCoverage;
      consistency: "stable-observation" | "changed-during-capture";
      startedAt: string;
      finishedAt: string;
      newObjectIds: string[];
      /** Stat cache for the next capture of the same incarnation. */
      statCache: Map<string, { stamp: string; oid: string; mode: ManifestMode }>;
    }
  | { kind: "unavailable"; reason: string; startedAt: string; finishedAt: string };

export interface CaptureRequest {
  executor: CaptureExecutor;
  store: ObjectStore;
  /** Paths the previous capture covered, rechecked even if now ignored. */
  previous?: Manifest | null;
  /** Reuse a blob when stat metadata matches; recorded in coverage. */
  statCache?: ReadonlyMap<string, { stamp: string; oid: string; mode: ManifestMode }>;
  limits?: Partial<CaptureLimits>;
  signal?: AbortSignal;
}

export async function captureWorktree(request: CaptureRequest): Promise<CaptureResult> {
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...request.limits };
  const startedAt = new Date().toISOString();
  const signal = request.signal ?? new AbortController().signal;
  const unavailable = (reason: string): CaptureResult => ({
    kind: "unavailable",
    reason,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  try {
    await request.store.init();
    const inventory = await request.executor.inventory(limits, signal);
    const candidates = new Map<string, InventoryRecord>();
    for (const record of inventory.records) candidates.set(record.pathId, record);
    for (const entry of request.previous?.entries ?? []) {
      if (!candidates.has(entry.p)) candidates.set(entry.p, { pathId: entry.p, tracked: false });
    }
    for (const omission of request.previous?.omitted ?? []) {
      if (!candidates.has(omission.p))
        candidates.set(omission.p, { pathId: omission.p, tracked: false });
    }

    const gitlinks: ManifestEntry[] = [];
    const toDescribe: string[] = [];
    for (const record of candidates.values()) {
      if (record.gitlink) {
        gitlinks.push({ p: record.pathId, m: "160000", o: record.gitlink, s: 0, t: 1 });
      } else {
        toDescribe.push(record.pathId);
      }
    }

    const described = await request.executor.describe(
      toDescribe,
      limits,
      signal,
      request.statCache,
    );
    const entries: ManifestEntry[] = [...gitlinks];
    const omitted: ManifestOmission[] = [];
    const unstable: string[] = [];
    const statCache = new Map<string, { stamp: string; oid: string; mode: ManifestMode }>();
    const newObjectIds: string[] = [];
    const needBytes: ReadRecord[] = [];
    let retainedBytes = 0;
    let metadataReused = 0;

    const accept = async (record: Extract<ReadRecord, { kind: "file" | "symlink" }>) => {
      const tracked = candidates.get(record.pathId)?.tracked ? 1 : 0;
      if (!record.stable) unstable.push(record.pathId);
      if (record.bytes) {
        if (retainedBytes + record.bytes.length > limits.maxCaptureBytes) {
          omitted.push({
            p: record.pathId,
            reason: "capture-byte-budget",
            size: record.size,
            stamp: record.stamp,
          });
          return;
        }
        const written = await request.store.put("blob", record.bytes);
        if (written.id !== record.oid) unstable.push(record.pathId);
        if (written.created) {
          retainedBytes += record.bytes.length;
          newObjectIds.push(written.id);
        }
        entries.push({
          p: record.pathId,
          m: record.mode,
          o: written.id,
          s: record.size,
          t: tracked,
        });
        statCache.set(record.pathId, { stamp: record.stamp, oid: written.id, mode: record.mode });
        return;
      }
      if (await request.store.has(record.oid)) {
        entries.push({
          p: record.pathId,
          m: record.mode,
          o: record.oid,
          s: record.size,
          t: tracked,
        });
        statCache.set(record.pathId, { stamp: record.stamp, oid: record.oid, mode: record.mode });
        return;
      }
      needBytes.push(record);
    };

    for (const record of described) {
      if (signal.aborted) return unavailable("capture-timeout");
      if (record.kind === "missing") continue;
      if (record.kind === "omitted") {
        omitted.push({
          p: record.pathId,
          reason: record.reason,
          size: record.size,
          stamp: record.stamp,
        });
        continue;
      }
      const cached = request.statCache?.get(record.pathId);
      if (
        request.executor.kind === "host-worker" &&
        !record.bytes &&
        cached &&
        cached.stamp === record.stamp &&
        cached.oid === record.oid
      ) {
        metadataReused++;
      }
      await accept(record);
    }

    if (needBytes.length > 0) {
      const sizes = new Map(
        needBytes.map((record) => [
          record.pathId,
          record.kind === "omitted" || record.kind === "missing" ? 0 : record.size,
        ]),
      );
      const fetched =
        request.executor instanceof ContainerCaptureExecutor
          ? await request.executor.fetch(
              needBytes.map((record) => record.pathId),
              limits,
              signal,
              sizes,
            )
          : await request.executor.fetch(
              needBytes.map((record) => record.pathId),
              limits,
              signal,
            );
      for (const record of fetched) {
        if (record.kind === "missing") continue;
        if (record.kind === "omitted") {
          omitted.push({
            p: record.pathId,
            reason: record.reason,
            size: record.size,
            stamp: record.stamp,
          });
          continue;
        }
        if (!record.bytes) {
          omitted.push({
            p: record.pathId,
            reason: "unreadable",
            size: record.size,
            stamp: record.stamp,
          });
          continue;
        }
        await accept(record);
      }
    }

    // Inventory recheck: membership that moved during the pass is unstable.
    let inventoryChanged = false;
    const recheck = await request.executor.inventory(limits, signal).catch(() => null);
    if (!recheck) inventoryChanged = true;
    else {
      const after = new Set(recheck.records.map((record) => record.pathId));
      for (const record of inventory.records)
        if (!after.has(record.pathId)) inventoryChanged = true;
      for (const id of after) if (!candidates.has(id)) inventoryChanged = true;
    }

    entries.sort((left, right) => comparePathIds(left.p, right.p));
    omitted.sort((left, right) => comparePathIds(left.p, right.p));
    const manifest: Manifest = {
      v: 1,
      root: request.executor.label,
      entries,
      omitted,
      unstable: [...new Set(unstable)].sort(comparePathIds),
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const written = await request.store.put("manifest", manifestBytes);
    if (written.created) newObjectIds.push(written.id);

    // Closure: every referenced blob is readable from this store alone.
    for (const entry of entries) {
      if (entry.m === "160000") continue;
      if (!(await request.store.has(entry.o))) return unavailable("closure-incomplete");
    }
    request.store.syncDirectories(newObjectIds);

    const partial = inventory.truncated || omitted.length > 0;
    return {
      kind: "captured",
      manifestId: written.id,
      manifest,
      coverage: {
        files: partial ? "partial" : "complete",
        candidateCount: candidates.size,
        inventoryTruncated: inventory.truncated,
        omitted: omitted.length,
        unstable: manifest.unstable.length,
        metadataReused,
        retainedBytes,
        newObjects: newObjectIds.length,
        head: inventory.head,
        inventoryChanged,
      },
      consistency:
        manifest.unstable.length > 0 || inventoryChanged
          ? "changed-during-capture"
          : "stable-observation",
      startedAt,
      finishedAt: new Date().toISOString(),
      newObjectIds,
      statCache,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (signal.aborted || message === "capture-timeout") return unavailable("capture-timeout");
    if (message === "capture-executor-unavailable")
      return unavailable("capture-executor-unavailable");
    if (error instanceof CommandFailedError) return unavailable("not-a-git-worktree");
    return unavailable("capture-failed");
  }
}

export async function readManifest(store: ObjectStore, id: string): Promise<Manifest | null> {
  const bytes = await store.get(id);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    return parsed.v === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}
