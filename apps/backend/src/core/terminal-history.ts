import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
  DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
  TERMINAL_STATE_FORMAT_VERSION,
  TERMINAL_STATE_TARGET_BYTES,
  normalizeTerminalHistoryRetention,
  type TerminalHistoryPage,
  type TerminalStateSnapshot,
} from "@orkestrator/protocol/terminal-history";

export const TERMINAL_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
export const TERMINAL_HISTORY_PAGE_MAX_ROWS = 1_000;
export const TERMINAL_HISTORY_SEGMENT_BYTES = 4 * 1024 * 1024;
export const TERMINAL_HISTORY_PENDING_BYTES = 1024 * 1024;
export const TERMINAL_HISTORY_PENDING_RECORDS = 256;
export const TERMINAL_HISTORY_GLOBAL_PENDING_BYTES = 16 * 1024 * 1024;
export const TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS = 4_096;
const TERMINAL_HISTORY_SCROLLBACK = 2_000;
const TERMINAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_HISTORY_RECORD_MAX_BYTES = 128 * 1024;
const TERMINAL_HISTORY_RECORD_MAX_ROWS = 500;
const TERMINAL_PARSER_CARRY_MAX_BYTES = 64 * 1024;
const TERMINAL_HISTORY_FLUSH_MS = 250;
const TERMINAL_CHECKPOINT_MS = 5_000;
const TERMINAL_HISTORY_PAGE_CONCURRENCY = 4;
const TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES = 3 * 1024 * 1024;
const TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES = 128 * 1024 * 1024;
const MAX_COMPLETED_RESIDENT_SESSIONS = 8;
const DEFAULT_MAX_HISTORY_DIRECTORIES = 4_096;
const MAX_TERMINAL_HISTORY_SEGMENTS = 256;
// xterm's typed buffers, line objects, parser state, and JS allocator overhead
// substantially exceed the visible character payload. This conservative
// reservation was tuned against the 1/10/50-terminal benchmark below.
const TERMINAL_CELL_ESTIMATED_BYTES = 96;

type HistoryRecord = { sequence: number; at: number; text: string };
type ParserState = "normal" | "escape" | "csi" | "string" | "string-escape";

type Manifest = {
  formatVersion: 1;
  archiveRowsVersion: 1;
  historyId: string;
  incarnation: string;
  environmentId?: string;
  tabId?: string;
  createdAt: number;
  updatedAt: number;
  earliestSequence: number;
  latestSequence: number;
  durableThroughSequence: number;
  historyTruncated: boolean;
  archiveTruncated: boolean;
  historyGap: boolean;
  completed: boolean;
  segments: Array<{ number: number; bytes: number; first: number; last: number }>;
};

type Session = {
  sessionId: string;
  historyId: string;
  directory: string;
  terminal: HeadlessTerminal;
  serializer: SerializeAddon;
  incarnation: string;
  generation: number;
  receivedRevision: number;
  appliedRevision: number;
  sequence: number;
  initialized: Promise<void>;
  parseTail: Promise<void>;
  ioTail: Promise<void>;
  pending: HistoryRecord[];
  pendingBytes: number;
  queuedBytes: number;
  queuedRecords: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastCheckpointAt: number;
  bytesSinceCheckpoint: number;
  manifest: Manifest;
  estimatedBytes: number;
  scrollback: number;
  parserState: ParserState;
  parserCarry: string;
  parserCarryBytes: number;
  parserCarryOverflow: boolean;
  gapWriteScheduled: boolean;
  snapshotPromise: Promise<TerminalStateSnapshot> | null;
  archiveParserState: ParserState;
  archivePendingCr: boolean;
  archiveHighSurrogate: string;
  archiveLineCarry: string;
  archiveInitialized: boolean;
  preinitArchiveChunks: Array<{ text: string; at: number; generationChanged: boolean }>;
  preinitArchiveBytes: number;
  completedAt: number | null;
  disposed: boolean;
  acceptingOutput: boolean;
};

function safeHistoryId(stableIdentity: string): string {
  return createHash("sha256").update(stableIdentity).digest("hex");
}

function encodeCursor(session: Session, before: number): string {
  return Buffer.from(
    JSON.stringify({
      version: TERMINAL_STATE_FORMAT_VERSION,
      historyId: session.historyId,
      incarnation: session.incarnation,
      before,
    }),
  ).toString("base64url");
}

function decodeCursor(session: Session, cursor: string): number {
  if (cursor.length === 0 || cursor.length > 1_024) {
    throw new Error("Terminal history cursor is invalid or expired");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: unknown;
      historyId?: unknown;
      incarnation?: unknown;
      before?: unknown;
    };
    if (
      decoded.version !== TERMINAL_STATE_FORMAT_VERSION ||
      decoded.historyId !== session.historyId ||
      decoded.incarnation !== session.incarnation ||
      !Number.isSafeInteger(decoded.before) ||
      (decoded.before as number) < 1
    ) {
      throw new Error();
    }
    return decoded.before as number;
  } catch {
    throw new Error("Terminal history cursor is invalid or expired");
  }
}

async function boundedFileSize(filePath: string, maximum: number): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size <= maximum ? stat.size : 0;
  } catch {
    return 0;
  }
}

function sessionDirectory(dataDir: string, historyId: string): string {
  return path.join(dataDir, "terminal-history", historyId);
}

function checkpointPath(session: Session): string {
  return path.join(session.directory, "checkpoint.json");
}

function manifestPath(session: Session): string {
  return path.join(session.directory, "manifest.json");
}

