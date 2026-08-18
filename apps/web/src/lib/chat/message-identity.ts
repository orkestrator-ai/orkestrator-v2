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

const MAX_DEEP_EQUAL_NODES = 100_000;

/**
 * Structural equality over JSON-shaped data (plain objects, arrays,
 * primitives).
 *
 * Model/tool payloads are untrusted and may be extremely deeply nested. Keep
 * this iterative so an otherwise-valid payload cannot overflow the renderer's
 * call stack, and stop after a generous work budget. Exceeding the budget is
 * deliberately treated as "changed": identity reuse is only an optimization.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  let visited = 0;

  while (pending.length > 0) {
    if (visited >= MAX_DEEP_EQUAL_NODES) return false;
    visited += 1;

    const [left, right] = pending.pop()!;
    if (Object.is(left, right)) continue;
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
      return false;
    }

    const leftIsArray = Array.isArray(left);
    if (leftIsArray !== Array.isArray(right)) return false;
    if (leftIsArray) {
      const leftArray = left as unknown[];
      const rightArray = right as unknown[];
      if (leftArray.length !== rightArray.length) return false;
      for (let index = 0; index < leftArray.length; index += 1) {
        pending.push([leftArray[index], rightArray[index]]);
      }
      continue;
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
      pending.push([leftRecord[key], rightRecord[key]]);
    }
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

  const existingById = new Map<string, TMessage[]>();
  for (const message of existing) {
    const matches = existingById.get(message.id);
    if (matches) matches.push(message);
    else existingById.set(message.id, [message]);
  }

  let changedAnything = false;
  const result = next.map((incoming) => {
    const previous = existingById.get(incoming.id)?.shift();
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
    result.length === existing.length &&
    result.every((message, index) => message === existing[index]);
  if (sameAsExisting) return existing;

  return changedAnything ? result : next;
}
