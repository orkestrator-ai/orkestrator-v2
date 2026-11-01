import {
  formatLogError,
  isSafeLogError,
  logErrorFromWire,
  logErrorKind,
  type LogErrorDetails,
  type SafeLogError,
} from "./log-error.js";
import { LOG_VOCABULARY, type LogAreaSpec, type ThrottleLogEvent } from "./log-vocabulary/index.js";

/**
 * The application logger. Browser-safe, dependency-free and shared by every
 * process; docs/architecture/logging.md is the guide.
 *
 * Each entry is an area and a static event from `log-vocabulary/`, plus scalar
 * fields. A raw object cannot be logged: the types refuse one and, for code the
 * types do not reach, the runtime replaces it with a marker.
 */

export {
  formatLogError,
  logErrorKind,
  type FormatLogErrorOptions,
  type SafeLogError,
} from "./log-error.js";

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "text" | "json";

export type LogArea = keyof typeof LOG_VOCABULARY;
export type LogEventOf<Area extends LogArea> = Extract<
  keyof (typeof LOG_VOCABULARY)[Area]["events"],
  string
>;

export type LogScalar = string | number | boolean | null | undefined;
export type LogFieldValue = LogScalar | SafeLogError;

/** Names that would hold content AGENTS.md invariant 12 keeps out of logs. */
export type ForbiddenLogField =
  | "stdout"
  | "stderr"
  | "cmd"
  | "spawnargs"
  | "prompt"
  | "token"
  | "password"
  | "secret"
  | "authorization"
  | "apiKey"
  | "cookie"
  | "credentials";

export type LogFields = Readonly<Record<string, LogFieldValue>> & {
  readonly [Name in ForbiddenLogField]?: never;
};
/** A function is called only when the level is on, so a hot path builds nothing. */
export type LogFieldsInput = LogFields | (() => LogFields);

/** The events an area may throttle: every one of its own, if it lists the throttle's lines. */
export type ThrottledEvent<Event extends string> = ThrottleLogEvent extends Event
  ? Exclude<Event, ThrottleLogEvent>
  : never;

export type ThrottledLogOptions = {
  /**
   * Which instance of the site failed, when one site runs for several tabs or
   * jobs, so that one instance's success does not clear another's fault. A
   * bounded identifier, never content: it reaches every line.
   */
  scope?: string;
  /** Detail for a first occurrence only. Repeats never build it. */
  fields?: LogFieldsInput;
} & (
  | {
      /** Keyed by its code or type through `logErrorKind`, never by its message. */
      error: unknown;
      kind?: never;
    }
  | {
      /** A static name, for a failure that has no error object. */
      kind: string;
      error?: never;
    }
);

export interface Logger<Event extends string> {
  error(event: Event, fields?: LogFieldsInput): void;
  warn(event: Event, fields?: LogFieldsInput): void;
  info(event: Event, fields?: LogFieldsInput): void;
  debug(event: Event, fields?: LogFieldsInput): void;
  trace(event: Event, fields?: LogFieldsInput): void;
  /**
   * For a loop that repeats a line as long as a fault lasts. The first occurrence
   * of each site and error kind is written in full, repeats are counted, and one
   * summary is written per window. docs/architecture/logging.md has the rules.
   */
  throttled(level: LogLevel, event: ThrottledEvent<Event>, options: ThrottledLogOptions): void;
  /**
   * The operation `throttled` reports on succeeded. Writes one recovered line if
   * the site was failing; otherwise costs two comparisons, so call it every pass.
   */
  recovered(event: ThrottledEvent<Event>, scope?: string): void;
  /** For a guard around work that is not just building fields. */
  isEnabled(level: LogLevel): boolean;
}

/** A field after validation: what crosses a process boundary. */
export type LogWireValue = string | number | boolean | null | LogErrorDetails;