function segmentPath(session: Session, number: number): string {
  return path.join(session.directory, `segment-${String(number).padStart(6, "0")}.jsonl`);
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function writeTerminal(terminal: HeadlessTerminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

function blankManifest(
  historyId: string,
  incarnation: string,
  environmentId?: string,
  tabId?: string,
): Manifest {
  const now = Date.now();
  return {
    formatVersion: 1,
    archiveRowsVersion: 1,
    historyId,
    incarnation,
    ...(environmentId ? { environmentId } : {}),
    ...(tabId ? { tabId } : {}),
    createdAt: now,
    updatedAt: now,
    earliestSequence: 1,
    latestSequence: 0,
    durableThroughSequence: 0,
    historyTruncated: false,
    archiveTruncated: false,
    historyGap: false,
    completed: false,
    segments: [],
  };
}

async function loadJson<T>(filePath: string, maximumBytes = 1024 * 1024): Promise<T | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximumBytes) return null;
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function reconcileCommittedSegments(session: Session, manifest: Manifest): Promise<void> {
  let changed = false;
  const declaredSegments = Array.isArray(manifest.segments) ? manifest.segments : [];
  const validSegments = declaredSegments.filter(
    (segment) =>
      segment !== null &&
      typeof segment === "object" &&
      Number.isSafeInteger(segment.number) &&
      segment.number >= 1 &&
      Number.isSafeInteger(segment.bytes) &&
      segment.bytes >= 0 &&
      segment.bytes <= TERMINAL_HISTORY_SEGMENT_BYTES + TERMINAL_HISTORY_RECORD_MAX_BYTES &&
      Number.isSafeInteger(segment.first) &&
      segment.first >= 1 &&
      Number.isSafeInteger(segment.last) &&
      segment.last >= segment.first,
  );
  if (validSegments.length !== declaredSegments.length) changed = true;
  validSegments.sort((left, right) => left.number - right.number);
  const retainedSegments = validSegments.slice(-MAX_TERMINAL_HISTORY_SEGMENTS);
  if (retainedSegments.length !== validSegments.length) {
    manifest.archiveTruncated = true;
    manifest.historyTruncated = true;
    changed = true;
  }
  const committedNumbers = new Set(retainedSegments.map((segment) => segment.number));
  try {
    const directory = await fs.opendir(session.directory);
    let scanned = 0;
    for await (const entry of directory) {
      const match = /^segment-(\d{6})\.jsonl$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      scanned += 1;
      if (scanned > MAX_TERMINAL_HISTORY_SEGMENTS * 2) {
        changed = true;
        break;
      }
      const number = Number(match[1]);
      if (!committedNumbers.has(number)) {
        await fs.rm(path.join(session.directory, entry.name), { force: true });
        changed = true;
      }
    }
  } catch {
    changed = true;
  }

  const physicallyValid = [] as Manifest["segments"];
  for (const segment of retainedSegments) {
    const filePath = segmentPath(session, segment.number);
    try {
      const file = await fs.stat(filePath);
      if (!file.isFile() || file.size < segment.bytes) {
        await fs.rm(filePath, { force: true });
        changed = true;
        continue;
      }
      if (file.size > segment.bytes) {
        await fs.truncate(filePath, segment.bytes);
        changed = true;
      }
      physicallyValid.push(segment);
    } catch {
      changed = true;
    }
  }
  manifest.segments = physicallyValid;
  manifest.durableThroughSequence = physicallyValid.at(-1)?.last ?? 0;
  manifest.earliestSequence = physicallyValid[0]?.first ?? manifest.latestSequence + 1;
  if (changed) manifest.historyGap = true;
}

function trackParserCarry(session: Session, text: string): void {
  for (const character of text) {
    const appendCarry = () => {
      if (session.parserCarryOverflow) return;
      session.parserCarry += character;
      session.parserCarryBytes += Buffer.byteLength(character, "utf8");
    };
    switch (session.parserState) {
      case "normal":
        if (character === "\x1b") {
          session.parserState = "escape";
          session.parserCarry = character;
          session.parserCarryBytes = 1;
        } else if (character === "\x9b") {
          session.parserState = "csi";
          session.parserCarry = character;
          session.parserCarryBytes = Buffer.byteLength(character, "utf8");
        } else if (["\x90", "\x98", "\x9d", "\x9e", "\x9f"].includes(character)) {
          session.parserState = "string";
          session.parserCarry = character;
          session.parserCarryBytes = Buffer.byteLength(character, "utf8");
        }
        break;
      case "escape":
        appendCarry();
        if (character === "[") session.parserState = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) session.parserState = "string";
        else if (character < " " || character > "/") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        }
        break;
      case "csi":
        appendCarry();
        if (character >= "@" && character <= "~") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        }
        break;
      case "string":
        appendCarry();
        if (character === "\x07" || character === "\x9c") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        } else if (character === "\x1b") {
          session.parserState = "string-escape";
        }
        break;
      case "string-escape":
        appendCarry();
        if (character === "\\") {
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
        } else {
          session.parserState = character === "\x1b" ? "string-escape" : "string";
        }
        break;
    }
    if (session.parserCarryBytes > TERMINAL_PARSER_CARRY_MAX_BYTES) {
      session.parserCarry = "";
      session.parserCarryBytes = 0;
      session.parserCarryOverflow = true;
    }
    if (session.parserState === "normal") session.parserCarryOverflow = false;
  }
}

export type TerminalHistoryConfiguration = {
  sessionId: string;
  dataDir: string;
  stableIdentity: string;
  cols: number;
  rows: number;
  environmentId?: string;
  tabId?: string;
  generation?: number;
};

