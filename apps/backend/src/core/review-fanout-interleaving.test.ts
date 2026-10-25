/**
 * Seeded, CI-sized randomised interleavings of the reviewer fan-out
 * (docs/todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md,
 * Code item 4).
 *
 * Each case runs a fixed list of seeds over panels of 2 to 8 reviewers. A seed
 * picks the panel (agents, per-reviewer provider scripts, concurrency limits),
 * the order in which every pending commit and provider call settles, and when
 * cancellation, fence loss and restarts happen. The harness and the invariants
 * it checks are in `review-fanout-interleaving-support.ts`.
 *
 * A failure names its seed. Replay it, or widen the search locally, with
 * `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS`: a count (`=500`) runs seeds 1..N,
 * a comma-separated list (`=17,4242`) runs exactly those.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  interleavingSeeds,
  invariantFailures,
  planScenario,
  runInterleaving,
  type InterleavingResult,
  type ScenarioFlavour,
} from "./review-fanout-interleaving-support.js";

const SEEDS = interleavingSeeds(24);

// The runner logs recoverable faults (deferred result consumption, a failed
// observation checkpoint) by design; the scenarios provoke hundreds of them.
const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

async function runSeed(seed: number, flavour: ScenarioFlavour): Promise<InterleavingResult> {
  const scenario = planScenario(seed, flavour);
  const result = await runInterleaving(scenario);
  const failures = invariantFailures(result);
  if (failures.length > 0) {
    const panel = scenario.reviewers
      .map((plan) => `${plan.id}=${plan.agent}/${plan.script}/r${plan.runningPolls}`)
      .join(", ");
    throw new Error(
      [
        `seed ${seed} (${flavour}) broke ${failures.length} invariant(s).`,
        `Replay: ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=${seed}`,
        `panel: ${panel}`,
        `limits: ${JSON.stringify(scenario.concurrency)}, mode ${scenario.reviewerMode}`,
        `disruptions fired: ${result.fired.join(", ") || "none"}`,
        ...failures.slice(0, 12).map((failure) => `  - ${failure}`),
      ].join("\n"),
    );
  }
  return result;
}

function suite(flavour: ScenarioFlavour, coverage: (results: InterleavingResult[]) => void) {
  const results: InterleavingResult[] = [];
  test.each(SEEDS)("seed %i", async (seed) => {
    results.push(await runSeed(seed, flavour));
  });
  // Guards the harness itself: the seeds must actually reach the interleavings
  // the suite is named for, or a green run proves nothing.
  test("the seeds exercise what the suite is named for", () => {
    if (results.length < SEEDS.length || SEEDS.length < 8) return;
    expect(Math.max(...results.map((result) => result.maxConcurrentReviewers))).toBeGreaterThan(1);
    coverage(results);
  });
}

describe("review fan-out interleavings", () => {
  describe("commit resolution and provider completion", () => {
    suite("plain", (results) => {
      // Every reviewer script and isolation path ran to settlement.
      expect(results.every((result) => result.outcome !== undefined)).toBe(true);
      expect(results.some((result) => result.outcome?.kind === "ready")).toBe(true);
    });
  });

  describe("user cancellation at a random point", () => {
    suite("cancellation", (results) => {
      expect(results.filter((result) => result.cancelled).length).toBeGreaterThan(
        results.length / 2,
      );
      expect(results.some((result) => result.unsettledAtCancel.length > 0)).toBe(true);
    });
  });

  describe("controller fence loss with a concurrent new owner", () => {
    suite("fence-loss", (results) => {
      const fenced = results.filter((result) => result.fired.includes("takeover"));
      expect(fenced.length).toBeGreaterThan(results.length / 2);
      expect(fenced.some((result) => result.owners > 2)).toBe(true);
    });
  });

  describe("backend restart over the last committed state", () => {
    suite("restart", (results) => {
      const crashed = results.filter((result) => result.fired.includes("crash"));
      expect(crashed.length).toBeGreaterThan(results.length / 2);
      // Some crash landed inside an ambiguous send and the provider dropped it.
      expect(
        crashed.some((result) => Object.values(result.ledgers).some((ledger) => ledger.tainted)),
      ).toBe(true);
    });
  });

  describe("cancellation, stop, fence loss and restart together", () => {
    suite("chaos", (results) => {
      expect(results.some((result) => result.fired.length >= 3)).toBe(true);
    });
  });

  // Regression seeds for recovery bugs found by these interleavings.
  describe("runner bugs found by interleaving", () => {
    // Fixed 2026-10-25. Accepting a tool-transport report, `consumeResult` and
    // the `commit()` after it share one try whose catch logged "Deferred
    // result consumption" for every error, a `*FenceError` included, so a
    // takeover while the result was consumed left the fenced runner's pass
    // resolving `ready` (or `working`) instead of rejecting. Durable state was
    // safe, but "a lost fence still propagates" did not hold. Seeds:
    // fence-loss 28, chaos 194.
    test("a fence lost while a result is consumed still ends the pass", async () => {
      for (const [flavour, seed] of [
        ["fence-loss", 28],
        ["chaos", 194],
      ] as const) {
        const result = await runInterleaving(planScenario(seed, flavour));
        expect({
          flavour,
          seed,
          resolved: result.fencedPassesResolved,
        }).toEqual({
          flavour,
          seed,
          resolved: 0,
        });
      }
    });

    // review-fanout.ts, the `dispatchState === "dispatching"` branch: a
    // recovered `dispatching` request becomes `sent` without asking the
    // provider (`dispatchStatus`), and the HTTP bridges have no `settleTurn`.
    // The store can hold `dispatching` for a request that never left:
    // - a peer's commit, saved after this reviewer set `dispatching` in memory
    //   but before its own commit ran, makes it durable; the fence is then
    //   lost (or the backend dies) and this reviewer's own commit and send
    //   never happen (fence-loss 24);
    // - a send refused before the prompt was written resets to `prepared`, but
    //   that commit loses the fence (fence-loss 34);
    // - the backend dies between the durable write and the send (restart 13,
    //   17, 24).
    // The next owner then watches an idle session that was never prompted.
    // A tool-transport reviewer gets the result reminder ("your analysis is
    // already done ... only submit the result") as its first turn, under a
    // new request id. A structured-output reviewer fails as "idle without
    // returning its structured report".
    test("a dispatch that never reached the provider is not treated as sent", async () => {
      for (const [flavour, seed] of [
        ["fence-loss", 24],
        ["fence-loss", 34],
        ["restart", 13],
        ["restart", 17],
        ["restart", 24],
      ] as const) {
        const result = await runInterleaving(planScenario(seed, flavour));
        for (const plan of result.scenario.reviewers) {
          const ledger = result.ledgers[plan.id]!;
          if (ledger.unsentDispatches.length === 0) continue;
          const reviewer = result.committed.reviewers.find(({ id }) => id === plan.id)!;
          expect({
            flavour,
            seed,
            reviewer: plan.id,
            firstTurn: ledger.acceptedKinds[0] ?? "original",
            idleFailure: reviewer.error?.includes("became idle") === true,
          }).toEqual({
            flavour,
            seed,
            reviewer: plan.id,
            firstTurn: "original",
            idleFailure: false,
          });
        }
      }
    });

    // review-fanout.ts, the restart-interruption branch: provider status is per
    // session, not per request. A controller takes over while the old one's
    // restart continuation is still in transit; the new owner turns the durable
    // `dispatching` into `sent` and reads status before the continuation lands,
    // so the bridge still reports the previous turn's `interruption: "restart"`.
    // The runner attributes it to the continuation, finds the continuation
    // spent, and fails the reviewer as restarted twice while its continuation
    // is about to run. Seeds: fence-loss 861, 1251 (outside the CI seed list).
    test("a takeover mid-continuation does not count the old restart twice", async () => {
      for (const seed of [861, 1251]) {
        const result = await runInterleaving(planScenario(seed, "fence-loss"));
        for (const plan of result.scenario.reviewers) {
          if (plan.script !== "restartOnce" || result.ledgers[plan.id]!.staleObservations === 0) {
            continue;
          }
          const reviewer = result.committed.reviewers.find(({ id }) => id === plan.id)!;
          expect({
            seed,
            reviewer: plan.id,
            status: reviewer.status,
          }).toEqual({
            seed,
            reviewer: plan.id,
            status: "completed",
          });
        }
      }
    });
  });

  test("a seed replays the same interleaving", async () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const first = await runInterleaving(planScenario(seed, "chaos"));
      const second = await runInterleaving(planScenario(seed, "chaos"));
      expect(second.trace).toEqual(first.trace);
    }
  });
});
