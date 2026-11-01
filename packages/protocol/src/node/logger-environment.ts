import { LOG_VOCABULARY } from "../log-vocabulary/index.js";
import {
  configureLogger,
  createLogger,
  isLogLevel,
  type LogFormat,
  type LogLevel,
} from "../logger.js";

/** `info`, or a default plus areas: `warn,updater=debug,bridge=trace`. */
export const LOG_LEVEL_ENV = "ORKESTRATOR_LOG_LEVEL";
/** `text` (the default) or `json` for JSON lines. */
export const LOG_FORMAT_ENV = "ORKESTRATOR_LOG_FORMAT";

export interface ParsedLogLevels {
  level?: LogLevel;
  areaLevels: Record<string, LogLevel>;
  invalid: string[];
}

export function parseLogLevels(value: string | undefined): ParsedLogLevels {
  const parsed: ParsedLogLevels = { areaLevels: {}, invalid: [] };
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      if (isLogLevel(trimmed)) parsed.level = trimmed;
      else parsed.invalid.push(trimmed);
      continue;
    }
    const area = trimmed.slice(0, separator);
    const level = trimmed.slice(separator + 1);
    // A parent of a listed area counts: `bridge` covers `bridge.claude`.
    if (isLogLevel(level) && isKnownScope(area)) parsed.areaLevels[area] = level;
    else parsed.invalid.push(trimmed);
  }
  return parsed;
}

function isKnownScope(scope: string): boolean {
  return Object.keys(LOG_VOCABULARY).some((area) => area === scope || area.startsWith(`${scope}.`));
}

/**
 * Applies the startup logging settings. Call once from a process entrypoint,
 * before anything logs.
 *
 * `relayToSupervisor` makes the output JSON lines whatever the user chose: the
 * process that reads this one's stdio parses them, re-emits each at its own
 * level and renders them in its own format. A backend sets it only when the
 * desktop supervises it (docs/architecture/logging.md, "The Electron relay").
 */
export function configureLoggerFromEnvironment(
  env: NodeJS.ProcessEnv,
  options: { relayToSupervisor?: boolean } = {},
): void {
  const levels = parseLogLevels(env[LOG_LEVEL_ENV]);
  const requestedFormat = env[LOG_FORMAT_ENV];
  const format: LogFormat =
    options.relayToSupervisor || requestedFormat === "json" ? "json" : "text";
  configureLogger({
    ...(levels.level ? { level: levels.level } : {}),
    areaLevels: levels.areaLevels,
    format,
  });
  const log = createLogger("logging");
  if (levels.invalid.length > 0) {
    log.warn("config.invalid", { variable: LOG_LEVEL_ENV, entries: levels.invalid.length });
  }
  if (requestedFormat && requestedFormat !== "json" && requestedFormat !== "text") {
    log.warn("config.invalid", { variable: LOG_FORMAT_ENV, entries: 1 });
  }
}