export interface LogRecord {
  /** Wire format version, always first; see `LOG_RECORD_PREFIX`. */
  readonly orklog: 1;
  readonly ts: string;
  readonly level: LogLevel;
  readonly area: string;
  readonly event: string;
  readonly fields?: Readonly<Record<string, LogWireValue>>;
}

/** The console method an output line uses. `log` is unstructured stdout. */
export type LogOutputMethod = "error" | "warn" | "info" | "debug" | "log";

export interface LogOutput {
  method: LogOutputMethod;
  line: string;
  /** Absent for unstructured process output. */
  record?: LogRecord;
}

export type LogSink = (output: LogOutput) => void;

export interface LoggerConfig {
  /** Applies to every area without its own entry in `areaLevels`. */
  level: LogLevel;
  /** By area; `desktop` also covers `desktop.dialog` unless that has its own. */
  areaLevels: Readonly<Record<string, LogLevel>>;
  format: LogFormat;
  sink: LogSink;
}

/** Every JSON line starts with this, so a reader can skip others without parsing. */
export const LOG_RECORD_PREFIX = '{"orklog":1,';

const MAX_FIELD_CHARS = 2048;
const TRUNCATION_MARKER_RESERVE = 32;
const MAX_FIELDS = 32;
const FIELD_NAME_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;
const BARE_TEXT_VALUE = /^[\w./:@+,~-]+$/;
const THROTTLE_KIND_PATTERN = /^[\w.:-]{1,64}$/;
const MAX_THROTTLE_SCOPE_CHARS = 128;
const FORBIDDEN_FIELD_NAMES = new Set([
  "stdout",
  "stderr",
  "cmd",
  "spawnargs",
  "prompt",
  "token",
  "password",
  "secret",
  "authorization",
  "apikey",
  "cookie",
  "credentials",
]);

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * `trace` goes out as `debug`: `console.trace` prints a stack of its own, and
 * neither the bounded console nor the file tee wraps it.
 */
const OUTPUT_METHOD: Readonly<Record<LogLevel, LogOutputMethod>> = {
  error: "error",
  warn: "warn",
  info: "info",
  debug: "debug",
  trace: "debug",
};

// Read at call time: production logging and tests replace these methods.
const consoleSink: LogSink = ({ method, line }) => {
  console[method](line);
};

const DEFAULT_CONFIG: LoggerConfig = {
  level: "info",
  areaLevels: {},
  format: "text",
  sink: consoleSink,
};

let config: LoggerConfig = DEFAULT_CONFIG;
// Bumped on every change so each logger can cache its threshold for a plain
// integer comparison on the hot path.
let generation = 0;

/** Applies a partial change for the whole process. Later calls layer on earlier ones. */
export function configureLogger(change: Partial<LoggerConfig>): void {
  config = { ...config, ...change };
  generation += 1;
}

/** Back to the defaults; for tests. */
export function resetLogger(): void {
  config = DEFAULT_CONFIG;
  generation += 1;
  throttledSites.clear();
  throttledKeyCount = 0;
  nextThrottleFlushAt = 0;
}

export function getLogFormat(): LogFormat {
  return config.format;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function areaSpec(area: string): LogAreaSpec | undefined {
  return Object.hasOwn(LOG_VOCABULARY, area)
    ? (LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>)[area]
    : undefined;
}

function thresholdRank(area: string): number {
  for (let scope = area; ; scope = scope.slice(0, scope.lastIndexOf("."))) {
    const level = Object.hasOwn(config.areaLevels, scope) ? config.areaLevels[scope] : undefined;
    if (level) return LEVEL_RANK[level];
    if (!scope.includes(".")) return LEVEL_RANK[config.level];
  }
}

/** The marker counts towards the bound, so a relayed value is not cut a second time. */
function boundedString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const kept = maxChars - TRUNCATION_MARKER_RESERVE;
  return `${value.slice(0, kept)}...[truncated ${value.length - kept} chars]`;
}

