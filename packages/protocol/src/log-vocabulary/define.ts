/** One logging area: what it covers, and the only events it may report. */
export interface LogAreaSpec {
  /** One sentence for reviewers and, later, the settings screen. */
  readonly description: string;
  /**
   * Replaces the area in the plain-text `[tag]`. Only for a tag that support
   * recipes already search for; a new area never needs one.
   */
  readonly tag?: string;
  /** Static event name to one sentence saying when it is written. */
  readonly events: Readonly<Record<string, string>>;
}

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
