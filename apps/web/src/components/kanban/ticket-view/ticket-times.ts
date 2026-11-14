import { ticketUpdatedAt } from "@orkestrator/protocol/ticket-sync";

import { formatRelativeTime } from "@/lib/format-relative-time";
import type { KanbanTask } from "@/stores/kanbanStore";

/**
 * When a ticket was created and last updated, as the ticket view's header and
 * the board's cards show them. A backend that predates `updatedAt` sends none,
 * and a ticket stored before it existed reads as last updated when created
 * (`ticketUpdatedAt`), so neither ever shows "Invalid Date".
 */

/** One time: what the text says, the exact local time for its tooltip, and the instant. */
export interface TicketTime {
  /** "Created 3h ago", "Updated just now", or a date once it is over a week old. */
  text: string;
  /** "Created 14 Nov 2026, 10:46:03": the exact local time. */
  title: string;
  /** The ISO timestamp, for a `<time dateTime>`. */
  dateTime: string;
}

export interface TicketTimes {
  /** Null only for a ticket whose creation time cannot be read. */
  created: TicketTime | null;
  /**
   * Null when it would say the same as `created`: a ticket never changed
   * since, or changed within a minute of its creation. In that second case
   * `created`'s tooltip also gives the exact update time.
   */
  updated: TicketTime | null;
}

/**
 * The header shows an update within this long of the creation as part of the
 * creation: the dialog that creates a ticket attaches its images just after,
 * and "Created 3h ago · Updated 3h ago" would only repeat itself. The exact
 * update time stays in the tooltip, and the board card always uses it.
 */
const SAME_TIME_MS = 60_000;

/** The exact local time; a parameter so tests do not depend on the host's locale. */
export type FormatExactTime = (date: Date) => string;

export const formatExactLocalTime: FormatExactTime = (date) =>
  date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

function readTime(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ticketTime(
  label: "Created" | "Updated",
  date: Date,
  now: Date,
  formatExact: FormatExactTime,
): TicketTime {
  return {
    text: `${label} ${formatRelativeTime(date, now)}`,
    title: `${label} ${formatExact(date)}`,
    dateTime: date.toISOString(),
  };
}

/**
 * Both readable times, `updated` null only when the ticket has not changed
 * since its creation (the same instant) or its time cannot be read.
 */
function readTicketTimes(
  task: Pick<KanbanTask, "createdAt" | "updatedAt">,
  now: Date,
  formatExact: FormatExactTime,
): { created: TicketTime | null; updated: TicketTime | null; gapMs: number | null } {
  const created = readTime(task.createdAt);
  const updated = readTime(ticketUpdatedAt(task));
  const changed = updated !== null && (created === null || updated.getTime() !== created.getTime());
  return {
    created: created ? ticketTime("Created", created, now, formatExact) : null,
    updated: changed && updated ? ticketTime("Updated", updated, now, formatExact) : null,
    gapMs: created && updated ? Math.abs(updated.getTime() - created.getTime()) : null,
  };
}

/**
 * The ticket view header's times. "Updated" appears when it is a minute or
 * more after "Created"; an earlier change is folded into "Created", whose
 * tooltip then gives both exact times.
 */
export function ticketTimes(
  task: Pick<KanbanTask, "createdAt" | "updatedAt">,
  now: Date = new Date(),
  formatExact: FormatExactTime = formatExactLocalTime,
): TicketTimes {
  const { created, updated, gapMs } = readTicketTimes(task, now, formatExact);
  if (created && updated && gapMs !== null && gapMs < SAME_TIME_MS) {
    return { created: { ...created, title: `${created.title}\n${updated.title}` }, updated: null };
  }
  return { created, updated };
}

/**
 * A board card's one compact time: when the ticket last changed (its creation,
 * if never since), always the exact `updatedAt`. The tooltip gives both exact
 * times. Null only when neither can be read.
 */
export function ticketCardTime(
  task: Pick<KanbanTask, "createdAt" | "updatedAt">,
  now: Date = new Date(),
  formatExact: FormatExactTime = formatExactLocalTime,
): TicketTime | null {
  const { created, updated } = readTicketTimes(task, now, formatExact);
  const latest = updated ?? created;
  if (!latest) return null;
  const text = `Updated ${formatRelativeTime(latest.dateTime, now)}`;
  const title = !updated
    ? `${latest.title}, not changed since`
    : created
      ? `${updated.title}\n${created.title}`
      : updated.title;
  return { text, title, dateTime: latest.dateTime };
}
