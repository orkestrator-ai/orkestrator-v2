import { LOG_VOCABULARY, type LogAreaSpec } from "./log-vocabulary/index.js";
import { isLogLevel, type LogLevel } from "./logger.js";

/**
 * The "Log detail" setting: which levels each process writes. Browser-safe, so
 * the settings screen and the backend read one definition. Saving to disk is a
 * separate setting (`debugLogging`, `debugLogRetentionDays`); see
 * docs/architecture/logging.md, "Live settings".
 */
export interface LogDetail {
  /** Applies to every area without its own entry in `areaLevels`. */
  level: LogLevel;
  /** By area; `desktop` also covers `desktop.dialog` unless that has its own. */
  areaLevels: Record<string, LogLevel>;
}

/** What a global config holds, for code that sees it before it is normalized. */
export interface LogDetailSource {
  debugLogging?: unknown;
  logDetail?: unknown;
}

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Every bridge area sits under this scope. */
export const BRIDGE_LOG_SCOPE = "bridge";
/** The metadata snapshots of bridge-diagnostics.md, under `BRIDGE_LOG_SCOPE`. */
export const BRIDGE_DIAGNOSTICS_LOG_AREA = "bridge.diagnostics";

// A config is user-editable and the policy crosses a bridge route, so both are
// bounded. The vocabulary is not the check: a bridge in an older container and
// a newer backend list different areas, and an unknown name matches no logger.
const MAX_LOG_DETAIL_AREAS = 256;
const MAX_LOG_AREA_NAME_CHARS = 64;
const LOG_AREA_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function defaultLogDetail(): LogDetail {
  return { level: DEFAULT_LOG_LEVEL, areaLevels: {} };
}

/**
 * What `debugLogging: true` already meant for level and detail before the two
 * settings split: nothing changed for the logger, and bridges wrote their
 * snapshots. Upgrades initially retain that detail; raised bridge detail expires
 * after 24 hours unless Keep raised detail on is enabled.
 */
export function legacyDebugLogDetail(): LogDetail {
  return { level: DEFAULT_LOG_LEVEL, areaLevels: { [BRIDGE_LOG_SCOPE]: "debug" } };
}

/** Null for anything but a valid setting. Sorted, so equal settings compare equal. */
export function parseLogDetail(value: unknown): LogDetail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { level, areaLevels } = value as { level?: unknown; areaLevels?: unknown };
  if (!isLogLevel(level)) return null;
  if (areaLevels === undefined) return { level, areaLevels: {} };
  if (typeof areaLevels !== "object" || areaLevels === null || Array.isArray(areaLevels)) {
    return null;
  }
  const names = Object.keys(areaLevels).sort();
  if (names.length > MAX_LOG_DETAIL_AREAS) return null;
  const clean: Record<string, LogLevel> = {};
  for (const name of names) {
    const areaLevel = (areaLevels as Record<string, unknown>)[name];
    if (name.length > MAX_LOG_AREA_NAME_CHARS || !LOG_AREA_NAME.test(name)) return null;
    if (!isLogLevel(areaLevel)) return null;
    clean[name] = areaLevel;
  }
  return { level, areaLevels: clean };
}

/**
 * The setting in force. A stored value wins; a config from before the split
 * (or a hand-edited one that does not parse) takes the upgrade mapping, so no
 * reader ever sees `debugLogging` on without bridge detail.
 */
export function resolveLogDetail(source: LogDetailSource): LogDetail {
  const stored = source.logDetail === undefined ? null : parseLogDetail(source.logDetail);
  if (stored) return stored;
  return source.debugLogging === true ? legacyDebugLogDetail() : defaultLogDetail();
}

const LEVEL_DETAIL: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** The level in force for one area: its own, the nearest parent's, or the default. */
export function effectiveLogLevel(detail: LogDetail, area: string): LogLevel {
  for (let scope = area; ; scope = scope.slice(0, scope.lastIndexOf("."))) {
    const level = Object.hasOwn(detail.areaLevels, scope) ? detail.areaLevels[scope] : undefined;
    if (level) return level;
    if (!scope.includes(".")) return detail.level;
  }
}

/** Whether any level in this setting is above `info`, the only detail that expires. */
export function logDetailIsRaised(detail: LogDetail): boolean {
  if (LEVEL_DETAIL[detail.level] > LEVEL_DETAIL.info) return true;
  return Object.values(detail.areaLevels).some((level) => LEVEL_DETAIL[level] > LEVEL_DETAIL.info);
}

/**
 * The setting with every raised level back at `info`: the default comes down to
 * `info` and a raised area loses its entry. A lowered one (`updater=warn`) stays,
 * because quieting an area is not what expiry exists to undo.
 */
export function revertRaisedLogDetail(detail: LogDetail): LogDetail {
  const areaLevels: Record<string, LogLevel> = {};
  for (const area of Object.keys(detail.areaLevels).sort()) {
    const level = detail.areaLevels[area]!;
    if (LEVEL_DETAIL[level] <= LEVEL_DETAIL.info) areaLevels[area] = level;
  }
  const level = LEVEL_DETAIL[detail.level] > LEVEL_DETAIL.info ? DEFAULT_LOG_LEVEL : detail.level;
  return { level, areaLevels };
}

/** Whether two settings write the same levels. */
export function sameLogDetail(left: LogDetail, right: LogDetail): boolean {
  return left.level === right.level && formatLogAreaLevels(left) === formatLogAreaLevels(right);
}

/**
 * How long raised detail stays before the backend reverts it. Saving to disk is
 * a separate setting, so a revert never touches it.
 */
