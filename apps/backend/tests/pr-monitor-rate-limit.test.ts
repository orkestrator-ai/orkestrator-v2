import { describe, expect, test } from "bun:test";
import { isPrReadingConfirmedByMonitor } from "@orkestrator/protocol/pr-merge-readiness";
import type { PrDetection } from "../src/core/pr-monitor";
import { deferred } from "../src/core/recurring-test-support";
import { createLifecycleHarness, localTarget } from "./pr-monitor-test-harness";

/**
 * How the backend PR monitor behaves while GitHub rate-limits its credential:
 * one refusal must not become a burst, repeated refusals back off further, and
 * a reading confirmed just before the limit keeps its "ready to merge" signal
 * for a bounded grace instead of dropping at the first refused poll.
 */

const SCOPE = "local-gh:github.com";
const RATE_LIMITED = "GraphQL: API rate limit already exceeded for user ID 1.";

function prUrlFor(id: string): string {
  return `https://github.com/org/repo/pull/${id}`;
}

function openDetection(id: string): PrDetection {
  return {
    url: prUrlFor(id),
    state: "open",
    hasMergeConflicts: false,
    checkSummary: null,
    checkSummaryStatus: "skipped",
  };
}

function scopedHarness(random?: () => number) {
  return createLifecycleHarness({
    random,
    cooldownScope: (target) => (target.kind === "local" ? SCOPE : null),
  });
}

