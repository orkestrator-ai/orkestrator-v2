/**
 * Reads a diagnostics bundle (`buildDiagnosticsBundle`, or a file from
 * `orkestrator diagnostics export`) into the few files self-improvement uses: the manifest, the essential event log, the
 * health rows and the database figures. Accepts the `.tar.gz` itself or a
 * directory it was extracted into.
 *
 * Everything here is data, never code: entries are read into memory, their
 * names are checked, and nothing is written to disk. Every read is bounded.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";

/** A diagnostics bundle is a few MiB; these leave room without trusting a stray file. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES = 512;
/** The essential log is capped at 4 MiB of 4 KiB entries; this is far above that. */
export const MAX_ESSENTIAL_ENTRIES = 200_000;

export type FieldValue = string | number | boolean | null;

export interface EssentialEntry {
  ts: string;
  at: number;
  level: string;
  area: string;
  event: string;
  fields: Record<string, FieldValue>;
}

export interface HealthJob {
  started: number;
  failed: number;
  totalMs: number;
}

export interface HealthRow {
  kind: "started" | "clean-exit" | "sample";
  at: number;
  pid: number;
  startedAt: number;
  uptimeMs?: number;
  rssBytes?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  stalls?: number | null;
  worstStallMs?: number | null;
  jobs?: Record<string, HealthJob>;
}

