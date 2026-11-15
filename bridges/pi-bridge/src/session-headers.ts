/**
 * Lists Pi's session files from a bounded window of each, not the whole file.
 *
 * Pi's own `SessionManager.list` (1.5.0) reads every session file in full and
 * keeps every session's `allMessagesText`, which this bridge never shows: on a
 * 17 GB history that held about 6 GB of bridge memory, and a history past the
 * 30 s ceiling could never be listed at all (to-do 5980). This reader keeps
 * what the resume dialog needs — the header, the name, the first prompt and
 * the time of the last message — from at most a head and a tail window of the
 * newest files, and stops once no older file can enter the newest
 * `limit`.
 *
 * It is a second reader of Pi's private format, so it reads only what it
 * recognises. Anything else (a header version it does not know, an entry
 * shaped differently from Pi 1.5's) throws `UnrecognisedSessionFormat`, and
 * the caller lists through Pi's own API instead. `session-headers.test.ts`
 * writes sessions with the pinned SDK and fails when this reader stops
 * agreeing with `SessionManager.list`, so a Pi bump cannot change the format
 * silently. Retire it for Pi's bounded listing once that ships
 * (`docs/upstream-issues/pi-bounded-session-listing.md`).
 *
 * Where it differs from `SessionManager.list`, by design:
 *
 * - **Files larger than both windows** are read only at their head
 *   (`SESSION_HEAD_WINDOW_BYTES`) and tail (`SESSION_TAIL_WINDOW_BYTES`). A
 *   name set only between the two windows is not seen; a first prompt that
 *   does not end inside the head window is not seen (the entry then has no
 *   detail rather than Pi's "(no messages)"); and the last message time comes
 *   from the tail, or from the file's modification time when the tail holds no
 *   whole message. Smaller files are read whole and match Pi exactly.
 * - **Which files are read.** Pi orders by the last message, which is known
 *   only after reading a file. Files are read newest-modified first, and the
 *   read stops once the next file was modified before the `limit`-th newest
 *   last message found so far: a message is written before its file is
 *   modified, so no older file can rank above it. Files copied without their
 *   modification times break that premise, so at most
 *   `SESSION_LIST_MAX_FILES_FACTOR` × `limit` files that list are read.
 * - **The working-directory filter** applies whenever the caller passes `cwd`.
 *   Pi skips it when the session directory is its own default for that
 *   directory, and resolves `~` and `file://` in a session's recorded `cwd`,
 *   which Pi itself never writes.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

/** How much of a file's start is read: Pi's own bound on a header scan. */
export const SESSION_HEAD_WINDOW_BYTES = 1024 * 1024;
/** How much of a large file's end is read, for its last message and newest name. */
export const SESSION_TAIL_WINDOW_BYTES = 256 * 1024;
/** Files read at once: each holds at most one head and one tail window. */
const SESSION_READ_CONCURRENCY = 8;
/** The most listed files read, as a multiple of `limit`, when modification times mislead. */
export const SESSION_LIST_MAX_FILES_FACTOR = 4;
/**
 * Header versions this reader reads the way Pi 1.5's listing does. A missing
 * version is 1. `CURRENT_SESSION_VERSION` is pinned against the newest in
 * `session-headers.test.ts`.
 */
export const KNOWN_SESSION_VERSIONS: readonly number[] = [1, 2, 3];

/** Why the reader handed over to Pi's own listing. Fixed strings: they are logged. */
export type UnrecognisedSessionReason =
  "session-version" | "session-header" | "message-entry" | "message-content" | "session-info-entry";

/** A session file this reader does not recognise; list through Pi instead. */
export class UnrecognisedSessionFormat extends Error {
  constructor(readonly reason: UnrecognisedSessionReason) {
    super(`Unrecognised Pi session format (${reason})`);
    this.name = "UnrecognisedSessionFormat";
  }
}

/** The fields of a `SessionInfo` the resume dialog uses. */
export interface ListedSession {
  path: string;
  name?: string;
  /** Undefined when the header's timestamp is not a date. */
  created?: Date;
  modified: Date;
  /** "" when a large file's first prompt is outside its head window. */
  firstMessage: string;
  parentSessionPath?: string;
}

export interface SessionHeaderListing {
  /** Newest last message first, at most `limit`. */
  sessions: ListedSession[];
  /** Files whose windows were read. */
  filesRead: number;
  /** Bytes read from session files. */
  bytesRead: number;
}

