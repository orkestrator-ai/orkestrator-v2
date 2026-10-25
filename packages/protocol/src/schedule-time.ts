/**
 * Wall-clock and cron maths for scheduled jobs. Dependency-free: time zones
 * come from `Intl`, so the same code runs in the backend, the CLI and the
 * renderer (which previews the next fire times while a form is edited).
 *
 * DST rules, chosen to match `Temporal`'s default ("compatible")
 * disambiguation so they are predictable and documented elsewhere:
 *
 * - A wall time that does not exist (the spring-forward gap, e.g. 01:30 in
 *   London on the last Sunday of March) fires at the same wall time shifted
 *   forward by the gap: 02:30 BST.
 * - A wall time that happens twice (the autumn fall-back hour) fires once, at
 *   its first occurrence, when the expression names fixed hours (`30 1 * * *`).
 *   An expression whose hour field is `*` follows real time instead and fires
 *   in both copies of the repeated hour, so `*\/15 * * * *` keeps a 15 minute
 *   rhythm through the change.
 *
 * Interval schedules are elapsed time and ignore the time zone entirely.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** How far ahead a cron search looks before deciding an expression never fires. */
const CRON_SEARCH_DAYS = 366 * 5;

export class ScheduleTimeError extends Error {}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The host's local IANA zone, `UTC` when the runtime cannot name one. */
export function hostTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export interface WallTime {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  /** 0–23 */
  hour: number;
  /** 0–59 */
  minute: number;
  second?: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall time of `instantMs` in `timeZone` (seconds included, weekday 0 = Sunday). */
export function wallTimeAt(
  instantMs: number,
  timeZone: string,
): Required<WallTime> & { weekday: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")) % 24,
    minute: Number(read("minute")),
    second: Number(read("second")),
    weekday: WEEKDAYS[read("weekday")] ?? 0,
  };
}

/** UTC offset of `timeZone` at `instantMs`, in milliseconds (BST = +3 600 000). */
export function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallTimeAt(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function wallMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
}

function sameWall(instantMs: number, timeZone: string, target: number): boolean {
  return wallMs(wallTimeAt(instantMs, timeZone)) === target;
}

/**
 * Every instant whose wall time in `timeZone` is `wall`: one normally, none in
 * a spring-forward gap, two in a repeated fall-back hour (earliest first).
 * Assumes at most one offset change within twelve hours of the wall time,
 * which holds for every real zone.
 */
