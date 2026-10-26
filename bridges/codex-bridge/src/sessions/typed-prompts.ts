/**
 * Typed forms of rewritten prompts, retained for as long as their rollout.
 * Each turn has an independent file: writing another turn never replaces an
 * older record, and independent bridge processes cannot compact away appends.
 * Old JSONL journals remain readable. Replay loads only its current turn;
 * neither long histories nor fork inheritance require an in-memory index.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexBridgeStateDir } from "../bridge-state-dir.js";

export const MAX_TYPED_PROMPT_CHARS = 32_000;
// JSON escaping can expand every character to six bytes.
const MAX_RECORD_BYTES = 6 * MAX_TYPED_PROMPT_CHARS + 2_048;

export interface TypedPromptRecord {
  turnId: string;
  /** sha256 of the trimmed sent text item. */
  sent: string;
  /** The live row's text, with coordinator context already removed. */
  typed: string;
}

export function typedPromptDigest(sentText: string): string {
  return createHash("sha256").update(sentText.trim()).digest("hex");
}

export function typedPromptFor(
  record: TypedPromptRecord | undefined,
  sentText: string,
): string | undefined {
  return record?.sent === typedPromptDigest(sentText) ? record.typed : undefined;
}

function parseRecord(value: unknown): TypedPromptRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { turnId, sent, typed } = value as Record<string, unknown>;
  if (typeof turnId !== "string" || turnId.length === 0 || turnId.length > 200) return undefined;
  if (typeof sent !== "string" || !/^[0-9a-f]{64}$/.test(sent)) return undefined;
  if (typeof typed !== "string" || typed.length > MAX_TYPED_PROMPT_CHARS) return undefined;
  return { turnId, sent, typed };
}

function parseLine(line: string): TypedPromptRecord | undefined {
  try {
    return parseRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Legacy location; kept readable, never compacted or rewritten. */
export function typedPromptJournalPath(codexHome: string, threadId: string): string | undefined {
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (!safe || safe === "." || safe === "..") return undefined;
  return join(codexBridgeStateDir(codexHome), "typed-prompts", `${safe}.jsonl`);
}

export function typedPromptRecordPath(
  codexHome: string,
  threadId: string,
  turnId: string,
): string | undefined {
  const legacy = typedPromptJournalPath(codexHome, threadId);
  return legacy && turnId ? join(`${legacy}.d`, `${typedPromptDigest(turnId)}.json`) : undefined;
}

/** Stream old journals, bounding even a malformed line without a newline. */
async function* legacyRecords(path: string): AsyncGenerator<TypedPromptRecord> {
  let line = "";
  let oversized = false;
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const pieces = String(chunk).split("\n");
      for (let index = 0; index < pieces.length; index += 1) {
        if (!oversized) {
          line += pieces[index];
          if (line.length > MAX_RECORD_BYTES) {
            line = "";
            oversized = true;
          }
        }
        if (index < pieces.length - 1) {
          const record = oversized ? undefined : parseLine(line);
          if (record) yield record;
          line = "";
          oversized = false;
        }
      }
    }
    const record = oversized ? undefined : parseLine(line);
    if (record) yield record;
  } catch {
    // Missing or unreadable display metadata falls back to rollout text.
  } finally {
    stream.destroy();
  }
}

// Only unfinished writes live here, never LRU-evicted journal instances. A
// same-process read waits for its turn's write, including during fork copying.
const writes = new Map<string, Promise<void>>();

async function writeRecord(path: string, record: TypedPromptRecord): Promise<void> {
  const pending = (writes.get(path) ?? Promise.resolve())
    .then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
    })
    .catch(() => {});
  writes.set(path, pending);
  await pending;
  if (writes.get(path) === pending) writes.delete(path);
}

async function readRecord(path: string): Promise<TypedPromptRecord | undefined> {
  await writes.get(path);
  try {
    const file = await open(path, "r");
    try {
      // Never allocate a buffer based on the size of untrusted metadata.
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_RECORD_BYTES) return undefined;
      return parseLine(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** One turn's typed record. No count or tail limit can discard older turns. */
export async function readTypedPrompt(
  codexHome: string,
  threadId: string,
  turnId: string | undefined,
): Promise<TypedPromptRecord | undefined> {
  if (!turnId) return undefined;
  const path = typedPromptRecordPath(codexHome, threadId, turnId);
  if (!path) return undefined;
  const current = await readRecord(path);
  if (current?.turnId === turnId) return current;
  let legacy: TypedPromptRecord | undefined;
  for await (const record of legacyRecords(typedPromptJournalPath(codexHome, threadId)!)) {
    if (record.turnId === turnId) legacy = record;
  }
  return legacy;
}

/** Record an accepted rewrite. Display metadata failures never reject dispatch. */
export function recordTypedPrompt(
  codexHome: string,
  threadId: string,
  turnId: string,
  sentText: string,
  typed: string,
): Promise<void> {
  const record = parseRecord({ turnId, sent: typedPromptDigest(sentText), typed });
  const path = typedPromptRecordPath(codexHome, threadId, turnId);
  if (!record || !path || typed.trim() === sentText.trim()) return Promise.resolve();
  return writeRecord(path, record);
}

/** Copy incrementally; a fork of a long thread never collects all its records. */
export async function inheritTypedPrompts(
  codexHome: string,
  parentThreadId: string,
  forkThreadId: string,
): Promise<void> {
  if (parentThreadId === forkThreadId) return;
  const parent = typedPromptJournalPath(codexHome, parentThreadId);
  const fork = typedPromptJournalPath(codexHome, forkThreadId);
  if (!parent || !fork) return;
  const copy = async (record: TypedPromptRecord) => {
    await writeRecord(typedPromptRecordPath(codexHome, forkThreadId, record.turnId)!, record);
  };
  // Legacy first, so current per-turn records take precedence.
  for await (const record of legacyRecords(parent)) await copy(record);
  // Pending records must be published before enumerating the directory.
  for (const [path, pending] of writes) {
    if (dirname(path) === `${parent}.d`) await pending;
  }
  try {
    const directory = await opendir(`${parent}.d`);
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
      const record = await readRecord(join(`${parent}.d`, entry.name));
      if (record) await copy(record);
    }
  } catch {
    // A missing sidecar is normal; inheritance is best effort.
  }
}
