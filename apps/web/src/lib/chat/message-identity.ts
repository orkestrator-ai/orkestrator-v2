/**
 * Structural equality for store writes.
 *
 * Snapshots from the server always arrive as fresh objects, but nearly all of
 * them encode exactly what the store already holds. Stores compare with
 * `deepEqualJson` so an unchanged snapshot keeps its existing objects and
 * becomes a no-op write instead of re-rendering every subscriber.
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
