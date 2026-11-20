/**
 * The three characters a machine tile shows for its machine (design EL01).
 *
 * - A name in hyphenated (or underscored, dotted, spaced) parts takes the
 *   first letter of the first part and the first two of the second
 *   (omarchy-hp → OHP); three or more parts take one letter of each of the
 *   first three (dev-box-eu → DBE).
 * - A name ending in a digit keeps its trailing digits and leads with letters
 *   up to three characters (beelink2 → BE2, mbp3 → MB3, node12 → N12).
 * - Otherwise its first three letters (mini → MIN).
 *
 * Always upper case; a name with no letters or digits shows "?".
 */
export function machineInitials(name: string): string {
  const parts = name
    .normalize("NFKC")
    .split(/[-_.\s]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  const upper = (text: string) => text.toLocaleUpperCase();
  if (parts.length >= 3)
    return upper(
      parts
        .slice(0, 3)
        .map((part) => [...part][0])
        .join(""),
    );
  if (parts.length === 2) {
    const [first, second] = parts.map((part) => [...part]) as [string[], string[]];
    const tail = second.slice(0, 2);
    return upper([...first.slice(0, 3 - tail.length), ...tail].join(""));
  }
  const chars = [...parts[0]!];
  const digits = /\p{N}+$/u.exec(parts[0]!)?.[0];
  if (digits && digits.length < chars.length) {
    const kept = [...digits].slice(-2);
    const letters = chars.slice(0, chars.length - [...digits].length);
    return upper([...letters.slice(0, 3 - kept.length), ...kept].join(""));
  }
  return upper(chars.slice(0, 3).join(""));
}
