/**
 * Progress output for package test runs that hide passing tests.
 *
 * The aggregate (`scripts/test-all.ts`) stops a group that prints nothing for
 * five minutes. A package suite run with `--only-failures` prints only its
 * startup banner while every test passes, so on a loaded host a healthy suite
 * that simply runs longer than the watchdog was killed as if it had hung
 * (flakes 0262, 0164 and 0233). That made the outcome depend on how busy the
 * machine was.
 *
 * Bun's dots reporter prints one `.` to stderr per finished test, so output
 * now tracks real progress: a slow suite keeps the watchdog fed for as long as
 * tests keep finishing, and a hung one still goes silent and is stopped.
 * Failures are reported exactly as before. Turbo forwards a task's output a
 * line at a time, so each run of dots is closed with a newline; anything else
 * passes through untouched.
 */

const REPORTER_FLAG = /^--(?:dots|reporter)(?:=|$)/;
const DOTS_ONLY = /^\.+$/;

/** Adds `--dots` to a run that hides passing tests and names no reporter. */
export function withProgressDots(flags: readonly string[]): string[] {
  if (!flags.includes("--only-failures")) return [...flags];
  if (flags.some((flag) => REPORTER_FLAG.test(flag))) return [...flags];
  return [...flags, "--dots"];
}

/** Closes a chunk made only of progress dots with a newline. */
export function terminateDotRun(chunk: string): string {
  return DOTS_ONLY.test(chunk) ? `${chunk}\n` : chunk;
}

/**
 * Copies a child's stream to `write`, closing each run of dots. Decoding is
 * streaming, so a multi-byte character split across chunks is preserved.
 */
export async function forwardWithDotLines(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) write(terminateDotRun(text));
  }
  const rest = decoder.decode();
  if (rest) write(rest);
}
