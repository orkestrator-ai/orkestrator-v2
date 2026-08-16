/** Compact line-change metadata shared by every agent transcript adapter. */
export interface ToolLineChangeStats {
  additions: number;
  deletions: number;
}

/**
 * Count logical lines without allocating an array proportional to the payload.
 * A trailing newline terminates the final line; it does not create another one.
 */
export function countTextLines(value: string | undefined): number {
  if (!value) return 0;

  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return value.endsWith("\n") ? lines - 1 : lines;
}

/**
 * Derive the small metadata shown on a collapsed edit row from replacement
 * sides before those potentially large strings are deferred or discarded.
 */
export function lineChangeStatsFromSides(
  before: string | undefined,
  after: string | undefined,
): ToolLineChangeStats | undefined {
  if (before === undefined && after === undefined) return undefined;
  return {
    additions: countTextLines(after),
    deletions: countTextLines(before),
  };
}
