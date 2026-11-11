/**
 * The transcript an adopted Build keeps, bounded so that confirming never
 * fails on how long the source session ran.
 *
 * `installCompletedBuild` refuses more than 10,000 messages or 8 MiB, so the
 * copy stored with a promoted draft has to be cut to fit before it gets there.
 * Nothing here reaches a prompt: the drafting agent works from its own record
 * of the session. The copy is what the pipeline view later shows as the
 * original Build session.
 *
 * The cut is deterministic and never fails:
 *
 * 1. Every string longer than {@link MAX_ADOPTED_STRING_CHARS} keeps its start
 *    and says how much was left out, so one large tool result cannot take the
 *    budget of a hundred messages. Nesting past {@link MAX_ADOPTED_DEPTH}
 *    levels is replaced the same way.
 * 2. The first message (the task as first given) is kept, then the newest
 *    messages that fit, in their original order.
 * 3. A message that still does not fit on its own is replaced by a short
 *    placeholder rather than dropped silently or failing the whole copy.
 */

/** Below the 10,000 messages `installCompletedBuild` accepts. */
export const MAX_ADOPTED_MESSAGES = 5_000;
/** Below the 8 MiB `installCompletedBuild` accepts. */
export const MAX_ADOPTED_BYTES = 4 * 1024 * 1024;
/** Longest string kept whole; longer ones keep their start. */
export const MAX_ADOPTED_STRING_CHARS = 8_192;
/** Deepest nesting kept; deeper values are replaced by a short marker. */
export const MAX_ADOPTED_DEPTH = 24;

function omitted(count: number): string {
  return `… [${count.toLocaleString("en-US")} characters omitted]`;
}

function cap(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_ADOPTED_STRING_CHARS
      ? `${value.slice(0, MAX_ADOPTED_STRING_CHARS)}${omitted(value.length - MAX_ADOPTED_STRING_CHARS)}`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_ADOPTED_DEPTH) return "[nested content omitted]";
  if (Array.isArray(value)) return value.map((entry) => cap(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      cap(entry, depth + 1),
    ]),
  );
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function placeholder(message: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  return { role, content: "[message omitted: too large to keep]", parts: [] };
}

/**
 * `messages` cut to the adoption limits. The input is not modified, and an
 * input already inside every limit comes back unchanged in content.
 */
export function boundAdoptedTranscript(messages: readonly unknown[]): unknown[] {
  const capped = messages.map((message) => {
    const value = cap(message, 0);
    return size(value) <= MAX_ADOPTED_BYTES ? value : placeholder(message);
  });
  const sizes = capped.map(size);
  const keep = new Set<number>();
  let total = 0;
  const take = (index: number): boolean => {
    if (keep.size >= MAX_ADOPTED_MESSAGES || total + sizes[index]! > MAX_ADOPTED_BYTES)
      return false;
    keep.add(index);
    total += sizes[index]!;
    return true;
  };
  if (capped.length > 0) take(0);
  for (let index = capped.length - 1; index > 0; index--) {
    if (!take(index)) break;
  }
  return capped.filter((_message, index) => keep.has(index));
}
