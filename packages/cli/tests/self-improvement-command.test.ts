import { afterEach, describe, expect, test } from "bun:test";
import { publicSuccessEnvelope, type PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  SelfImprovementRunSummary,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const STARTED_AT = "2026-11-09T09:00:00.000Z";
const LATER = "2026-11-09T11:00:00.000Z";

function receipt(): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000011",
    action: "self-improvement.run",
    state: "succeeded",
    stage: "completed",
  };
}

function lastRun(overrides: Partial<SelfImprovementRunSummary>): SelfImprovementRunSummary {
  return {
    digestId: "d1",
    trigger: "manual",
    startedAt: STARTED_AT,
    finishedAt: "2026-11-09T09:05:00.000Z",
    outcome: "succeeded",
    created: [],
    linked: [],
    verified: [],
    fixFailed: [],
    partly: [],
    markedFixed: [],
    reopenedFromBoard: [],
    ignoredDeleted: [],
    wouldCreate: [],
    heldForTomorrow: 0,
    belowBar: 0,
    conversations: {
      enabled: false,
      read: 0,
      waiting: 0,
      notesAdded: 0,
      themes: 0,
      costUsd: 0,
      heldForTomorrow: 0,
      errors: [],
    },
    ...overrides,
  };
}

/** A backend whose run (started at STARTED_AT) is already over when the status is read. */
async function fixture(status: Partial<SelfImprovementStatus>): Promise<ClientSandbox> {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    if (action === "self-improvement.run") {
      return envelope(
        publicSuccessEnvelope(
          action,
          { started: true, dryRun: false, startedAt: STARTED_AT },
          receipt(),
        ),
      );
    }
    if (action === "self-improvement.status") {
      return envelope(
        publicSuccessEnvelope(action, {
          enabled: true,
          settings: { projectId: "p1", conversationReview: false, dailyRun: false },
          project: { id: "p1", name: "orkestrator-v2" },
          running: null,
          lastRun: null,
          nextDailyRunAt: null,
          tracked: [],
          themes: [],
          ...status,
        }),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return box;
}

describe("orkestrator self-improvement run --wait", () => {
  test("prints the summary of the run it started", async () => {
    const box = await fixture({
      lastRun: lastRun({ created: [{ ticket: "7", signature: "s", title: "[improvement] x" }] }),
    });
    const run = await box.run(["self-improvement", "run", "--wait", "--request-id", "si-1"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Run succeeded");
    expect(run.out).toContain("new ticket #7");
  });

  test("exits as failed when its run failed, with the fixed reason", async () => {
    const box = await fixture({
      lastRun: lastRun({ outcome: "failed", error: "Could not read the project's board." }),
    });
    const run = await box.run(["self-improvement", "run", "--wait", "--request-id", "si-2"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("Could not read the project's board.");
  });

  test("does not follow or report another run", async () => {
    const box = await fixture({
      running: { trigger: "daily", startedAt: LATER, step: "board" },
      lastRun: lastRun({ startedAt: LATER, outcome: "failed", error: "Not ours." }),
    });
    const started = Date.now();
    const run = await box.run(["self-improvement", "run", "--wait", "--request-id", "si-3"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("no longer the last one");
    expect(run.out).not.toContain("Not ours.");
    // It did not poll the other run.
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
