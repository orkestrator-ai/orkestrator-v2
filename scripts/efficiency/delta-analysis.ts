/**
 * Repeated-content accounting for whole-message transcript deltas (step 14).
 *
 * A client that receives `messageUpserts` replaces each message whole. This
 * module measures, against what that client last held for the same message,
 * how many of the decoded upsert bytes were already there:
 *
 * - `identicalPartBytes`: top-level parts byte-identical to the previous
 *   version of the same part. This is what a part-level replace operation
 *   would stop resending, and is the step-14 gate metric.
 * - `grownPartPrefixBytes`: the unchanged prefix of a part whose text only
 *   grew — what an append-text operation would additionally save.
 * - `contentPrefixBytes`: the same for the message-level `content` mirror.
 * - `nestedIdenticalChildBytes`: identical children (`subagentActions`,
 *   `childTools`, nested `parts`) inside a part that itself changed — what
 *   only nested part operations could save.
 *
 * Parts are matched by stable identity (`sourcePartId`, `toolUseId`, `id`),
 * falling back to position only when a part carries none. Only integers are
 * kept; no part content is retained beyond the client's own previous copy.
 */

export interface DeltaAccounting {
  upserts: number;
  decodedUpsertBytes: number;
  identicalPartBytes: number;
  grownPartPrefixBytes: number;
  contentPrefixBytes: number;
  nestedIdenticalChildBytes: number;
}

type Row = Record<string, unknown>;

const NESTED_FIELDS = ["subagentActions", "childTools", "parts"] as const;

export function emptyAccounting(): DeltaAccounting {
  return {
    upserts: 0,
    decodedUpsertBytes: 0,
    identicalPartBytes: 0,
    grownPartPrefixBytes: 0,
    contentPrefixBytes: 0,
    nestedIdenticalChildBytes: 0,
  };
}

function bytesOf(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json);
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function partKey(part: unknown, index: number): string {
  if (isRow(part)) {
    for (const field of ["sourcePartId", "toolUseId", "id"] as const) {
      if (typeof part[field] === "string" && part[field]) return `${field}:${part[field]}`;
    }
  }
  return `index:${index}`;
}

function keyed(parts: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(parts)) return map;
  parts.forEach((part, index) => map.set(partKey(part, index), part));
  return map;
}

/** UTF-8 bytes of `previous` when `next` extends it, else zero. */
function grownPrefixBytes(previous: unknown, next: unknown): number {
  return typeof previous === "string" &&
    typeof next === "string" &&
    previous.length > 0 &&
    next.length > previous.length &&
    next.startsWith(previous)
    ? Buffer.byteLength(previous)
    : 0;
}

function nestedIdenticalBytes(previous: Row, next: Row): number {
  let total = 0;
  for (const field of NESTED_FIELDS) {
    const before = keyed(previous[field]);
    if (before.size === 0 || !Array.isArray(next[field])) continue;
    (next[field] as unknown[]).forEach((child, index) => {
      const prior = before.get(partKey(child, index));
      if (prior === undefined) return;
      const childBytes = bytesOf(child);
      if (childBytes === bytesOf(prior) && JSON.stringify(child) === JSON.stringify(prior)) {
        total += childBytes;
      } else if (isRow(child) && isRow(prior)) {
        total += nestedIdenticalBytes(prior, child);
      }
    });
  }
  return total;
}

/**
 * Folds one delta's upserts into `accounting`, then records them as the
 * client's current copies in `held`.
 */
export function accountUpserts(
  accounting: DeltaAccounting,
  held: Map<string, Row>,
  upserts: readonly unknown[],
): void {
  for (const message of upserts) {
    if (!isRow(message)) continue;
    accounting.upserts += 1;
    accounting.decodedUpsertBytes += bytesOf(message);
    const id = typeof message.id === "string" ? message.id : undefined;
    const previous = id ? held.get(id) : undefined;
    if (previous) {
      accounting.contentPrefixBytes += grownPrefixBytes(previous.content, message.content);
      const priorParts = keyed(previous.parts);
      if (Array.isArray(message.parts)) {
        message.parts.forEach((part, index) => {
          const prior = priorParts.get(partKey(part, index));
          if (prior === undefined) return;
          const json = JSON.stringify(part);
          if (json === JSON.stringify(prior)) {
            accounting.identicalPartBytes += Buffer.byteLength(json);
          } else if (isRow(part) && isRow(prior)) {
            accounting.grownPartPrefixBytes += grownPrefixBytes(prior.content, part.content);
            accounting.nestedIdenticalChildBytes += nestedIdenticalBytes(prior, part);
          }
        });
      }
    }
    if (id) held.set(id, message);
  }
}

/** Replaces the client's copies after a snapshot. */
export function holdSnapshot(held: Map<string, Row>, messages: readonly unknown[]): void {
  held.clear();
  for (const message of messages) {
    if (isRow(message) && typeof message.id === "string") held.set(message.id, message);
  }
}

/** A ratio rounded to four places, so reports compare exactly. */
export function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}
