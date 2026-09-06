export const TERMINAL_STATE_FORMAT_VERSION = 1 as const;
export const TERMINAL_STATE_TARGET_BYTES = 512 * 1024;
export const TERMINAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const TERMINAL_PARSER_CARRY_MAX_BYTES = 64 * 1024;
export const TERMINAL_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
export const TERMINAL_HISTORY_PAGE_MAX_ROWS = 1_000;
export const DEFAULT_TERMINAL_HISTORY_RETENTION_MB = 64;
export const MIN_TERMINAL_HISTORY_RETENTION_MB = 8;
export const MAX_TERMINAL_HISTORY_RETENTION_MB = 512;
export const DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB = 1_024;
export const MIN_TERMINAL_HISTORY_GLOBAL_RETENTION_MB = 128;
export const MAX_TERMINAL_HISTORY_GLOBAL_RETENTION_MB = 8_192;
export const DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS = 7;
export const MIN_TERMINAL_HISTORY_RETENTION_DAYS = 1;
export const MAX_TERMINAL_HISTORY_RETENTION_DAYS = 90;

function normalizeInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function normalizeTerminalHistoryRetention(value: {
  sessionMb?: unknown;
  globalMb?: unknown;
  days?: unknown;
}): { sessionMb: number; globalMb: number; days: number } {
  return {
    sessionMb: normalizeInteger(
      value.sessionMb,
      DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
      MIN_TERMINAL_HISTORY_RETENTION_MB,
      MAX_TERMINAL_HISTORY_RETENTION_MB,
    ),
    globalMb: normalizeInteger(
      value.globalMb,
      DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
      MIN_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
      MAX_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
    ),
    days: normalizeInteger(
      value.days,
      DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
      MIN_TERMINAL_HISTORY_RETENTION_DAYS,
      MAX_TERMINAL_HISTORY_RETENTION_DAYS,
    ),
  };
}

export interface TerminalStateSnapshot {
  formatVersion: typeof TERMINAL_STATE_FORMAT_VERSION;
  mode: "state";
  output: string;
  /** Bounded incomplete terminal control sequence needed to restore parser state. */
  pendingOutput: string;
  generation: number;
  revision: number;
  historyId: string;
  incarnation: string;
  cols: number;
  rows: number;
  earliestSequence: number;
  latestSequence: number;
  historyTruncated: boolean;
  historyGap: boolean;
  completed: boolean;
}

export interface TerminalHistoryRow {
  id: string;
  text: string;
}

export interface TerminalHistoryPage {
  formatVersion: typeof TERMINAL_STATE_FORMAT_VERSION;
  historyId: string;
  rows: TerminalHistoryRow[];
  previousCursor: string | null;
  earliestAvailable: boolean;
  historyTruncated: boolean;
  historyGap: boolean;
}

export function isTerminalStateSnapshot(value: unknown): value is TerminalStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<TerminalStateSnapshot>;
  if (
    typeof snapshot.output !== "string" ||
    typeof snapshot.pendingOutput !== "string" ||
    new TextEncoder().encode(snapshot.output).byteLength +
      new TextEncoder().encode(snapshot.pendingOutput).byteLength >
      TERMINAL_STATE_MAX_BYTES ||
    new TextEncoder().encode(snapshot.pendingOutput).byteLength > TERMINAL_PARSER_CARRY_MAX_BYTES
  )
    return false;
  return (
    snapshot.formatVersion === TERMINAL_STATE_FORMAT_VERSION &&
    snapshot.mode === "state" &&
    Number.isSafeInteger(snapshot.generation) &&
    snapshot.generation! >= 0 &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision! >= 0 &&
    typeof snapshot.historyId === "string" &&
    snapshot.historyId.length <= 128 &&
    typeof snapshot.incarnation === "string" &&
    snapshot.incarnation.length <= 128 &&
    Number.isSafeInteger(snapshot.cols) &&
    snapshot.cols! >= 1 &&
    snapshot.cols! <= 1_000 &&
    Number.isSafeInteger(snapshot.rows) &&
    snapshot.rows! >= 1 &&
    snapshot.rows! <= 1_000 &&
    Number.isSafeInteger(snapshot.earliestSequence) &&
    snapshot.earliestSequence! >= 0 &&
    Number.isSafeInteger(snapshot.latestSequence) &&
    snapshot.latestSequence! >= 0 &&
    typeof snapshot.historyTruncated === "boolean" &&
    typeof snapshot.historyGap === "boolean" &&
    typeof snapshot.completed === "boolean"
  );
}

export function isTerminalHistoryPage(value: unknown): value is TerminalHistoryPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<TerminalHistoryPage>;
  if (!Array.isArray(page.rows) || page.rows.length > TERMINAL_HISTORY_PAGE_MAX_ROWS) return false;
  let bytes = 0;
  for (const row of page.rows) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      row.id.length > 128 ||
      typeof row.text !== "string"
    )
      return false;
    bytes += new TextEncoder().encode(row.text).byteLength;
    if (bytes > TERMINAL_HISTORY_PAGE_MAX_BYTES) return false;
  }
  return (
    page.formatVersion === TERMINAL_STATE_FORMAT_VERSION &&
    typeof page.historyId === "string" &&
    page.historyId.length <= 128 &&
    (page.previousCursor === null ||
      (typeof page.previousCursor === "string" && page.previousCursor.length <= 1_024)) &&
    typeof page.earliestAvailable === "boolean" &&
    typeof page.historyTruncated === "boolean" &&
    typeof page.historyGap === "boolean"
  );
}
