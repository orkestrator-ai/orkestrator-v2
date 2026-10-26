/**
 * What the user typed for a turn whose prompt the bridge rewrote before
 * sending it.
 *
 * The live **You** row shows the prompt as typed; Codex's rollout holds the
 * text the bridge sent. For a `/skill:name` command (sent as `$name`), a
 * prompt template (sent expanded) and the first prompt after a lost rollout
 * (sent inside the recovered transcript) the typed text cannot be read back
 * from what was sent, so the bridge keeps it here, one sparse append-only
 * JSONL file per thread, and a reload lays it back over the rollout's text.
 * The plan-mode preamble needs no record: it is fixed text that the reader
 * strips exactly (`stripPlanModePreamble`).
 *
 * A record applies only to the user message of its own turn whose sent text
 * hashes to the digest it holds. A steer in the same turn, a thread continued
 * from the Codex CLI, or a record whose turn was rewritten all render the
 * rollout's text. Bounded on every axis (entries per file, characters per
 * entry, bytes read back) and failure-silent: a lost record costs the typed
 * form of one prompt, never the message.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexBridgeStateDir } from "../bridge-state-dir.js";

export const MAX_TYPED_PROMPT_ENTRIES = 500;
/** A longer typed prompt is not recorded; its reload shows what was sent. */
export const MAX_TYPED_PROMPT_CHARS = 32_000;
const MAX_TYPED_PROMPT_FILE_BYTES = 4 * 1024 * 1024;
/** Journal instances kept open; past this many threads the least recently used is dropped. */
export const MAX_OPEN_TYPED_PROMPT_JOURNALS = 256;

export interface TypedPromptRecord {
  turnId: string;
  /** sha256 of the sent text item, trimmed, as `typedPromptDigest` computes it. */
  sent: string;
  /** The live row's text: the prompt as typed, coordinator context already removed. */
  typed: string;
}

export type TypedPrompts = ReadonlyMap<string, TypedPromptRecord>;

/** Digest of a sent text item, matched against the rollout's joined user text. */
export function typedPromptDigest(sentText: string): string {
  return createHash("sha256").update(sentText.trim()).digest("hex");
}

/** The typed text for the user message `sentText` of `turnId`, when this bridge recorded it. */
export function typedPromptFor(
  prompts: TypedPrompts,
  turnId: string | undefined,
  sentText: string,
): string | undefined {
  const record = turnId ? prompts.get(turnId) : undefined;
  return record && record.sent === typedPromptDigest(sentText) ? record.typed : undefined;
}

function parseRecord(value: unknown): TypedPromptRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { turnId, sent, typed } = value as Record<string, unknown>;
  if (typeof turnId !== "string" || turnId.length === 0 || turnId.length > 200) return undefined;
  if (typeof sent !== "string" || !/^[0-9a-f]{64}$/.test(sent)) return undefined;
  if (typeof typed !== "string" || typed.length > MAX_TYPED_PROMPT_CHARS) return undefined;
  return { turnId, sent, typed };
}

async function readJournal(
  path: string,
  maxEntries: number,
): Promise<Map<string, TypedPromptRecord>> {
  const records = new Map<string, TypedPromptRecord>();
  let text: string;
  try {
    const buffer = await readFile(path);
    // A runaway file is read from its tail: the newest turns are the ones a
    // reload is most likely to show.
    text = buffer
      .subarray(Math.max(0, buffer.length - MAX_TYPED_PROMPT_FILE_BYTES))
      .toString("utf8");
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
    const record = parseRecord(parsed);
    if (!record) continue;
    // Re-inserting moves the turn to the end, so eviction drops the oldest.
    records.delete(record.turnId);
    records.set(record.turnId, record);
    if (records.size > maxEntries) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
  }
  return records;
}

