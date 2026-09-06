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
let terminalHistorySessionBytes = DEFAULT_TERMINAL_HISTORY_RETENTION_MB * 1024 * 1024;
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
const TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES = 3 * 1024 * 1024;
let terminalHistoryGlobalBytes = DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB * 1024 * 1024;
let terminalHistoryCompletedMaxAgeMs = DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
const TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES = 128 * 1024 * 1024;
// xterm's typed buffers, line objects, parser state, and JS allocator overhead
// substantially exceed the visible character payload. This conservative
// reservation was tuned against the 1/10/50-terminal benchmark below.
const TERMINAL_CELL_ESTIMATED_BYTES = 96;

type HistoryRecord = { sequence: number; at: number; text: string };
type ParserState = "normal" | "escape" | "csi" | "string" | "string-escape";

type Manifest = {
  formatVersion: 1;
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
};

const sessions = new Map<string, Session>();
const historyIoTails = new Map<string, Promise<void>>();
const historyDisposals = new Map<string, Promise<void>>();
const prunedRoots = new Set<string>();
let terminalStateEstimatedBytes = 0;
let terminalHistoryQueuedBytes = 0;
let terminalHistoryQueuedRecords = 0;
let terminalHistoryPageReads = 0;
const terminalHistoryPageWaiters: Array<() => void> = [];
const TERMINAL_HISTORY_PAGE_CONCURRENCY = 4;

export function configureTerminalHistoryRetention(value: {
  sessionMb?: unknown;
  globalMb?: unknown;
  days?: unknown;
}): void {
  const retention = normalizeTerminalHistoryRetention(value);
  terminalHistorySessionBytes = retention.sessionMb * 1024 * 1024;
  terminalHistoryGlobalBytes = retention.globalMb * 1024 * 1024;
  terminalHistoryCompletedMaxAgeMs = retention.days * 24 * 60 * 60_000;
  prunedRoots.clear();
  for (const session of sessions.values()) scheduleSessionRetention(session);
}

function safeHistoryId(stableIdentity: string): string {
  return createHash("sha256").update(stableIdentity).digest("hex");
}

