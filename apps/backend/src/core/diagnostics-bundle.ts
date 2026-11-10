import {
  DIAGNOSTICS_CHUNK_BYTES,
  DIAGNOSTICS_MANIFEST_SCHEMA_VERSION,
  DIAGNOSTICS_REDACTION_NOTICE,
  type DiagnosticsBundleChunk,
  type DiagnosticsBundlePlan,
  type DiagnosticsManifest,
  type DiagnosticsManifestAbsent,
  type DiagnosticsManifestEntry,
} from "@orkestrator/protocol/backend-diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { pack } from "tar-stream";
import {
  containsCredentialShape,
  DiagnosticsRedactor,
  type RedactionContext,
} from "./diagnostics-redaction.js";

/**
 * A local diagnostics bundle: one `.tar.gz` of content-free figures and the
 * logs that explain most bugs, for a user to attach to a report if they choose.
 * Nothing here uploads anything.
 *
 * A plan builds the whole archive, so the manifest it reports is the
 * `manifest.json` inside it and every size and hash in it describes exactly what
 * a later read returns. The bytes wait in memory until read or expired, which
 * also means nothing is left on disk unless the user saves it.
 *
 * Every file goes through {@link DiagnosticsRedactor}, then
 * {@link containsCredentialShape}; a file that still matches is left out and
 * named as absent. See `docs/architecture/logging.md`, "The diagnostics bundle".
 */

const gzipAsync = promisify(gzip);

/** The newest debug log bytes kept, across files. Older lines are not read at all. */
export const DIAGNOSTICS_DEBUG_LOG_BYTES = 8 * 1024 * 1024;
const MAX_JSON_ENTRY_CHARS = 4 * 1024 * 1024;
/** The essential log is capped at four 1 MiB files; this only guards a stray one. */
const MAX_ESSENTIAL_FILE_BYTES = 2 * 1024 * 1024;
const LINES_PER_BATCH = 2_000;
export const DIAGNOSTICS_PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_HELD_PLANS = 2;

const ESSENTIAL_FILE = /^essential(?:\.\d{1,2})?\.jsonl$/;
const DEBUG_LOG_FILE =
  /^orkestrator-(?:ai|backend)-\d{4}-\d{2}-\d{2}(?:\.\d{1,5})?\.(?:log|jsonl)$/;

export interface DiagnosticsJsonSource {
  path: string;
  description: string;
  /** May throw: the file is then named as absent with this source's `absentAs`. */
  read: () => unknown;
  absentAs: string;
}

/**
 * Text already read from somewhere other than this backend's log directory (a
 * container server's log), passed through the same redaction and check as a
 * log file before it is written.
 */
export interface DiagnosticsTextSource {
  path: string;
  description: string;
  text: string;
}

export interface DiagnosticsSources {
  now: () => Date;
  appVersion: string;
  platform: string;
  arch: string;
  bunVersion: string | null;
  redaction: RedactionContext;
  logsDir: string;
  debugLogging: boolean;
  json: readonly DiagnosticsJsonSource[];
  /** Read before the build, chosen by the user; none by default. */
  texts?: readonly DiagnosticsTextSource[];
  /** Things a reader might expect that a bundle does not hold, and why. */
  notCollected: readonly DiagnosticsManifestAbsent[];
  /**
   * Debug log bytes kept across files; defaults to
   * {@link DIAGNOSTICS_DEBUG_LOG_BYTES}. Tests lower it, since redacting the
   * full budget line by line takes seconds on a loaded host.
   */
  debugLogBytes?: number;
}

interface BuiltEntry {
  path: string;
  description: string;
  contents: Buffer;
  redactions: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function redactLines(
  raw: string,
  redactor: DiagnosticsRedactor,
): Promise<{ text: string; redactions: number }> {
  // Process PEM blocks before line boundaries erase their context. An unfinished
  // block consumes the remaining tail rather than exporting its body.
  let blockRedactions = 0;
  const withoutKeys = raw.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    () => {
      blockRedactions += 1;
      return "[redacted]";
    },
  );
  const lines = withoutKeys.split("\n");
  const output: string[] = [];
  let redactions = blockRedactions;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, "");
    const redacted = redactor.line(line);
    output.push(redacted.text);
    redactions += redacted.redactions;
    // A large log stays off the event loop's back.
    if ((index + 1) % LINES_PER_BATCH === 0) await yieldToEventLoop();
  }
  return { text: output.join("\n"), redactions };
}

/** The end of a file, from a line start: a cut line can hold half a credential. */
async function readTail(file: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (length === stat.size) return text;
      const firstLineEnd = text.indexOf("\n");
      return firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1);
    } finally {
      await handle.close();
    }
  } catch {
    // Rotation and unreadable logs must not prevent exporting other diagnostics.
    return null;
  }
}

async function namedFiles(directory: string, pattern: RegExp) {
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => pattern.test(name))
      .map(async (name) => {
        const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
        return stat?.isFile() ? { name, bytes: stat.size, modifiedMs: stat.mtimeMs } : null;
      }),
  );
  return files
    .filter((file) => file !== null)
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
}

