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
/**
 * Seeds past the default range that once broke an invariant, run on every
 * default (unconfigured) CI run alongside it. Keyed by flavour.
 */
const REGRESSION_SEEDS: Partial<Record<ScenarioFlavour, readonly number[]>> = process.env
  .ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS
  ? {}
  : // 0112: a takeover mid-continuation counted the old restart twice.
    { "fence-loss": [861, 1251] };

// The runner logs recoverable faults (deferred result consumption, a failed
// observation checkpoint) by design; the scenarios provoke hundreds of them.
const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

async function runSeed(
  seed: number,
  flavour: ScenarioFlavour,
  provesAbsence = false,
): Promise<InterleavingResult> {
  const scenario = { ...planScenario(seed, flavour), ...(provesAbsence ? { provesAbsence } : {}) };
  const result = await runInterleaving(scenario);
  const failures = invariantFailures(result);
  if (failures.length > 0) {
    const panel = scenario.reviewers
      .map((plan) => `${plan.id}=${plan.agent}/${plan.script}/r${plan.runningPolls}`)
      .join(", ");
    throw new Error(
      [
        `seed ${seed} (${flavour}${provesAbsence ? ", proves absence" : ""}) broke ${
          failures.length
        } invariant(s).`,
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

function suite(
  flavour: ScenarioFlavour,
  coverage: (results: InterleavingResult[]) => void,
  provesAbsence = false,
) {
  const results: InterleavingResult[] = [];
  test.each([...SEEDS, ...(provesAbsence ? [] : (REGRESSION_SEEDS[flavour] ?? []))])(
    "seed %i",
    async (seed) => {
      results.push(await runSeed(seed, flavour, provesAbsence));
    },
  );
  // Guards the harness itself: the seeds must actually reach the interleavings
  // the suite is named for, or a green run proves nothing.
  test("the seeds exercise what the suite is named for", () => {
    if (results.length < SEEDS.length || SEEDS.length < 8) return;
    // A continuation journaled before its turn started was read at least once
    // while status still described the restart it continues (0112).
    expect(
      results.some((result) =>
        Object.values(result.ledgers).some((ledger) => ledger.lateStartReads > 0),
      ),
    ).toBe(true);
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

  // 0223: the provider proves an id never arrived, so a recovered request is
  // re-sent under the same id; a crash can leave the first send on the wire,
  // and its late delivery must be the provider's duplicate, never a turn.
  describe("a provider that proves an id never arrived", () => {
    for (const flavour of ["restart", "chaos"] as const) {
      describe(flavour, () => {
        suite(
          flavour,
          (results) => {
            const ledgers = results.flatMap((result) => Object.values(result.ledgers));
            expect(ledgers.some((ledger) => ledger.absentAnswers > 0)).toBe(true);
            expect(ledgers.some((ledger) => ledger.lateDeliveries > 0)).toBe(true);
            expect(ledgers.some((ledger) => ledger.duplicateDeliveries > 0)).toBe(true);
          },
          true,
        );
      });
    }
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

    // Fixed 2026-10-26 (0112, item 1). The store can hold `dispatching` for a
    // request that never left:
    // - a peer's commit, saved after this reviewer set `dispatching` in memory
    //   but before its own commit ran, made it durable; the fence was then
    //   lost and this reviewer's own commit and send never happened. Fixed by
    //   applying `dispatching` inside the reviewer's own serialized commit; the
    //   harness now fails any seed without a crash that leaves one behind;
    // - a send refused before the prompt was written resets to `prepared`, but
    //   that commit loses the fence (fence-loss 24, 34);
    // - the backend dies between the durable write and the send (restart 13,
    //   17, 24).
    // The next owner used to watch an idle session that was never prompted: a
    // tool-transport reviewer got the result reminder as its first turn, and a
    // structured-output reviewer failed as idle without its report. Now only
    // the provider's own proof (`dispatched`, or a result for this exact
    // request) promotes the request; otherwise it parks and fails closed,
    // because no provider can yet prove an id never arrived (todo 0223).
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

    // Fixed 2026-10-26 (0112, item 2). Provider status is per session, not per
    // request: a new owner that read status after the continuation was
    // journaled but before its turn started still saw the previous turn's
    // `interruption: "restart"`, attributed it to the continuation, found the
    // continuation spent and failed the reviewer as restarted twice. The
    // Claude and Codex bridges now name the interrupted request
    // (`interruptedRequestId`), and `readProviderStatus` reads a notice about
    // another request, while the provider reports this one in flight, as
    // "this request's turn has not settled". The harness
    // models the late start on half of all continuations. Seeds: fence-loss 861,
    // 1251, also in the fence-loss suite's CI list.
    test("a takeover mid-continuation does not count the old restart twice", async () => {
      for (const seed of [861, 1251]) {
        const result = await runInterleaving(planScenario(seed, "fence-loss"));
        let continued = 0;
        for (const plan of result.scenario.reviewers) {
          if (
            plan.script !== "restartOnce" ||
            result.ledgers[plan.id]!.accepted.continuation === 0
          ) {
            continue;
          }
          continued += 1;
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
        expect(continued).toBeGreaterThan(0);
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
