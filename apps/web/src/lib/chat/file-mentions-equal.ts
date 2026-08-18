import type { FileMention } from "@/types";

/**
 * True when two mention lists describe the same mentions in the same order.
 *
 * Used by the compose bars to decide whether the draft still holds exactly what
 * was submitted before clearing it. If the user typed on while the send was in
 * flight, the draft has moved on and clearing it would eat their input.
 *
 * Compares by value rather than reference because the store hands back a fresh
 * array on every read.
 */
export function fileMentionsEqual(
  left: readonly FileMention[],
  right: readonly FileMention[],
): boolean {
  if (left === right) return true;
  return (
    left.length === right.length &&
    left.every((mention, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        mention.id === other.id &&
        mention.filename === other.filename &&
        mention.relativePath === other.relativePath
      );
    })
  );
}