function sanitizeValue(name: string, value: unknown, maxChars: number): LogWireValue | undefined {
  if (FORBIDDEN_FIELD_NAMES.has(name.toLowerCase().replace(/[-_.]/g, ""))) return "[forbidden]";
  switch (typeof value) {
    case "string":
      return boundedString(value, maxChars);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "bigint":
      return value.toString();
    case "object":
      if (value === null) return null;
      if (isSafeLogError(value)) return value;
      // A raw Error still cannot escape: it takes the same path a call site's would.
      if (value instanceof Error) return formatLogError(value);
      return "[rejected:object]";
    default:
      return `[rejected:${typeof value}]`;
  }
}

function sanitizeFields(
  fields: Readonly<Record<string, unknown>>,
  maxChars: number,
): Readonly<Record<string, LogWireValue>> | undefined {
  const clean: Record<string, LogWireValue> = {};
  let count = 0;
  let dropped = 0;
  for (const name of Object.keys(fields)) {
    const value = sanitizeValue(name, fields[name], maxChars);
    if (value === undefined) continue;
    if (count >= MAX_FIELDS || !FIELD_NAME_PATTERN.test(name)) {
      dropped += 1;
      continue;
    }
    clean[name] = value;
    count += 1;
  }
  if (dropped > 0) clean.droppedFields = dropped;
  return count > 0 || dropped > 0 ? clean : undefined;
}

function textValue(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  return BARE_TEXT_VALUE.test(value) ? value : JSON.stringify(value);
}

function appendTextField(parts: string[], name: string, value: LogWireValue): void {
  if (typeof value !== "object" || value === null) {
    parts.push(`${name}=${textValue(value)}`);
    return;
  }
  for (const key of Object.keys(value) as Array<keyof LogErrorDetails>) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (key === "cause") appendTextField(parts, `${name}.cause`, entry as LogErrorDetails);
    else if (key === "stack")
      parts.push(`${name}.stack=${textValue((entry as string[]).join(" | "))}`);
    else parts.push(`${name}.${key}=${textValue(entry as string | number | boolean)}`);
  }
}

/**
 * `JSON.stringify` leaves these raw, and a reader such as Node's readline ends a
 * line at U+2028 and U+2029, which would split one entry into two.
 */