/** Text that passes the check after redaction, or `null` to leave the file out. */
function finishedText(text: string, entry: Omit<BuiltEntry, "contents">): BuiltEntry | null {
  if (containsCredentialShape(text)) return null;
  return { ...entry, contents: Buffer.from(text, "utf8") };
}

const REFUSED_REASON =
  "Left out: this file still looked like it held a credential or a home directory after redaction.";

async function collectLogs(
  sources: DiagnosticsSources,
  redactor: DiagnosticsRedactor,
  entries: BuiltEntry[],
  absent: DiagnosticsManifestAbsent[],
): Promise<void> {
  const essentialDirectory = path.join(sources.logsDir, "essential");
  const essential = await namedFiles(essentialDirectory, ESSENTIAL_FILE);
  if (essential.length === 0) {
    absent.push({ name: "logs/essential", reason: "No essential event log has been written yet." });
  }
  for (const file of essential) {
    const raw = await readTail(path.join(essentialDirectory, file.name), MAX_ESSENTIAL_FILE_BYTES);
    if (raw === null) {
      absent.push({
        name: `logs/essential/${file.name}`,
        reason: "The log file could not be read.",
      });
      continue;
    }
    const { text, redactions } = await redactLines(raw, redactor);
    const entry = finishedText(text, {
      path: `logs/essential/${file.name}`,
      description: "The always-on event log: errors and key lifecycle events, with no messages.",
      redactions,
    });
    if (entry) entries.push(entry);
    else absent.push({ name: `logs/essential/${file.name}`, reason: REFUSED_REASON });
  }

  if (!sources.debugLogging) {
    absent.push({
      name: "logs/debug",
      reason: "Save Logs to Disk is off, so the debug log was not read.",
    });
    return;
  }
  let remaining = sources.debugLogBytes ?? DIAGNOSTICS_DEBUG_LOG_BYTES;
  const debugFiles = await namedFiles(sources.logsDir, DEBUG_LOG_FILE);
  if (debugFiles.length === 0) {
    absent.push({ name: "logs/debug", reason: "Save Logs to Disk is on, but no log file exists." });
  }
  // Newest first, so the budget keeps the lines nearest the problem.
  for (const file of debugFiles) {
    if (remaining <= 0) break;
    const raw = await readTail(path.join(sources.logsDir, file.name), remaining);
    if (raw === null) {
      absent.push({ name: `logs/debug/${file.name}`, reason: "The log file could not be read." });
      continue;
    }
    remaining = Math.max(0, remaining - file.bytes);
    const { text, redactions } = await redactLines(raw, redactor);
    const entry = finishedText(text, {
      path: `logs/debug/${file.name}`,
      description: `The newest debug log lines, up to ${DIAGNOSTICS_DEBUG_LOG_BYTES / (1024 * 1024)} MiB across files. Redacted, but can still hold file names and other text.`,
      redactions,
    });
    if (entry) entries.push(entry);
    else absent.push({ name: `logs/debug/${file.name}`, reason: REFUSED_REASON });
  }
}

function collectJson(
  sources: DiagnosticsSources,
  redactor: DiagnosticsRedactor,
  entries: BuiltEntry[],
  absent: DiagnosticsManifestAbsent[],
): void {
  for (const source of sources.json) {
    let read: unknown;
    try {
      read = source.read();
    } catch {
      absent.push({ name: source.path, reason: source.absentAs });
      continue;
    }
    if (read === undefined || read === null) {
      absent.push({ name: source.path, reason: source.absentAs });
      continue;
    }
    const { value, redactions } = redactor.value(read);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (text.length > MAX_JSON_ENTRY_CHARS) {
      absent.push({ name: source.path, reason: "Left out: larger than a bundle file may be." });
      continue;
    }
    const entry = finishedText(text, {
      path: source.path,
      description: source.description,
      redactions,
    });
    if (entry) entries.push(entry);
    else absent.push({ name: source.path, reason: REFUSED_REASON });
  }
}

async function collectTexts(
  sources: DiagnosticsSources,
  redactor: DiagnosticsRedactor,
  entries: BuiltEntry[],
  absent: DiagnosticsManifestAbsent[],
): Promise<void> {
  for (const source of sources.texts ?? []) {
    const { text, redactions } = await redactLines(source.text, redactor);
    const entry = finishedText(text, {
      path: source.path,
      description: source.description,
      redactions,
    });
    if (entry) entries.push(entry);
    else absent.push({ name: source.path, reason: REFUSED_REASON });
  }
}

async function tarGz(
  files: ReadonlyArray<{ path: string; contents: Buffer }>,
  mtime: Date,
): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  })();
  for (const file of files) archive.entry({ name: file.path, mode: 0o600, mtime }, file.contents);
  archive.finalize();
  return gzipAsync(await collected);
}

export interface BuiltDiagnosticsBundle {
  manifest: DiagnosticsManifest;
  archive: Buffer;
}