/** One instance per file: appends are serialized, and a read waits for them. */
class TypedPromptJournal {
  private appendsSinceCompaction = 0;
  private sizeChecked = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly maxEntries = MAX_TYPED_PROMPT_ENTRIES,
  ) {}

  append(records: readonly TypedPromptRecord[]): Promise<void> {
    const lines = records
      .map(parseRecord)
      .filter((record): record is TypedPromptRecord => record !== undefined)
      .map((record) => `${JSON.stringify(record)}\n`);
    if (lines.length === 0) return this.writes;
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        if (!this.sizeChecked) {
          this.sizeChecked = true;
          const existing = await stat(this.path).catch(() => undefined);
          if (existing && existing.size > MAX_TYPED_PROMPT_FILE_BYTES / 2) await this.compact();
        }
        await appendFile(this.path, lines.join(""), { mode: 0o600 });
        this.appendsSinceCompaction += lines.length;
        if (this.appendsSinceCompaction >= this.maxEntries) await this.compact();
      })
      .catch(() => {});
    return this.writes;
  }

  async read(): Promise<Map<string, TypedPromptRecord>> {
    await this.writes;
    return readJournal(this.path, this.maxEntries);
  }

  /** Rewrite the file with only the newest `maxEntries` records. */
  private async compact(): Promise<void> {
    this.appendsSinceCompaction = 0;
    const records = await readJournal(this.path, this.maxEntries);
    const body = Array.from(records.values(), (record) => JSON.stringify(record)).join("\n");
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, body ? `${body}\n` : "", { mode: 0o600 });
    await rename(temp, this.path);
  }
}

const journals = new Map<string, TypedPromptJournal>();

/** Thread ids are UUIDs; anything else is folded to a safe file name. */
export function typedPromptJournalPath(codexHome: string, threadId: string): string | undefined {
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (!safe || safe === "." || safe === "..") return undefined;
  return join(codexBridgeStateDir(codexHome), "typed-prompts", `${safe}.jsonl`);
}

function journalFor(codexHome: string, threadId: string): TypedPromptJournal | undefined {
  const path = typedPromptJournalPath(codexHome, threadId);
  if (!path) return undefined;
  let journal = journals.get(path);
  if (journal) {
    journals.delete(path);
  } else {
    journal = new TypedPromptJournal(path);
    while (journals.size >= MAX_OPEN_TYPED_PROMPT_JOURNALS) {
      const oldest = journals.keys().next().value;
      if (oldest === undefined) break;
      journals.delete(oldest);
    }
  }
  journals.set(path, journal);
  return journal;
}

/** Every recorded typed prompt for one thread, by turn; empty when there are none. */
export async function readTypedPrompts(
  codexHome: string,
  threadId: string,
): Promise<Map<string, TypedPromptRecord>> {
  const journal = journalFor(codexHome, threadId);
  if (!journal) return new Map();
  return journal.read().catch(() => new Map<string, TypedPromptRecord>());
}

/**
 * Record what the user typed for an accepted turn. Never rejects. Nothing is
 * written when the typed text is what was sent, or too long to keep.
 */
export function recordTypedPrompt(
  codexHome: string,
  threadId: string,
  turnId: string,
  sentText: string,
  typed: string,
): Promise<void> {
  if (!turnId || typed.length > MAX_TYPED_PROMPT_CHARS || typed.trim() === sentText.trim()) {
    return Promise.resolve();
  }
  return (
    journalFor(codexHome, threadId)?.append([
      { turnId, sent: typedPromptDigest(sentText), typed },
    ]) ?? Promise.resolve()
  );
}

/**
 * A fork's rollout copies its parent's turns, ids and all, but the parent's
 * typed prompts live in the parent's file. Copy them into the fork's before
 * the fork is first replayed; a record for a turn the fork dropped matches
 * nothing.
 */
export async function inheritTypedPrompts(
  codexHome: string,
  parentThreadId: string,
  forkThreadId: string,
): Promise<void> {
  if (parentThreadId === forkThreadId) return;
  const inherited = await readTypedPrompts(codexHome, parentThreadId);
  if (inherited.size === 0) return;
  await journalFor(codexHome, forkThreadId)?.append([...inherited.values()]);
}
