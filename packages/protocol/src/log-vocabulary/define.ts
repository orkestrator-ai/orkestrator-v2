/** One logging area: what it covers, and the only events it may report. */
export interface LogAreaSpec {
  /** One sentence for reviewers and, later, the settings screen. */
  readonly description: string;
  /**
   * Replaces the area in the plain-text `[tag]`. Only for a tag that support
   * recipes already search for; a new area never needs one.
   */
  readonly tag?: string;
  /**
   * Replaces the 2 KiB bound on one string field. Only for an area whose single
   * field is already bounded and allowlisted at its source, as a bridge
   * diagnostic snapshot is; the vocabulary test pins who has one.
   */
  readonly maxStringChars?: number;
  /** Static event name to one sentence saying when it is written, or its essential definition. */
  readonly events: Readonly<Record<string, LogEventSpec>>;
}

/**
 * What a field of an essential event may hold. `label` is one short word from a
 * fixed set or an identifier, never free text; `log-essential.ts` drops a value
 * that does not fit, and there is deliberately no kind for an object or text.
 */
export type EssentialFieldKind = "number" | "boolean" | "label";

/**
 * An event kept in the always-on essential log, whatever "Save Logs to Disk" and
 * the levels say (docs/architecture/logging.md, "The essential event log"). Only
 * the fields declared here reach that file, so reviewing this list is reviewing
 * what the app keeps by default.
 */
export interface EssentialLogEvent {
  /** One sentence saying when it is written. */
  readonly description: string;
  readonly essential: true;
  /** Only an entry at `error` counts, for an event whose `warn` is routine. */
  readonly minLevel?: "error";
  readonly fields: Readonly<Record<string, EssentialFieldKind>>;
}

export type LogEventSpec = string | EssentialLogEvent;

/**
 * What an essential entry may keep of a `formatLogError` field called `error`:
 * its identity, with no message, stack or cause.
 */
export const ESSENTIAL_ERROR_FIELDS = {
  "error.name": "label",
  "error.code": "label",
  "error.errno": "number",
  "error.syscall": "label",
  "error.exitCode": "number",
  "error.signal": "label",
  "error.outputOmitted": "boolean",
  "error.errorCount": "number",
} as const satisfies Readonly<Record<string, EssentialFieldKind>>;

/**
 * The lines `log.throttled` adds. An area that throttles spreads these into its
 * events, and the types refuse `throttled` on an area that has not. They carry
 * the throttled event's name in a `site` field, not in the event, so one short
 * list serves every site.
 */
export const THROTTLE_LOG_EVENTS = {
  "throttle.suppressed": "Repeats of the throttled `site` were counted over a window, not written.",
  "throttle.recovered": "The throttled `site` succeeded again, so its fault has cleared.",
  "throttle.evicted":
    "The tracked-key limit dropped the `site`, so no recovered line follows unless it fails again.",
} as const;

export type ThrottleLogEvent = keyof typeof THROTTLE_LOG_EVENTS;

/** Keeps each file's literal area and event names for `createLogger`'s types. */
export function defineLogAreas<const Areas extends Readonly<Record<string, LogAreaSpec>>>(
  areas: Areas,
): Areas {
  return areas;
}
