// A content-free description of a render or window failure: an allowlisted
// error class, a one-way fingerprint and component names. Kept free of React
// and UI imports, because the renderer's startup handlers use it before the
// application loads, and the renderer error ring stores exactly these.

/**
 * Signatures browsers and bundlers use when a dynamic `import()` cannot be
 * fetched or evaluated. Matched against the message only — the message itself
 * is never rendered or logged, because it embeds the chunk URL.
 */
const MODULE_LOAD_ERROR_PATTERN =
  /dynamically imported module|importing a module script failed|error loading chunk|failed to fetch dynamically imported module/i;

export function isModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return MODULE_LOAD_ERROR_PATTERN.test(error.message);
}

export interface LazyLoadFailureDiagnostic {
  kind: "module-load" | "render";
  /**
   * An allowlisted built-in error name, `NonErrorThrow` when the thrown value
   * was not an `Error`, or `Error` for anything else. Never a custom subclass
   * name, which application code controls and could embed untrusted text.
   */
  errorType: string;
  fingerprint: string;
  componentChain: string[];
}

/** Fixed sentinel for a thrown value that was not an `Error` at all. */
const NON_ERROR_THROW = "NonErrorThrow";

const SAFE_ERROR_TYPES = new Set([
  "AggregateError",
  "ChunkLoadError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function failureFingerprint(value: string): string {
  // FNV-1a is not used as a security primitive here. It gives support logs a
  // stable correlation key without retaining the exception message, stack,
  // chunk URL, absolute path, or transcript content that produced it.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Build a bounded diagnostic that cannot echo provider or filesystem data. */
export function createLazyLoadFailureDiagnostic(
  error: unknown,
  info?: { componentStack?: string | null },
): LazyLoadFailureDiagnostic {
  let rawName = NON_ERROR_THROW;
  let stack = "";
  if (error instanceof Error) {
    try {
      rawName = error.name;
      stack = error.stack ?? "";
    } catch {
      rawName = "Error";
    }
  }
  // The sentinel is a fixed literal rather than attacker-influenced text, so
  // preserving it alongside the allowlist keeps "nobody threw an Error" visible
  // without letting a custom subclass name reach the log.
  const errorType =
    rawName === NON_ERROR_THROW || SAFE_ERROR_TYPES.has(rawName) ? rawName : "Error";
  const componentStack = info?.componentStack ?? "";
  const componentChain = componentStack
    .split("\n")
    .flatMap((line) => {
      // The trailing lookahead is what keeps a location-only frame out of the
      // chain: React writes `at Name (loc)` or `at Name`, so a line such as
      // `at https://host/assets/chunk.js:2:2` fails on the `:` and is dropped
      // rather than contributing a bare `https`.
      const match = /^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\s|\(|$)/.exec(line);
      return match?.[1] ? [match[1]] : [];
    })
    .slice(0, 12);
  return {
    kind: isModuleLoadError(error) ? "module-load" : "render",
    errorType,
    fingerprint: failureFingerprint(`${errorType}\n${stack}\n${componentStack}`),
    componentChain,
  };
}