export interface SlowSeries {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface LeaseFamily {
  acquired: number;
  timedOut: number;
  maxWaitMs: number;
}

export interface DatabaseFigures {
  mainFileBytes: number | null;
  mainWalBytes: number | null;
  mainFreelistBytes: number | null;
  leaseFamilies: Record<string, LeaseFamily>;
  transactionsBusy: number;
  slowSeries: Record<string, SlowSeries>;
}

export interface BundleManifestInfo {
  createdAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  /** Names the bundle says it left out, with the reason. */
  absent: Array<{ name: string; reason: string }>;
}

export interface BundleData {
  /** SHA-256 of the archive, or of the files read from a directory. */
  sha256: string;
  manifest: BundleManifestInfo;
  essential: EssentialEntry[];
  /** Essential lines that were not valid entries. */
  essentialUnreadable: number;
  health: HealthRow[];
  database: DatabaseFigures | null;
}

const WANTED =
  /^(?:manifest\.json|health-summary\.json|database\.json|logs\/essential\/[A-Za-z0-9._-]+\.jsonl)$/;

function safeName(name: string): string | null {
  const normalized = name.replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return WANTED.test(normalized) ? normalized : null;
}

async function readArchive(archive: Buffer): Promise<Map<string, Buffer>> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `The bundle is larger than ${MAX_ARCHIVE_BYTES} bytes; is it a diagnostics bundle?`,
    );
  }
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const files = new Map<string, Buffer>();
  let entries = 0;
  const reader = extract();
  const done = new Promise<void>((resolve, reject) => {
    reader.on("entry", (header, stream, next) => {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        reject(new Error(`The bundle has more than ${MAX_ENTRIES} entries.`));
        stream.resume();
        return;
      }
      const name = header.type === "file" ? safeName(header.name) : null;
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (data: unknown) => {
        if (!name) return;
        const chunk = data as Buffer;
        bytes += chunk.byteLength;
        if (bytes <= MAX_FILE_BYTES) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (name && bytes <= MAX_FILE_BYTES) files.set(name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    reader.on("finish", resolve);
    reader.on("error", reject);
  });
  reader.end(tar);
  await done;
  return files;
}

function readDirectory(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const add = (relative: string) => {
    const name = safeName(relative);
    if (!name) return;
    const full = path.join(root, relative);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    files.set(name, readFileSync(full));
  };
  add("manifest.json");
  add("health-summary.json");
  add("database.json");
  const essentialDir = path.join(root, "logs", "essential");
  let names: string[] = [];
  try {
    names = readdirSync(essentialDir);
  } catch {
    names = [];
  }
  for (const name of names.slice(0, MAX_ENTRIES)) add(`logs/essential/${name}`);
  return files;
}

function parseJson(buffer: Buffer | undefined): unknown {
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseManifest(value: unknown): BundleManifestInfo {
  const manifest = record(value);
  if (!manifest)
    throw new Error("The bundle has no readable manifest.json; is it a diagnostics bundle?");
  const absent = Array.isArray(manifest.absent)
    ? manifest.absent
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({ name: str(item.name), reason: str(item.reason) }))
    : [];
  return {
    createdAt: str(manifest.createdAt),
    appVersion: str(manifest.appVersion, "unknown"),
    platform: str(manifest.platform),
    arch: str(manifest.arch),
    absent,
  };
}

/** Oldest first: `essential.jsonl` is the newest file, `essential.3.jsonl` the oldest. */
function essentialFileOrder(name: string): number {
  const match = /essential\.(\d+)\.jsonl$/.exec(name);
  return match ? -Number(match[1]) : 0;
}

export function parseEssentialLines(text: string): {
  entries: EssentialEntry[];
  unreadable: number;
} {
  const entries: EssentialEntry[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: Record<string, unknown> | null = null;
    try {
      value = record(JSON.parse(line));
    } catch {
      value = null;
    }
    const at = value ? Date.parse(str(value.ts)) : Number.NaN;
    if (!value || !Number.isFinite(at) || !str(value.area) || !str(value.event)) {
      unreadable += 1;
      continue;
    }
    const fields: Record<string, FieldValue> = {};
    for (const [key, field] of Object.entries(record(value.fields) ?? {})) {
      if (field === null || ["string", "number", "boolean"].includes(typeof field)) {
        fields[key] = field as FieldValue;
      }
    }
    entries.push({
      ts: str(value.ts),
      at,
      level: str(value.level, "info"),
      area: str(value.area),
      event: str(value.event),
      fields,
    });
  }
  return { entries, unreadable };
}

function parseHealth(value: unknown): HealthRow[] {
  if (!Array.isArray(value)) return [];
  const rows: HealthRow[] = [];
  for (const item of value) {
    const row = record(item);
    if (!row) continue;
    const kind = row.kind;
    const at = num(row.at);
    const pid = num(row.pid);
    const startedAt = num(row.startedAt);
    if ((kind !== "started" && kind !== "clean-exit" && kind !== "sample") || at === null) continue;
    if (pid === null || startedAt === null) continue;
    const jobs: Record<string, HealthJob> = {};
    for (const [name, job] of Object.entries(record(row.jobs) ?? {})) {
      const fields = record(job);
      if (!fields) continue;
      jobs[name] = {
        started: num(fields.started) ?? 0,
        failed: num(fields.failed) ?? 0,
        totalMs: num(fields.totalMs) ?? 0,
      };
    }
    rows.push({
      kind,
      at,
      pid,
      startedAt,
      uptimeMs: num(row.uptimeMs) ?? undefined,
      rssBytes: num(row.rssBytes) ?? undefined,
      cpuUserMs: num(row.cpuUserMs) ?? undefined,
      cpuSystemMs: num(row.cpuSystemMs) ?? undefined,
      stalls: num(row.stalls),
      worstStallMs: num(row.worstStallMs),
      jobs,
    });
  }
  return rows.sort((left, right) => left.at - right.at);
}

function parseDatabase(value: unknown): DatabaseFigures | null {
  const database = record(value);
  if (!database) return null;
  const main = record(database.main);
  const leaseWaits = record(database.leaseWaits);
  const leaseFamilies: Record<string, LeaseFamily> = {};
  for (const [family, figures] of Object.entries(record(leaseWaits?.families) ?? {})) {
    const fields = record(figures);
    if (!fields) continue;
    leaseFamilies[family] = {
      acquired: num(fields.acquired) ?? 0,
      timedOut: num(fields.timedOut) ?? 0,
      maxWaitMs: num(fields.maxWaitMs) ?? 0,
    };
  }
  const slowSeries: Record<string, SlowSeries> = {};
  for (const [key, figures] of Object.entries(
    record(record(database.slowOperations)?.series) ?? {},
  )) {
    const fields = record(figures);
    if (!fields) continue;
    slowSeries[key] = {
      count: num(fields.count) ?? 0,
      totalMs: num(fields.totalMs) ?? 0,
      maxMs: num(fields.maxMs) ?? 0,
    };
  }
  return {
    mainFileBytes: num(main?.fileBytes),
    mainWalBytes: num(main?.walBytes),
    mainFreelistBytes: num(main?.freelistBytes),
    leaseFamilies,
    transactionsBusy: num(leaseWaits?.transactionsBusy) ?? 0,
    slowSeries,
  };
}

export function parseBundleFiles(files: Map<string, Buffer>, sha256: string): BundleData {
  const manifest = parseManifest(parseJson(files.get("manifest.json")));
  const essentialNames = [...files.keys()]
    .filter((name) => name.startsWith("logs/essential/"))
    .sort((left, right) => essentialFileOrder(left) - essentialFileOrder(right));
  const essential: EssentialEntry[] = [];
  let essentialUnreadable = 0;
  for (const name of essentialNames) {
    const parsed = parseEssentialLines(files.get(name)!.toString("utf8"));
    essentialUnreadable += parsed.unreadable;
    for (const entry of parsed.entries) {
      if (essential.length >= MAX_ESSENTIAL_ENTRIES) break;
      essential.push(entry);
    }
  }
  essential.sort((left, right) => left.at - right.at);
  return {
    sha256,
    manifest,
    essential,
    essentialUnreadable,
    health: parseHealth(parseJson(files.get("health-summary.json"))),
    database: parseDatabase(parseJson(files.get("database.json"))),
  };
}

/** Reads a bundle archive held in memory, as `buildDiagnosticsBundle` returns it. */
export async function readBundleArchive(archive: Buffer): Promise<BundleData> {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`The bundle is larger than ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return parseBundleFiles(await readArchive(archive), sha256);
}

/** Reads a bundle archive file or an extracted bundle directory (tests and manual use). */
export async function readBundle(location: string): Promise<BundleData> {
  const stat = statSync(location);
  if (stat.isDirectory()) {
    const files = readDirectory(location);
    const hash = createHash("sha256");
    for (const name of [...files.keys()].sort()) hash.update(name).update(files.get(name)!);
    return parseBundleFiles(files, hash.digest("hex"));
  }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `The bundle is larger than ${MAX_ARCHIVE_BYTES} bytes; is it a diagnostics bundle?`,
    );
  }
  const archive = readFileSync(location);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return parseBundleFiles(await readArchive(archive), sha256);
}
