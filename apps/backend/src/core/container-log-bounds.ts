/**
 * Bounds for diagnostic output read from containers.
 *
 * A bridge log can grow without limit and one enormous line defeats a
 * line-count-only limit, so a tail is bounded twice: by bytes at the source
 * (`tail -c`) and by bytes and lines again on the host.
 */
export const DIAGNOSTIC_TAIL_MAX_BYTES = 64 * 1024;
export const DIAGNOSTIC_TAIL_MAX_LINES = 200;

/** Shell that prints at most the bounded tail of `file` (quoted by the caller). */
export function boundedTailCommand(file: string): string {
  return `tail -c ${DIAGNOSTIC_TAIL_MAX_BYTES} ${file} 2>/dev/null | tail -n ${DIAGNOSTIC_TAIL_MAX_LINES} || true`;
}

/**
 * Host-side second bound. Keeps the end of the text (the most recent output),
 * and says so when anything was dropped.
 */
export function boundDiagnosticTail(text: string): string {
  let bounded = text;
  let truncated = false;
  if (Buffer.byteLength(bounded, "utf8") > DIAGNOSTIC_TAIL_MAX_BYTES) {
    bounded = Buffer.from(bounded, "utf8")
      .subarray(-DIAGNOSTIC_TAIL_MAX_BYTES)
      .toString("utf8")
      .replace(/^�+/, "");
    truncated = true;
  }
  const lines = bounded.split("\n");
  if (lines.length > DIAGNOSTIC_TAIL_MAX_LINES + 1) {
    bounded = lines.slice(-(DIAGNOSTIC_TAIL_MAX_LINES + 1)).join("\n");
    truncated = true;
  }
  return truncated ? `[earlier output truncated]\n${bounded}` : bounded;
}
