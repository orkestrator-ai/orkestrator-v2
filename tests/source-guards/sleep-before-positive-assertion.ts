import type { SourceGuard } from "./guard";
import { mayHaveSleepAssertion, visitSleepWindows } from "./sleep-before-negative-assertion";

/**
 * The mirror of `sleep-before-negative-assertion`: a fixed sleep followed only
 * by checks that something did happen. The sleep is a guess at how long the
 * work takes, so a loaded host fails the test while the work is still on its
 * way. A sleep that a negative assertion also follows is that guard's finding,
 * not this one's, so no sleep is counted twice.
 */
export const sleepBeforePositiveAssertion: SourceGuard = {
  id: "sleep-before-positive-assertion",
  advice:
    "A fixed sleep followed by a check that something happened is a guess at how long the " +
    "work takes; a loaded host makes the guess wrong and the test fails while the work is " +
    "still running. Wait for the event itself (an awaited promise, waitFor, a release " +
    "signal), or drive the delay with ManualClock (@orkestrator/protocol/testing/manual-clock) " +
    "or installControlledTimeout (tests/helpers/controlled-timeout.ts), then assert. See " +
    "docs/development/testing-guide.md, 'Controlled time'.",
  appliesTo: () => true,
  mayOffend: mayHaveSleepAssertion,
  visit: (_program, file) =>
    visitSleepWindows(file, (window) => window.positive && !window.negative),
};