export function escapeLogLine(line: string): string {
  return line.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function renderText(record: LogRecord): string {
  const tag = areaSpec(record.area)?.tag ?? record.area;
  const parts = [`[${tag}]`, record.event];
  if (record.fields) {
    for (const name of Object.keys(record.fields))
      appendTextField(parts, name, record.fields[name]!);
  }
  return escapeLogLine(parts.join(" "));
}

function renderJson(record: LogRecord): string {
  return escapeLogLine(JSON.stringify(record));
}

function deliver(record: LogRecord): void {
  try {
    config.sink({
      method: OUTPUT_METHOD[record.level],
      line: config.format === "json" ? renderJson(record) : renderText(record),
      record,
    });
  } catch {
    // Logging never owns the operation being logged.
  }
}

function buildRecord(
  level: LogLevel,
  area: string,
  event: string,
  fields: Readonly<Record<string, unknown>> | undefined,
): LogRecord {
  const clean = fields
    ? sanitizeFields(fields, areaSpec(area)?.maxStringChars ?? MAX_FIELD_CHARS)
    : undefined;
  return {
    orklog: 1,
    ts: new Date().toISOString(),
    level,
    area,
    event,
    ...(clean ? { fields: clean } : {}),
  };
}

/** One line per window per key, however fast the loop repeats. */
export const LOG_THROTTLE_WINDOW_MS = 60_000;
/** Keys tracked across the process (AGENTS.md invariant 11). */
export const LOG_THROTTLE_MAX_KEYS = 512;
/** A stopped loop must not hide the next incident behind an old key. */
export const LOG_THROTTLE_IDLE_MS = 5 * LOG_THROTTLE_WINDOW_MS;

interface ThrottledKey {
  /** Repeats counted since the last line that reported them. */
  pending: number;
  windowStart: number;
  lastFailureAt: number;
  recency: number;
}

/** One site and scope. Its keys are the error kinds seen since it last recovered. */
interface ThrottledSite {
  area: string;
  event: string;
  scope: string | undefined;
  level: LogLevel;
  since: number;
  failures: number;
  keys: Map<string, ThrottledKey>;
}

// Each kind carries its own recency; a busy sibling kind cannot protect it.
const throttledSites = new Map<string, ThrottledSite>();
let throttledKeyCount = 0;
let throttleRecency = 0;
let throttleGeneration = generation;
let nextThrottleFlushAt = 0;

function writeThrottleLine(
  site: ThrottledSite,
  event: ThrottleLogEvent,
  fields: Readonly<Record<string, unknown>>,
): void {
  const spec = areaSpec(site.area);
  if (!spec) return;
  const listed = Object.hasOwn(spec.events, event);
  const line = { site: site.event, ...(site.scope === undefined ? {} : { scope: site.scope }) };
  deliver(
    buildRecord(
      site.level,
      site.area,
      listed ? event : "invalid-event",
      listed ? { ...line, ...fields } : undefined,
    ),
  );
}

/**
 * A level is re-read here rather than remembered, because it can be replaced at
 * any time. A site whose level is now off is dropped with its count, so nothing
 * tracked ever outlives the reader's ability to see it: the next failure after
 * the level returns is a first occurrence again.
 */
function syncThrottleLevels(): void {
  if (throttleGeneration === generation) return;
  throttleGeneration = generation;
  for (const [siteKey, site] of Array.from(throttledSites)) {
    if (LEVEL_RANK[site.level] <= thresholdRank(site.area)) continue;
    throttledSites.delete(siteKey);
    throttledKeyCount -= site.keys.size;
  }
}

/** Closes a key's window once it has run its length; a clock moved back also closes it. */
function rollThrottleWindow(site: ThrottledSite, kind: string, key: ThrottledKey, now: number) {
  const elapsed = now - key.windowStart;
  if (elapsed >= 0 && elapsed < LOG_THROTTLE_WINDOW_MS) return;
  if (key.pending > 0) {
    writeThrottleLine(site, "throttle.suppressed", {
      kind,
      suppressed: key.pending,
      windowSeconds: Math.max(0, Math.round(elapsed / 1000)),
    });
  }
  key.pending = 0;
  key.windowStart = now;
}

/** So a loop that stopped calling still reports its count, while any other throttle runs. */
function flushDueThrottleWindows(now: number): void {
  if (now < nextThrottleFlushAt && nextThrottleFlushAt - now <= LOG_THROTTLE_WINDOW_MS) return;
  nextThrottleFlushAt = now + LOG_THROTTLE_WINDOW_MS;
  for (const site of throttledSites.values()) {
    for (const [kind, key] of site.keys) rollThrottleWindow(site, kind, key, now);
  }
}

/**
 * Makes room by dropping the key that has gone longest without failing, most
 * likely a loop that stopped without ever succeeding. It says so, because its
 * count and its recovered line go with it. If it fails again it is a first
 * occurrence, so the limit can cost extra lines but never hides a failure.
 */
function evictOldestThrottleKey(): void {
  let oldest: { siteKey: string; site: ThrottledSite; kind: string; key: ThrottledKey } | undefined;
  for (const [siteKey, site] of throttledSites) {
    for (const [kind, key] of site.keys) {
      if (!oldest || key.recency < oldest.key.recency) oldest = { siteKey, site, kind, key };
    }
  }
  if (!oldest) return;
  const { siteKey, site, kind, key } = oldest;
  writeThrottleLine(site, "throttle.evicted", { kind, suppressed: key.pending });
  site.keys.delete(kind);
  throttledKeyCount -= 1;
  if (site.keys.size === 0) throttledSites.delete(siteKey);
}

function throttleSiteKey(area: string, event: string, scope: string | undefined): string {
  return `${area}\0${event}\0${scope ?? ""}`;
}

/** Counts one failure. Returns true when it is a first occurrence, to write in full. */
function noteThrottledFailure(
  area: string,
  level: LogLevel,
  event: string,
  scope: string | undefined,
  kind: string,
): boolean {
  const now = Date.now();
  flushDueThrottleWindows(now);
  const siteKey = throttleSiteKey(area, event, scope);
  let site = throttledSites.get(siteKey);
  let known = site?.keys.get(kind);
  if (known && now - known.lastFailureAt >= LOG_THROTTLE_IDLE_MS) {
    site!.keys.delete(kind);
    throttledKeyCount -= 1;
    if (site!.keys.size === 0) {
      throttledSites.delete(siteKey);
      site = undefined;
    }
    known = undefined;
  }
  if (!known && throttledKeyCount >= LOG_THROTTLE_MAX_KEYS) {
    evictOldestThrottleKey();
    site = throttledSites.get(siteKey);
  }
  site ??= { area, event, scope, level, since: now, failures: 0, keys: new Map() };
  site.level = level;
  site.failures += 1;
  throttledSites.delete(siteKey);
  throttledSites.set(siteKey, site);
  if (known) {
    rollThrottleWindow(site, kind, known, now);
    known.pending += 1;
    known.lastFailureAt = now;
    known.recency = ++throttleRecency;
    site.keys.delete(kind);
    site.keys.set(kind, known);
    return false;
  }
  site.keys.set(kind, {
    pending: 0,
    windowStart: now,
    lastFailureAt: now,
    recency: ++throttleRecency,
  });
  throttledKeyCount += 1;
  return true;
}

function noteThrottledSuccess(area: string, event: string, scope: string | undefined): void {
  const now = Date.now();
  flushDueThrottleWindows(now);
  const siteKey = throttleSiteKey(area, event, scope);
  const site = throttledSites.get(siteKey);
  if (!site) return;
  throttledSites.delete(siteKey);
  throttledKeyCount -= site.keys.size;
  let suppressed = 0;
  for (const key of site.keys.values()) suppressed += key.pending;
  writeThrottleLine(site, "throttle.recovered", {
    failures: site.failures,
    kinds: site.keys.size,
    suppressed,
    faultSeconds: Math.max(0, Math.round((now - site.since) / 1000)),
  });
}

function throttleKind(options: ThrottledLogOptions): string {
  if (options.kind === undefined) return logErrorKind(options.error);
  return THROTTLE_KIND_PATTERN.test(options.kind) ? options.kind : "invalid-kind";
}

function resolveFields(
  fields: LogFieldsInput | undefined,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return typeof fields === "function" ? fields() : fields;
  } catch {
    return { fieldsFailed: true };
  }
}

