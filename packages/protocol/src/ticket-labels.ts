/**
 * Kanban ticket labels: short names a ticket is tagged with, and the
 * project's label catalogue.
 *
 * A ticket stores its labels as names (`KanbanTask.labels`), in the order
 * they were added. The catalogue holds labels created ahead of use, with an
 * optional colour and description. The labels a project offers are the
 * catalogue plus every name a ticket carries, so a label that arrived on a
 * synced ticket is listed even on a machine whose catalogue never saw it.
 *
 * Names compare case-insensitively: adding `Bug` to a project that already
 * has `bug` adds `bug`. Whitespace runs collapse to one space.
 *
 * This module is shared with the browser; it must stay free of Node APIs.
 */

export const TICKET_LABEL_LIMITS = {
  /** Characters in one label name. */
  maxNameLength: 50,
  /** Labels on one ticket. */
  maxPerTicket: 20,
  /** Labels in one project's catalogue. */
  maxCatalogue: 200,
  /** Characters in a label's description. */
  maxDescriptionLength: 200,
} as const;

/** A colour is `#rrggbb`. */
export const TICKET_LABEL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** One label in a project's catalogue. */
export interface TicketLabelDefinition {
  name: string;
  color?: string;
  description?: string;
  createdAt: string;
}

/** One label a project offers: the catalogue entry, if any, and how many tickets carry it. */
export interface TicketLabelSummary {
  name: string;
  color?: string;
  description?: string;
  /** Absent for a label only tickets carry. */
  createdAt?: string;
  ticketCount: number;
}

/**
 * A label name in canonical form, or an error naming what is wrong. Names are
 * one line of printable text.
 */
export function normalizeTicketLabelName(value: unknown): string {
  if (typeof value !== "string") throw new Error("A label name must be a string");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("A label name must not be empty");
  if (name.length > TICKET_LABEL_LIMITS.maxNameLength) {
    throw new Error(`A label name must be at most ${TICKET_LABEL_LIMITS.maxNameLength} characters`);
  }
  if ([...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new Error("A label name must not contain control characters");
  }
  return name;
}

export function ticketLabelKey(name: string): string {
  return name.toLowerCase();
}

/**
 * A ticket's labels in canonical form: each name normalized, duplicates
 * (ignoring case) dropped, first spelling kept, at most `maxPerTicket`.
 */
export function normalizeTicketLabels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("labels must be an array of label names");
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of value) {
    const name = normalizeTicketLabelName(entry);
    const key = ticketLabelKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(name);
  }
  if (labels.length > TICKET_LABEL_LIMITS.maxPerTicket) {
    throw new Error(`A ticket can have at most ${TICKET_LABEL_LIMITS.maxPerTicket} labels`);
  }
  return labels;
}

/** Whether `value` is a stored ticket label list (as sync accepts it). */
export function isTicketLabelList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > TICKET_LABEL_LIMITS.maxPerTicket) return false;
  try {
    const normalized = normalizeTicketLabels(value);
    return normalized.length === value.length && normalized.every((name, i) => name === value[i]);
  } catch {
    return false;
  }
}

/**
 * Names spelled as the project already spells them: a name that matches a
 * known label ignoring case takes the known spelling.
 */
export function canonicalTicketLabels(
  labels: readonly string[],
  known: Iterable<string>,
): string[] {
  const spelling = new Map<string, string>();
  for (const name of known) {
    const key = ticketLabelKey(name);
    if (!spelling.has(key)) spelling.set(key, name);
  }
  return normalizeTicketLabels(labels.map((name) => spelling.get(ticketLabelKey(name)) ?? name));
}

export function normalizeTicketLabelColor(value: unknown): string {
  if (typeof value !== "string" || !TICKET_LABEL_COLOR_PATTERN.test(value)) {
    throw new Error("A label colour must be #rrggbb");
  }
  return value.toLowerCase();
}

export function normalizeTicketLabelDescription(value: unknown): string {
  if (typeof value !== "string") throw new Error("A label description must be a string");
  const description = value.trim();
  if (description.length > TICKET_LABEL_LIMITS.maxDescriptionLength) {
    throw new Error(
      `A label description must be at most ${TICKET_LABEL_LIMITS.maxDescriptionLength} characters`,
    );
  }
  return description;
}

/**
 * The labels a project offers: catalogue entries first (in creation order),
 * then names only tickets carry (alphabetically), each with its ticket count.
 */
export function summarizeTicketLabels(
  catalogue: readonly TicketLabelDefinition[],
  tickets: ReadonlyArray<{ labels?: readonly string[] }>,
): TicketLabelSummary[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const ticket of tickets) {
    for (const name of ticket.labels ?? []) {
      const key = ticketLabelKey(name);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { name, count: 1 });
    }
  }
  const summaries: TicketLabelSummary[] = catalogue.map((label) => ({
    name: label.name,
    ...(label.color ? { color: label.color } : {}),
    ...(label.description ? { description: label.description } : {}),
    createdAt: label.createdAt,
    ticketCount: counts.get(ticketLabelKey(label.name))?.count ?? 0,
  }));
  const listed = new Set(catalogue.map((label) => ticketLabelKey(label.name)));
  const used = [...counts.entries()]
    .filter(([key]) => !listed.has(key))
    .map(([, entry]) => ({ name: entry.name, ticketCount: entry.count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...summaries, ...used];
}