function reclaimTerminalStateBytes(requiredBytes: number): void {
  let remaining = requiredBytes;
  for (const session of sessions.values()) {
    if (remaining <= 0) break;
    const rowBytes = session.terminal.cols * TERMINAL_CELL_ESTIMATED_BYTES;
    const rowsToRemove = Math.min(session.scrollback, Math.ceil(remaining / rowBytes));
    if (rowsToRemove <= 0) continue;
    session.scrollback -= rowsToRemove;
    session.terminal.options.scrollback = session.scrollback;
    const reclaimed = rowsToRemove * rowBytes;
    session.estimatedBytes -= reclaimed;
    terminalStateEstimatedBytes = Math.max(0, terminalStateEstimatedBytes - reclaimed);
    remaining -= reclaimed;
  }
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

async function listHistoryDirectories(root: string): Promise<string[]> {
  try {
    const directory = await fs.opendir(root);
    const entries: string[] = [];
    for await (const entry of directory) {
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) entries.push(entry.name);
      if (entries.length >= 4_096) break;
    }
    return entries;
  } catch {
    return [];
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

async function pruneHistoryRoot(root: string, activeHistoryId: string): Promise<void> {
  const entries = await listHistoryDirectories(root);
  const manifests: Array<{ directory: string; manifest: Manifest; bytes: number }> = [];
  for (const entry of entries) {
    const directory = path.join(root, entry);
    const manifest = await loadJson<Manifest>(path.join(directory, "manifest.json"));
    if (!manifest || manifest.formatVersion !== 1 || manifest.historyId !== entry) continue;
    const metadataBytes =
      (await boundedFileSize(path.join(directory, "manifest.json"), 1024 * 1024)) +
      (await boundedFileSize(path.join(directory, "checkpoint.json"), 3 * 1024 * 1024));
    manifests.push({
      directory,
      manifest,
      bytes: metadataBytes + manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0),
    });
  }
  const now = Date.now();
  const activeHistoryIds = new Set(Array.from(sessions.values(), (session) => session.historyId));
  activeHistoryIds.add(activeHistoryId);
  for (const entry of manifests) {
    if (
      entry.manifest.completed &&
      !activeHistoryIds.has(entry.manifest.historyId) &&
      now - entry.manifest.updatedAt > terminalHistoryCompletedMaxAgeMs
    ) {
      await fs.rm(entry.directory, { recursive: true, force: true });
      entry.bytes = 0;
    }
  }
  let total = manifests.reduce((sum, entry) => sum + entry.bytes, 0);
  const candidates = manifests
    .filter((entry) => entry.bytes > 0 && !activeHistoryIds.has(entry.manifest.historyId))
    .sort(
      (left, right) =>
        Number(right.manifest.completed) - Number(left.manifest.completed) ||
        left.manifest.updatedAt - right.manifest.updatedAt,
    );
  for (const entry of candidates) {
    if (total <= terminalHistoryGlobalBytes) break;
    await fs.rm(entry.directory, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

export async function pruneTerminalHistoryStorage(dataDir: string): Promise<void> {
  const root = path.join(dataDir, "terminal-history");
  await pruneHistoryRoot(root, "");
  prunedRoots.add(root);
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

function serializedState(session: Session): string {
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

async function initialize(session: Session): Promise<void> {
  await historyIoTails.get(session.historyId)?.catch(() => undefined);
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
    session.manifest = {
      ...previousManifest,
      archiveTruncated: previousManifest.archiveTruncated ?? false,
      incarnation: session.incarnation,
      completed: false,
      updatedAt: Date.now(),
    };
    session.sequence = previousManifest.latestSequence;
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
    session.terminal.resize(checkpoint.cols, checkpoint.rows);
    await writeTerminal(session.terminal, checkpoint.output);
    if (checkpoint.pendingOutput) await writeTerminal(session.terminal, checkpoint.pendingOutput);
    trackParserCarry(session, checkpoint.pendingOutput ?? "");
    session.receivedRevision = checkpoint.revision ?? 0;
    session.appliedRevision = checkpoint.revision ?? 0;
    session.generation = checkpoint.generation ?? session.generation;
  } else if (checkpoint) {
    session.manifest.historyGap = true;
  }
  await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
}

export function configureTerminalHistory(input: {
  sessionId: string;
  dataDir: string;
  stableIdentity: string;
  cols: number;
  rows: number;
  environmentId?: string;
  tabId?: string;
  generation?: number;
}): string {
  const existing = sessions.get(input.sessionId);
  if (existing) return existing.historyId;
  if ((sessions.size + 1) * TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES > terminalHistoryGlobalBytes) {
    throw new Error("Terminal history storage admission limit reached");
  }
  const historyId = safeHistoryId(input.stableIdentity);
  const incarnation = randomUUID();
  let availableBytes = Math.max(
    0,
    TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - terminalStateEstimatedBytes,
  );
  const minimumBytes = input.cols * input.rows * TERMINAL_CELL_ESTIMATED_BYTES;
  if (minimumBytes > availableBytes) {
    reclaimTerminalStateBytes(minimumBytes - availableBytes);
    availableBytes = Math.max(
      0,
      TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - terminalStateEstimatedBytes,
    );
  }
  if (minimumBytes > availableBytes) {
    throw new Error("Terminal state memory limit reached");
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
  } satisfies Session;
  session.initialized = initialize(session).catch(() => {
    session.manifest.historyGap = true;
  });
  session.parseTail = session.initialized;
  session.ioTail = session.initialized;
  sessions.set(input.sessionId, session);
  terminalStateEstimatedBytes += estimatedBytes;
  for (const activeSession of sessions.values()) scheduleSessionRetention(activeSession);
  const root = path.join(input.dataDir, "terminal-history");
  if (!prunedRoots.has(root)) {
    prunedRoots.add(root);
    void pruneHistoryRoot(root, historyId);
  }
  return historyId;
}

function scheduleIo(session: Session, operation: () => Promise<void>): void {
  const previous = historyIoTails.get(session.historyId) ?? session.ioTail;
  session.ioTail = Promise.allSettled([previous, session.initialized])
    .then(operation)
    .catch(() => {
      session.manifest.historyGap = true;
    });
  historyIoTails.set(session.historyId, session.ioTail);
}

function markHistoryGap(session: Session): void {
  session.manifest.historyGap = true;
  if (session.gapWriteScheduled) return;
  session.gapWriteScheduled = true;
  scheduleIo(session, async () => {
    try {
      session.manifest.updatedAt = Date.now();
      await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
    } finally {
      session.gapWriteScheduled = false;
    }
  });
}

function scheduleFlush(session: Session): void {
  if (session.flushTimer) return;
  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    flushPending(session);
  }, TERMINAL_HISTORY_FLUSH_MS);
  session.flushTimer.unref?.();
}

function releaseQueuedRecords(session: Session, records: HistoryRecord[]): void {
  const bytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.text, "utf8"), 0);
  session.queuedBytes = Math.max(0, session.queuedBytes - bytes);
  session.queuedRecords = Math.max(0, session.queuedRecords - records.length);
  terminalHistoryQueuedBytes = Math.max(0, terminalHistoryQueuedBytes - bytes);
  terminalHistoryQueuedRecords = Math.max(0, terminalHistoryQueuedRecords - records.length);
}

function activeSessionSegmentBudget(): number {
  const aggregateShare =
    Math.floor(terminalHistoryGlobalBytes / Math.max(1, sessions.size)) -
    TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES;
  return Math.max(
    0,
    Math.min(terminalHistorySessionBytes - TERMINAL_HISTORY_RECOVERY_RESERVE_BYTES, aggregateShare),
  );
}

async function pruneSessionSegments(session: Session): Promise<void> {
  let total = session.manifest.segments.reduce((sum, entry) => sum + entry.bytes, 0);
  const segmentBudget = activeSessionSegmentBudget();
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

function scheduleSessionRetention(session: Session): void {
  scheduleIo(session, async () => {
    await pruneSessionSegments(session);
    session.manifest.updatedAt = Date.now();
    await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
  });
}

function flushPending(session: Session): void {
  const records = session.pending.splice(0);
  session.pendingBytes = 0;
  if (records.length === 0) return;
  scheduleIo(session, async () => {
    try {
      let segment = session.manifest.segments.at(-1);
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
      await pruneSessionSegments(session);
      session.manifest.updatedAt = Date.now();
      await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
    } finally {
      releaseQueuedRecords(session, records);
    }
  });
}

/** Split raw output without splitting UTF-8 or allowing one record to monopolize a page. */
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

function enqueueHistoryRecord(session: Session, text: string, at: number): void {
  const bytes = Buffer.byteLength(text, "utf8");
  const hasCapacity =
    session.queuedRecords < TERMINAL_HISTORY_PENDING_RECORDS &&
    session.queuedBytes + bytes <= TERMINAL_HISTORY_PENDING_BYTES &&
    terminalHistoryQueuedRecords < TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS &&
    terminalHistoryQueuedBytes + bytes <= TERMINAL_HISTORY_GLOBAL_PENDING_BYTES;
  if (!hasCapacity) {
    markHistoryGap(session);
    return;
  }
  session.sequence += 1;
  session.manifest.latestSequence = session.sequence;
  const record = { sequence: session.sequence, at, text };
  session.pending.push(record);
  session.pendingBytes += bytes;
  session.queuedBytes += bytes;
  session.queuedRecords += 1;
  terminalHistoryQueuedBytes += bytes;
  terminalHistoryQueuedRecords += 1;
  scheduleFlush(session);
}

function scheduleCheckpoint(session: Session): void {
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
      if (session.parserCarryOverflow) return;
      const output = serializedState(session);
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
      scheduleIo(session, () =>
        atomicWrite(checkpointPath(session), `${JSON.stringify(checkpoint)}\n`),
      );
    })
    .catch(() => {
      // A pathological current screen can exceed the hard snapshot bound. Keep
      // the parser chain usable for later output/resizes and report that the
      // durable checkpoint has a gap instead of freezing collection forever.
      markHistoryGap(session);
    });
}