interface Candidate {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

interface FileWindows {
  /** Whole lines from the start of the file; the whole file when `whole`. */
  head: string[];
  /** Whole lines from the end of the file; empty when `whole`. */
  tail: string[];
  whole: boolean;
  bytes: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi's line split (`readline` with `crlfDelay: Infinity`). */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Pi's `parseSessionEntryLine`: blank and malformed lines are skipped. */
function parseLine(line: string): JsonObject | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    return isObject(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function readWindows(path: string, size: number): Promise<FileWindows> {
  const handle = await open(path, "r");
  try {
    if (size <= SESSION_HEAD_WINDOW_BYTES + SESSION_TAIL_WINDOW_BYTES) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return {
        head: splitLines(buffer.toString("utf8", 0, bytesRead)),
        tail: [],
        whole: true,
        bytes: bytesRead,
      };
    }
    const head = Buffer.alloc(SESSION_HEAD_WINDOW_BYTES);
    const headRead = (await handle.read(head, 0, head.length, 0)).bytesRead;
    // One byte before the window, so a tail that starts on a line boundary
    // keeps its first line: everything up to the first break is dropped.
    const tail = Buffer.alloc(SESSION_TAIL_WINDOW_BYTES + 1);
    const tailRead = (await handle.read(tail, 0, tail.length, size - tail.length)).bytesRead;
    // The last head segment and the first tail segment may be cut mid-line
    // (and mid-character); neither is parsed.
    return {
      head: splitLines(head.toString("utf8", 0, headRead)).slice(0, -1),
      tail: splitLines(tail.toString("utf8", 0, tailRead)).slice(1),
      whole: false,
      bytes: headRead + tailRead,
    };
  } finally {
    await handle.close();
  }
}

/** Pi's `extractTextContent`, refusing what would make Pi's own read throw. */
function textContent(message: JsonObject): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new UnrecognisedSessionFormat("message-content");
  const texts: unknown[] = [];
  for (const block of content) {
    if (!isObject(block)) throw new UnrecognisedSessionFormat("message-content");
    if (block.type === "text") texts.push(block.text);
  }
  return texts.join(" ");
}

interface EntryScan {
  name?: string;
  /** Whether any `session_info` entry was seen; a later one replaces an earlier name. */
  named: boolean;
  firstMessage: string;
  lastActivity?: number;
}

/** Pi's `buildSessionInfo` loop over every entry after the header. */
function scanEntries(entries: Iterable<JsonObject>, scan: EntryScan, firstPrompt: boolean): void {
  for (const entry of entries) {
    if (entry.type === "session_info") {
      const name = entry.name;
      if (name !== undefined && name !== null && typeof name !== "string") {
        throw new UnrecognisedSessionFormat("session-info-entry");
      }
      scan.name = typeof name === "string" ? name.trim() || undefined : undefined;
      scan.named = true;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message)) throw new UnrecognisedSessionFormat("message-entry");
    if (typeof message.role !== "string" || !("content" in message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const activity =
      typeof message.timestamp === "number"
        ? message.timestamp
        : new Date(entry.timestamp as string | number).getTime();
    if (!Number.isNaN(activity)) scan.lastActivity = Math.max(scan.lastActivity ?? 0, activity);
    const text = textContent(message);
    if (firstPrompt && text && !scan.firstMessage && message.role === "user") {
      scan.firstMessage = text;
    }
  }
}

function* parsedLines(lines: string[]): Generator<JsonObject> {
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry) yield entry;
  }
}

function pathKey(path: string): string {
  if (process.platform === "win32") return win32.resolve(path).toLowerCase();
  return posix.resolve(path);
}

