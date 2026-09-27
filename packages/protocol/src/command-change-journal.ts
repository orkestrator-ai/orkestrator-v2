/**
 * Durable record of what each shell command changed, keyed by tool call id.
 *
 * The measurement (see `workspace-change-probe.ts`) exists only in the bridge
 * that took it: no provider transcript carries it, so a reload rebuilds the
 * shell row without its badge unless the bridge keeps it somewhere. This is
 * that somewhere — one append-only JSONL file per session, written once per
 * measured command rather than rewriting a whole state file each time.
 *
 * Node-only. Bounded on every axis: entries per file (older entries are
 * compacted away), files and path length per entry, and bytes read back.
 * Every operation is failure-silent; a lost record costs a badge.
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MeasuredFileChange, MeasuredWorkspaceChange } from "./tool-diff.js";

export const MAX_JOURNAL_ENTRIES = 1_000;
/** A file keeps at most this many files per entry; the totals cover them all. */
export const MAX_JOURNAL_FILES_PER_ENTRY = 20;
const MAX_JOURNAL_PATH_LENGTH = 1_024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

export interface CommandChangeRecord {
  id: string;
  change: MeasuredWorkspaceChange;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseFile(value: unknown): MeasuredFileChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const file = value as Record<string, unknown>;
  if (typeof file.path !== "string" || file.path.length === 0) return undefined;
  if (!isCount(file.additions) || !isCount(file.deletions)) return undefined;
  return {
    path: file.path.slice(0, MAX_JOURNAL_PATH_LENGTH),
    additions: file.additions,
    deletions: file.deletions,
    ...(file.binary === true ? { binary: true as const } : {}),
    ...(typeof file.previousPath === "string" && file.previousPath.length > 0
      ? { previousPath: file.previousPath.slice(0, MAX_JOURNAL_PATH_LENGTH) }
      : {}),
  };
}

/**
 * Validate and bound a measured change from untrusted JSON. Shared with the
 * wire readers so a record parsed from disk and one received live are held to
 * the same shape.
 */
export function parseMeasuredWorkspaceChange(
  value: unknown,
  maxFiles = MAX_JOURNAL_FILES_PER_ENTRY,
): MeasuredWorkspaceChange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const change = value as Record<string, unknown>;
  if (!isCount(change.additions) || !isCount(change.deletions)) return undefined;
  const rawFiles = Array.isArray(change.files) ? change.files : [];
  const files: MeasuredFileChange[] = [];
  for (const raw of rawFiles) {
    const file = parseFile(raw);
    if (file) files.push(file);
    if (files.length >= maxFiles) break;
  }
  const truncated = change.filesTruncated === true || files.length < rawFiles.length;
  return {
    additions: change.additions,
    deletions: change.deletions,
    files,
    ...(truncated ? { filesTruncated: true as const } : {}),
    ...(change.approximate === true ? { approximate: true as const } : {}),
  };
}

/** True when a measured change is worth showing (and so worth persisting). */
export function hasMeasuredChanges(change: MeasuredWorkspaceChange | undefined): boolean {
  return Boolean(change && (change.additions > 0 || change.deletions > 0 || change.files.length));
}

/**
 * One instance per file: appends are serialized per instance, so callers keep
 * the instance for the session's life rather than constructing one per write.
 */
export class CommandChangeJournal {
  private appendsSinceCompaction = 0;
  /** Earlier processes may have left more than `maxEntries` behind. */
  private sizeChecked = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxEntries = MAX_JOURNAL_ENTRIES,
  ) {}

  /** Append one record. Writes are serialized; the returned promise never rejects. */
  append(id: string, change: MeasuredWorkspaceChange): Promise<void> {
    const bounded = parseMeasuredWorkspaceChange(change);
    if (!id || !bounded) return this.writes;
    const line = `${JSON.stringify({ id, change: bounded })}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        if (!this.sizeChecked) {
          this.sizeChecked = true;
          const existing = await stat(this.path).catch(() => undefined);
          if (existing && existing.size > MAX_JOURNAL_BYTES / 2) await this.compact();
        }
        await appendFile(this.path, line, { mode: 0o600 });
        this.appendsSinceCompaction += 1;
        if (this.appendsSinceCompaction >= this.maxEntries) await this.compact();
      })
      .catch(() => {});
    return this.writes;
  }

  /** Read every surviving record, later records for an id replacing earlier ones. */
  async read(): Promise<Map<string, MeasuredWorkspaceChange>> {
    await this.writes;
    return readJournal(this.path, this.maxEntries);
  }

  async remove(): Promise<void> {
    await this.writes;
    await rm(this.path, { force: true }).catch(() => {});
  }

  /** Rewrite the file with only the newest `maxEntries` records. */
  private async compact(): Promise<void> {
    this.appendsSinceCompaction = 0;
    const records = await readJournal(this.path, this.maxEntries);
    const body = Array.from(records, ([id, change]) => JSON.stringify({ id, change })).join("\n");
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, body ? `${body}\n` : "", { mode: 0o600 });
    await rename(temp, this.path);
  }
}

async function readJournal(
  path: string,
  maxEntries: number,
): Promise<Map<string, MeasuredWorkspaceChange>> {
  const records = new Map<string, MeasuredWorkspaceChange>();
  let text: string;
  try {
    const buffer = await readFile(path);
    // A runaway file is read from its tail: the newest records are the ones
    // a reload is most likely to show.
    text = buffer.subarray(Math.max(0, buffer.length - MAX_JOURNAL_BYTES)).toString("utf8");
  } catch {
    return records;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const { id, change } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) continue;
    const measured = parseMeasuredWorkspaceChange(change);
    if (!measured) continue;
    // Re-inserting moves the id to the end, so eviction drops the oldest.
    records.delete(id);
    records.set(id, measured);
    if (records.size > maxEntries) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
  }
  return records;
}