/** Reads, redacts and packs every source, holding the result in memory. */
export async function buildDiagnosticsBundle(
  sources: DiagnosticsSources,
): Promise<BuiltDiagnosticsBundle> {
  const redactor = new DiagnosticsRedactor(sources.redaction);
  const entries: BuiltEntry[] = [];
  const absent: DiagnosticsManifestAbsent[] = [];
  collectJson(sources, redactor, entries, absent);
  await collectLogs(sources, redactor, entries, absent);
  await collectTexts(sources, redactor, entries, absent);
  absent.push(...sources.notCollected);

  const createdAt = sources.now();
  const manifestEntries: DiagnosticsManifestEntry[] = entries.map((entry) => ({
    path: entry.path,
    bytes: entry.contents.byteLength,
    sha256: createHash("sha256").update(entry.contents).digest("hex"),
    description: entry.description,
    redactions: entry.redactions,
  }));
  const manifest: DiagnosticsManifest = {
    schemaVersion: DIAGNOSTICS_MANIFEST_SCHEMA_VERSION,
    createdAt: createdAt.toISOString(),
    appVersion: redactor.text(sources.appVersion).text,
    platform: sources.platform,
    arch: sources.arch,
    bunVersion: sources.bunVersion,
    notice: DIAGNOSTICS_REDACTION_NOTICE,
    entries: manifestEntries,
    absent,
  };
  const archive = await tarGz(
    [
      { path: "manifest.json", contents: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      ...entries,
    ],
    createdAt,
  );
  return { manifest, archive };
}

export class DiagnosticsPlanError extends Error {
  readonly code = "diagnostics-plan-expired";
}

interface HeldPlan {
  plan: DiagnosticsBundlePlan;
  archive: Buffer;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Plans held for reading. At most {@link MAX_HELD_PLANS}, each dropped when its
 * time is up, so an abandoned export cannot keep its bytes in memory for long.
 * Requests that arrive while a plan with the same choice is building join it.
 */
export class DiagnosticsBundles {
  private readonly held = new Map<string, HeldPlan>();
  /** Builds in flight, by what they were asked to hold. */
  private readonly building = new Map<string, Promise<DiagnosticsBundlePlan>>();

  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      build?: (sources: DiagnosticsSources) => Promise<BuiltDiagnosticsBundle>;
    } = {},
  ) {}

  /**
   * `choice` says what the user chose to add (the container environments, in a
   * canonical order). Only a request for the same choice joins a build in
   * flight: a plan must hold exactly what its caller asked for.
   */
  plan(sources: () => DiagnosticsSources | Promise<DiagnosticsSources>, choice = "") {
    let building = this.building.get(choice);
    if (!building) {
      building = this.buildPlan(sources).finally(() => {
        this.building.delete(choice);
      });
      this.building.set(choice, building);
    }
    return building;
  }

  private async buildPlan(
    sources: () => DiagnosticsSources | Promise<DiagnosticsSources>,
  ): Promise<DiagnosticsBundlePlan> {
    const { manifest, archive } = await (this.options.build ?? buildDiagnosticsBundle)(
      await sources(),
    );
    const now = (this.options.now ?? Date.now)();
    const ttlMs = this.options.ttlMs ?? DIAGNOSTICS_PLAN_TTL_MS;
    const expiresAt = now + ttlMs;
    const planId = randomUUID();
    const plan: DiagnosticsBundlePlan = {
      planId,
      fileName: `orkestrator-diagnostics-${manifest.createdAt.replace(/[:.]/g, "-")}.tar.gz`,
      expiresAt: new Date(expiresAt).toISOString(),
      archive: {
        bytes: archive.byteLength,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
      manifest,
    };
    const timer = setTimeout(() => this.drop(planId), ttlMs);
    timer.unref?.();
    this.held.set(planId, { plan, archive, expiresAt, timer });
    while (this.held.size > MAX_HELD_PLANS) {
      this.drop(this.held.keys().next().value as string);
    }
    return plan;
  }

  /** One piece, from `offset`. A plan is read as many times as asked until it expires. */
  read(planId: string, offset: number): DiagnosticsBundleChunk {
    const held = this.held.get(planId);
    if (!held || (this.options.now ?? Date.now)() >= held.expiresAt) {
      if (held) this.drop(planId);
      throw new DiagnosticsPlanError("This diagnostics plan has expired. Plan the bundle again.");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > held.archive.byteLength) {
      throw new RangeError("The offset is outside this diagnostics bundle.");
    }
    const end = Math.min(offset + DIAGNOSTICS_CHUNK_BYTES, held.archive.byteLength);
    return {
      planId,
      fileName: held.plan.fileName,
      archive: held.plan.archive,
      offset,
      data: held.archive.subarray(offset, end).toString("base64"),
      nextOffset: end < held.archive.byteLength ? end : null,
    };
  }

  private drop(planId: string): void {
    const held = this.held.get(planId);
    if (!held) return;
    clearTimeout(held.timer);
    this.held.delete(planId);
  }

  dispose(): void {
    for (const planId of Array.from(this.held.keys())) this.drop(planId);
  }
}
