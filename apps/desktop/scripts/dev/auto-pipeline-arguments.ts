/**
 * Arguments and environment for `mise run test:agent:auto-pipeline`
 * (`test-agent-auto-pipeline.ts`), kept here so they are unit-tested
 * (`auto-pipeline-arguments.test.ts`) rather than exercised only by a live run.
 */

export type AutoPipelineArguments = {
  /** Whether this is the supervisor's child (the flag it prepends when re-running the script). */
  supervised: boolean;
  /** The review panel size, `"1"` to `"4"`: passed on as an environment value. */
  reviewers: string;
};

/**
 * `[<supervised flag>] [--reviewers <1-4>]`, in that order. Anything else
 * throws, so a typo cannot silently run the default single reviewer.
 */
export function parseAutoPipelineArguments(
  argv: readonly string[],
  supervisedFlag: string,
): AutoPipelineArguments {
  const args = [...argv];
  const supervised = args[0] === supervisedFlag;
  if (supervised) args.shift();
  let reviewers = "1";
  if (args[0] === "--reviewers") {
    reviewers = args[1] ?? "";
    args.splice(0, 2);
  }
  if (!/^[1-4]$/.test(reviewers)) throw new Error("--reviewers takes a count from 1 to 4");
  if (args.length > 0)
    throw new Error(`test:agent:auto-pipeline takes only --reviewers <n> (got ${args[0]})`);
  return { supervised, reviewers };
}

/**
 * The caller's `ORKESTRATOR_LOG_LEVEL` with `build-pipeline=debug` appended,
 * so the review fan-out's per-pass prompt-reads line reaches the profile log.
 * Later entries win for the same area, so it holds even over a caller's own
 * `build-pipeline` level, and every other entry the caller set is kept.
 */
export function autoPipelineLogLevel(callerLevel: string | undefined): string {
  return [callerLevel, "build-pipeline=debug"].filter(Boolean).join(",");
}