/** The listed session in one file, or undefined when Pi would not list it either. */
function listedSession(
  candidate: Candidate,
  windows: FileWindows,
  cwdKey: string | undefined,
): ListedSession | undefined {
  const head = parsedLines(windows.head);
  const header = head.next();
  // Pi lists a file only when its first parsed entry is the session header.
  // A large file with no whole line in its head window is skipped, as Pi's own
  // header discovery skips one past the same bound.
  if (header.done || header.value.type !== "session") return undefined;
  const fields = header.value;
  const version = fields.version ?? 1;
  if (typeof version !== "number" || !KNOWN_SESSION_VERSIONS.includes(version)) {
    throw new UnrecognisedSessionFormat("session-version");
  }
  const parent = fields.parentSession;
  if (parent !== undefined && parent !== null && typeof parent !== "string") {
    throw new UnrecognisedSessionFormat("session-header");
  }
  if (cwdKey !== undefined) {
    const cwd = typeof fields.cwd === "string" ? fields.cwd : "";
    if (cwd === "" || pathKey(cwd) !== cwdKey) return undefined;
  }

  const scan: EntryScan = { named: false, firstMessage: "" };
  scanEntries(head, scan, true);
  if (!windows.whole) {
    // The tail is later in the file, so its activity and name supersede the head's.
    const tail: EntryScan = { named: false, firstMessage: "" };
    scanEntries(parsedLines(windows.tail), tail, false);
    if (tail.named) scan.name = tail.name;
    scan.lastActivity = tail.lastActivity;
  }

  const headerTime =
    typeof fields.timestamp === "string" ? new Date(fields.timestamp).getTime() : Number.NaN;
  // Pi's fallbacks are the header's time, then the file's. A large file whose
  // tail holds no whole message has messages this reader did not see, so its
  // modification time is the closer answer there.
  const modified =
    scan.lastActivity !== undefined && scan.lastActivity > 0
      ? scan.lastActivity
      : windows.whole && !Number.isNaN(headerTime)
        ? headerTime
        : candidate.mtimeMs;

  return {
    path: candidate.path,
    ...(scan.name ? { name: scan.name } : {}),
    ...(!Number.isNaN(headerTime) ? { created: new Date(headerTime) } : {}),
    modified: new Date(modified),
    firstMessage: scan.firstMessage || (windows.whole ? "(no messages)" : ""),
    ...(typeof parent === "string" ? { parentSessionPath: parent } : {}),
  };
}

/** Pi's order: newest last message first; equal times keep Pi's descending file-name order. */
function compareListed(left: ListedSession, right: ListedSession): number {
  return right.modified.getTime() - left.modified.getTime() || right.path.localeCompare(left.path);
}

/**
 * The newest `limit` sessions in `directory`, read from bounded windows.
 *
 * `cwd`, when given, keeps only sessions recorded for that directory. Throws
 * `UnrecognisedSessionFormat` for a file Pi's listing should read instead.
 */
export async function listSessionsFromHeaders(options: {
  directory: string;
  cwd?: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<SessionHeaderListing> {
  const { directory, limit, signal } = options;
  const cwdKey = options.cwd === undefined ? undefined : pathKey(options.cwd);
  signal?.throwIfAborted();
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    // Pi answers an unreadable or missing directory with no sessions.
    signal?.throwIfAborted();
    return { sessions: [], filesRead: 0, bytesRead: 0 };
  }
  const stats = await Promise.all(
    names.map(async (name): Promise<Candidate | undefined> => {
      const path = join(directory, name);
      try {
        const file = await stat(path);
        return file.isFile() ? { path, name, size: file.size, mtimeMs: file.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const candidates = stats
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));

  let sessions: ListedSession[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  let listedFilesRead = 0;
  for (let index = 0; index < candidates.length; index += SESSION_READ_CONCURRENCY) {
    signal?.throwIfAborted();
    const next = candidates[index]!;
    if (sessions.length >= limit && next.mtimeMs < sessions[limit - 1]!.modified.getTime()) break;
    if (listedFilesRead >= limit * SESSION_LIST_MAX_FILES_FACTOR) break;
    const batch = candidates.slice(index, index + SESSION_READ_CONCURRENCY);
    const read = await Promise.all(
      batch.map(async (candidate) => {
        try {
          return { candidate, windows: await readWindows(candidate.path, candidate.size) };
        } catch {
          // Pi skips a file it cannot read.
          return undefined;
        }
      }),
    );
    for (const file of read) {
      if (!file) continue;
      filesRead += 1;
      bytesRead += file.windows.bytes;
      const session = listedSession(file.candidate, file.windows, cwdKey);
      if (!session) continue;
      listedFilesRead += 1;
      sessions.push(session);
    }
    sessions.sort(compareListed);
    if (sessions.length > limit) sessions = sessions.slice(0, limit);
  }
  return { sessions, filesRead, bytesRead };
}
