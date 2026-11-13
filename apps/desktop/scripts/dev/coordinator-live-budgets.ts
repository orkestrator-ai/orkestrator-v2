import type { CoordinatorLiveScenario } from "./coordinator-live.js";

/** Shared by the Node Playwright spec and the Bun profile runner. */
export function coordinatorLiveBudgets(env: NodeJS.ProcessEnv = process.env) {
  const positive = (key: string, fallback: number) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const turn = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_TURN_TIMEOUT_MS", 600_000);
  const step = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS", 600_000);
  const family = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_FAMILY_TIMEOUT_MS", 2_100_000);
  const peer = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_PEER_TIMEOUT_MS", 1_800_000);
  // A real Multi Review (reviewers, consolidation, then the Fix turn).
  const review = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_REVIEW_TIMEOUT_MS", 2_700_000);
  // A whole build pipeline: build, Multi Review, its fix, verify.
  const build = positive("ORKESTRATOR_AGENT_TEST_COORDINATOR_BUILD_TIMEOUT_MS", 3_600_000);
  // asyncCase has seven sequential step waits.
  const waits: Record<CoordinatorLiveScenario, number> = {
    "read-only": turn,
    // One turn: a research call or two and the report line.
    research: turn,
    async: step * 7,
    family: step * 2 + family,
    // Waiter startup uses the turn budget; launch/review/delegation waits use five steps.
    status: turn + step * 5 + review,
    // Native: five turns or waits and the wake; Claude's terminal case: five more.
    "deliver-now": step * 12,
    // Launch, its wake, the set turn, then the goal's turns and wake (three steps).
    goal: step * 6,
    // Four request turns, four quiet waits and the worker's report, then the build.
    routing: step * 9 + build,
    // The surfaces turn, the wait for its request, then the outcome and its wake (two steps).
    surfaces: step * 4,
    // Seven turns, the launch wake, the long turn's start, the stop wake and the command.
    "gap-tools": step * 11,
    // Three probes (reviewer, builder, researcher), each an environment start and one node turn.
    "graph-profiles": step * 6,
    // The delegate-and-ask turn, the worker's wake and the settle after it.
    ask: step * 3,
    // Three tab turns, the idle-policy mail turn and the resumed tab's turn.
    identity: step * 5,
    // Per phase: the set turn, the timer and its wake, the switch's outcome.
    "account-switch": step * 8,
    // Two environment starts, then the exchange.
    peer: step * 2 + peer,
  };
  const overhead = 240_000;
  const processMargin = 120_000;
  const tests = Object.fromEntries(
    Object.entries(waits).map(([scenario, wait]) => [scenario, wait + overhead]),
  ) as Record<CoordinatorLiveScenario, number>;
  return { turn, step, family, peer, review, build, waits, tests, overhead, processMargin };
}

export function coordinatorLiveRunnerTimeout(
  scenarios: readonly CoordinatorLiveScenario[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { tests, processMargin } = coordinatorLiveBudgets(env);
  return scenarios.reduce((total, scenario) => total + tests[scenario] + processMargin, 0);
}
