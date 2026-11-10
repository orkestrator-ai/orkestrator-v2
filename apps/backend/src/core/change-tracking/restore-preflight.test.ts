import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  ContainerCaptureExecutor,
  decodePath,
  HostCaptureExecutor,
  type CaptureLimits,
} from "./capture.js";
import { CHANGE_TRACKING_POLICY_V1, type ChangeTrackingPolicy } from "./policy-registry.js";
import { restoreCaptureDeadlineMs, restorePreflightDeadlineMs } from "./restore.js";
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

  test.each([
    { name: "covers multiple container batches beyond the floor", files: 5_001, perPathMs: 10 },
    { name: "refuses a container batch that exceeds the whole deadline", files: 20, perPathMs: 0 },
  ])(
    "$name",
    async ({ files, perPathMs }) => {
      const h = harness({
        restorePreflightDeadlineMs: 40,
        restorePreflightPerPathMs: perPathMs,
        restorePreflightMaxDeadlineMs: 60_000,
      });
      const turn = await addFilesInTurn(h, files);
      const owner = h.service.registry.ownerById(turn.worktreeId)!;
      const host = owner.executor;
      const executor = new ContainerCaptureExecutor("fake", h.repo);
      // Replace only the remote transport. Exercise the real container executor's
      // framing and describe path without a Docker daemon or container lifecycle.
      const transport = executor as unknown as {
        helper: (
          mode: string,
          limits: CaptureLimits,
          stdin: Buffer,
          timeoutMs: number,
          signal: AbortSignal,
        ) => Promise<string>;
      };
      const signals: AbortSignal[] = [];
      const batches: string[][] = [];
      const helper = spyOn(transport, "helper").mockImplementation(
        async (mode, limits, stdin, _timeoutMs, signal) => {
          expect(mode).toBe("describe");
          const paths = stdin
            .toString("latin1")
            .split("\0")
            .filter(Boolean)
            .map((encoded) => `u:${Buffer.from(encoded, "base64").toString()}`);
          batches.push(paths);
          signals.push(signal);
          expect(limits.maxCandidates).toBe(files);
          await new Promise((resolve) => setTimeout(resolve, 70));
          signal.throwIfAborted();
          const records = await host.describe(paths, limits, signal);
          return records
            .map((record) => {
              if (record.kind !== "file") throw new Error("expected a destination file");
              return JSON.stringify({
                p: Buffer.from(decodePath(record.pathId)).toString("base64"),
                k: "file",
                m: record.mode,
                s: record.size,
                st: record.stamp,
                o: record.oid,
                ok: record.stable,
              });
            })
            .join("\n");
        },
      );
      const describe = spyOn(executor, "describe");
      const lookup = spyOn(h.service.registry, "ownerById").mockReturnValue(
        Object.assign(Object.create(owner), { executor }),
      );
      try {
        const result = await h.service.restore.prepare({ measurementId: turn.measurementId });
        if (perPathMs === 0) {
          expect(result).toEqual({
            kind: "disabled",
            reasonKey: "changes.restore.runtime-unavailable",
          });
          expect(signals[0]?.aborted).toBe(true);
          expect(batches.map((batch) => batch.length)).toEqual([20]);
        } else {
          if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);
          expect(result.files).toHaveLength(files);
          expect(result.files.every((file) => file.action === "delete")).toBe(true);
          expect(batches.map((batch) => batch.length)).toEqual([5_000, 1]);
          expect(new Set(batches.flat()).size).toBe(files);
          expect(signals[1]).toBe(signals[0]);
          expect(signals[0]?.aborted).toBe(false);
        }
        // Restore preflight must send each batch once, rather than using the
        // host's one-describe-per-path path or checking only the first batch.
        expect(describe).toHaveBeenCalledTimes(batches.length);
      } finally {
        lookup.mockRestore();
        describe.mockRestore();
        helper.mockRestore();
      }
    },
    30_000,
  );
});

describe("restore apply capture deadline", () => {
  test("is at least the finalization deadline and grows with the plan like the preview", () => {
    const policy = CHANGE_TRACKING_POLICY_V1;
    expect(restoreCaptureDeadlineMs(0, policy)).toBe(30_000);
    expect(restoreCaptureDeadlineMs(2_000, policy)).toBe(30_000);
    expect(restoreCaptureDeadlineMs(10_000, policy)).toBe(50_000);
    expect(restoreCaptureDeadlineMs(20_000, policy)).toBe(100_000);
    expect(restoreCaptureDeadlineMs(100_000, policy)).toBe(5 * 60_000);
  });

  test("the checkpoint and result captures run on it, not a fixed 10 s", async () => {
    const files = 20;
    const h = harness({
      finalizationDeadlineMs: 30_000,
      restorePreflightPerPathMs: 2_000,
      restorePreflightMaxDeadlineMs: 60_000,
    });
    const turn = await addFilesInTurn(h, files);
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    const owner = h.service.registry.ownerById(turn.worktreeId)!;
    const capture = spyOn(owner, "capture");
    try {
      const applied = await h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "apply-1",
      });
      expect(applied).toMatchObject({ kind: "applied", outcome: "complete" });
      const deadlines = capture.mock.calls.map(([options]) => [
        options.purpose,
        options.deadlineMs,
      ]);
      // 20 planned paths × 2 s, past the 30 s finalization floor.
      expect(deadlines).toEqual([
        ["restore-checkpoint", 40_000],
        ["restore-result", 40_000],
      ]);
    } finally {
      capture.mockRestore();
    }
  });
});
