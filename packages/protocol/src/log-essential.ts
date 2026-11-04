import { isEssentialLabel } from "./log-essential-labels.js";
import type { LogErrorDetails } from "./log-error.js";
import {
  LOG_VOCABULARY,
  type EssentialFieldKind,
  type EssentialLogEvent,
  type LogAreaSpec,
} from "./log-vocabulary/index.js";
import type { LogLevel, LogRecord, LogWireValue } from "./logger.js";

/**
 * Decides what the always-on essential log may hold; `node/essential-log.ts`
 * writes it. Browser-safe and dependency-free apart from the vocabulary.
 *
 * Nobody chose to save this, so nothing reaches it because a call site passed it:
 * an essential event keeps only the fields its definition declares, and any other
 * `error` keeps numbers, booleans and a short list of fixed labels. An error
 * keeps its identity. Its message, stack and cause never do.
 */

const vocabulary = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * String fields an `error` nobody declared may keep. Each holds a static name at
 * every site that sets it: the throttled event, an error code or type, a part of
 * startup or shutdown, a classified reason, a signal.
 */
const UNDECLARED_ERROR_LABELS: ReadonlySet<string> = new Set([
  "site",
  "kind",
  "step",
  "reason",
  "signal",
  "code",
]);

// Fixed names only: scalar values do not make an arbitrary key content-free.
const UNDECLARED_ERROR_SCALARS: Readonly<Record<string, EssentialFieldKind>> = {
  attempts: "number",
  retried: "boolean",
  exitCode: "number",
  errno: "number",
  suppressed: "number",
  windowSeconds: "number",
  droppedFields: "number",
};

const ERROR_IDENTITY_KINDS: Readonly<Partial<Record<keyof LogErrorDetails, EssentialFieldKind>>> = {
  name: "label",
  code: "label",
  errno: "number",
  syscall: "label",
  exitCode: "number",
  signal: "label",
  outputOmitted: "boolean",
  errorCount: "number",
};

function eventSpec(area: string, event: string): EssentialLogEvent | null {
  const spec = Object.hasOwn(vocabulary, area) ? vocabulary[area] : undefined;
  if (!spec || !Object.hasOwn(spec.events, event)) return null;
  const definition = spec.events[event]!;
  return typeof definition === "object" && definition.essential ? definition : null;
}

function declaredEssential(area: string, event: string, level: LogLevel): EssentialLogEvent | null {
  const spec = eventSpec(area, event);
  return spec && (spec.minLevel !== "error" || level === "error") ? spec : null;
}

/** Whether an area lists any essential event, so a logger can skip the lookup for good. */
export function hasEssentialEvents(area: string): boolean {
  const spec = Object.hasOwn(vocabulary, area) ? vocabulary[area] : undefined;
  return (
    spec !== undefined &&
    Object.values(spec.events).some((event) => typeof event === "object" && event.essential)
  );
}

/** Whether this entry belongs in the essential log: every `error` and each flagged event. */
export function isEssentialEntry(area: string, event: string, level: LogLevel): boolean {
  if (area === "logging" && event === "essential.write-failed") return false;
  return level === "error" || declaredEssential(area, event, level) !== null;
}

function fits(
  kind: EssentialFieldKind,
  value: LogWireValue,
  area: string,
  event: string,
  field: string,
): boolean {
  if (value === null) return true;
  switch (kind) {
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "label":
      return (
        typeof value === "number" ||
        (typeof value === "string" && isEssentialLabel(area, event, field, value))
      );
  }
}

/**
 * The entry as the essential log may hold it, or null if it does not belong
 * there. Field by field it builds a new record, so anything added to a record
 * later stays out until someone lists it here.
 */
export function projectEssentialRecord(record: LogRecord, fallbackTs: string): LogRecord | null {
  if (!isEssentialEntry(record.area, record.event, record.level)) return null;
  const declared = declaredEssential(record.area, record.event, record.level);
  const kept: Record<string, LogWireValue> = {};
  let unfit = 0;

  const admit = (name: string, kind: EssentialFieldKind | undefined, value: LogWireValue) => {
    if (kind && fits(kind, value, record.area, record.event, name)) kept[name] = value;
    else unfit += 1;
  };
  const admitScalar = (name: string, value: string | number | boolean | null) => {
    // The hop that relayed a bridge's entry sets `source` itself: `kind:environment`.
    if (name === "source") admit(name, "label", value);
    else if (declared) {
      if (Object.hasOwn(declared.fields, name)) admit(name, declared.fields[name], value);
    } else if (typeof value === "string") {
      admit(name, UNDECLARED_ERROR_LABELS.has(name) ? "label" : undefined, value);
    } else {
      admit(
        name,
        Object.hasOwn(UNDECLARED_ERROR_SCALARS, name)
          ? UNDECLARED_ERROR_SCALARS[name]
          : UNDECLARED_ERROR_LABELS.has(name)
            ? "label"
            : undefined,
        value,
      );
    }
  };

  for (const [name, value] of Object.entries(record.fields ?? {})) {
    if (typeof value !== "object" || value === null) {
      admitScalar(name, value);
      continue;
    }
    if (!declared && name !== "error") {
      unfit += 1;
      continue;
    }
    for (const key of Object.keys(ERROR_IDENTITY_KINDS) as Array<keyof LogErrorDetails>) {
      const part = value[key];
      if (part === undefined) continue;
      const leaf = `${name}.${key}`;
      if (declared && !Object.hasOwn(declared.fields, leaf)) continue;
      admit(leaf, ERROR_IDENTITY_KINDS[key], part as string | number | boolean);
    }
  }
  if (unfit > 0) kept.droppedFields = unfit;

  return {
    orklog: 1,
    // A relayed timestamp is whatever the line said, so it has to look like one.
    ts: TIMESTAMP_PATTERN.test(record.ts) ? record.ts : fallbackTs,
    level: record.level,
    area: record.area,
    event: record.event,
    ...(Object.keys(kept).length > 0 ? { fields: kept } : {}),
  };
}
