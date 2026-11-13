/**
 * The pure parts of the two-node checks of to-dos 1030 (tasks 2, 7) and 4860 (task 2): the
 * goal `scripts/qa-remote-goal-hold.ts` gives the leaf's worker (a goal the
 * leaf's own goal service accepts as running, held by a check that waits for
 * a file), and how the mixed-version `nodes` module reads a coordinator's
 * `list_nodes` machine entry (`scripts/mixed-version/scenarios/coordinator-list-nodes.ts`).
 * The live runs themselves need two backends and are recorded in the docs.
 */
import { describe, expect, test } from "bun:test";

import { goalIsRunning, isNativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";

import {
  hasReadings,
  machineEvidence,
  type ListedMachine,
} from "../../scripts/mixed-version/scenarios/coordinator-list-nodes";
import { heldGoal, waitForFileCheck } from "../../scripts/qa-remote-goal-hold";

describe("the remote goal hold's seeded goal", () => {
  test("is a valid running goal on the session's own provider session", () => {
    const goal = heldGoal({
      providerSessionId: "provider-1",
      check: waitForFileCheck("/work/release"),
      now: new Date("2026-11-13T00:00:00Z"),
    });
    expect(isNativeAgentGoal(goal)).toBe(true);
    expect(goalIsRunning(goal.status)).toBe(true);
    expect(goal).toMatchObject({ status: "checking", providerSessionId: "provider-1" });
    expect(goal.iterations).toBeLessThan(goal.maxIterations);
  });

  test("waits on a quoted path, so a space or a quote cannot split the check", () => {
    expect(waitForFileCheck("/a b/it's")).toBe(`until [ -f '/a b/it'"'"'s' ]; do sleep 1; done`);
  });
});

describe("a list_nodes machine entry", () => {
  const ok: ListedMachine = {
    status: "ok",
    osFamily: "linux",
    os: "Debian GNU/Linux 13 (trixie)",
    cpuCores: 8,
    totalRamGb: 16,
    latestSampleAgeSeconds: 3,
    load: [
      { window: "5m", windowSeconds: 300, coveredSeconds: 15, cpuPercent: 12, ramPercent: 40 },
    ],
  };

  test("has readings only once the machine has sampled itself", () => {
    expect(hasReadings(ok)).toBe(true);
    expect(hasReadings({ ...ok, latestSampleAgeSeconds: null })).toBe(false);
    expect(
      hasReadings({
        ...ok,
        load: [
          {
            window: "5m",
            windowSeconds: 300,
            coveredSeconds: 0,
            cpuPercent: null,
            ramPercent: null,
          },
        ],
      }),
    ).toBe(false);
    expect(hasReadings({ status: "unavailable", reason: "older-version" })).toBe(false);
    expect(hasReadings(undefined)).toBe(false);
  });

  test("records figures, and for an unavailable machine only its reason", () => {
    expect(machineEvidence(ok)).toMatchObject({ status: "ok", cpuCores: 8, totalRamGb: 16 });
    expect(machineEvidence({ status: "unavailable", reason: "older-version" })).toEqual({
      status: "unavailable",
      reason: "older-version",
    });
  });
});
