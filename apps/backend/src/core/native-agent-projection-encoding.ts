/**
 * Serialize each projected message once, and reuse it everywhere.
 *
 * A changed transcript read used to stringify the same window five times: to
 * hash the view token, to size the cache entry, to compare every message with
 * its previous version (twice per message), and to size both the delta and
 * the snapshot it chose between. The sync-v1 and history paths did the same
 * again for their own tokens, fingerprints and byte budgets.
 *
 * Projected values are immutable once `projectionMessages` returns them — the
 * projection builds fresh objects and never edits one it has handed out — so
 * an encoding can be memoized per object. A message that survives from one
 * read to the next keeps its object (see {@link reuseUnchangedMessages}) and is
 * therefore never serialized again while it stays in the window.
 */
import { createHash, type Hash } from "node:crypto";

interface Encoding {
  json: string;
  bytes: number;
}

const encodings = new WeakMap<object, Encoding>();

/** The JSON of an immutable projected value, computed at most once per object. */
export function encodedValue(value: unknown): Encoding {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value) ?? "null";
    return { json, bytes: Buffer.byteLength(json) };
  }
  let encoding = encodings.get(value);
  if (!encoding) {
    const json = JSON.stringify(value);
    encoding = { json, bytes: Buffer.byteLength(json) };
    encodings.set(value, encoding);
  }
  return encoding;
}

/** Exact encoded bytes of a JSON array of projected values. */
export function encodedArrayBytes(values: readonly unknown[]): number {
  let bytes = 2 + Math.max(0, values.length - 1);
  for (const value of values) bytes += encodedValue(value).bytes;
  return bytes;
}

/** Feed each value's memoized encoding into a digest, separated unambiguously. */
export function updateHashWithValues(hash: Hash, values: readonly unknown[]): Hash {
  hash.update(String(values.length));
  for (const value of values) {
    const { json } = encodedValue(value);
    hash.update(`\0${json.length}\0`);
    hash.update(json);
  }
  return hash;
}

/** Whether two projected values encode identically; identity short-circuits. */
export function sameEncoding(left: unknown, right: unknown): boolean {
  return left === right || encodedValue(left).json === encodedValue(right).json;
}

/** Short content fingerprint of one projected value. */
export function valueFingerprint(value: unknown): string {
  return createHash("sha256").update(encodedValue(value).json).digest("hex").slice(0, 24);
}

function messageId(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Replace every message whose encoding did not change with the object already
 * held for it, so unchanged rows keep their identity across reads: downstream
 * comparisons short-circuit, and renderer caches keyed by object stay warm.
 */
export function reuseUnchangedMessages(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[],
): unknown[] {
  if (!previous || previous.length === 0) return next.slice();
  const byId = new Map<string, unknown>();
  for (const message of previous) {
    const id = messageId(message);
    if (id !== undefined) byId.set(id, message);
  }
  return next.map((message) => {
    const id = messageId(message);
    const held = id === undefined ? undefined : byId.get(id);
    return held !== undefined && sameEncoding(held, message) ? held : message;
  });
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Encoded bytes of an object whose `messages` array is measured through the
 * memo; every other field is serialized once. Used for budgets and for
 * choosing between a delta and a snapshot, where one byte of framing drift is
 * immaterial but a full re-serialization of the window is not.
 */
export function encodedBytesWithMessages<T extends { messages: readonly unknown[] }>(
  value: T,
): number {
  const { messages, ...rest } = value;
  return (
    Buffer.byteLength(JSON.stringify(rest)) + encodedArrayBytes(messages) + '"messages":,'.length
  );
}

/** Digest of an object with a `messages` array, hashing messages through the memo. */
export function digestWithMessages<T extends { messages: readonly unknown[] }>(
  prefix: string,
  value: T,
): string {
  const { messages, ...rest } = value;
  const hash = createHash("sha256").update(prefix).update("\0").update(JSON.stringify(rest));
  return updateHashWithValues(hash, messages).digest("base64url").slice(0, 43);
}
