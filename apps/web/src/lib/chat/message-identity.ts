/**
 * Identity preservation for message snapshots.
 *
 * `setMessages` replaces a session's transcript with a fresh snapshot from the
 * server. The snapshot's objects are always new, but nearly all of them encode
 * exactly the message the store already holds — handing the fresh objects to
 * React would re-render every memoized row for a no-op poll. These helpers map
 * a merged snapshot back onto the existing objects wherever the data is
 * structurally identical, so unchanged rows keep their identity and an entirely
 * unchanged snapshot can be turned into a store no-op.
 */

/** Structural equality over JSON-shaped data (plain objects, arrays, primitives). */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const arrayA = a as unknown[];
    const arrayB = b as unknown[];
    if (arrayA.length !== arrayB.length) return false;
    for (let index = 0; index < arrayA.length; index += 1) {
      if (!deepEqualJson(arrayA[index], arrayB[index])) return false;
    }
    return true;
  }

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) return false;
    if (!deepEqualJson(recordA[key], recordB[key])) return false;
  }
  return true;
}

interface MessageLike {
  id: string;
  parts?: unknown[];
  content?: string;
}

/** Cheap structural screen before paying for a deep compare. */
function cheaplyDiffers(existing: MessageLike, incoming: MessageLike): boolean {
  if (existing.content !== undefined || incoming.content !== undefined) {
    if (existing.content !== incoming.content) return true;
  }
  const existingParts = existing.parts;
  const incomingParts = incoming.parts;
  if (Array.isArray(existingParts) !== Array.isArray(incomingParts)) return true;
  if (Array.isArray(existingParts) && Array.isArray(incomingParts)) {
    if (existingParts.length !== incomingParts.length) return true;
  }
  return false;
}

/**
 * Replace entries of `next` with the store's existing object whenever the two
 * are structurally identical, keyed by message id. Returns `existing` itself
 * when the result would be element-for-element identical to it, so callers can
 * treat a byte-identical snapshot as a no-op.
 */
export function preserveMessageIdentities<TMessage extends { id: string }>(
  existing: TMessage[],
  next: TMessage[],
): TMessage[] {
  if (existing === next) return existing;
  if (existing.length === 0) return next;

  const existingById = new Map<string, TMessage>();
  for (const message of existing) {
    // First occurrence wins, mirroring findIndex-based lookups elsewhere.
    if (!existingById.has(message.id)) existingById.set(message.id, message);
  }

  let changedAnything = false;
  const result = next.map((incoming) => {
    const previous = existingById.get(incoming.id);
    if (!previous) return incoming;
    if (previous === incoming) return previous;
    if (cheaplyDiffers(previous as MessageLike, incoming as MessageLike)) {
      return incoming;
    }
    if (deepEqualJson(previous, incoming)) {
      changedAnything = true;
      return previous;
    }
    return incoming;
  });

  const sameAsExisting =
    result.length === existing.length
    && result.every((message, index) => message === existing[index]);
  if (sameAsExisting) return existing;

  return changedAnything ? result : next;
}
