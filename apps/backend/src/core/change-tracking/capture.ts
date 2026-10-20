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

import { confinedRead, validCapturePath } from "./confined-read.js";
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
    sizes?: ReadonlyMap<string, number>,
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

  private git(args: string[], timeoutMs: number, signal?: AbortSignal) {
    return runCommandBuffer("git", [...SAFE_GIT_CONFIG, ...args], {
      cwd: this.root,
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs,
    });
  }

  async inventory(limits: CaptureLimits, signal?: AbortSignal): Promise<Inventory> {
    const [staged, untracked, head] = await Promise.all([
      this.git(["ls-files", "-z", "-s"], 30_000, signal),
      this.git(["ls-files", "-z", "--others", "--exclude-standard"], 30_000, signal),
      this.git(["rev-parse", "--verify", "-q", "HEAD"], 10_000, signal).then(
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
      this.readOne(pathId, limits, statCache, signal),
    );
  }

  fetch(
    pathIds: readonly string[],
    limits: CaptureLimits,
    signal: AbortSignal,
  ): Promise<ReadRecord[]> {
    return mapBounded(pathIds, limits.readers, signal, (pathId) =>
      this.readOne(pathId, limits, undefined, signal),
    );
  }

  private async readOne(
    pathId: string,
    limits: CaptureLimits,
    statCache?: ReadonlyMap<string, { stamp: string; oid: string; mode: ManifestMode }>,
    signal?: AbortSignal,
  ): Promise<ReadRecord> {
    if (!validCapturePath(decodePath(pathId)))
      return { pathId, kind: "omitted", reason: "unreadable", size: null, stamp: null };
    for (let attempt = 0; attempt < limits.stableReadAttempts; attempt++) {
      try {
        const { bytes, info, after, symlink } = await confinedRead(
          this.root,
          decodePath(pathId),
          limits.maxFileBytes,
          signal,
        );
        const stamp = info ? statStamp(info) : `symlink:${objectId("blob", bytes)}`;
        const stable =
          !info || (!!after && statStamp(after) === stamp && bytes.length === info.size);
        if (!stable && attempt + 1 < limits.stableReadAttempts) continue;
        const cached = statCache?.get(pathId);
        return {
          pathId,
          kind: symlink ? "symlink" : "file",
          mode: symlink ? "120000" : info!.mode & 0o111 ? "100755" : "100644",
          size: bytes.length,
          stamp,
          oid: objectId("blob", bytes),
          ...(cached?.stamp === stamp ? {} : { bytes }),
          stable,
        };
      } catch (error) {
        if (signal?.aborted) throw new Error("capture-timeout");
        const message = error instanceof Error ? error.message : "";
        if (message === "capture-file-missing") return { pathId, kind: "missing" };
        return {
          pathId,
          kind: "omitted",
          reason: message === "capture-file-too-large" ? "too-large" : "unreadable",
          size: null,
          stamp: null,
        };
      }
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
const rootInfo = fs.lstatSync(root);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe-root");
const pinRoot = () => { process.chdir(root); const pinned = fs.statSync("."); if (pinned.dev !== rootInfo.dev || pinned.ino !== rootInfo.ino) throw new Error("unsafe-root"); };
pinRoot();
const mode = process.argv[2];
const maxFile = Number(process.argv[3]);
const maxCandidates = Number(process.argv[4]);
const attempts = Number(process.argv[5]) || 2;
let remaining = Number(process.argv[6]) || 0;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const git = (args) => cp.execFileSync("git", ["-c","core.fsmonitor=false","-c","core.untrackedCache=false","-c","core.hooksPath=/dev/null", ...args], { cwd: ".", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 256 * 1024 * 1024 });
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
    const rawPath = Buffer.from(p, "base64");
    const text = rawPath.toString("latin1");
    const parts = text.split("/");
    if (!text || text.includes("\0") || text.includes("\\") || /^[A-Za-z]:/.test(text) || parts.some(x => !x || x === "." || x === ".." || x.toLowerCase() === ".git")) { out({ p, k: "omitted", r: "unreadable" }); continue; }
    const file = Buffer.from(parts.pop(), "latin1");
    try {
      pinRoot();
      for (const part of parts) {
        const component = Buffer.from(part, "latin1");
        const before = fs.lstatSync(component);
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("ancestor");
        process.chdir(component);
        const pinned = fs.statSync(".");
        if (before.dev !== pinned.dev || before.ino !== pinned.ino) throw new Error("ancestor");
      }
    } catch (e) { out(e.code === "ENOENT" ? { p, k: "missing" } : { p, k: "omitted", r: "unreadable" }); continue; }
    const maxRead = mode === "fetch" ? Math.min(maxFile, remaining) : maxFile;
    let result = null;
    for (let attempt = 0; attempt < attempts && !result; attempt++) {
      let before; try { before = fs.lstatSync(file); } catch { result = { p, k: "missing" }; break; }
      if (before.isSymbolicLink()) {
        let target; try { target = fs.readlinkSync(file, { encoding: "buffer" }); } catch { result = { p, k: "omitted", r: "unreadable" }; break; }
        if (target.length > maxRead) { result = { p, k: "omitted", r: maxRead < maxFile ? "capture-byte-budget" : "too-large", s: target.length }; break; }
        let after = null; try { after = fs.lstatSync(file); } catch {}
        const stable = !!after && stamp(after) === stamp(before);
        if (!stable && attempt + 1 < attempts) continue;
        result = { p, k: "symlink", m: "120000", s: target.length, st: stamp(before), o: blobId(target), ok: stable, b: mode === "fetch" ? target.toString("base64") : undefined };
        break;
      }
      if (!before.isFile()) { result = { p, k: "omitted", r: "unsupported-kind", st: stamp(before) }; break; }
      if (before.size > maxRead) { result = { p, k: "omitted", r: maxRead < maxFile ? "capture-byte-budget" : "too-large", s: before.size, st: stamp(before) }; break; }
      let bytes; try { const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const info = fs.fstatSync(fd); if (!info.isFile() || info.size > maxRead) throw new Error("size"); const buffer = Buffer.alloc(Math.min(info.size + 1, maxRead + 1)); let n = 0; while(n < buffer.length) { const count = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!count) break; n += count; } if (n > maxRead) throw new Error("size"); bytes = buffer.subarray(0, n); } finally { fs.closeSync(fd); } } catch { result = { p, k: "omitted", r: "unreadable", s: before.size, st: stamp(before) }; break; }
      let after = null; try { after = fs.lstatSync(file); } catch {}
      const stable = !!after && stamp(after) === stamp(before) && bytes.length === before.size;
      if (!stable && attempt + 1 < attempts) continue;
      result = { p, k: "file", m: (before.mode & 0o111) ? "100755" : "100644", s: bytes.length, st: stamp(before), o: blobId(bytes), ok: stable, b: mode === "fetch" ? bytes.toString("base64") : undefined };
    }
    if (result && result.b !== undefined) remaining -= result.s;
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
    signal?: AbortSignal,
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
          String(limits.maxCaptureBytes),
        ],
        { ...(stdin ? { stdin } : {}), timeoutMs, signal },
      );
      return result.stdout.toString("utf8");
    } catch (error) {
      if (error instanceof CommandFailedError && error.timedOut) throw new Error("capture-timeout");
      throw new Error("capture-executor-unavailable");
    }
  }

  async inventory(limits: CaptureLimits, signal?: AbortSignal): Promise<Inventory> {
    const parsed = JSON.parse(
      await this.helper("inventory", limits, undefined, 60_000, signal),
    ) as {
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
        ...this.parse(await this.helper("describe", limits, this.input(batch), 120_000, signal)),
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
      records.push(
        ...this.parse(await this.helper("fetch", limits, this.input(batch), 120_000, signal)),
      );
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
        retainedBytes += record.bytes.length;
        if (written.created) {
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
      if (await request.store.reuse(record.oid)) {
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

    const describeBatch = request.executor.kind === "host-worker" ? 1 : CONTAINER_DESCRIBE_BATCH;
    for (let index = 0; index < toDescribe.length; index += describeBatch) {
      const described = await request.executor.describe(
        toDescribe.slice(index, index + describeBatch),
        {
          ...limits,
          maxFileBytes: Math.min(
            limits.maxFileBytes,
            Math.max(0, limits.maxCaptureBytes - retainedBytes),
          ),
        },
        signal,
        request.statCache,
      );
      for (const record of described) {
        if (signal.aborted) return unavailable("capture-timeout");
        if (record.kind === "missing") continue;
        if (record.kind === "omitted") {
          omitted.push({
            p: record.pathId,
            reason:
              record.reason === "too-large" &&
              limits.maxCaptureBytes - retainedBytes < limits.maxFileBytes
                ? "capture-byte-budget"
                : record.reason,
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
    }
    if (needBytes.length > 0) {
      for (let index = 0; index < needBytes.length;) {
        const batch: string[] = [];
        const batchSizes = new Map<string, number>();
        let batchBytes = 0;
        const transferBudget = Math.min(
          CONTAINER_FETCH_BATCH_BYTES,
          limits.maxCaptureBytes - retainedBytes,
        );
        do {
          const candidate = needBytes[index]!;
          if (candidate.kind !== "file" && candidate.kind !== "symlink") {
            index++;
            continue;
          }
          if (candidate.size > limits.maxCaptureBytes - retainedBytes) {
            omitted.push({
              p: candidate.pathId,
              reason: "capture-byte-budget",
              size: candidate.size,
              stamp: candidate.stamp,
            });
            index++;
            continue;
          }
          if (
            batch.length &&
            (batchBytes + candidate.size > transferBudget ||
              request.executor.kind === "host-worker")
          )
            break;
          batch.push(candidate.pathId);
          batchSizes.set(candidate.pathId, candidate.size);
          batchBytes += candidate.size;
          index++;
        } while (index < needBytes.length && batch.length < CONTAINER_DESCRIBE_BATCH);
        if (!batch.length) continue;
        const fetched = await request.executor.fetch(
          batch,
          {
            ...limits,
            maxFileBytes: Math.min(limits.maxFileBytes, transferBudget),
            maxCaptureBytes: transferBudget,
          },
          signal,
          batchSizes,
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
    if (signal.aborted) return unavailable("capture-timeout");
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
    if (message === "capture-storage-quota") return unavailable(message);
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