export function appendTerminalHistory(
  sessionId: string,
  text: string,
  revision: number,
  generation: number,
): void {
  const session = sessions.get(sessionId);
  if (!session || !text) return;
  if (session.generation !== generation) {
    session.incarnation = randomUUID();
    session.manifest.incarnation = session.incarnation;
    session.manifest.completed = false;
    session.appliedRevision = 0;
    session.parseTail = session.parseTail.then(() => {
      session.terminal.reset();
      session.parserState = "normal";
      session.parserCarry = "";
      session.parserCarryBytes = 0;
      session.parserCarryOverflow = false;
    });
  }
  session.receivedRevision = revision;
  session.generation = generation;
  session.manifest.updatedAt = Date.now();
  const bytes = Buffer.byteLength(text, "utf8");
  const at = Date.now();
  for (const chunk of splitHistoryRecords(text)) enqueueHistoryRecord(session, chunk, at);
  session.bytesSinceCheckpoint += bytes;
  session.parseTail = session.parseTail.then(async () => {
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
  });
  scheduleCheckpoint(session);
}

export function resizeTerminalHistory(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const nextEstimate = cols * (rows + session.scrollback) * TERMINAL_CELL_ESTIMATED_BYTES;
  const available =
    TERMINAL_STATE_GLOBAL_ESTIMATED_BYTES - terminalStateEstimatedBytes + session.estimatedBytes;
  if (nextEstimate > available) {
    throw new Error("Terminal resize exceeds the terminal state memory limit");
  }
  terminalStateEstimatedBytes += nextEstimate - session.estimatedBytes;
  session.estimatedBytes = nextEstimate;
  session.parseTail = session.parseTail.then(() => {
    session.terminal.resize(cols, rows);
  });
  scheduleCheckpoint(session);
}

