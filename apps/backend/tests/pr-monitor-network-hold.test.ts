import { describe, expect, test } from "bun:test";
import type { PrDetection } from "../src/core/pr-monitor";
import { deferred } from "../src/core/recurring-test-support";
import { createLifecycleHarness } from "./pr-monitor-test-harness";

/**
 * How the backend PR monitor behaves when GitHub cannot be reached: the first
 * check to find the outage holds the background checks of its network scope,
 * so a dozen environments do not each find it (and each count a failed
 * detection) on their own.
 */

/** What `gh` prints when it cannot reach GitHub. */
const UNREACHABLE = "error connecting to api.github.com\ncheck your internet connection";
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

/** Time of every detection of an environment, relative to `start`. */
function detectionTimes(
  harness: ReturnType<typeof createLifecycleHarness>,
  id: string,
  start: number,
): number[] {
  return harness.calls.detect
    .filter((call) => call.environmentId === id)
    .map((call) => call.at - start);
}

/** Fails `id`'s check interactively, one strike per call, each after the last. */
async function failInteractively(
  harness: ReturnType<typeof createLifecycleHarness>,
  id: string,
  times: number,
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    harness.service.requestCheck(id);
    await harness.advance(0);
    await harness.flush();
  }
}

function errorsOf(harness: ReturnType<typeof createLifecycleHarness>, id: string) {
  return harness.service.snapshot().find((entry) => entry.environmentId === id)?.consecutiveErrors;
}