/** Split text without splitting UTF-8 or allowing one record to monopolize a page. */
function splitHistoryRecords(text: string): string[] {
  const encoded = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < encoded.length) {
    let end = Math.min(encoded.length, offset + TERMINAL_HISTORY_RECORD_MAX_BYTES);
    while (end < encoded.length && end > offset && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    let rows = 0;
    let rowBoundedEnd = end;
    for (let index = offset; index < end; index += 1) {
      if (encoded[index] !== 0x0a && encoded[index] !== 0x0d) continue;
      if (encoded[index] === 0x0a && index > offset && encoded[index - 1] === 0x0d) continue;
      rows += 1;
      if (rows === TERMINAL_HISTORY_RECORD_MAX_ROWS) {
        rowBoundedEnd = index + 1;
        break;
      }
    }
    end = rowBoundedEnd > offset ? rowBoundedEnd : end;
    if (end <= offset) end = Math.min(encoded.length, offset + 1);
    chunks.push(encoded.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

function sanitizeHistoryChunk(session: Session, text: string, final = false): string {
  let input = `${session.archiveHighSurrogate}${text}`;
  session.archiveHighSurrogate = "";
  if (!final && input.length > 0) {
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      session.archiveHighSurrogate = input.at(-1)!;
      input = input.slice(0, -1);
    }
  }
  let output = "";
  const emit = (character: string) => {
    if (session.archivePendingCr) {
      output += "\n";
      session.archivePendingCr = false;
      if (character === "\n") return;
    }
    if (character === "\r") {
      session.archivePendingCr = true;
    } else if (
      character === "\n" ||
      character === "\t" ||
      (character >= " " && (character < "\x7f" || character > "\x9f"))
    ) {
      output += character;
    }
  };
  for (const character of input) {
    switch (session.archiveParserState) {
      case "normal":
        if (character === "\x1b") session.archiveParserState = "escape";
        else if (character === "\x9b") session.archiveParserState = "csi";
        else if (["\x90", "\x98", "\x9d", "\x9e", "\x9f"].includes(character)) {
          session.archiveParserState = "string";
        } else {
          emit(character);
        }
        break;
      case "escape":
        if (character === "[") session.archiveParserState = "csi";
        else if (["]", "P", "X", "^", "_"].includes(character)) {
          session.archiveParserState = "string";
        } else if (character < " " || character > "/") {
          session.archiveParserState = "normal";
        }
        break;
      case "csi":
        if (character >= "@" && character <= "~") session.archiveParserState = "normal";
        break;
      case "string":
        if (character === "\x07" || character === "\x9c") {
          session.archiveParserState = "normal";
        } else if (character === "\x1b") {
          session.archiveParserState = "string-escape";
        }
        break;
      case "string-escape":
        if (character === "\\") session.archiveParserState = "normal";
        else session.archiveParserState = character === "\x1b" ? "string-escape" : "string";
        break;
    }
  }
  if (final) {
    if (session.archiveHighSurrogate) {
      emit("�");
      session.archiveHighSurrogate = "";
    }
    if (session.archivePendingCr) {
      output += "\n";
      session.archivePendingCr = false;
    }
  }
  return output;
}

export type TerminalHistoryOptions = {
  /** Awaited inside each page read's concurrency slot. Tests hold reads open with it. */
  pageReadHook?: () => Promise<void>;
  /** Called before every state serialization. Tests inject serialization failures with it. */
  serializeHook?: () => void;
  /** Most history directories one root keeps (and scans twice that per prune pass). */
  maxHistoryDirectories?: number;
};

/**
 * Durable terminal history and restorable terminal state for one backend
 * instance: a headless emulator per collected session, its bounded archive
 * segments and checkpoints under `<dataDir>/terminal-history`, and the
 * process-wide retention and memory budgets. Owned by `TerminalRuntime` and
 * reached through `context.runtime.terminals.history` at call time.
 */
export class TerminalHistory {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionConfigurations = new Map<string, TerminalHistoryConfiguration>();
  private readonly historyIoTails = new Map<string, Promise<void>>();
  private readonly historyDisposals = new Map<string, Promise<void>>();
  private readonly rootPruneTails = new Map<string, Promise<void>>();
  private readonly initiallyPrunedRoots = new Set<string>();
  private readonly pruneContinuationTimers = new Set<ReturnType<typeof setTimeout>>();
  private stateEstimatedBytes = 0;
  private queuedBytes = 0;
  private queuedRecords = 0;
  private preinitBytes = 0;
  private preinitRecords = 0;
  private pageReads = 0;
  private readonly pageWaiters: Array<() => void> = [];
  private enabled = true;
  private sessionBytes = DEFAULT_TERMINAL_HISTORY_RETENTION_MB * 1024 * 1024;
  private globalBytes = DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB * 1024 * 1024;
  private completedMaxAgeMs = DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
  private readonly maxDirectories: number;
  private readonly pageReadHook: (() => Promise<void>) | null;
  private readonly serializeHook: (() => void) | null;

  constructor(options: TerminalHistoryOptions = {}) {
    this.maxDirectories = Math.max(
      1,
      Math.floor(options.maxHistoryDirectories ?? DEFAULT_MAX_HISTORY_DIRECTORIES),
    );
    this.pageReadHook = options.pageReadHook ?? null;
    this.serializeHook = options.serializeHook ?? null;
  }

  configureRetention(value: {
    enabled?: unknown;
    sessionMb?: unknown;
    globalMb?: unknown;
    days?: unknown;
  }): void {
    const retention = normalizeTerminalHistoryRetention(value);
    this.enabled = retention.enabled;
    this.sessionBytes = retention.sessionMb * 1024 * 1024;
    this.globalBytes = retention.globalMb * 1024 * 1024;
    this.completedMaxAgeMs = retention.days * 24 * 60 * 60_000;
    for (const session of this.sessions.values()) this.scheduleSessionRetention(session);
  }

  private reclaimStateBytes(requiredBytes: number, excludedSession?: Session): void {
    let remaining = requiredBytes;
    for (const session of this.sessions.values()) {
      if (session === excludedSession) continue;
      if (remaining <= 0) break;
      const rowBytes = session.terminal.cols * TERMINAL_CELL_ESTIMATED_BYTES;
      const rowsToRemove = Math.min(session.scrollback, Math.ceil(remaining / rowBytes));
      if (rowsToRemove <= 0) continue;
      const nextScrollback = session.scrollback - rowsToRemove;
      session.terminal.options.scrollback = nextScrollback;
      session.scrollback = nextScrollback;
      session.manifest.historyTruncated = true;
      const reclaimed = rowsToRemove * rowBytes;
      session.estimatedBytes -= reclaimed;
      this.stateEstimatedBytes = Math.max(0, this.stateEstimatedBytes - reclaimed);
      remaining -= reclaimed;
    }
  }

  private async listHistoryDirectories(root: string): Promise<string[]> {
    try {
      const directory = await fs.opendir(root);
      const entries: string[] = [];
      for await (const entry of directory) {
        if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) entries.push(entry.name);
        if (entries.length >= this.maxDirectories * 2) break;
      }
      return entries;
    } catch {
      return [];
    }
  }

  private forgetHistoryConfiguration(historyId: string): void {
    for (const [sessionId, configuration] of this.sessionConfigurations) {
      if (safeHistoryId(configuration.stableIdentity) === historyId) {
        this.sessionConfigurations.delete(sessionId);
      }
    }
  }

  private async pruneHistoryRoot(root: string, activeHistoryId: string): Promise<void> {
    const now = Date.now();
    const expiredCollectors = Array.from(this.sessions.values()).filter(
      (session) =>
        path.dirname(session.directory) === root &&
        session.manifest.completed &&
        session.completedAt !== null &&
        now - session.completedAt > this.completedMaxAgeMs,
    );
    await Promise.allSettled(
      expiredCollectors.map((session) => this.dispose(session.sessionId, false, false)),
    );
    const activeHistoryIds = new Set(
      Array.from(this.sessions.values(), (session) => session.historyId),
    );
    if (activeHistoryId) activeHistoryIds.add(activeHistoryId);
    let total = 0;
    let retainedDirectories = 0;
    let scanLimitReached = false;
    const candidates: Array<{
      directory: string;
      historyId: string;
      completed: boolean;
      updatedAt: number;
      bytes: number;
    }> = [];
    try {
      const directory = await fs.opendir(root);
      let scanned = 0;
      for await (const entry of directory) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        scanned += 1;
        if (scanned > this.maxDirectories * 2) {
          scanLimitReached = true;
          break;
        }
        const historyDirectory = path.join(root, entry.name);
        const manifest = await loadJson<Manifest>(path.join(historyDirectory, "manifest.json"));
        if (!manifest || manifest.formatVersion !== 1 || manifest.historyId !== entry.name) {
          if (!activeHistoryIds.has(entry.name)) {
            await fs.rm(historyDirectory, { recursive: true, force: true });
            this.forgetHistoryConfiguration(entry.name);
          }
          continue;
        }
        const metadataBytes =
          (await boundedFileSize(path.join(historyDirectory, "manifest.json"), 1024 * 1024)) +
          (await boundedFileSize(path.join(historyDirectory, "checkpoint.json"), 3 * 1024 * 1024));
        const bytes =
          metadataBytes + manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
        if (
          manifest.completed &&
          !activeHistoryIds.has(manifest.historyId) &&
          now - manifest.updatedAt > this.completedMaxAgeMs
        ) {
          await fs.rm(historyDirectory, { recursive: true, force: true });
          this.forgetHistoryConfiguration(manifest.historyId);
          continue;
        }
        total += bytes;
        retainedDirectories += 1;
        if (!activeHistoryIds.has(manifest.historyId)) {
          candidates.push({
            directory: historyDirectory,
            historyId: manifest.historyId,
            completed: manifest.completed,
            updatedAt: manifest.updatedAt,
            bytes,
          });
        }
      }
    } catch {
      return;
    }
    candidates.sort(
      (left, right) =>
        Number(right.completed) - Number(left.completed) || left.updatedAt - right.updatedAt,
    );
    let directoriesToRemove = Math.max(0, retainedDirectories - this.maxDirectories);
    for (const candidate of candidates) {
      if (directoriesToRemove <= 0 && total <= this.globalBytes) break;
      await fs.rm(candidate.directory, { recursive: true, force: true });
      this.historyIoTails.delete(candidate.historyId);
      this.forgetHistoryConfiguration(candidate.historyId);
      total -= candidate.bytes;
      directoriesToRemove = Math.max(0, directoriesToRemove - 1);
    }
    if (scanLimitReached) {
      const timer = setTimeout(() => {
        this.pruneContinuationTimers.delete(timer);
        void this.scheduleRootPrune(root);
      }, 0);
      timer.unref?.();
      this.pruneContinuationTimers.add(timer);
    }
  }

  private scheduleRootPrune(root: string, activeHistoryId = ""): Promise<void> {
    const previous = this.rootPruneTails.get(root) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.pruneHistoryRoot(root, activeHistoryId))
      .catch(() => undefined);
    this.rootPruneTails.set(root, next);
    void next.finally(() => {
      if (this.rootPruneTails.get(root) === next) this.rootPruneTails.delete(root);
    });
    return next;
  }

  async pruneStorage(dataDir: string): Promise<void> {
    const root = path.join(dataDir, "terminal-history");
    if (!this.enabled) {
      const disposals = Array.from(this.sessions.values())
        .filter((session) => path.dirname(session.directory) === root)
        .map((session) => this.dispose(session.sessionId, true));
      await Promise.allSettled(disposals);
      await fs.rm(root, { recursive: true, force: true });
      this.rootPruneTails.delete(root);
      this.initiallyPrunedRoots.delete(root);
      return;
    }
    await this.scheduleRootPrune(root);
  }

  private serializedState(session: Session): string {
    this.serializeHook?.();
    const pendingBytes = Buffer.byteLength(session.parserCarry, "utf8");
    const availableBytes = TERMINAL_STATE_MAX_BYTES - pendingBytes;
    const currentScreen = session.serializer.serialize({ scrollback: 0 });
    const currentScreenBytes = Buffer.byteLength(currentScreen, "utf8");
    if (currentScreenBytes > availableBytes) {
      throw new Error("Current terminal screen exceeds the terminal snapshot limit");
    }
    const targetBytes = Math.max(
      currentScreenBytes,
      Math.min(availableBytes, TERMINAL_STATE_TARGET_BYTES - pendingBytes),
    );
    let scrollback = TERMINAL_HISTORY_SCROLLBACK;
    let output = session.serializer.serialize({ scrollback });
    while (Buffer.byteLength(output, "utf8") > targetBytes && scrollback > 0) {
      scrollback = Math.floor(scrollback / 2);
      output = session.serializer.serialize({ scrollback });
    }
    if (scrollback < session.terminal.buffer.active.baseY) {
      session.manifest.historyTruncated = true;
    }
    return output;
  }

  private async initialize(session: Session, active: boolean): Promise<void> {
    await this.historyIoTails.get(session.historyId)?.catch(() => undefined);
    await fs.mkdir(session.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(session.directory, 0o700);
    const previousManifest = await loadJson<Manifest>(manifestPath(session));
    const checkpoint = await loadJson<{
      formatVersion: number;
      output: string;
      cols: number;
      rows: number;
      sequence: number;
      revision?: number;
      generation?: number;
      checksum?: string;
      pendingOutput?: string;
    }>(checkpointPath(session), 3 * 1024 * 1024);
    if (previousManifest?.formatVersion === 1 && previousManifest.historyId === session.historyId) {
      const legacySegments =
        previousManifest.archiveRowsVersion === 1 ? [] : [...previousManifest.segments];
      session.incarnation = active ? session.incarnation : previousManifest.incarnation;
      session.manifest = {
        ...previousManifest,
        archiveRowsVersion: 1,
        archiveTruncated: previousManifest.archiveTruncated ?? false,
        incarnation: session.incarnation,
        completed: active ? false : previousManifest.completed,
        updatedAt: active ? Date.now() : previousManifest.updatedAt,
      };
      await reconcileCommittedSegments(session, session.manifest);
      session.sequence = previousManifest.latestSequence;
      session.completedAt = session.manifest.completed ? previousManifest.updatedAt : null;
      if (legacySegments.length > 0) {
        for (const segment of legacySegments) {
          await fs.rm(segmentPath(session, segment.number), { force: true });
        }
        session.manifest.segments = [];
        session.manifest.earliestSequence = session.sequence + 1;
        session.manifest.durableThroughSequence = session.sequence;
        session.manifest.archiveTruncated = true;
        session.manifest.historyGap = true;
      }
    }
    const checkpointValid =
      checkpoint?.formatVersion === TERMINAL_STATE_FORMAT_VERSION &&
      typeof checkpoint.output === "string" &&
      typeof checkpoint.pendingOutput === "string" &&
      Buffer.byteLength(checkpoint.pendingOutput, "utf8") <= TERMINAL_PARSER_CARRY_MAX_BYTES &&
      Buffer.byteLength(checkpoint.output, "utf8") +
        Buffer.byteLength(checkpoint.pendingOutput, "utf8") <=
        TERMINAL_STATE_MAX_BYTES &&
      Number.isSafeInteger(checkpoint.sequence) &&
      checkpoint.sequence >= 0 &&
      Number.isSafeInteger(checkpoint.revision) &&
      checkpoint.revision! >= 0 &&
      Number.isSafeInteger(checkpoint.generation) &&
      checkpoint.generation! >= 0 &&
      Number.isSafeInteger(checkpoint.cols) &&
      checkpoint.cols >= 1 &&
      checkpoint.cols <= 1_000 &&
      Number.isSafeInteger(checkpoint.rows) &&
      checkpoint.rows >= 1 &&
      checkpoint.rows <= 1_000 &&
      typeof checkpoint.checksum === "string" &&
      checkpoint.checksum ===
        createHash("sha256")
          .update(checkpoint.output)
          .update("\0")
          .update(checkpoint.pendingOutput)
          .digest("hex");
    if (checkpointValid && checkpoint) {
      const hasQueuedLiveOutput = session.receivedRevision > 0;
      session.terminal.resize(checkpoint.cols, checkpoint.rows);
      await writeTerminal(session.terminal, checkpoint.output);
      if (checkpoint.pendingOutput) await writeTerminal(session.terminal, checkpoint.pendingOutput);
      trackParserCarry(session, checkpoint.pendingOutput ?? "");
      session.appliedRevision = checkpoint.revision ?? 0;
      if (!hasQueuedLiveOutput) {
        session.receivedRevision = checkpoint.revision ?? 0;
        session.generation = checkpoint.generation ?? session.generation;
      }
    } else if (checkpoint) {
      session.manifest.historyGap = true;
    }
    this.initializeArchive(session);
    await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
  }

  configure(input: TerminalHistoryConfiguration): string | null {
    try {
      return this.configureCollector(input, true);
    } catch {
      // Terminal history is a best-effort recovery surface. Resource admission
      // and emulator failures must never prevent the real PTY from starting.
      return null;
    }
  }

  private beginSessionResume(session: Session): Promise<void> {
    session.acceptingOutput = true;
    session.completedAt = null;
    session.parseTail = session.parseTail
      .then(() => {
        if (session.disposed) return;
        session.manifest.completed = false;
        session.completedAt = null;
        session.manifest.updatedAt = Date.now();
      })
      .catch(() => {
        if (!session.disposed) this.markHistoryGap(session);
      });
    return session.parseTail;
  }

  private configureCollector(input: TerminalHistoryConfiguration, active: boolean): string | null {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (active) void this.beginSessionResume(existing);
      return existing.historyId;
    }
    if (!this.enabled) return null;
    const historyId = safeHistoryId(input.stableIdentity);
    if (!this.sessionConfigurations.has(input.sessionId)) {
      for (const [sessionId, configuration] of this.sessionConfigurations) {
        if (
          sessionId !== input.sessionId &&
          safeHistoryId(configuration.stableIdentity) === historyId
        ) {
          this.sessionConfigurations.delete(sessionId);
        }
      }
      if (this.sessionConfigurations.size >= this.maxDirectories) return null;
    }
    if ((this.sessions.size + 1) * TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES > this.globalBytes) {
      return null;
    }
    const incarnation = randomUUID();
    let availableBytes = Math.max(
      0,
      TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - this.stateEstimatedBytes,
    );
    const minimumBytes = input.cols * input.rows * TERMINAL_CELL_ESTIMATED_BYTES;
    if (minimumBytes > availableBytes) {
      this.reclaimStateBytes(minimumBytes - availableBytes);
      availableBytes = Math.max(
        0,
        TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - this.stateEstimatedBytes,
      );
    }
    if (minimumBytes > availableBytes) {
      return null;
    }
    const scrollback = Math.min(
      TERMINAL_HISTORY_SCROLLBACK,
      Math.max(
        0,
        Math.floor(availableBytes / (input.cols * TERMINAL_CELL_ESTIMATED_BYTES)) - input.rows,
      ),
    );
    const estimatedBytes = input.cols * (input.rows + scrollback) * TERMINAL_CELL_ESTIMATED_BYTES;
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols: input.cols,
      rows: input.rows,
      scrollback,
      disableStdin: true,
      logLevel: "off",
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer as never);
    const session = {
      sessionId: input.sessionId,
      historyId,
      directory: sessionDirectory(input.dataDir, historyId),
      terminal,
      serializer,
      incarnation,
      generation: input.generation ?? 1,
      receivedRevision: 0,
      appliedRevision: 0,
      sequence: 0,
      initialized: Promise.resolve(),
      parseTail: Promise.resolve(),
      ioTail: Promise.resolve(),
      pending: [],
      pendingBytes: 0,
      queuedBytes: 0,
      queuedRecords: 0,
      flushTimer: null,
      lastCheckpointAt: 0,
      bytesSinceCheckpoint: 0,
      manifest: blankManifest(historyId, incarnation, input.environmentId, input.tabId),
      estimatedBytes,
      scrollback,
      parserState: "normal",
      parserCarry: "",
      parserCarryBytes: 0,
      parserCarryOverflow: false,
      gapWriteScheduled: false,
      snapshotPromise: null,
      archiveParserState: "normal",
      archivePendingCr: false,
      archiveHighSurrogate: "",
      archiveLineCarry: "",
      archiveInitialized: false,
      preinitArchiveChunks: [],
      preinitArchiveBytes: 0,
      completedAt: null,
      disposed: false,
      acceptingOutput: active,
    } satisfies Session;
    session.initialized = this.initialize(session, active).catch(() => {
      session.manifest.historyGap = true;
      this.initializeArchive(session);
    });
    session.parseTail = session.initialized;
    session.ioTail = session.initialized;
    this.sessions.set(input.sessionId, session);
    this.sessionConfigurations.set(input.sessionId, { ...input });
    this.stateEstimatedBytes += estimatedBytes;
    for (const activeSession of this.sessions.values())
      this.scheduleSessionRetention(activeSession);
    const root = path.join(input.dataDir, "terminal-history");
    if (!this.initiallyPrunedRoots.has(root)) {
      this.initiallyPrunedRoots.add(root);
      void this.scheduleRootPrune(root, historyId);
    }
    return historyId;
  }

  private ensureSession(sessionId: string): Session | null {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const configuration = this.sessionConfigurations.get(sessionId);
    if (!configuration || this.configureCollector(configuration, false) === null) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  async resume(sessionId: string): Promise<void> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const configuration = this.sessionConfigurations.get(sessionId);
      if (!configuration || this.configureCollector(configuration, true) === null) return;
      session = this.sessions.get(sessionId);
    }
    if (!session) return;
    await this.beginSessionResume(session);
  }

  private scheduleIo(session: Session, operation: () => Promise<void>): Promise<void> {
    const previous = this.historyIoTails.get(session.historyId) ?? session.ioTail;
    session.ioTail = Promise.allSettled([previous, session.initialized])
      .then(operation)
      .catch(() => {
        session.manifest.historyGap = true;
      });
    this.historyIoTails.set(session.historyId, session.ioTail);
    return session.ioTail;
  }

  private markHistoryGap(session: Session): void {
    session.manifest.historyGap = true;
    if (session.gapWriteScheduled) return;
    session.gapWriteScheduled = true;
    this.scheduleIo(session, async () => {
      try {
        session.manifest.updatedAt = Date.now();
        await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
      } finally {
        session.gapWriteScheduled = false;
      }
    });
  }

  private scheduleFlush(session: Session): void {
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      this.flushPending(session);
    }, TERMINAL_HISTORY_FLUSH_MS);
    session.flushTimer.unref?.();
  }

  private releaseQueuedRecords(session: Session, records: HistoryRecord[]): void {
    const bytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.text, "utf8"), 0);
    session.queuedBytes = Math.max(0, session.queuedBytes - bytes);
    session.queuedRecords = Math.max(0, session.queuedRecords - records.length);
    this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    this.queuedRecords = Math.max(0, this.queuedRecords - records.length);
  }

  private activeSessionSegmentBudget(): number {
    const aggregateShare =
      Math.floor(this.globalBytes / Math.max(1, this.sessions.size)) -
      TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES;
    return Math.max(
      0,
      Math.min(this.sessionBytes - TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES, aggregateShare),
    );
  }

  private async pruneSessionSegments(session: Session): Promise<void> {
    let total = session.manifest.segments.reduce((sum, entry) => sum + entry.bytes, 0);
    const segmentBudget = this.activeSessionSegmentBudget();
    while (total > segmentBudget && session.manifest.segments.length > 0) {
      const removed = session.manifest.segments.shift();
      if (!removed) break;
      await fs.rm(segmentPath(session, removed.number), { force: true });
      total -= removed.bytes;
      session.manifest.historyTruncated = true;
      session.manifest.archiveTruncated = true;
      session.manifest.earliestSequence =
        session.manifest.segments[0]?.first ?? session.manifest.latestSequence + 1;
    }
  }

  private scheduleSessionRetention(session: Session): void {
    this.scheduleIo(session, async () => {
      await this.pruneSessionSegments(session);
      session.manifest.updatedAt = Date.now();
      await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
    });
  }

  private flushPending(session: Session): void {
    const records = session.pending.splice(0);
    session.pendingBytes = 0;
    if (records.length === 0) return;
    this.scheduleIo(session, async () => {
      try {
        let segment = session.manifest.segments.at(-1);
        let createdSegment = false;
        for (const record of records) {
          const line = `${JSON.stringify(record)}\n`;
          const bytes = Buffer.byteLength(line, "utf8");
          if (!segment || segment.bytes + bytes > TERMINAL_HISTORY_SEGMENT_BYTES) {
            segment = {
              number: (segment?.number ?? 0) + 1,
              bytes: 0,
              first: record.sequence,
              last: record.sequence,
            };
            session.manifest.segments.push(segment);
            createdSegment = true;
          }
          await fs.appendFile(segmentPath(session, segment.number), line, {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.chmod(segmentPath(session, segment.number), 0o600);
          segment.bytes += bytes;
          segment.last = record.sequence;
          session.manifest.durableThroughSequence = record.sequence;
        }
        await this.pruneSessionSegments(session);
        session.manifest.updatedAt = Date.now();
        await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
        if (createdSegment)
          void this.scheduleRootPrune(path.dirname(session.directory), session.historyId);
      } finally {
        this.releaseQueuedRecords(session, records);
      }
    });
  }

  private archiveText(session: Session, text: string, at: number): void {
    session.archiveLineCarry += sanitizeHistoryChunk(session, text);
    let newline = session.archiveLineCarry.indexOf("\n");
    while (newline >= 0) {
      const line = session.archiveLineCarry.slice(0, newline);
      for (const chunk of splitHistoryRecords(line)) this.enqueueHistoryRecord(session, chunk, at);
      if (line.length === 0) this.enqueueHistoryRecord(session, "", at);
      session.archiveLineCarry = session.archiveLineCarry.slice(newline + 1);
      newline = session.archiveLineCarry.indexOf("\n");
    }
    while (
      Buffer.byteLength(session.archiveLineCarry, "utf8") > TERMINAL_HISTORY_RECORD_MAX_BYTES
    ) {
      const [chunk = "", ...remaining] = splitHistoryRecords(session.archiveLineCarry);
      this.enqueueHistoryRecord(session, chunk, at);
      session.archiveLineCarry = remaining.join("");
    }
  }

  private flushArchiveLine(session: Session): void {
    const at = Date.now();
    session.archiveLineCarry += sanitizeHistoryChunk(session, "", true);
    if (session.archiveLineCarry.length > 0) {
      for (const chunk of splitHistoryRecords(session.archiveLineCarry)) {
        this.enqueueHistoryRecord(session, chunk, at);
      }
    }
    session.archiveLineCarry = "";
    session.archiveParserState = "normal";
  }

  private archiveOutput(
    session: Session,
    text: string,
    at: number,
    generationChanged: boolean,
  ): void {
    if (generationChanged) {
      this.flushArchiveLine(session);
      session.archiveParserState = "normal";
      session.archivePendingCr = false;
      session.archiveHighSurrogate = "";
      session.archiveLineCarry = "";
    }
    this.archiveText(session, text, at);
  }

  private initializeArchive(session: Session): void {
    if (session.archiveInitialized) return;
    session.archiveInitialized = true;
    const chunks = session.preinitArchiveChunks.splice(0);
    this.preinitBytes = Math.max(0, this.preinitBytes - session.preinitArchiveBytes);
    this.preinitRecords = Math.max(0, this.preinitRecords - chunks.length);
    session.preinitArchiveBytes = 0;
    for (const chunk of chunks) {
      this.archiveOutput(session, chunk.text, chunk.at, chunk.generationChanged);
    }
  }

  private archiveOrQueueOutput(
    session: Session,
    text: string,
    at: number,
    generationChanged: boolean,
  ): void {
    if (session.archiveInitialized) {
      this.archiveOutput(session, text, at, generationChanged);
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      session.preinitArchiveChunks.length >= TERMINAL_HISTORY_PENDING_RECORDS ||
      session.preinitArchiveBytes + bytes > TERMINAL_HISTORY_PENDING_BYTES ||
      this.preinitRecords >= TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS ||
      this.preinitBytes + bytes > TERMINAL_HISTORY_GLOBAL_PENDING_BYTES
    ) {
      this.markHistoryGap(session);
      return;
    }
    session.preinitArchiveChunks.push({ text, at, generationChanged });
    session.preinitArchiveBytes += bytes;
    this.preinitBytes += bytes;
    this.preinitRecords += 1;
  }

  private enqueueHistoryRecord(session: Session, text: string, at: number): void {
    const bytes = Buffer.byteLength(text, "utf8");
    const hasCapacity =
      session.queuedRecords < TERMINAL_HISTORY_PENDING_RECORDS &&
      session.queuedBytes + bytes <= TERMINAL_HISTORY_PENDING_BYTES &&
      this.queuedRecords < TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS &&
      this.queuedBytes + bytes <= TERMINAL_HISTORY_GLOBAL_PENDING_BYTES;
    if (!hasCapacity) {
      this.markHistoryGap(session);
      return;
    }
    session.sequence += 1;
    session.manifest.latestSequence = session.sequence;
    const record = { sequence: session.sequence, at, text };
    session.pending.push(record);
    session.pendingBytes += bytes;
    session.queuedBytes += bytes;
    session.queuedRecords += 1;
    this.queuedBytes += bytes;
    this.queuedRecords += 1;
    this.scheduleFlush(session);
  }

  private scheduleCheckpoint(session: Session): void {
    const now = Date.now();
    if (
      session.bytesSinceCheckpoint < 1024 * 1024 &&
      now - session.lastCheckpointAt < TERMINAL_CHECKPOINT_MS
    ) {
      return;
    }
    session.lastCheckpointAt = now;
    session.bytesSinceCheckpoint = 0;
    session.parseTail = session.parseTail
      .then(async () => {
        if (session.disposed) return;
        if (session.parserCarryOverflow) return;
        const output = this.serializedState(session);
        const checkpoint = {
          formatVersion: TERMINAL_STATE_FORMAT_VERSION,
          output,
          cols: session.terminal.cols,
          rows: session.terminal.rows,
          sequence: session.sequence,
          revision: session.appliedRevision,
          generation: session.generation,
          incarnation: session.incarnation,
          at: Date.now(),
          checksum: createHash("sha256")
            .update(output)
            .update("\0")
            .update(session.parserCarry)
            .digest("hex"),
          pendingOutput: session.parserCarry,
        };
        this.scheduleIo(session, () =>
          atomicWrite(checkpointPath(session), `${JSON.stringify(checkpoint)}\n`),
        );
      })
      .catch(() => {
        // A pathological current screen can exceed the hard snapshot bound. Keep
        // the parser chain usable for later output/resizes and report that the
        // durable checkpoint has a gap instead of freezing collection forever.
        this.markHistoryGap(session);
      });
  }

  append(sessionId: string, text: string, revision: number, generation: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !text || !session.acceptingOutput) return;
    session.manifest.completed = false;
    session.completedAt = null;
    const generationChanged = session.generation !== generation;
    if (generationChanged) {
      session.incarnation = randomUUID();
      session.manifest.incarnation = session.incarnation;
      session.appliedRevision = 0;
    }
    session.receivedRevision = revision;
    session.generation = generation;
    session.manifest.updatedAt = Date.now();
    const bytes = Buffer.byteLength(text, "utf8");
    const at = Date.now();
    session.bytesSinceCheckpoint += bytes;
    this.archiveOrQueueOutput(session, text, at, generationChanged);
    session.parseTail = session.parseTail
      .then(async () => {
        if (session.disposed) return;
        if (generationChanged) {
          session.terminal.reset();
          session.parserState = "normal";
          session.parserCarry = "";
          session.parserCarryBytes = 0;
          session.parserCarryOverflow = false;
        }
        trackParserCarry(session, text);
        const scrollbackAtCapacity = session.terminal.buffer.active.baseY >= session.scrollback;
        await writeTerminal(session.terminal, text);
        if (
          scrollbackAtCapacity ||
          (session.terminal.buffer.active.baseY >= session.scrollback &&
            Buffer.byteLength(text, "utf8") > session.terminal.cols * session.terminal.rows)
        ) {
          session.manifest.historyTruncated = true;
        }
        session.appliedRevision = revision;
      })
      .catch(() => {
        if (!session.disposed) this.markHistoryGap(session);
      });
    this.scheduleCheckpoint(session);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let available =
      TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - this.stateEstimatedBytes + session.estimatedBytes;
    const desiredEstimate = cols * (rows + session.scrollback) * TERMINAL_CELL_ESTIMATED_BYTES;
    if (desiredEstimate > available) {
      this.reclaimStateBytes(desiredEstimate - available, session);
      available =
        TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - this.stateEstimatedBytes + session.estimatedBytes;
    }
    const minimumEstimate = cols * rows * TERMINAL_CELL_ESTIMATED_BYTES;
    if (minimumEstimate > available) {
      this.markHistoryGap(session);
      void this.dispose(sessionId).catch(() => undefined);
      return;
    }
    const nextScrollback = Math.min(
      session.scrollback,
      Math.max(0, Math.floor(available / (cols * TERMINAL_CELL_ESTIMATED_BYTES)) - rows),
    );
    if (nextScrollback < session.scrollback) session.manifest.historyTruncated = true;
    session.terminal.options.scrollback = nextScrollback;
    session.scrollback = nextScrollback;
    const nextEstimate = cols * (rows + nextScrollback) * TERMINAL_CELL_ESTIMATED_BYTES;
    this.stateEstimatedBytes += nextEstimate - session.estimatedBytes;
    session.estimatedBytes = nextEstimate;
    session.parseTail = session.parseTail
      .then(() => {
        if (session.disposed) return;
        session.terminal.resize(cols, rows);
      })
      .catch(() => {
        if (!session.disposed) this.markHistoryGap(session);
      });
    this.scheduleCheckpoint(session);
  }

  private async persistCurrentCheckpoint(session: Session): Promise<void> {
    await session.parseTail.catch(() => {
      this.markHistoryGap(session);
    });
    if (session.disposed) return;
    let checkpoint: string | null = null;
    if (!session.parserCarryOverflow) {
      try {
        const output = this.serializedState(session);
        checkpoint = `${JSON.stringify({
          formatVersion: TERMINAL_STATE_FORMAT_VERSION,
          output,
          cols: session.terminal.cols,
          rows: session.terminal.rows,
          sequence: session.sequence,
          revision: session.appliedRevision,
          generation: session.generation,
          incarnation: session.incarnation,
          at: Date.now(),
          checksum: createHash("sha256")
            .update(output)
            .update("\0")
            .update(session.parserCarry)
            .digest("hex"),
          pendingOutput: session.parserCarry,
        })}\n`;
      } catch {
        this.markHistoryGap(session);
      }
    } else {
      this.markHistoryGap(session);
    }
    await this.scheduleIo(session, async () => {
      if (checkpoint !== null) await atomicWrite(checkpointPath(session), checkpoint);
      session.manifest.updatedAt = Date.now();
      await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
    });
  }

  private async evictCompletedSessions(): Promise<void> {
    const completed = Array.from(this.sessions.values())
      .filter((session) => session.manifest.completed && session.completedAt !== null)
      .sort((left, right) => left.completedAt! - right.completedAt!);
    const excess = completed.slice(
      0,
      Math.max(0, completed.length - MAX_COMPLETED_RESIDENT_SESSIONS),
    );
    await Promise.allSettled(
      excess.map((session) => this.dispose(session.sessionId, false, true, true)),
    );
  }

  async stateSnapshot(sessionId: string): Promise<TerminalStateSnapshot | null> {
    const session = this.ensureSession(sessionId);
    if (!session) return null;
    if (!session.snapshotPromise) {
      session.snapshotPromise = (async () => {
        await session.parseTail;
        if (session.parserCarryOverflow) {
          throw new Error("Terminal snapshot is unavailable during an oversized control sequence");
        }
        return {
          formatVersion: TERMINAL_STATE_FORMAT_VERSION,
          mode: "state",
          output: this.serializedState(session),
          pendingOutput: session.parserCarry,
          generation: session.generation,
          revision: session.appliedRevision,
          historyId: session.historyId,
          incarnation: session.incarnation,
          cols: session.terminal.cols,
          rows: session.terminal.rows,
          earliestSequence: session.manifest.earliestSequence,
          latestSequence: session.sequence,
          historyTruncated: session.manifest.historyTruncated,
          historyGap: session.manifest.historyGap,
          completed: session.manifest.completed,
        } satisfies TerminalStateSnapshot;
      })().finally(() => {
        session.snapshotPromise = null;
      });
    }
    const snapshot = await session.snapshotPromise;
    if (session.manifest.completed) await this.evictCompletedSessions();
    return snapshot;
  }

  async complete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.acceptingOutput = false;
    session.manifest.completed = true;
    session.completedAt = Date.now();
    session.manifest.updatedAt = Date.now();
    session.parseTail = session.parseTail.then(() => {
      if (session.disposed) return;
      this.flushArchiveLine(session);
      this.flushPending(session);
    });
    await this.persistCurrentCheckpoint(session);
    await this.evictCompletedSessions();
    await this.scheduleRootPrune(path.dirname(session.directory));
  }

  dispose(
    sessionId: string,
    removeHistory = false,
    schedulePruneAfter = true,
    preserveConfiguration = false,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (!preserveConfiguration) this.sessionConfigurations.delete(sessionId);
      return Promise.resolve();
    }
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.acceptingOutput = false;
    session.parseTail = session.parseTail.then(() => {
      this.flushArchiveLine(session);
      this.flushPending(session);
    });
    this.sessions.delete(sessionId);
    if (!preserveConfiguration) this.sessionConfigurations.delete(sessionId);
    this.stateEstimatedBytes = Math.max(0, this.stateEstimatedBytes - session.estimatedBytes);
    const disposal = (async () => {
      await session.parseTail.catch(() => undefined);
      await session.ioTail.catch(() => undefined);
      session.disposed = true;
      session.serializer.dispose();
      session.terminal.dispose();
      if (removeHistory) await fs.rm(session.directory, { recursive: true, force: true });
      else if (schedulePruneAfter) await this.scheduleRootPrune(path.dirname(session.directory));
    })();
    this.historyDisposals.set(session.historyId, disposal);
    void disposal
      .finally(() => {
        if (this.historyDisposals.get(session.historyId) === disposal) {
          this.historyDisposals.delete(session.historyId);
        }
        if (this.historyIoTails.get(session.historyId) === session.ioTail) {
          this.historyIoTails.delete(session.historyId);
        }
      })
      .catch(() => undefined);
    return disposal;
  }

  /** Remove history for an explicit tab or environment deletion, including dormant archives. */
  async deleteHistories(input: {
    dataDir: string;
    environmentId: string;
    tabId?: string;
  }): Promise<void> {
    const root = path.join(input.dataDir, "terminal-history");
    const targets = new Set<string>();
    for (const session of Array.from(this.sessions.values())) {
      if (
        session.manifest.environmentId === input.environmentId &&
        (input.tabId === undefined || session.manifest.tabId === input.tabId)
      ) {
        targets.add(session.historyId);
        this.dispose(session.sessionId);
      }
    }
    for (const [sessionId, configuration] of Array.from(this.sessionConfigurations)) {
      if (
        configuration.environmentId === input.environmentId &&
        (input.tabId === undefined || configuration.tabId === input.tabId)
      ) {
        targets.add(safeHistoryId(configuration.stableIdentity));
        this.sessionConfigurations.delete(sessionId);
      }
    }
    const entries = await this.listHistoryDirectories(root);
    for (const entry of entries) {
      const manifest = await loadJson<Manifest>(path.join(root, entry, "manifest.json"));
      if (
        manifest?.formatVersion === 1 &&
        manifest.environmentId === input.environmentId &&
        (input.tabId === undefined || manifest.tabId === input.tabId)
      ) {
        targets.add(entry);
      }
    }
    for (const historyId of targets) {
      await this.historyDisposals.get(historyId)?.catch(() => undefined);
      await this.historyIoTails.get(historyId)?.catch(() => undefined);
      await fs.rm(sessionDirectory(input.dataDir, historyId), { recursive: true, force: true });
      this.historyIoTails.delete(historyId);
    }
  }

  private async acquirePageRead(): Promise<void> {
    if (this.pageReads < TERMINAL_HISTORY_PAGE_CONCURRENCY && this.pageWaiters.length === 0) {
      this.pageReads += 1;
      return;
    }
    await new Promise<void>((resolve) => this.pageWaiters.push(resolve));
  }

  private releasePageRead(): void {
    const waiter = this.pageWaiters.shift();
    if (waiter) waiter();
    else this.pageReads = Math.max(0, this.pageReads - 1);
  }

  async page(sessionId: string, cursor?: string): Promise<TerminalHistoryPage | null> {
    const session = this.ensureSession(sessionId);
    if (!session) return null;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    await session.parseTail;
    this.flushPending(session);
    await session.ioTail;
    await this.acquirePageRead();
    try {
      await this.pageReadHook?.();
      const upper = cursor === undefined ? session.sequence + 1 : decodeCursor(session, cursor);
      const records: HistoryRecord[] = [];
      let bytes = 0;
      let rowCount = 0;
      let pageFull = false;
      for (const segment of session.manifest.segments.toReversed()) {
        if (segment.first >= upper) continue;
        if (
          (await boundedFileSize(
            segmentPath(session, segment.number),
            TERMINAL_HISTORY_SEGMENT_BYTES + TERMINAL_HISTORY_RECORD_MAX_BYTES,
          )) === 0
        ) {
          this.markHistoryGap(session);
          continue;
        }
        const contents = await fs
          .readFile(segmentPath(session, segment.number), "utf8")
          .catch(() => "");
        const lines = contents.trimEnd().split("\n");
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          let record: HistoryRecord;
          try {
            record = JSON.parse(lines[index]!) as HistoryRecord;
          } catch {
            this.markHistoryGap(session);
            continue;
          }
          if (
            !Number.isSafeInteger(record.sequence) ||
            record.sequence < 1 ||
            !Number.isFinite(record.at) ||
            typeof record.text !== "string" ||
            Buffer.byteLength(record.text, "utf8") > TERMINAL_HISTORY_RECORD_MAX_BYTES
          ) {
            this.markHistoryGap(session);
            continue;
          }
          if (record.sequence >= upper) continue;
          const size = Buffer.byteLength(record.text, "utf8");
          const recordRows = 1;
          if (
            records.length > 0 &&
            (bytes + size > TERMINAL_HISTORY_PAGE_MAX_BYTES ||
              rowCount + recordRows > TERMINAL_HISTORY_PAGE_MAX_ROWS)
          ) {
            pageFull = true;
            break;
          }
          records.push(record);
          bytes += size;
          rowCount += recordRows;
          if (rowCount >= TERMINAL_HISTORY_PAGE_MAX_ROWS) break;
        }
        if (
          pageFull ||
          rowCount >= TERMINAL_HISTORY_PAGE_MAX_ROWS ||
          bytes >= TERMINAL_HISTORY_PAGE_MAX_BYTES
        )
          break;
      }
      records.reverse();
      const rows = records.map((record) => ({ id: `${record.sequence}:0`, text: record.text }));
      const first = records[0]?.sequence;
      const earliestAvailable = first === undefined || first <= session.manifest.earliestSequence;
      return {
        formatVersion: 1,
        historyId: session.historyId,
        rows,
        previousCursor:
          earliestAvailable || first === undefined ? null : encodeCursor(session, first),
        earliestAvailable,
        historyTruncated: session.manifest.archiveTruncated,
        historyGap: session.manifest.historyGap,
      };
    } finally {
      this.releasePageRead();
      if (session.manifest.completed) await this.evictCompletedSessions();
    }
  }

  async flush(quiesce = false): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (quiesce) session.acceptingOutput = false;
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.flushTimer = null;
      session.parseTail = session.parseTail.then(() => {
        this.flushArchiveLine(session);
        this.flushPending(session);
      });
      pending.push(this.persistCurrentCheckpoint(session).catch(() => undefined));
    }
    await Promise.allSettled(pending);
  }

  /**
   * Resolves once no history write, disposal or prune is in flight, including
   * work one of them queued while it ran. Disposal and completion are not
   * awaited by their callers, so a test awaits this before removing the data
   * directory they write into.
   */
  async settled(): Promise<void> {
    let previous = new Set<Promise<unknown>>();
    while (true) {
      const pending = new Set<Promise<unknown>>([
        ...Array.from(this.sessions.values(), (session) => session.parseTail),
        ...Array.from(this.sessions.values(), (session) => session.ioTail),
        ...this.historyIoTails.values(),
        ...this.historyDisposals.values(),
        ...this.rootPruneTails.values(),
      ]);
      if (Array.from(pending).every((promise) => previous.has(promise))) return;
      await Promise.allSettled(pending);
      previous = pending;
    }
  }

  /** Resident collectors, remembered configurations and queue usage; for tests and diagnostics. */
  stats(): {
    sessions: number;
    configurations: number;
    estimatedStateBytes: number;
    queuedBytes: number;
    queuedRecords: number;
    pageReads: number;
  } {
    return {
      sessions: this.sessions.size,
      configurations: this.sessionConfigurations.size,
      estimatedStateBytes: this.stateEstimatedBytes,
      queuedBytes: this.queuedBytes + this.preinitBytes,
      queuedRecords: this.queuedRecords + this.preinitRecords,
      pageReads: this.pageReads,
    };
  }

  /**
   * Clears every timer this history owns; called once by
   * `TerminalRuntime.shutdown()`. Collectors stay usable: the backend's awaited
   * `flush(true)` runs later in shutdown and persists their pending records and
   * final checkpoints.
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    for (const timer of this.pruneContinuationTimers) clearTimeout(timer);
    this.pruneContinuationTimers.clear();
  }
}