export async function getTerminalStateSnapshot(
  sessionId: string,
): Promise<TerminalStateSnapshot | null> {
  const session = sessions.get(sessionId);
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
        output: serializedState(session),
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
  return session.snapshotPromise;
}

export async function completeTerminalHistory(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  flushPending(session);
  await session.parseTail;
  session.manifest.completed = true;
  session.manifest.updatedAt = Date.now();
  if (session.parserCarryOverflow) {
    markHistoryGap(session);
    await session.ioTail;
    return;
  }
  const output = serializedState(session);
  scheduleIo(session, async () => {
    await atomicWrite(
      checkpointPath(session),
      `${JSON.stringify({
        formatVersion: 1,
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
      })}\n`,
    );
    await atomicWrite(manifestPath(session), `${JSON.stringify(session.manifest)}\n`);
  });
  await session.ioTail;
}

export function disposeTerminalHistory(sessionId: string, removeHistory = false): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve();
  if (session.flushTimer) clearTimeout(session.flushTimer);
  flushPending(session);
  sessions.delete(sessionId);
  terminalStateEstimatedBytes = Math.max(0, terminalStateEstimatedBytes - session.estimatedBytes);
  const disposal = (async () => {
    await session.parseTail.catch(() => undefined);
    await session.ioTail.catch(() => undefined);
    session.serializer.dispose();
    session.terminal.dispose();
    if (removeHistory) await fs.rm(session.directory, { recursive: true, force: true });
  })();
  historyDisposals.set(session.historyId, disposal);
  void disposal
    .finally(() => {
      if (historyDisposals.get(session.historyId) === disposal) {
        historyDisposals.delete(session.historyId);
      }
    })
    .catch(() => undefined);
  return disposal;
}