export function createLogger<Area extends LogArea>(area: Area): Logger<LogEventOf<Area>> {
  const spec = areaSpec(area);
  let seenGeneration = -1;
  let rank = 0;
  const enabled = (level: LogLevel): boolean => {
    if (seenGeneration !== generation) {
      seenGeneration = generation;
      rank = thresholdRank(area);
    }
    return LEVEL_RANK[level] <= rank;
  };
  const writeResolved = (
    level: LogLevel,
    event: string,
    resolved: Readonly<Record<string, unknown>> | undefined,
  ): void => {
    if (!spec) {
      deliver(buildRecord(level, "logging", "unknown-area", undefined));
    } else if (Object.hasOwn(spec.events, event)) {
      deliver(buildRecord(level, area, event, resolved));
    } else {
      // The unlisted name itself may be dynamic, so it never reaches the log.
      deliver(buildRecord(level, area, "invalid-event", undefined));
    }
  };
  const write = (level: LogLevel, event: string, fields?: LogFieldsInput): void => {
    if (!enabled(level)) return;
    writeResolved(level, event, resolveFields(fields));
  };
  return {
    error: (event, fields) => write("error", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    info: (event, fields) => write("info", event, fields),
    debug: (event, fields) => write("debug", event, fields),
    trace: (event, fields) => write("trace", event, fields),
    throttled: (level, event, options) => {
      syncThrottleLevels();
      // While the level is off a call counts nothing and builds nothing.
      if (!enabled(level)) return;
      if (
        !spec ||
        !Object.hasOwn(spec.events, event) ||
        event.startsWith("throttle.") ||
        !Object.hasOwn(spec.events, "throttle.recovered")
      ) {
        deliver(
          buildRecord(
            level,
            spec ? area : "logging",
            spec ? "invalid-event" : "unknown-area",
            undefined,
          ),
        );
        return;
      }
      const kind = throttleKind(options);
      const scope = options.scope?.slice(0, MAX_THROTTLE_SCOPE_CHARS);
      if (!noteThrottledFailure(area, level, event, scope, kind)) return;
      writeResolved(level, event, {
        ...(scope === undefined ? {} : { scope }),
        kind,
        ...resolveFields(options.fields),
      });
    },
    recovered: (event, scope) => {
      syncThrottleLevels();
      if (throttledKeyCount === 0) return;
      noteThrottledSuccess(area, event, scope?.slice(0, MAX_THROTTLE_SCOPE_CHARS));
    },
    isEnabled: enabled,
  };
}

/** One entry's output line, for the writer that must not go through the console. */
export function renderLogLine<Area extends LogArea>(
  level: LogLevel,
  area: Area,
  event: LogEventOf<Area>,
  fields?: LogFields,
): string {
  const record = buildRecord(level, area, event, fields);
  return config.format === "json" ? renderJson(record) : renderText(record);
}

/**
 * Reads one line a logger in another process wrote. Returns null for anything
 * else, including a record naming an area or event this build does not list, so
 * the caller keeps it as ordinary output and nothing is lost. Fields get the
 * same validation as a local call, because any output can imitate a record.
 */
export function parseLogRecordLine(line: string): LogRecord | null {
  if (!line.startsWith(LOG_RECORD_PREFIX)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { ts, level, area, event, fields } = parsed;
  if (typeof ts !== "string" || ts.length > 64 || !isLogLevel(level)) return null;
  if (typeof area !== "string" || typeof event !== "string") return null;
  const spec = areaSpec(area);
  if (!spec || (event !== "invalid-event" && !Object.hasOwn(spec.events, event))) return null;
  const clean =
    typeof fields === "object" && fields !== null && !Array.isArray(fields)
      ? sanitizeFields(
          reviveWireErrors(fields as Record<string, unknown>),
          spec.maxStringChars ?? MAX_FIELD_CHARS,
        )
      : undefined;
  return { orklog: 1, ts, level, area, event, ...(clean ? { fields: clean } : {}) };
}

function reviveWireErrors(fields: Record<string, unknown>): Record<string, unknown> {
  const revived: Record<string, unknown> = {};
  for (const name of Object.keys(fields)) {
    const value = fields[name];
    revived[name] = typeof value === "object" ? (logErrorFromWire(value) ?? value) : value;
  }
  return revived;
}

/**
 * Writes a record another process produced, at the level it carries. The source
 * has already applied its threshold, so this never filters: a relay must not
 * lose what the source chose to emit.
 */
export function emitLogRecord(record: LogRecord): void {
  deliver(record);
}

/**
 * Captures a line of process output no logger produced: a child's stdout or
 * stderr, a native crash, a runtime panic. It bypasses levels, because such text
 * has none, and is the only way raw text enters the log. Only stdio relays may
 * call it.
 */
export function writeProcessOutputLine(stream: "stdout" | "stderr", line: string): void {
  try {
    config.sink({ method: stream === "stdout" ? "log" : "error", line });
  } catch {
    // Logging never owns the operation being logged.
  }
}
