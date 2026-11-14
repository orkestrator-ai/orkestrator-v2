/**
 * Automatic switching's resend across a real bridge replacement: real bridges and
 * the pinned CLIs, with the provider's servers scripted, so no turn is billed and no
 * real login is read. See `account-switch-stack.ts` for what this can and cannot say.
 *
 * Each platform has its own `account-switch-<platform>-live.test.ts` that calls
 * `defineAccountSwitchSuite`, so `bun test --parallel` runs the platforms on separate
 * workers. Within a platform the scenarios are `test.concurrent`: each one boots its
 * own host (own temp root, HOME, data dir, port 0), so they overlap, and the 20 s
 * settle window that proves "no second resend" is waited out by all of them at once.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import type { StackEvidence, StackPlatform } from "./account-switch-stack";
import {
  buildBridgeIfStale,
  CLIS,
  runScenario,
  SCENARIO_TIMEOUT_MS,
} from "./account-switch-resend-runner";

/** One refused call on the first account, and the turn that continued it on the next. */
function expectContinuedOnNewAccount(evidence: StackEvidence, expectedResends = 1): void {
  expect(evidence.active).toBe("later");
  expect(evidence.lastSwitchReason).toBe("limit");
  expect(evidence.pinned).toBe(false);
  expect(evidence.loginsUnchanged).toBe(true);
  // The process that took the refusal is gone, and a new one served the resend.
  expect(evidence.bridgePids.length).toBeGreaterThanOrEqual(2);
  const refused = evidence.calls.filter((call) => call.refused);
  expect(refused.length).toBeGreaterThanOrEqual(1);
  expect(refused.every((call) => call.account === "soonest")).toBe(true);
  const resent = evidence.calls.filter((call) => call.resendTurn);
  expect(resent).toHaveLength(expectedResends);
  for (const call of resent) {
    expect(call.account).toBe("later");
    expect(call.refused).toBe(false);
    // Read back from the shared transcript exactly once: continued, not run twice.
    expect(call.stoppedPromptCopies).toBe(1);
  }
}

function expectOneModeAcrossTheMove(evidence: StackEvidence): void {
  const modes = new Set(evidence.launches.map((launch) => launch.permissionMode));
  expect(modes.size).toBe(1);
}

export function defineAccountSwitchSuite(platform: StackPlatform): void {
  describe(`automatic switching on the pinned ${platform}`, () => {
    // Concurrent tests all start together, so a missing CLI skips them all alike.
    const scenarioTest = CLIS[platform] ? test.concurrent : test.skip;

    beforeAll(() => {
      if (CLIS[platform]) buildBridgeIfStale(platform);
    });

    scenarioTest(
      "a native tab continues on the new account after a real bridge replacement",
      async () => {
        const evidence = await runScenario(platform, "native-build");
        expectContinuedOnNewAccount(evidence);
        expectOneModeAcrossTheMove(evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "a planning turn stays a planning turn when it is resent",
      async () => {
        const evidence = await runScenario(platform, "native-plan-turn");
        expectContinuedOnNewAccount(evidence);
        const resent = evidence.calls.find((call) => call.resendTurn)!;
        if (platform === "claude") {
          expect(evidence.launches.at(-1)).toMatchObject({
            account: "later",
            permissionMode: "plan",
            resumed: true,
          });
        } else {
          expect(resent.plan).toBe(true);
        }
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "two tabs stopped together each continue once",
      async () => {
        const evidence = await runScenario(platform, "native-two-tabs");
        expectContinuedOnNewAccount(evidence, 2);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "a 5-hour refusal continues on the new account",
      async () => {
        const evidence = await runScenario(platform, "native-five-hour");
        expectContinuedOnNewAccount(evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "another limit moves nothing and resends nothing",
      async () => {
        const evidence = await runScenario(platform, "native-other-limit");
        expect(evidence.active).toBe("soonest");
        expect(evidence.lastSwitchReason).toBeUndefined();
        expect(evidence.bridgePids).toHaveLength(1);
        expect(evidence.calls).toHaveLength(1);
        // It looked, rather than moving or staying on the error's words alone.
        expect(evidence.usageReadsAfterRefusal).toBeGreaterThanOrEqual(1);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "with every account out, one resend is refused and nothing more happens",
      async () => {
        const evidence = await runScenario(platform, "native-all-out");
        expect(evidence.calls.map((call) => [call.account, call.refused])).toEqual([
          ["soonest", true],
          ["later", true],
        ]);
        expect(evidence.calls.filter((call) => call.resendTurn)).toHaveLength(1);
        expect(evidence.loginsUnchanged).toBe(true);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenarioTest(
      "two reviewers on one bridge each continue once, still read-only",
      async () => {
        const evidence = await runScenario(platform, "graph-panel");
        expectContinuedOnNewAccount(evidence, 2);
        expect(evidence.bridgePids).toHaveLength(2);
        expectOneModeAcrossTheMove(evidence);
        if (platform === "claude") expect(evidence.launches[0]?.permissionMode).toBe("dontAsk");
      },
      SCENARIO_TIMEOUT_MS,
    );

    for (const scenario of ["multi-review", "build-pipeline", "graph-run"] as const) {
      scenarioTest(
        `a ${scenario} continues on the new account after a real bridge replacement`,
        async () => {
          const evidence = await runScenario(platform, scenario);
          expectContinuedOnNewAccount(evidence);
          expectOneModeAcrossTheMove(evidence);
        },
        SCENARIO_TIMEOUT_MS,
      );
    }
  });
}
