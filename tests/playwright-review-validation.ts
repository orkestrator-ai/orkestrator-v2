import type { PlaywrightTestConfig } from "@playwright/test";

// Review validation writes each command's output to a log file and kills the
// command when its budget runs out. A browser suite on the `line` reporter
// printed nothing useful there: outside a terminal it names a test only when
// it fails, and a run killed from outside never printed which tests were still
// running (a 20-minute timeout left no output at all). So in review validation
// the browser configs use the `list` reporter, one plain line per finished test
// with its status and duration, and stop themselves through Playwright's
// `globalTimeout` a minute before the worker's deadline, so Playwright's own
// report names the tests it interrupted.

/** How long before the worker's deadline Playwright stops the run. */
export const REVIEW_VALIDATION_DEADLINE_MARGIN_MS = 60_000;
/** The shortest run Playwright is given, however close the deadline. */
export const REVIEW_VALIDATION_MIN_GLOBAL_TIMEOUT_MS = 60_000;

export type ReviewValidationRunOptions = Pick<PlaywrightTestConfig, "reporter" | "globalTimeout">;

/**
 * The reporter and global timeout to spread into `defineConfig`. Outside
 * review validation it keeps `defaultReporter` and sets no global timeout.
 * `ORKESTRATOR_VALIDATION_DEADLINE_MS` is the epoch millisecond at which the
 * review-validation worker kills the command; an absent, malformed or past
 * value sets no global timeout.
 */
export function reviewValidationRunOptions(
  defaultReporter: PlaywrightTestConfig["reporter"],
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): ReviewValidationRunOptions {
  if (env.ORKESTRATOR_REVIEW_VALIDATION !== "1") return { reporter: defaultReporter };
  const raw = env.ORKESTRATOR_VALIDATION_DEADLINE_MS?.trim() ?? "";
  const deadline = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(deadline) || deadline <= now) return { reporter: "list" };
  return {
    reporter: "list",
    globalTimeout: Math.max(
      REVIEW_VALIDATION_MIN_GLOBAL_TIMEOUT_MS,
      deadline - now - REVIEW_VALIDATION_DEADLINE_MARGIN_MS,
    ),
  };
}
