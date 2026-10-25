import { createHash } from "node:crypto";

export interface AttentionPosition {
  rank: number;
  at: number;
  key: string;
}
export interface AttentionCursor {
  since: number;
  until?: number;
  after?: AttentionPosition;
}

export function attentionKey(kind: string, id: string): string {
  return createHash("sha256").update(`${kind}:${id}`).digest("hex").slice(0, 16);
}

/** Blocking interactions first, then newest first, with stable ties. */
export function compareAttention(a: AttentionPosition, b: AttentionPosition): number {
  return a.rank - b.rank || b.at - a.at || a.key.localeCompare(b.key);
}

export function encodeAttentionCursor(ms: number): string {
  return `att1-${Math.max(0, Math.floor(ms)).toString(36)}`;
}

export function encodeAttentionContinuation(
  cursor: AttentionCursor,
  after: AttentionPosition,
): string {
  return `att2-${cursor.since.toString(36)}-${cursor.until!.toString(36)}-${after.rank}${after.at.toString(36)}-${after.key}`;
}

export function parseAttentionCursor(cursor: string): AttentionCursor | null {
  const simple = /^att1-([0-9a-z]{1,12})$/.exec(cursor);
  if (simple) {
    const since = Number.parseInt(simple[1]!, 36);
    return Number.isSafeInteger(since) ? { since } : null;
  }
  const page =
    /^att2-([0-9a-z]{1,12})-([0-9a-z]{1,12})-([01])([0-9a-z]{1,12})-([0-9a-f]{16})$/.exec(cursor);
  if (!page) return null;
  const [since, until, at] = [page[1]!, page[2]!, page[4]!].map((value) =>
    Number.parseInt(value, 36),
  );
  if (![since, until, at].every(Number.isSafeInteger) || since! > until!) return null;
  return { since: since!, until: until!, after: { rank: Number(page[3]), at: at!, key: page[5]! } };
}

export function decodeAttentionCursor(cursor: string): number | null {
  return parseAttentionCursor(cursor)?.since ?? null;
}
