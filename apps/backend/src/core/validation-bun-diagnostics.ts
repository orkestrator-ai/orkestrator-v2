/**
 * Keep only a digest of the error and assertion details. Source excerpts,
 * stack locations and timings vary between checkouts. The same function is
 * embedded in the environment-side failure classifier.
 */
export function bunFailureFingerprint(lines: string[], hash: (text: string) => string) {
  // Under GITHUB_ACTIONS Bun also prints workflow commands (`::error ...::`,
  // `::group::`), which a run outside Actions lacks for the same failure.
  const relevant = lines.filter((line) => !/^::[a-z][\w-]*(?: [^\n]*)?::/.test(line));
  const start = relevant.findIndex((line) => /^error: \S/.test(line));
  if (start < 0) return undefined;
  const block = relevant.slice(start);
  if (
    block.length > 128 ||
    block.some((line) => line.length > 8_192) ||
    block.slice(1).some((line) => /^error: \S/.test(line))
  )
    return undefined;
  const stack = block.findIndex((line) => /^\s+at\s/.test(line));
  const diagnostic = (stack < 0 ? block : block.slice(0, stack)).join("\n").trimEnd();
  // An assertion heading alone does not distinguish two different failures of
  // the same assertion. The details must include both sides or a diff.
  if (
    diagnostic.startsWith("error: expect(") &&
    !(/\nExpected[^\n]*:/.test(diagnostic) && /\nReceived[^\n]*:/.test(diagnostic)) &&
    !(/\n-\s/.test(diagnostic) && /\n\+\s/.test(diagnostic))
  )
    return undefined;
  return hash(diagnostic);
}
