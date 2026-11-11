/**
 * Picks the conversation parts the insight stage has not read yet and renders
 * each as compact text for the model: messages and replies only, tool names
 * counted, secrets redacted, every piece capped.
 *
 * A conversation is read once it has been quiet for an hour, from where the
 * last run stopped, so a long conversation is read in parts and none twice.
 * Where it stopped is a byte offset in the history file, not an entry count:
 * a file too large to read whole is read from a tail that slides forward as
 * the file grows, so an entry's index moves while its offset does not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { createEventLoopSlicer } from "../../event-loop-slice.js";
import { writeAtomic } from "../ledger.js";
import {
  type Conversation,
  listTranscriptFiles,
  MAX_TRANSCRIPT_BYTES,
  readConversation,
  type TranscriptEntry,
  type TranscriptSources,
} from "./transcripts.js";

/** A conversation is read only after it has been quiet this long. */
export const SETTLE_MS = 60 * 60 * 1000;
/** How far back the first run reads. */
export const FIRST_RUN_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Conversation parts read per run; the rest wait for the next run. */
export const MAX_SEGMENTS_PER_RUN = 30;
/** Text sent to the model for one part. */
export const MAX_SEGMENT_CHARS = 60_000;
const MAX_USER_CHARS = 2500;
const MAX_REPLY_CHARS = 1200;
/** Earlier entries repeated before a continued part, for context. */
const CONTEXT_ENTRIES = 2;
/** Cursor entries kept: conversations not touched for this long are forgotten. */
const CURSOR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface CursorEntry {
  /**
   * Entries of the conversation already read. Only a fallback now: used when
   * `lastEntryOffset` is absent or names another file.
   */
  analyzedEntries: number;
  /** The history file the offset below is in. */
  file?: string;
  /** The byte offset of the last entry already read; reading resumes after it. */
  lastEntryOffset?: number;
  lastAt: number;
  project: string;
  /** When the last part was read. */
  analyzedAt: number;
  /**
   * When the newest part a model reviewed ended. Absent while only system
   * messages were ever seen: such a conversation was skipped, not reviewed,
   * and does not count as evidence (`readConversationsByVersion`).
   */
  reviewedAt?: number;
}

export interface InsightCursor {
  schemaVersion: 1;
  conversations: Record<string, CursorEntry>;
}

export interface Segment {
  conversationId: string;
  provider: Conversation["provider"];
  project: string;
  startedAt: number;
  lastAt: number;
  /** Entry range read, [from, to): indexes into this run's read of the file. */
  from: number;
  to: number;
  /** The history file, and the byte offset of the part's last entry. */
  file: string;
  lastEntryOffset?: number;
  /** Names the part across runs (its byte range when known), for note ids. */
  key: string;
  text: string;
  typedMessages: number;
}

/** A conversation read up to date with nothing worth sending (only system messages). */
export interface SkippedPart {
  conversationId: string;
  to: number;
  file: string;
  lastEntryOffset?: number;
  lastAt: number;
  project: string;
}

/**
 * The cursor entry after `part` was handled. A reviewed part moves
 * `reviewedAt`; a skipped one keeps the earlier value, so a conversation that
 * was reviewed once stays evidence when a later system-only tail is skipped.
 */
export function cursorAfter(
  part: Segment | SkippedPart,
  reviewed: boolean,
  previous: CursorEntry | undefined,
  now: number,
): CursorEntry {
  const reviewedAt = reviewed ? part.lastAt : previous?.reviewedAt;
  return {
    analyzedEntries: part.to,
    file: part.file,
    ...(part.lastEntryOffset !== undefined ? { lastEntryOffset: part.lastEntryOffset } : {}),
    lastAt: part.lastAt,
    project: part.project,
    analyzedAt: now,
    ...(reviewedAt !== undefined ? { reviewedAt } : {}),
  };
}

function cursorPath(dir: string): string {
  return path.join(dir, "cursor.json");
}

export function loadCursor(dir: string): InsightCursor {
  try {
    const cursor = JSON.parse(readFileSync(cursorPath(dir), "utf8")) as InsightCursor;
    if (cursor.schemaVersion === 1 && cursor.conversations) return cursor;
  } catch {
    // First run.
  }
  return { schemaVersion: 1, conversations: {} };
}

export function saveCursor(dir: string, cursor: InsightCursor, now: number): void {
  for (const [id, entry] of Object.entries(cursor.conversations)) {
    if (now - entry.lastAt > CURSOR_RETENTION_MS) delete cursor.conversations[id];
  }
  writeAtomic(cursorPath(dir), `${JSON.stringify(cursor)}\n`);
}

