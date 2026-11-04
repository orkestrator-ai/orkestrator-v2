/** Fields a bridge may reissue for a part whose content did not change. */
const PART_IDENTITY_FIELDS: ReadonlySet<string> = new Set(["sourcePartId", "createdAt"]);

function serializedKeys(value: Record<string, unknown>, skip?: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined && !skip?.has(key));
}

function sameJson(a: unknown, b: unknown, skip?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameJson(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = serializedKeys(left, skip);
  const rightKeys = serializedKeys(right, skip);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && sameJson(left[key], right[key]),
  );
}

/**
 * Whether two transcript values (a part, a message) serialize to the same JSON,
 * key order included, without serializing them. They come from parsed JSON, so a
 * new copy is always a new object and a per-object cache of its serialization
 * would never hit; this allocates only key lists and stops at the first difference.
 */
export function sameTranscriptJson(a: unknown, b: unknown): boolean {
  return sameJson(a, b);
}

/** `sameTranscriptJson` for parts, ignoring the top-level fields a bridge may reissue. */
export function samePartContent(a: unknown, b: unknown): boolean {
  return sameJson(a, b, PART_IDENTITY_FIELDS);
}