describe("PR monitor under GitHub rate limits", () => {
  test("checks queued behind a refused one wait out the cooldown instead of bursting", async () => {
    const harness = scopedHarness();
    const ids = ["a", "b", "c", "d", "e"];
    const refusal = deferred<PrDetection | null>();
    const answer = deferred<PrDetection | null>();
    let limited = true;
    for (const id of ids) {
      harness.detectors.set(id, async () => {
        if (id === "a" && limited) return refusal.promise;
        if (id === "b" && !answer.settled) return answer.promise;
        return openDetection(id);
      });
    }
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );

    // All five fall due together; `a` and `b` hold the two admission slots and
    // the rest queue.
    await harness.advance(20_000);
    expect(harness.admission.status()).toMatchObject({ active: 2, waiting: 3 });

    // `a` is refused, then `b` finishes: the three queued checks get their
    // slots inside the cooldown and must not ask GitHub.
    refusal.reject(new Error(RATE_LIMITED));
    await harness.flush();
    answer.resolve(openDetection("b"));
    await harness.flush();
    expect(harness.detections("a")).toBe(1);
    expect(harness.detections("b")).toBe(1);
    for (const id of ["c", "d", "e"]) expect(harness.detections(id)).toBe(0);
    expect(harness.admission.status()).toMatchObject({ active: 0, waiting: 0 });
    // A held check is not a failure: its entry reports no error.
    for (const id of ["c", "d", "e"]) {
      expect(
        harness.service.snapshot().find((entry) => entry.environmentId === id)?.consecutiveErrors,
      ).toBe(0);
    }

    // The scope resumes when the two-minute cooldown ends.
    limited = false;
    await harness.advance(2 * 60_000);
    for (const id of ["a", "c", "d", "e"]) expect(harness.detections(id)).toBeGreaterThan(0);
  });

  test("entries a cooldown held resume spread out, not in the same instant", async () => {
    const samples = [0.1, 0.9, 0.5, 0.3, 0.7];
    let next = 0;
    const harness = scopedHarness(() => samples[next++ % samples.length]!);
    const ids = ["a", "b", "c", "d"];
    let limited = true;
    for (const id of ids) {
      harness.detectors.set(id, async () => {
        if (limited) throw new Error(RATE_LIMITED);
        return openDetection(id);
      });
    }
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );
    await harness.advance(60_000);
    const refusedAt = harness.calls.detect.map((call) => call.at);
    expect(refusedAt.length).toBeGreaterThan(0);

    limited = false;
    await harness.advance(5 * 60_000);
    const resumed = harness.calls.detect.slice(refusedAt.length).map((call) => call.at);
    expect(new Set(resumed.slice(0, ids.length)).size).toBeGreaterThan(1);
    // Spread over at most the resume-jitter window after the cooldown.
    const first = Math.min(...resumed);
    const last = Math.max(...resumed.slice(0, ids.length));
    expect(last - first).toBeLessThanOrEqual(30_000 + 20_000);
  });

  test("rate limits in a row lengthen the cooldown, and a successful check resets it", async () => {
    const harness = scopedHarness();
    let limited = true;
    harness.detectors.set("a", async () => {
      if (limited) throw new Error(RATE_LIMITED);
      return openDetection("a");
    });
    harness.service.sync([harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" })]);

    await harness.advance(20_000);
    for (const minutes of [2, 4, 8, 16, 30, 30]) {
      const before = harness.detections("a");
      await harness.advance(minutes * 60_000 - 1);
      expect(harness.detections("a")).toBe(before);
      await harness.advance(1);
      expect(harness.detections("a")).toBe(before + 1);
    }

    limited = false;
    await harness.advance(30 * 60_000);
    const answered = harness.detections("a");
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(0);

    // The next refusal starts again at two minutes.
    limited = true;
    await harness.advance(20_000);
    expect(harness.detections("a")).toBe(answered + 1);
    await harness.advance(2 * 60_000);
    expect(harness.detections("a")).toBe(answered + 2);
  });

  test("a confirmed reading stays confirmed for the grace while rate limits refuse every poll", async () => {
    const harness = scopedHarness();
    let limited = false;
    harness.detectors.set("a", async () => {
      if (limited) throw new Error(RATE_LIMITED);
      return openDetection("a");
    });
    const target = harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" });
    harness.service.sync([target]);
    const environment = { ...target, environmentType: "local", status: "running" };
    const confirmed = () =>
      isPrReadingConfirmedByMonitor(environment, harness.service.revisionedSnapshot().entries[0]);

    // Answered at t=20 s, then GitHub refuses everything.
    await harness.advance(20_000);
    expect(confirmed()).toBe(true);
    limited = true;
    await harness.advance(20_000);
    expect(harness.detections("a")).toBe(2);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(0);
    expect(confirmed()).toBe(true);

    // Still confirmed just before the grace (15 min from the answered check)
    // ends, despite further refusals; no longer once it has.
    await harness.advance(15 * 60_000 - 20_000 - 1);
    expect(harness.detections("a")).toBeGreaterThan(2);
    expect(confirmed()).toBe(true);
    await harness.advance(1);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBeGreaterThan(0);
    expect(confirmed()).toBe(false);

    // The next answered check confirms it again.
    limited = false;
    harness.service.requestCheck("a");
    await harness.advance(0);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(0);
    expect(confirmed()).toBe(true);
  });

  test("ordinary failures are counted at once, even inside the grace", async () => {
    const harness = scopedHarness();
    let failing = false;
    harness.detectors.set("a", async () => {
      if (failing) throw new Error("gh: HTTP 502 Bad Gateway");
      return openDetection("a");
    });
    harness.service.sync([harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" })]);
    await harness.advance(20_000);
    failing = true;
    await harness.advance(20_000);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(1);
  });

  test("a rate limit with no confirmed reading behind it is counted at once", async () => {
    const harness = scopedHarness();
    harness.detectors.set("a", async () => {
      throw new Error(RATE_LIMITED);
    });
    harness.service.sync([localTarget("a", { prUrl: prUrlFor("a"), prState: "open" })]);
    await harness.advance(20_000);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(1);
  });

  test("pausing drops the grace: a resumed entry must earn a new answer", async () => {
    const harness = scopedHarness();
    let limited = false;
    harness.detectors.set("a", async () => {
      if (limited) throw new Error(RATE_LIMITED);
      return openDetection("a");
    });
    const target = harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" });
    harness.service.sync([target]);
    await harness.advance(20_000);
    harness.service.pause("a");
    limited = true;
    harness.service.sync([target]);
    await harness.advance(60_000);
    expect(harness.detections("a")).toBe(2);
    expect(harness.service.snapshot()[0]?.consecutiveErrors).toBe(1);
  });
});