export const LOG_DETAIL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** What a global config holds for expiry, before it is normalized. */
export interface LogDetailExpirySource extends LogDetailSource {
  /** Backend-owned: when raised detail reverts. ISO 8601; absent when nothing expires. */
  logDetailExpiresAt?: unknown;
  /** The user's choice to keep raised detail for a long investigation. */
  logDetailKeepRaised?: unknown;
}

const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Milliseconds since the epoch, or null for anything but a stored expiry. */
export function parseLogDetailExpiresAt(value: unknown): number | null {
  if (typeof value !== "string" || !EXPIRY_PATTERN.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function expires(source: LogDetailExpirySource, detail: LogDetail): boolean {
  return logDetailIsRaised(detail) && source.logDetailKeepRaised !== true;
}

/**
 * The expiry a config write stores, or undefined for none. Raised detail keeps
 * the expiry it already had while the levels stay the same; a change of levels
 * (or turning "keep" off) starts a fresh 24 hours. Every writer gets this,
 * including a client that predates the setting, so none can raise detail for good
 * by accident.
 */
export function nextLogDetailExpiresAt(
  next: LogDetailExpirySource,
  stored: LogDetailExpirySource | null,
  nowMs: number,
): string | undefined {
  const detail = resolveLogDetail(next);
  if (!expires(next, detail)) return undefined;
  const storedExpiry = stored ? parseLogDetailExpiresAt(stored.logDetailExpiresAt) : null;
  if (
    stored &&
    storedExpiry !== null &&
    stored.logDetailKeepRaised !== true &&
    sameLogDetail(resolveLogDetail(stored), detail)
  ) {
    return stored.logDetailExpiresAt as string;
  }
  return new Date(nowMs + LOG_DETAIL_EXPIRY_MS).toISOString();
}

/** What the backend's expiry check does to a stored config at `nowMs`. */
export type LogDetailExpiryAction =
  | { kind: "none" }
  /** Raised detail with no expiry (written by hand or by an older backend): give it one. */
  | { kind: "stamp"; expiresAt: string }
  /** An expiry is stored but nothing is raised, or the user keeps it raised. */
  | { kind: "clear" }
  /** Due: raised levels go back to `info`, and the expiry goes. */
  | { kind: "revert"; detail: LogDetail };

export function logDetailExpiryAction(
  source: LogDetailExpirySource,
  nowMs: number,
): LogDetailExpiryAction {
  const detail = resolveLogDetail(source);
  if (!expires(source, detail)) {
    return source.logDetailExpiresAt === undefined ? { kind: "none" } : { kind: "clear" };
  }
  const expiry = parseLogDetailExpiresAt(source.logDetailExpiresAt);
  if (expiry === null) {
    return { kind: "stamp", expiresAt: new Date(nowMs + LOG_DETAIL_EXPIRY_MS).toISOString() };
  }
  if (expiry <= nowMs) return { kind: "revert", detail: revertRaisedLogDetail(detail) };
  return { kind: "none" };
}

/** Whether bridges keep writing their diagnostic snapshots under this setting. */
export function logDetailEnablesBridgeDiagnostics(detail: LogDetail): boolean {
  return LEVEL_DETAIL[effectiveLogLevel(detail, BRIDGE_DIAGNOSTICS_LOG_AREA)] >= LEVEL_DETAIL.debug;
}

/** `ORKESTRATOR_BRIDGE_DEBUG` for a bridge starting now: its startup default. */
export function bridgeDebugEnvValue(source: LogDetailSource): "1" | "0" {
  return logDetailEnablesBridgeDiagnostics(resolveLogDetail(source)) ? "1" : "0";
}

/** The audit line's text form: `bridge=debug,updater=trace`. Names and levels only. */
export function formatLogAreaLevels(detail: LogDetail): string {
  return Object.keys(detail.areaLevels)
    .sort()
    .map((area) => `${area}=${detail.areaLevels[area]}`)
    .join(",");
}

export interface LogDetailArea {
  area: string;
  description: string;
}

// Listed even while no call site uses them: the bridges' `console.*` lines move
// onto these areas separately, and the snapshots already follow this setting.
const BRIDGE_DETAIL_AREAS: readonly LogDetailArea[] = [
  {
    area: BRIDGE_LOG_SCOPE,
    description: "Every agent bridge, including its diagnostic snapshots.",
  },
  {
    area: BRIDGE_DIAGNOSTICS_LOG_AREA,
    description:
      "Metadata snapshots of agent turns and bridge processes. Info writes lifecycle, stalls and a ten-minute keepalive; Debug adds one every minute, including for turns already running; Trace also writes each change as it happens.",
  },
];

/** The areas the settings screen offers an override for. */
export function logDetailAreas(): LogDetailArea[] {
  const areas = new Map(BRIDGE_DETAIL_AREAS.map((entry) => [entry.area, entry]));
  const vocabulary = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;
  for (const area of Object.keys(vocabulary).sort()) {
    // Renderer-only levels come from orkestrator:debug at startup, not live policy.
    // The shared terminal area also has backend sites, which do follow live policy.
    if (area.startsWith("web.") || area.startsWith("terminal.")) continue;
    if (!areas.has(area)) areas.set(area, { area, description: vocabulary[area]!.description });
  }
  return Array.from(areas.values());
}

/** The body of a bridge's `POST /debug/log-policy`. */
export interface BridgeLogPolicy extends LogDetail {
  /** Rises with each policy, so a delayed older request cannot undo a newer one. */
  seq: number;
}

export const BRIDGE_LOG_POLICY_ROUTE = "/debug/log-policy";

export function parseBridgeLogPolicy(value: unknown): BridgeLogPolicy | null {
  const detail = parseLogDetail(value);
  if (!detail) return null;
  const { seq } = value as { seq?: unknown };
  return Number.isSafeInteger(seq) && (seq as number) >= 0
    ? { ...detail, seq: seq as number }
    : null;
}