function clip(text: string, max: number, keepEnd = false): string {
  if (text.length <= max) return text;
  if (!keepEnd) return `${text.slice(0, max)} […]`;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)} […] ${text.slice(text.length - (max - head))}`;
}

function time(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function renderEntry(entry: TranscriptEntry, replyChars: number): string {
  if (entry.role === "interrupt")
    return `[${time(entry.at)}] (the person interrupted the agent here)`;
  if (entry.role === "user") {
    const who =
      entry.origin === "typed" ? "PERSON" : entry.origin === "agent" ? "AGENT MESSAGE" : "SYSTEM";
    return `[${time(entry.at)}] ${who}: ${clip(entry.text, MAX_USER_CHARS)}`;
  }
  const tools = Object.entries(entry.tools)
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  const notes = [
    tools ? `tools: ${tools}` : null,
    entry.toolErrors ? `${entry.toolErrors} tool error(s)` : null,
  ]
    .filter(Boolean)
    .join("; ");
  const text = entry.text ? clip(entry.text, replyChars, true) : "(no text)";
  return `[${time(entry.at)}] ASSISTANT: ${text}${notes ? `\n  (${notes})` : ""}`;
}

/** The part of a conversation from `from`, as text for the model, within the size cap. */
export function renderSegment(conversation: Conversation, from: number): string {
  const start = Math.max(0, from - CONTEXT_ENTRIES);
  const header = [
    `Conversation ${conversation.id} (${conversation.provider}), project "${conversation.project}"`,
    `From ${time(conversation.startedAt)} to ${time(conversation.lastAt)} UTC, entries ${from + 1}-${conversation.entries.length} of ${conversation.entries.length}.`,
    start < from
      ? `The first ${from - start} entr${from - start === 1 ? "y is" : "ies are"} earlier context, already read.`
      : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  for (const replyChars of [MAX_REPLY_CHARS, 400, 150]) {
    const body = conversation.entries
      .slice(start)
      .map((entry) => renderEntry(entry, replyChars))
      .join("\n");
    const text = redactSecrets(`${header}\n${body}`);
    if (text.length <= MAX_SEGMENT_CHARS) return text;
  }
  // Still too long: keep the newest part that fits.
  const body = conversation.entries
    .slice(start)
    .map((entry) => renderEntry(entry, 150))
    .join("\n");
  return redactSecrets(
    `${header}\n[… earlier entries omitted …]\n${body.slice(body.length - (MAX_SEGMENT_CHARS - header.length - 40))}`,
  );
}

export interface SelectOptions {
  sources: TranscriptSources;
  cursor: InsightCursor;
  now: number;
  /** Working directories whose conversations are never read (the app's data, the state directory). */
  excludeDirs: string[];
  maxSegments?: number;
  /** A history file larger than this is read from its end only (tests lower it). */
  maxTranscriptBytes?: number;
  /** Awaited between files; yields to the event loop once per slice by default. */
  slice?: () => Promise<void>;
}

export interface Selection {
  segments: Segment[];
  /** Conversations read up to date with nothing worth sending (only system messages). */
  skipped: SkippedPart[];
  /** Parts ready to read but over this run's limit. */
  waiting: number;
}

function excluded(cwd: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => cwd === dir || cwd.startsWith(`${dir}${path.sep}`));
}

/** The index of the first entry not read yet. */
export function resumeIndex(conversation: Conversation, known: CursorEntry | undefined): number {
  if (!known) return 0;
  const offsets = conversation.entryOffsets;
  if (offsets && known.lastEntryOffset !== undefined && known.file === conversation.file) {
    const after = known.lastEntryOffset;
    const index = offsets.findIndex((offset) => offset > after);
    return index < 0 ? conversation.entries.length : index;
  }
  return Math.min(known.analyzedEntries, conversation.entries.length);
}

/**
 * The unread parts of settled conversations, newest first, up to the run's
 * limit. Every settled file in the lookback is read to find where it resumes
 * (3,146 files and 4.4 s of reads on one host), so the loop yields to the event
 * loop between files: done in one go it held the backend for 7 s.
 */
export async function selectSegments(options: SelectOptions): Promise<Selection> {
  const { cursor, now } = options;
  const max = options.maxSegments ?? MAX_SEGMENTS_PER_RUN;
  const slice = options.slice ?? createEventLoopSlicer();
  const files = (await listTranscriptFiles(options.sources, slice))
    .filter(
      (file) => now - file.mtimeMs >= SETTLE_MS && now - file.mtimeMs <= FIRST_RUN_LOOKBACK_MS,
    )
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const selection: Selection = { segments: [], skipped: [], waiting: 0 };
  const seen = new Set<string>();
  for (const file of files) {
    await slice();
    const conversation = readConversation(file, options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES);
    if (!conversation || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    if (excluded(conversation.cwd, options.excludeDirs)) continue;
    const from = resumeIndex(conversation, cursor.conversations[conversation.id]);
    if (from >= conversation.entries.length) continue;
    const to = conversation.entries.length;
    const lastEntryOffset = conversation.entryOffsets?.[to - 1];
    const position = {
      file: conversation.file,
      ...(lastEntryOffset !== undefined ? { lastEntryOffset } : {}),
    };
    const fresh = conversation.entries.slice(from);
    const people = fresh.filter((entry) => entry.role === "user" && entry.origin !== "system");
    if (people.length === 0) {
      selection.skipped.push({
        conversationId: conversation.id,
        to,
        ...position,
        lastAt: conversation.lastAt,
        project: conversation.project,
      });
      continue;
    }
    if (selection.segments.length >= max) {
      selection.waiting += 1;
      continue;
    }
    selection.segments.push({
      conversationId: conversation.id,
      provider: conversation.provider,
      project: conversation.project,
      startedAt: conversation.startedAt,
      lastAt: conversation.lastAt,
      from,
      to,
      ...position,
      key:
        lastEntryOffset !== undefined
          ? `@${conversation.entryOffsets![from]}-${lastEntryOffset}`
          : `${from}-${to}`,
      text: renderSegment(conversation, from),
      typedMessages: fresh.filter((entry) => entry.role === "user" && entry.origin === "typed")
        .length,
    });
  }
  return selection;
}
