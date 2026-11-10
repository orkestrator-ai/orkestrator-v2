/**
 * Synthetic diagnostics bundles for the improvement digest tests, in the same
 * layout `diagnostics-bundle.ts` writes: manifest.json, health-summary.json,
 * database.json and logs/essential/*.jsonl, gzipped into one tar.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { type BundleData, parseBundleFiles } from "../bundle.js";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const MIB = 1024 * 1024;

export interface EssentialLine {
  at: number;
  level?: "error" | "warn" | "info";
  area: string;
  event: string;
  fields?: Record<string, string | number | boolean | null>;
}

export interface FixtureBundle {
  createdAt: number;
  appVersion?: string;
  essential?: EssentialLine[];
  health?: unknown[];
  database?: unknown;
  /** Extra archive entries, for name checks. */
  extra?: Array<{ name: string; contents: string }>;
}

export function essentialJsonl(lines: readonly EssentialLine[]): string {
  return lines
    .map((line) =>
      JSON.stringify({
        orklog: 1,
        ts: new Date(line.at).toISOString(),
        level: line.level ?? "warn",
        area: line.area,
        event: line.event,
        ...(line.fields ? { fields: line.fields } : {}),
      }),
    )
    .join("\n")
    .concat("\n");
}

export function bundleFiles(bundle: FixtureBundle): Array<{ name: string; contents: string }> {
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date(bundle.createdAt).toISOString(),
    appVersion: bundle.appVersion ?? "2.30.0",
    platform: "linux",
    arch: "x64",
    bunVersion: "1.4.4",
    notice: "Redaction is a best-effort pass.",
    entries: [],
    absent: [{ name: "container server logs", reason: "Not collected." }],
  };
  const files = [{ name: "manifest.json", contents: JSON.stringify(manifest) }];
  if (bundle.essential)
    files.push({
      name: "logs/essential/essential.jsonl",
      contents: essentialJsonl(bundle.essential),
    });
  if (bundle.health)
    files.push({ name: "health-summary.json", contents: JSON.stringify(bundle.health) });
  if (bundle.database)
    files.push({ name: "database.json", contents: JSON.stringify(bundle.database) });
  return [...files, ...(bundle.extra ?? [])];
}

/** The bundle as a run reads it, without building an archive. */
export function bundleData(bundle: FixtureBundle, sha = "a"): BundleData {
  const files = new Map(bundleFiles(bundle).map((file) => [file.name, Buffer.from(file.contents)]));
  return parseBundleFiles(files, sha.repeat(64).slice(0, 64));
}

export async function bundleArchive(bundle: FixtureBundle): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  })();
  for (const file of bundleFiles(bundle))
    archive.entry({ name: file.name, mode: 0o600 }, file.contents);
  archive.finalize();
  return gzipSync(await collected);
}

export function bundleDirectory(root: string, bundle: FixtureBundle): string {
  for (const file of bundleFiles(bundle)) {
    const target = path.join(root, file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.contents);
  }
  return root;
}

/** Health rows for one backend run: a start marker, a sample every 5 minutes, and an optional clean exit. */
export function healthRun(options: {
  pid: number;
  startedAt: number;
  hours: number;
  clean: boolean;
  rssStartMiB?: number;
  rssMiBPerHour?: number;
  cpuPercent?: number;
  stalls?: number;
  worstStallMs?: number;
  jobs?: Record<string, { started: number; failed: number; totalMs: number }>;
}): unknown[] {
  const rows: unknown[] = [
    { kind: "started", at: options.startedAt, pid: options.pid, startedAt: options.startedAt },
  ];
  const end = options.startedAt + options.hours * HOUR;
  for (let at = options.startedAt + 5 * 60 * 1000; at <= end; at += 5 * 60 * 1000) {
    const uptimeMs = at - options.startedAt;
    const hours = uptimeMs / HOUR;
    rows.push({
      kind: "sample",
      at,
      pid: options.pid,
      startedAt: options.startedAt,
      uptimeMs,
      rssBytes: Math.round(
        ((options.rssStartMiB ?? 300) + (options.rssMiBPerHour ?? 0) * hours) * MIB,
      ),
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
      cpuUserMs: Math.round(((options.cpuPercent ?? 2) / 100) * uptimeMs),
      cpuSystemMs: 0,
      stalls: options.stalls ?? 0,
      worstStallMs: options.worstStallMs ?? null,
      mainDatabaseBytes: null,
      mainWalBytes: null,
      mainFreeBytes: null,
      ledgerBytes: null,
      ledgerWalBytes: null,
      backupBytes: null,
      jobs: options.jobs ?? {},
    });
  }
  if (options.clean)
    rows.push({ kind: "clean-exit", at: end, pid: options.pid, startedAt: options.startedAt });
  return rows;
}

export function temporaryDirectory(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