/** Remove history for an explicit tab or environment deletion, including dormant archives. */
export async function deleteTerminalHistories(input: {
  dataDir: string;
  environmentId: string;
  tabId?: string;
}): Promise<void> {
  const root = path.join(input.dataDir, "terminal-history");
  const targets = new Set<string>();
  for (const session of Array.from(sessions.values())) {
    if (
      session.manifest.environmentId === input.environmentId &&
      (input.tabId === undefined || session.manifest.tabId === input.tabId)
    ) {
      targets.add(session.historyId);
      disposeTerminalHistory(session.sessionId);
    }
  }
  const entries = await listHistoryDirectories(root);
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
    await historyDisposals.get(historyId)?.catch(() => undefined);
    await historyIoTails.get(historyId)?.catch(() => undefined);
    await fs.rm(sessionDirectory(input.dataDir, historyId), { recursive: true, force: true });
    historyIoTails.delete(historyId);
  }
}

function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export async function getTerminalHistoryPage(
  sessionId: string,
  cursor?: string,
): Promise<TerminalHistoryPage | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.flushTimer) clearTimeout(session.flushTimer);
  session.flushTimer = null;
  flushPending(session);
  await session.initialized;
  await session.ioTail;
  if (terminalHistoryPageReads >= TERMINAL_HISTORY_PAGE_CONCURRENCY) {
    await new Promise<void>((resolve) => terminalHistoryPageWaiters.push(resolve));
  }
  terminalHistoryPageReads += 1;
  try {
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
        markHistoryGap(session);
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
          markHistoryGap(session);
          continue;
        }
        if (
          !Number.isSafeInteger(record.sequence) ||
          record.sequence < 1 ||
          !Number.isFinite(record.at) ||
          typeof record.text !== "string" ||
          Buffer.byteLength(record.text, "utf8") > TERMINAL_HISTORY_RECORD_MAX_BYTES
        ) {
          markHistoryGap(session);
          continue;
        }
        if (record.sequence >= upper) continue;
        const size = Buffer.byteLength(record.text, "utf8");
        const recordRows = stripTerminalControls(record.text).split("\n").length;
        if (recordRows > TERMINAL_HISTORY_RECORD_MAX_ROWS + 1) {
          markHistoryGap(session);
          continue;
        }
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
    const rows = records.flatMap((record) =>
      stripTerminalControls(record.text)
        .split("\n")
        .map((text, index) => ({ id: `${record.sequence}:${index}`, text })),
    );
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
    terminalHistoryPageReads = Math.max(0, terminalHistoryPageReads - 1);
    terminalHistoryPageWaiters.shift()?.();
  }
}

export async function flushTerminalHistories(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const session of sessions.values()) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    flushPending(session);
    pending.push(
      session.parseTail
        .catch(() => undefined)
        .then(() => session.ioTail)
        .catch(() => undefined),
    );
  }
  await Promise.allSettled(pending);
}

export const terminalHistoryTesting = {
  stats(): {
    sessions: number;
    estimatedStateBytes: number;
    queuedBytes: number;
    queuedRecords: number;
    pageReads: number;
  } {
    return {
      sessions: sessions.size,
      estimatedStateBytes: terminalStateEstimatedBytes,
      queuedBytes: terminalHistoryQueuedBytes,
      queuedRecords: terminalHistoryQueuedRecords,
      pageReads: terminalHistoryPageReads,
    };
  },
  clear(): void {
    for (const session of sessions.values()) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      session.serializer.dispose();
      session.terminal.dispose();
    }
    sessions.clear();
    terminalStateEstimatedBytes = 0;
    terminalHistoryQueuedBytes = 0;
    terminalHistoryQueuedRecords = 0;
    terminalHistoryPageReads = 0;
    terminalHistoryPageWaiters.splice(0).forEach((resolve) => resolve());
    historyIoTails.clear();
    historyDisposals.clear();
    prunedRoots.clear();
    configureTerminalHistoryRetention({});
  },
};