describe("PR monitor while GitHub is unreachable", () => {
  test("checks that fall due after one could not reach GitHub wait out the hold", async () => {
    const harness = createLifecycleHarness();
    const ids = ["a", "b", "c", "d"];
    let offline = true;
    for (const id of ids) {
      harness.detectors.set(id, async () => {
        if (offline && id === "a") throw new Error(UNREACHABLE);
        return openDetection(id);
      });
    }
    harness.service.sync(
      ids.map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );

    // All four fall due together; `a` goes first and cannot reach GitHub, so
    // the other three come due inside the hold and do not ask.
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("a")).toBe(1);
    for (const id of ["b", "c", "d"]) expect(harness.detections(id)).toBe(0);
    expect(errorsOf(harness, "a")).toBe(1);
    // A held check is not a failure.
    for (const id of ["b", "c", "d"]) expect(errorsOf(harness, id)).toBe(0);
    const failedBefore = harness.metrics.snapshot().kinds["pr-detection"]?.failed;
    expect(failedBefore).toBe(1);

    // Nothing else in the scope asks GitHub until the 30-second hold ends.
    await harness.advance(29_000);
    for (const id of ["b", "c", "d"]) expect(harness.detections(id)).toBe(0);

    offline = false;
    await harness.advance(60_000);
    expect(harness.detections("a")).toBeGreaterThan(1);
    for (const id of ["b", "c", "d"]) expect(harness.detections(id)).toBeGreaterThan(0);
    for (const id of ids) expect(errorsOf(harness, id)).toBe(0);
    harness.service.shutdown();
  });

  test("a timeout holds the scope as well", async () => {
    const harness = createLifecycleHarness();
    const timedOut = Object.assign(new Error("Command failed"), { timedOut: true });
    harness.detectors.set("a", async () => {
      throw timedOut;
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.detectors.set("c", async () => openDetection("c"));
    harness.service.sync(
      ["a", "b", "c"].map((id) =>
        harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
      ),
    );
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("a")).toBe(1);
    expect(harness.detections("c")).toBe(0);
    harness.service.shutdown();
  });

  test("an interactive refresh still asks GitHub during the hold", async () => {
    const harness = createLifecycleHarness();
    harness.detectors.set("a", async () => {
      throw new Error(UNREACHABLE);
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.service.sync([
      harness.addEnvironment("a", { prUrl: prUrlFor("a"), prState: "open" }),
      harness.addEnvironment("b", { prUrl: prUrlFor("b"), prState: "open" }, { branch: "x" }),
    ]);
    // Only `a` falls due first, so `b` has not started when the hold begins.
    harness.service.requestCheck("a");
    await harness.advance(0);
    expect(harness.detections("a")).toBe(1);
    const before = harness.detections("b");

    harness.service.requestCheck("b");
    await harness.advance(0);
    expect(harness.detections("b")).toBe(before + 1);
    harness.service.shutdown();
  });

  test("a check that started after the hold and succeeded ends it", async () => {
    const harness = createLifecycleHarness();
    let offline = true;
    for (const id of ["a", "b", "c"]) {
      harness.detectors.set(id, async () => {
        if (offline && id === "a") throw new Error(UNREACHABLE);
        return openDetection(id);
      });
    }
    harness.service.sync(
      ["a", "b", "c"].map((id) =>
        harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
      ),
    );
    harness.service.requestCheck("a");
    await harness.advance(0);
    expect(harness.detections("a")).toBe(1);

    // The user refreshes `b` and GitHub answers: the network is back.
    offline = false;
    harness.service.requestCheck("b");
    await harness.advance(0);
    expect(errorsOf(harness, "b")).toBe(0);

    // `c` falls due on its ordinary schedule and is no longer held.
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("c")).toBeGreaterThan(0);
    harness.service.shutdown();
  });

  test("a success already in flight when GitHub became unreachable does not end the hold", async () => {
    const harness = createLifecycleHarness();
    const inFlight = deferred<PrDetection | null>();
    const refusal = deferred<PrDetection | null>();
    harness.detectors.set("a", () => refusal.promise);
    harness.detectors.set("b", () => inFlight.promise);
    harness.detectors.set("c", async () => openDetection("c"));
    const targets = ["a", "b"].map((id) =>
      harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
    );
    harness.service.sync(targets);
    await harness.advance(20_000);
    expect(harness.admission.status()).toMatchObject({ active: 2, waiting: 0 });

    // `a` cannot reach GitHub while `b`, which started earlier, then succeeds.
    refusal.reject(new Error(UNREACHABLE));
    await harness.flush();
    inFlight.resolve(openDetection("b"));
    await harness.flush();

    // `c` joins and falls due 20 s later, inside the 30-second hold, which
    // `b`'s earlier success did not lift.
    harness.service.sync([
      ...targets,
      harness.addEnvironment("c", { prUrl: prUrlFor("c"), prState: "open" }),
    ]);
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("c")).toBe(0);
    harness.service.shutdown();
  });

  test("a container that cannot reach GitHub holds only itself", async () => {
    const harness = createLifecycleHarness();
    const refusal = deferred<PrDetection | null>();
    harness.detectors.set("boxed", () => refusal.promise);
    harness.detectors.set("other-box", async () => openDetection("other-box"));
    harness.detectors.set("local", async () => openDetection("local"));
    harness.service.sync([
      harness.addEnvironment(
        "boxed",
        { prUrl: prUrlFor("boxed"), prState: "open" },
        { kind: "container", containerId: "c-1", worktreePath: undefined },
      ),
      harness.addEnvironment(
        "other-box",
        { prUrl: prUrlFor("other-box"), prState: "open" },
        { kind: "container", containerId: "c-2", worktreePath: undefined },
      ),
      harness.addEnvironment("local", { prUrl: prUrlFor("local"), prState: "open" }),
    ]);
    harness.service.requestCheck("boxed");
    await harness.advance(0);
    refusal.reject(new Error(UNREACHABLE));
    await harness.flush();

    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("other-box")).toBeGreaterThan(0);
    expect(harness.detections("local")).toBeGreaterThan(0);
    harness.service.shutdown();
  });

  test("each failure from a check started after the last one lengthens the hold", async () => {
    const harness = createLifecycleHarness();
    const start = harness.time.now();
    harness.detectors.set("a", async () => {
      throw new Error(UNREACHABLE);
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.service.sync(
      ["a", "b"].map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );

    // Three failures in a row: 30 s, then 60 s, then 120 s from the third.
    await failInteractively(harness, "a", 3);
    expect(harness.detections("a")).toBe(3);

    // `b` falls due at 20 s and waits for the 120-second hold, not the first 30.
    await harness.advance(119_000);
    await harness.flush();
    expect(harness.detections("b")).toBe(0);
    await harness.advance(2_000);
    await harness.flush();
    expect(detectionTimes(harness, "b", start)).toEqual([120_000]);
    harness.service.shutdown();
  });

  test("ending a long hold resumes the checks it already held, not at its old deadline", async () => {
    const harness = createLifecycleHarness();
    const start = harness.time.now();
    let offline = true;
    harness.detectors.set("a", async () => {
      if (offline) throw new Error(UNREACHABLE);
      return openDetection("a");
    });
    harness.detectors.set("b", async () => openDetection("b"));
    let limited = true;
    harness.detectors.set("d", async () => {
      if (limited) throw new Error(RATE_LIMITED);
      return openDetection("d");
    });
    harness.service.sync(
      ["a", "b", "d"].map((id) =>
        harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
      ),
    );

    // `d` is rate-limited on its own: a two-minute cooldown of its own.
    harness.service.requestCheck("d");
    await harness.advance(0);
    await harness.flush();
    limited = false;
    // Five network failures in a row: a five-minute hold.
    await failInteractively(harness, "a", 5);

    // `b` falls due at 20 s and is held towards the 300-second deadline.
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("b")).toBe(0);

    // At 21 s the user refreshes `a` and GitHub answers: the network is back.
    await harness.advance(1_000);
    offline = false;
    harness.service.requestCheck("a");
    await harness.advance(0);
    await harness.flush();
    expect(errorsOf(harness, "a")).toBe(0);

    // `b` resumes straight away (resume jitter is 0 here), not at 300 s.
    await harness.flush();
    expect(detectionTimes(harness, "b", start)).toEqual([21_000]);

    // `d` still waits out its own rate-limit cooldown, then asks again.
    await harness.advance(98_000);
    await harness.flush();
    expect(harness.detections("d")).toBe(1);
    await harness.advance(2_000);
    await harness.flush();
    expect(detectionTimes(harness, "d", start)).toEqual([0, 120_000]);
    harness.service.shutdown();
  });

  test("a rate limit during a hold keeps its own cooldown and does not lengthen the hold", async () => {
    const harness = createLifecycleHarness();
    const start = harness.time.now();
    let offline = true;
    harness.detectors.set("a", async () => {
      if (offline) throw new Error(UNREACHABLE);
      return openDetection("a");
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.detectors.set("c", async () => {
      throw new Error(RATE_LIMITED);
    });
    harness.service.sync(
      ["a", "b", "c"].map((id) =>
        harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
      ),
    );
    await failInteractively(harness, "a", 1);
    offline = false;

    // Inside the hold `c` is refreshed and rate-limited.
    await harness.advance(1_000);
    harness.service.requestCheck("c");
    await harness.advance(0);
    await harness.flush();
    expect(harness.detections("c")).toBe(1);

    // The hold still ends at 30 s: `b`, due at 20 s, resumes then.
    await harness.advance(28_000);
    await harness.flush();
    expect(harness.detections("b")).toBe(0);
    await harness.advance(2_000);
    await harness.flush();
    expect(detectionTimes(harness, "b", start)[0]).toBe(30_000);

    // `c` waits for its two-minute cooldown, which outlasts the hold.
    await harness.advance(89_000);
    await harness.flush();
    expect(harness.detections("c")).toBe(1);
    await harness.advance(2_000);
    await harness.flush();
    expect(detectionTimes(harness, "c", start)).toEqual([1_000, 121_000]);
    harness.service.shutdown();
  });

  test("an agent-completion wake during a hold waits it out, then still runs", async () => {
    const harness = createLifecycleHarness();
    const start = harness.time.now();
    harness.detectors.set("a", async () => {
      throw new Error(UNREACHABLE);
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.service.sync(
      ["a", "b"].map((id) => harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" })),
    );
    await failInteractively(harness, "a", 1);

    await harness.advance(5_000);
    harness.service.wakeForCompletion(harness.targets(["b"])[0]!);
    await harness.advance(0);
    await harness.flush();
    expect(harness.detections("b")).toBe(0);

    await harness.advance(24_000);
    await harness.flush();
    expect(harness.detections("b")).toBe(0);
    await harness.advance(2_000);
    await harness.flush();
    expect(detectionTimes(harness, "b", start)).toEqual([30_000]);
    // It is still the completion check: a fresh read with the rollup.
    const [first] = harness.calls.detect.filter((call) => call.environmentId === "b");
    expect(first?.options).toMatchObject({ includeCheckSummary: true, fresh: true });
    harness.service.shutdown();
  });

  test("one unreachable GitHub host does not hold, or get released by, another host", async () => {
    const harness = createLifecycleHarness();
    const enterprise = (id: string) => `https://ghe.example.com/org/repo/pull/${id}`;
    harness.detectors.set("ghe-1", async () => {
      throw new Error(UNREACHABLE);
    });
    harness.detectors.set("ghe-2", async () => ({
      ...openDetection("ghe-2"),
      url: enterprise("2"),
    }));
    harness.detectors.set("dotcom", async () => openDetection("dotcom"));
    harness.service.sync([
      harness.addEnvironment("ghe-1", { prUrl: enterprise("1"), prState: "open" }),
      harness.addEnvironment("ghe-2", { prUrl: enterprise("2"), prState: "open" }),
      harness.addEnvironment("dotcom", { prUrl: prUrlFor("dotcom"), prState: "open" }),
    ]);
    await failInteractively(harness, "ghe-1", 1);

    // github.com is not delayed by the Enterprise host's outage, and its
    // success does not end the Enterprise hold.
    await harness.advance(20_000);
    await harness.flush();
    expect(harness.detections("dotcom")).toBe(1);
    expect(harness.detections("ghe-2")).toBe(0);
    await harness.advance(9_000);
    await harness.flush();
    expect(harness.detections("ghe-2")).toBe(0);
    await harness.advance(2_000);
    await harness.flush();
    expect(harness.detections("ghe-2")).toBe(1);
    harness.service.shutdown();
  });

  test("a failure that is not a network failure holds nobody else", async () => {
    const harness = createLifecycleHarness();
    harness.detectors.set("a", async () => {
      throw new Error("gh unavailable");
    });
    harness.detectors.set("b", async () => openDetection("b"));
    harness.detectors.set("c", async () => openDetection("c"));
    harness.service.sync(
      ["a", "b", "c"].map((id) =>
        harness.addEnvironment(id, { prUrl: prUrlFor(id), prState: "open" }),
      ),
    );
    await harness.advance(20_000);
    await harness.flush();
    for (const id of ["a", "b", "c"]) expect(harness.detections(id)).toBe(1);
    harness.service.shutdown();
  });
});
