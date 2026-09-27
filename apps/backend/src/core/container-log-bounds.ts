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

/** In-image rotating writer (`bounded-logs=1`). */
export const CONTAINER_LOG_WRITER = "/usr/local/bin/orkestrator-log-writer";

/**
 * Shell that starts `command` detached with its output in `logFile`. Where the
 * image ships the rotating writer, output goes through it (5 MiB, 3 files);
 * an older image keeps the plain redirect it always had. The whole pipeline
 * is `setsid`, so the writer outlives the exec session exactly like the
 * process it drains.
 */
export function boundedBackgroundLaunch(command: string, logFile: string): string {
  const pipeline = `${command} 2>&1 | ${CONTAINER_LOG_WRITER} ${logFile}`;
  return [
    `if [ -x ${CONTAINER_LOG_WRITER} ]; then`,
    `  setsid sh -c ${shellQuote(pipeline)} >/dev/null 2>&1 &`,
    "else",
    `  setsid ${command} > ${logFile} 2>&1 &`,
    "fi",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
