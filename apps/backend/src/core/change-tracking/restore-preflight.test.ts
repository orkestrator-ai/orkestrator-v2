import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import { HostCaptureExecutor } from "./capture.js";
import { CHANGE_TRACKING_POLICY_V1, type ChangeTrackingPolicy } from "./policy-registry.js";
import { restorePreflightDeadlineMs } from "./restore.js";
import { createHarness, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(policy: Partial<ChangeTrackingPolicy>): Harness {
  const created = createHarness({ policy });
  harnesses.push(created);
  return created;
}

async function addFilesInTurn(h: Harness, count: number): Promise<ChangeMeasurement> {
  const identity = { environmentId: "env-1", logicalSessionKey: "env-env-1:tab" };
  await h.service.prepareTurnStart({ ...identity, requestId: "bulk", provider: "claude" });
  h.service.markTurnDispatched("env-1", "env-env-1:tab", "bulk", "accepted");
  mkdirSync(join(h.repo, "bulk"));
  for (let index = 0; index < count; index++)
    writeFileSync(join(h.repo, "bulk", `f${index}.txt`), `${index}\n`);
  await h.service.finalizeTurn({ ...identity, requestId: "bulk" });
  const turnId = turnIdFor("env-1", "env-env-1:tab", "bulk");
  const measurement = h.service.ledger.latestMeasurement("turn", turnId, "turn-net");
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

/** Each destination check waits `delayMs` before it reads, as on a busy host. */
function slowDestinationChecks(delayMs: number) {
  const describeFiles = HostCaptureExecutor.prototype.describe;
  return spyOn(HostCaptureExecutor.prototype, "describe").mockImplementation(async function (
    this: HostCaptureExecutor,
    ...args: Parameters<HostCaptureExecutor["describe"]>
  ) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return describeFiles.apply(this, args);
  });
}

describe("restore preflight deadline", () => {
  test("is the floor for small plans, grows with the plan, and stops at the ceiling", () => {
    const policy = CHANGE_TRACKING_POLICY_V1;
    expect(restorePreflightDeadlineMs(0, policy)).toBe(10_000);
    expect(restorePreflightDeadlineMs(2_000, policy)).toBe(10_000);
    expect(restorePreflightDeadlineMs(10_000, policy)).toBe(50_000);
    expect(restorePreflightDeadlineMs(20_000, policy)).toBe(100_000);
    expect(restorePreflightDeadlineMs(60_000, policy)).toBe(5 * 60_000);
    expect(restorePreflightDeadlineMs(100_000, policy)).toBe(5 * 60_000);
  });

  test("a plan that outlasts the floor still previews when the per-path budget covers it", async () => {
    const files = 20;
    const h = harness({
      restorePreflightDeadlineMs: 40,
      restorePreflightPerPathMs: 250,
      restorePreflightMaxDeadlineMs: 60_000,
    });
    const turn = await addFilesInTurn(h, files);
    const slow = slowDestinationChecks(5);
    try {
      // At least 20 × 5 ms of checks: past the 40 ms floor, inside 20 × 250 ms.
      const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
      if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
      expect(preview.files).toHaveLength(files);
      expect(preview.files.every((file) => file.action === "delete")).toBe(true);
    } finally {
      slow.mockRestore();
    }
  });

  test("a plan that outlasts its whole deadline is still refused, never half-checked", async () => {
    const h = harness({
      restorePreflightDeadlineMs: 40,
      restorePreflightPerPathMs: 0,
      restorePreflightMaxDeadlineMs: 60_000,
    });
    const turn = await addFilesInTurn(h, 20);
    const slow = slowDestinationChecks(5);
    try {
      expect(await h.service.restore.prepare({ measurementId: turn.measurementId })).toEqual({
        kind: "disabled",
        reasonKey: "changes.restore.runtime-unavailable",
      });
    } finally {
      slow.mockRestore();
    }
  });
});
