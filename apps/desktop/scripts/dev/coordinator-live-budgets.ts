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
  // asyncCase has seven sequential step waits.
  const waits: Record<CoordinatorLiveScenario, number> = {
    "read-only": turn,
    async: step * 7,
    family: step * 2 + family,
    // Two environment starts, then the exchange.
    peer: step * 2 + peer,
  };
  const overhead = 240_000;
  const processMargin = 120_000;
  const tests = Object.fromEntries(
    Object.entries(waits).map(([scenario, wait]) => [scenario, wait + overhead]),
  ) as Record<CoordinatorLiveScenario, number>;
  return { turn, step, family, peer, waits, tests, overhead, processMargin };
}

export function coordinatorLiveRunnerTimeout(
  scenarios: readonly CoordinatorLiveScenario[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { tests, processMargin } = coordinatorLiveBudgets(env);
  return scenarios.reduce((total, scenario) => total + tests[scenario] + processMargin, 0);
}
