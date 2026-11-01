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

/** Keeps each file's literal area and event names for `createLogger`'s types. */
export function defineLogAreas<const Areas extends Readonly<Record<string, LogAreaSpec>>>(
  areas: Areas,
): Areas {
  return areas;
}
