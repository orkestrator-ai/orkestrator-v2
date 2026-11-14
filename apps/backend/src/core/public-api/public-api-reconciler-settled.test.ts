import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { RegistryDependencies } from "../commands-registry-types.js";
import { recurringWorkMetrics } from "../recurring-work-metrics.js";
import { createPublicActionContext } from "./dispatch.js";
import { PublicOperationReconciler, RECONCILE_FULL_PASS_MS, stopReconciler } from "./reconciler.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * The reconciler's periodic pass skips a run whose turn was seen to end with a
 * later turn in its session (to-do 7562 (retired), task 4): its observation cannot
 * change while its record and environment stay as they were, and every pass
 * used to re-read the environment, the session and its activity for it.
 */

afterEach(cleanupSessionHarnesses);

async function receipt(harness: PublicApiHarness, operationId: string): Promise<PublicReceipt> {
  const response = await harness.call("run.get", { operationId });
  if (!response.receipt) throw new Error(`run.get failed: ${JSON.stringify(response)}`);
  return response.receipt;
}

async function operation(harness: PublicApiHarness, operationId: string) {
  const lookup = await harness.storage.publicOperations.getPublicOperation(operationId);
  if (lookup.status !== "found") throw new Error(`operation ${lookup.status}`);
  return lookup.record;
}

/** A run that ended without an outcome, and a later turn of its session still running. */
async function endedRunWithLaterTurn() {
  const session = await setup();
  const { harness, service, stub } = session;
  const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "first" },
    { requestId: "settled-0" },
  );
  if (!started.ok) throw new Error(`session.start failed: ${started.error.code}`);
  const { tabId, sessionId } = started.result;
  const providerSession = stub.sends[0]!.sessionId;
  stub.setStatus(async () => "idle");
  setActivity(service, "claude", tabId, providerSession, "idle");
  expect((await receipt(harness, started.result.runId)).state).toBe("succeeded");
  const prompt = async (requestId: string) => {
    const response = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId, prompt: `prompt ${requestId}` },
      { requestId },
    );
    if (!response.ok) throw new Error(`session.prompt failed: ${response.error.code}`);
    return response.result.runId;
  };
  const endedRun = await prompt("settled-1");
  stub.setStatus(async () => "missing");
  setActivity(service, "claude", tabId, providerSession, "idle");
  expect((await receipt(harness, endedRun)).execution?.state).toBe("unknown");
  stub.setStatus(async () => "idle");
  const laterRun = await prompt("settled-2");
  setActivity(service, "claude", tabId, providerSession, "working");
  // This observation sees the ended run with a later turn: it is settled.
  expect((await receipt(harness, endedRun)).execution?.state).toBe("unknown");

  // Only this test's reconciler runs passes; the harness's own (started by
  // the first public action) would observe the same records in between.
  await stopReconciler(harness.storage);
  let now = Date.now();
  const record = await operation(harness, endedRun);
  const context = {
    ...createPublicActionContext(
      harness.context,
      { commands: harness.commands } as unknown as RegistryDependencies,
      { installationId: "settled-test", generation: record.generation },
    ),
    now: () => now,
  };
  const reconciler = new PublicOperationReconciler(context);
  const observed = spyOn(harness.context.runtime.publicApi, "observeRun");
  const passObserving = async (environments: Set<string> | null = null) => {
    observed.mockClear();
    await reconciler.pass(environments);
    return observed.mock.calls.map(([operationId]) => operationId);
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { ...session, endedRun, laterRun, passObserving, advance };
}

describe("reconciler pass over runs that can no longer change", () => {
  test("the periodic pass skips a settled run until the full pass comes round", async () => {
    const { endedRun, laterRun, passObserving, advance } = await endedRunWithLaterTurn();
    // The first pass is a full pass: everything is observed.
    expect(await passObserving()).toEqual(expect.arrayContaining([endedRun, laterRun]));
    advance(15_000);
    const periodic = await passObserving();
    expect(periodic).not.toContain(endedRun);
    expect(periodic).toContain(laterRun);
    advance(RECONCILE_FULL_PASS_MS);
    expect(await passObserving()).toContain(endedRun);
  });

  test("skips are counted as cache hits of the reconcile kind", async () => {
    const { passObserving, advance } = await endedRunWithLaterTurn();
    await passObserving();
    const before = recurringWorkMetrics.snapshot().kinds["public-operation-reconcile"];
    advance(15_000);
    await passObserving();
    const after = recurringWorkMetrics.snapshot().kinds["public-operation-reconcile"];
    expect((after?.cacheHits ?? 0) - (before?.cacheHits ?? 0)).toBe(1);
  });

  test("a changed record is observed again", async () => {
    const { harness, endedRun, passObserving, advance } = await endedRunWithLaterTurn();
    await passObserving();
    advance(15_000);
    expect(await passObserving()).not.toContain(endedRun);
    await harness.storage.publicOperations.updatePublicOperation(endedRun, (current) => ({
      ...current,
      stopRequestedAt: new Date().toISOString(),
    }));
    advance(15_000);
    expect(await passObserving()).toContain(endedRun);
  });

  test("a client read still observes a settled run", async () => {
    const { harness, endedRun, passObserving, advance } = await endedRunWithLaterTurn();
    await passObserving();
    advance(15_000);
    await passObserving();
    const observed = spyOn(harness.context.runtime.publicApi, "observeRun");
    observed.mockClear();
    await receipt(harness, endedRun);
    expect(observed.mock.calls.map(([operationId]) => operationId)).toContain(endedRun);
  });

  test("a pass for a changed environment skips it while the environment exists", async () => {
    const { harness, endedRun, passObserving, advance } = await endedRunWithLaterTurn();
    await passObserving();
    advance(15_000);
    expect(await passObserving(new Set(["env-1"]))).not.toContain(endedRun);
    await harness.storage.removeEnvironment("env-1");
    expect(await passObserving(new Set(["env-1"]))).toContain(endedRun);
    const settled = await operation(harness, endedRun);
    expect(settled.state).toBe("interrupted");
    expect(settled.execution?.reason).toBe("The environment was deleted");
  });
});