export function instantsForWallTime(wall: WallTime, timeZone: string): number[] {
  const target = wallMs(wall);
  const before = timeZoneOffsetMs(target - DAY_MS / 2, timeZone);
  const after = timeZoneOffsetMs(target + DAY_MS / 2, timeZone);
  const found = new Set<number>();
  for (const offset of [before, after]) {
    const candidate = target - offset;
    if (sameWall(candidate, timeZone, target)) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The instant a wall time names, with `compatible` disambiguation: the
 * earlier copy of a repeated time; a skipped time shifted forward by the gap.
 */
export function resolveWallTime(wall: WallTime, timeZone: string): number {
  const instants = instantsForWallTime(wall, timeZone);
  if (instants.length > 0) return instants[0]!;
  const target = wallMs(wall);
  // In a gap the offset before the change is the smaller one; subtracting it
  // lands after the change, at the wall time shifted forward by the gap.
  return target - timeZoneOffsetMs(target - DAY_MS / 2, timeZone);
}

// ---------------------------------------------------------------------------
// Cron

export interface CronExpression {
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** `*` (or `?`) in the day-of-month field. */
  anyDay: boolean;
  /** `*` (or `?`) in the day-of-week field. */
  anyWeekday: boolean;
  /** `*` in the hour field: the expression follows real time through DST. */
  anyHour: boolean;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function parseFieldValue(
  raw: string,
  field: string,
  min: number,
  max: number,
  names?: string[],
): number {
  const lower = raw.toLowerCase();
  const named = names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + min;
  if (!/^\d{1,2}$/.test(raw)) throw new ScheduleTimeError(`Invalid ${field} value "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ScheduleTimeError(`${field} value ${value} is outside ${min}-${max}`);
  }
  return value;
}

function parseField(
  raw: string,
  field: string,
  min: number,
  max: number,
  names?: string[],
): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of raw.split(",")) {
    if (!part) throw new ScheduleTimeError(`Empty entry in the ${field} field`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new ScheduleTimeError(`Invalid step in "${part}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) {
        throw new ScheduleTimeError(`Invalid step in "${part}"`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (range === "*" || range === "?") {
      start = min;
      end = max;
      if (stepText === undefined) any = true;
    } else if (range!.includes("-")) {
      const [from, to, more] = range!.split("-");
      if (more !== undefined || !from || !to) {
        throw new ScheduleTimeError(`Invalid range "${range}"`);
      }
      start = parseFieldValue(from, field, min, max, names);
      end = parseFieldValue(to, field, min, max, names);
      if (end < start) throw new ScheduleTimeError(`Range "${range}" runs backwards`);
    } else {
      start = parseFieldValue(range!, field, min, max, names);
      end = stepText === undefined ? start : max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, any };
}

/**
 * Parses a five-field cron expression (`minute hour day-of-month month
 * day-of-week`), with lists, ranges, steps, month and weekday names, `7` as
 * Sunday and the `@daily`-style macros. Day-of-month and day-of-week combine
 * the classic way: when both are restricted a day matching either fires.
 */
export function parseCronExpression(source: string): CronExpression {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 200) throw new ScheduleTimeError("Cron expression is empty");
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleTimeError(
      "Cron expressions have five fields: minute hour day-of-month month day-of-week",
    );
  }
  const minutes = parseField(fields[0]!, "minute", 0, 59);
  const hours = parseField(fields[1]!, "hour", 0, 23);
  const days = parseField(fields[2]!, "day-of-month", 1, 31);
  const months = parseField(fields[3]!, "month", 1, 12, MONTH_NAMES);
  const weekdayField = parseField(fields[4]!, "day-of-week", 0, 7, [...DAY_NAMES, "sun"]);
  const weekdays = new Set([...weekdayField.values].map((day) => day % 7));
  return {
    source: trimmed,
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    months: months.values,
    weekdays,
    anyDay: days.any,
    anyWeekday: weekdayField.any,
    anyHour: hours.any,
  };
}

function dayMatches(cron: CronExpression, year: number, month: number, day: number): boolean {
  if (!cron.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayOk = cron.days.has(day);
  const weekdayOk = cron.weekdays.has(weekday);
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return weekdayOk;
  if (cron.anyWeekday) return dayOk;
  return dayOk || weekdayOk;
}

function sortedValues(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Fire instants of one local calendar day, ascending and de-duplicated. */
function cronInstantsOnDay(
  cron: CronExpression,
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number[] {
  const hours = sortedValues(cron.hours);
  const minutes = sortedValues(cron.minutes);
  const midnight = Date.UTC(year, month - 1, day);
  const offsetStart = timeZoneOffsetMs(midnight - DAY_MS / 2, timeZone);
  const offsetEnd = timeZoneOffsetMs(midnight + DAY_MS + DAY_MS / 2, timeZone);
  const result: number[] = [];
  if (
    offsetStart === offsetEnd &&
    timeZoneOffsetMs(midnight + DAY_MS / 2, timeZone) === offsetStart
  ) {
    // No offset change near this day: plain arithmetic.
    for (const hour of hours) {
      for (const minute of minutes) {
        result.push(midnight + hour * 3_600_000 + minute * MINUTE_MS - offsetStart);
      }
    }
    return result;
  }
  // One offset change near this day: find it once, then classify each wall
  // time arithmetically instead of asking Intl about every minute.
  let low = midnight - DAY_MS / 2;
  let high = midnight + DAY_MS + DAY_MS / 2;
  while (high - low > MINUTE_MS) {
    const middle = Math.floor((low + high) / 2 / MINUTE_MS) * MINUTE_MS;
    if (middle <= low || middle >= high) break;
    if (timeZoneOffsetMs(middle, timeZone) === offsetStart) low = middle;
    else high = middle;
  }
  const change = high;
  const seen = new Set<number>();
  for (const hour of hours) {
    for (const minute of minutes) {
      const wall = midnight + hour * 3_600_000 + minute * MINUTE_MS;
      const instants: number[] = [];
      if (wall - offsetStart < change) instants.push(wall - offsetStart);
      if (wall - offsetEnd >= change) instants.push(wall - offsetEnd);
      instants.sort((a, b) => a - b);
      const chosen =
        instants.length === 0
          ? // Skipped by a forward change: the same wall time shifted by the gap.
            [wall - offsetStart]
          : cron.anyHour
            ? instants
            : [instants[0]!];
      for (const instant of chosen) {
        if (!seen.has(instant)) {
          seen.add(instant);
          result.push(instant);
        }
      }
    }
  }
  return result.sort((a, b) => a - b);
}

/**
 * The first fire instant strictly after `afterMs`, or null when the expression
 * cannot fire within five years (for example `0 0 31 2 *`).
 */
export function nextCronFire(
  cron: CronExpression,
  timeZone: string,
  afterMs: number,
): number | null {
  // Start a day early so a fire just after a backwards offset change is seen.
  const start = wallTimeAt(afterMs - DAY_MS, timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  let best: number | null = null;
  for (let index = 0; index < CRON_SEARCH_DAYS; index += 1, cursor += DAY_MS) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (dayMatches(cron, year, month, day)) {
      for (const instant of cronInstantsOnDay(cron, timeZone, year, month, day)) {
        if (instant > afterMs && (best === null || instant < best)) best = instant;
      }
    }
    // A shifted gap time can land on the following day's wall clock; once a
    // candidate is found, one more day decides it.
    if (best !== null && cursor - DAY_MS * 2 > best) return best;
  }
  return best;
}

// ---------------------------------------------------------------------------
// One-shot times

/**
 * Resolves a one-shot `at` value to an instant:
 *
 * - an ISO 8601 date-time with `Z` or an offset is absolute;
 * - `YYYY-MM-DDTHH:MM[:SS]` (or with a space) is a wall time in `timeZone`;
 * - `HH:MM[:SS]` is the next time that wall time occurs after `nowMs` (today
 *   when still ahead, else tomorrow);
 * - `+90s`, `+15m`, `+2h`, `+1d` (combinable, `+1h30m`) is relative to `nowMs`.
 */
export function resolveOneShotTime(at: string, timeZone: string, nowMs: number): number {
  const text = at.trim();
  if (!text || text.length > 64) throw new ScheduleTimeError("Time is empty");
  const relative = /^\+((?:\d+[smhd])+)$/i.exec(text);
  if (relative) {
    let total = 0;
    for (const match of relative[1]!.matchAll(/(\d+)([smhd])/gi)) {
      const unit = match[2]!.toLowerCase();
      const factor =
        unit === "s" ? 1000 : unit === "m" ? MINUTE_MS : unit === "h" ? 3_600_000 : DAY_MS;
      total += Number(match[1]) * factor;
    }
    if (total <= 0) throw new ScheduleTimeError("Relative time must be positive");
    return nowMs + total;
  }
  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = Number(timeOnly[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59)
      throw new ScheduleTimeError(`Invalid time "${text}"`);
    const today = wallTimeAt(nowMs, timeZone);
    for (let offset = 0; offset < 3; offset += 1) {
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
      const instant = resolveWallTime(
        {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
          hour,
          minute,
          second,
        },
        timeZone,
      );
      if (instant > nowMs) return instant;
    }
    throw new ScheduleTimeError(`Could not resolve "${text}"`);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(
    text,
  );
  if (local) {
    const [year, month, day, hour, minute, second] = local
      .slice(1, 7)
      .map((part) => Number(part ?? 0));
    const wall = {
      year: year!,
      month: month!,
      day: day!,
      hour: hour!,
      minute: minute!,
      second: second ?? 0,
    };
    const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
    if (
      check.getUTCMonth() + 1 !== wall.month ||
      check.getUTCDate() !== wall.day ||
      wall.hour > 23 ||
      wall.minute > 59 ||
      wall.second > 59
    ) {
      throw new ScheduleTimeError(`Invalid date-time "${text}"`);
    }
    return resolveWallTime(wall, timeZone);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const instant = Date.parse(text);
    if (Number.isFinite(instant)) return instant;
  }
  throw new ScheduleTimeError(
    `Unrecognised time "${text}": use HH:MM, YYYY-MM-DDTHH:MM, an ISO time with an offset, or +15m`,
  );
}

/** `2026-10-26 03:12 GMT` style rendering of an instant in a zone, for results and logs. */
export function formatInstantInZone(instantMs: number, timeZone: string): string {
  const wall = wallTimeAt(instantMs, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  let zoneName = timeZone;
  try {
    zoneName =
      new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
        .formatToParts(new Date(instantMs))
        .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    // keep the IANA name
  }
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)} ${zoneName}`;
}
