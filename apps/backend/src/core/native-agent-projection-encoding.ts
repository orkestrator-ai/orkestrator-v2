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
/** `valueFingerprint` per object; lives exactly as long as its row, like `encodings`. */
const fingerprints = new WeakMap<object, string>();

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

/** The memoized JSON of a value, if something already encoded it; never encodes. */
export function memoizedEncoding(value: unknown): string | undefined {
  return value !== null && typeof value === "object" ? encodings.get(value)?.json : undefined;
}

/** Short content fingerprint of one projected value, computed at most once per object. */
export function valueFingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") return fingerprintOf(encodedValue(value).json);
  let fingerprint = fingerprints.get(value);
  if (fingerprint === undefined) {
    fingerprint = fingerprintOf(encodedValue(value).json);
    fingerprints.set(value, fingerprint);
  }
  return fingerprint;
}

function fingerprintOf(json: string): string {
  return createHash("sha256").update(json).digest("hex").slice(0, 24);
}

/**
 * Feed each value's memoized fingerprint into a digest. A read that changed
 * one row hashes that row's bytes once (for its fingerprint) and a short
 * fixed-length string for every other row, instead of every row's JSON.
 * Fingerprints keep 96 bits: ample for telling a changed view from an
 * unchanged one.
 */
export function updateHashWithFingerprints(hash: Hash, values: readonly unknown[]): Hash {
  hash.update(String(values.length));
  for (const value of values) {
    hash.update("\0");
    hash.update(valueFingerprint(value));
  }
  return hash;
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
 * Ids that left a live tail because they were removed from the conversation,
 * not because newer rows pushed them out of the window's front.
 *
 * Both lists are tails of one history (same epoch). A row older than the
 * oldest row both windows still share has aged out: it is still history, and
 * a client that reads it as a deletion drops a message the user can no longer
 * page back to. When the windows share nothing, the tail moved past every row
 * it held — unless the new window starts at the beginning of the history, in
 * which case nothing older exists and the old rows really are gone.
 */
export function tailDeletions(
  previousIds: readonly string[],
  currentIds: readonly string[],
  currentWindowOmitsOlder: boolean,
): string[] {
  const current = new Set(currentIds);
  const firstShared = previousIds.findIndex((id) => current.has(id));
  if (firstShared < 0) return currentWindowOmitsOlder ? [] : [...previousIds];
  return previousIds.slice(firstShared).filter((id) => !current.has(id));
}

/**
 * Encoded bytes of an object whose `messages` and `revisedMessages` arrays are
 * measured through the memo; every other field is serialized once. Used for
 * budgets and for choosing between a delta and a snapshot, where one byte of
 * framing drift is immaterial but a full re-serialization of the window is
 * not. The framing allowance counts a separating comma for each array, so the
 * result never undercounts: at most it is one byte over.
 */
export function encodedBytesWithMessages<
  T extends { messages: readonly unknown[]; revisedMessages?: readonly unknown[] },
>(value: T): number {
  const { messages, revisedMessages, ...rest } = value;
  let bytes =
    Buffer.byteLength(JSON.stringify(rest)) + encodedArrayBytes(messages) + '"messages":,'.length;
  if (revisedMessages !== undefined) {
    bytes += encodedArrayBytes(revisedMessages) + '"revisedMessages":,'.length;
  }
  return bytes;
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

/** Containers deeper than this are serialized whole rather than walked. */
const MAX_SPLICE_DEPTH = 8;
const spliceableResults = new WeakSet<object>();

/**
 * Mark a command result whose rows were already encoded on the way to it, so
 * the gateway writes it with {@link spliceEncodedJson} instead of serializing
 * those rows again. The value is untouched: every caller that is not the
 * gateway (the CLI, coordinator tools, tests) receives the same plain object.
 */
export function markSpliceableResult<T>(value: T): T {
  if (value !== null && typeof value === "object") spliceableResults.add(value);
  return value;
}

export function isSpliceableResult(value: unknown): boolean {
  return value !== null && typeof value === "object" && spliceableResults.has(value);
}

/**
 * The same JSON as `JSON.stringify(value)`, with each array element that was
 * already encoded (a projected row, a patch) copied from the memo rather than
 * serialized again. Only plain objects and arrays are walked, and only to a
 * fixed depth; anything else (a class instance, a `toJSON`, a deep subtree)
 * goes through `JSON.stringify` whole, so the output cannot differ from it.
 */
export function spliceEncodedJson(value: unknown): string | undefined {
  return splicedJson(value, 0);
}

function splicedJson(value: unknown, depth: number): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (depth >= MAX_SPLICE_DEPTH || typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const elements: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const element: unknown = value[index];
      elements.push(memoizedEncoding(element) ?? splicedJson(element, depth + 1) ?? "null");
    }
    return `[${elements.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return JSON.stringify(value);
  const fields: string[] = [];
  for (const key of Object.keys(value)) {
    const json = splicedJson((value as Record<string, unknown>)[key], depth + 1);
    if (json !== undefined) fields.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${fields.join(",")}}`;
}
