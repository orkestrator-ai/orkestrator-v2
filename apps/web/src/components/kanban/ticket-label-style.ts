import { ticketLabelKey } from "@orkestrator/protocol/ticket-labels";

/** Chip classes for a ticket label on a card; a label's own colour is not sent with the ticket. */
const LABEL_STYLES = [
  "border-sky-500/30 bg-sky-500/15 text-sky-300",
  "border-violet-500/30 bg-violet-500/15 text-violet-300",
  "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  "border-amber-500/30 bg-amber-500/15 text-amber-300",
  "border-rose-500/30 bg-rose-500/15 text-rose-300",
  "border-cyan-500/30 bg-cyan-500/15 text-cyan-300",
  "border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-300",
  "border-lime-500/30 bg-lime-500/15 text-lime-300",
] as const;

/** The two labels self-improvement files under keep the colours it gives them in the catalogue. */
// A Map, not an object: a label may be named `constructor` or `__proto__`.
const FIXED_STYLES: ReadonlyMap<string, number> = new Map([
  ["improvement", 0],
  ["insight", 1],
]);

/** The same name always gets the same chip, whatever its case. */
export function ticketLabelClassName(name: string): string {
  const key = ticketLabelKey(name);
  const fixed = FIXED_STYLES.get(key);
  if (fixed !== undefined) return LABEL_STYLES[fixed]!;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return LABEL_STYLES[hash % LABEL_STYLES.length]!;
}
