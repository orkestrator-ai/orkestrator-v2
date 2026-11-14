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
  /** Null when it says the same as `created`: a ticket never changed since. */
  updated: TicketTime | null;
}

/**
 * An update within this long of the creation is the creation: the dialog that
 * creates a ticket attaches its images just after, and "Created 3h ago ·
 * Updated 3h ago" would only repeat itself.
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

/** The ticket view header's times; "Updated" only when it differs from "Created". */
export function ticketTimes(
  task: Pick<KanbanTask, "createdAt" | "updatedAt">,
  now: Date = new Date(),
  formatExact: FormatExactTime = formatExactLocalTime,
): TicketTimes {
  const created = readTime(task.createdAt);
  const updated = readTime(ticketUpdatedAt(task));
  const changed =
    updated !== null &&
    (created === null || Math.abs(updated.getTime() - created.getTime()) >= SAME_TIME_MS);
  return {
    created: created ? ticketTime("Created", created, now, formatExact) : null,
    updated: changed && updated ? ticketTime("Updated", updated, now, formatExact) : null,
  };
}

/**
 * A board card's one compact time: when the ticket last changed (its creation,
 * if never since). The tooltip gives both exact times. Null only when neither
 * can be read.
 */
export function ticketCardTime(
  task: Pick<KanbanTask, "createdAt" | "updatedAt">,
  now: Date = new Date(),
  formatExact: FormatExactTime = formatExactLocalTime,
): TicketTime | null {
  const times = ticketTimes(task, now, formatExact);
  const latest = times.updated ?? times.created;
  if (!latest) return null;
  const text = `Updated ${formatRelativeTime(latest.dateTime, now)}`;
  const title = !times.updated
    ? `${latest.title}, not changed since`
    : times.created
      ? `${times.updated.title}\n${times.created.title}`
      : times.updated.title;
  return { text, title, dateTime: latest.dateTime };
}
