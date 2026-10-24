import { afterEach, describe, expect, test } from "bun:test";
import { fixtureDestination } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import {
  compileWebAnnotationBrief,
  composeWebAnnotationDispatchText,
} from "./web-annotation-brief.js";
import { WebAnnotationMetrics } from "./web-annotation-metrics.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

/**
 * The turn-end reconcile (outcomes read while the bridge is still up) and the
 * content-free series added for acceptance, reopening, evidence omissions,
 * turn outcomes and anchor resolutions.
 */

let harness: ServiceHarness;
afterEach(async () => {
  await harness?.cleanup();
});

async function send(service: WebAnnotationService, annotationId: string, requestId: string) {
  const { annotation } = await service.get(ENV_A, annotationId);
  const preparation = await service.prepare({
    environmentId: ENV_A,
    operation: "implement",
    destination: fixtureDestination,
    annotations: [
      {
        annotationId,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: "",
  });
  return service.send({
    environmentId: ENV_A,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
}

function counters(service: WebAnnotationService) {
  return service.metrics.snapshot().counters;
}

describe("turn-end reconcile", () => {
  test("a turn-end edge observes that session's requests at once, and only those", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, note.annotationId, "req-1");
    harness.dispatch.observe_("req-1", "awaiting-review", { turnOutcome: "completed" });

    const before = harness.dispatch.observeCalls;
    await harness.service.noteTurnEnded({
      environmentId: ENV_A,
      agent: fixtureDestination.agent,
      logicalSessionKey: "env-other:tab-9",
    });
    expect(harness.dispatch.observeCalls).toBe(before);
    expect((await harness.service.getRequest(ENV_A, "req-1")).request.state).not.toBe(
      "awaiting-review",
    );

    await harness.service.noteTurnEnded({
      environmentId: ENV_A,
      agent: fixtureDestination.agent,
      logicalSessionKey: fixtureDestination.logicalSessionKey,
    });
    expect(harness.dispatch.observeCalls).toBe(before + 1);
    expect((await harness.service.getRequest(ENV_A, "req-1")).request).toMatchObject({
      state: "awaiting-review",
      turnOutcome: "completed",
    });
    expect(
      counters(harness.service)[
        `request_turn_outcomes|agent=${fixtureDestination.agent}|operation=implement|outcome=completed`
      ],
    ).toBe(1);
  });

  test("an environment that is not loaded is never hydrated for it", async () => {
    harness = await createHarness();
    const before = harness.dispatch.observeCalls;
    await harness.service.noteTurnEnded({
      environmentId: "env-never-loaded",
      agent: fixtureDestination.agent,
      logicalSessionKey: fixtureDestination.logicalSessionKey,
    });
    expect(harness.dispatch.observeCalls).toBe(before);
  });
});

describe("annotation lifecycle series", () => {
  test("acceptance time and reopen count are recorded without ids or text", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service);
    harness.clock.advance(90_000);
    const resolved = await harness.service.resolve({
      environmentId: ENV_A,
      operationId: "op-resolve",
      annotationId: receipt.annotationId,
      expectedContentRevision: receipt.contentRevision,
      expectedCaptureId: receipt.captureId!,
    });
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-reply",
      annotationId: receipt.annotationId,
      expectedContentRevision: resolved.contentRevision,
      body: "Not quite.",
    });
    const snapshot = harness.service.metrics.snapshot();
    expect(snapshot.counters.annotations_reopened).toBe(1);
    expect(snapshot.durations["acceptance_ms|source=note"]).toMatchObject({ count: 1 });
    expect(snapshot.durations["acceptance_ms|source=note"]!.totalMs).toBeGreaterThanOrEqual(90_000);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(receipt.annotationId);
    expect(serialized).not.toContain("Not quite");
  });

  test("evidence the brief left out is counted by section", async () => {
    // The real compiler, so the manifest has real omitted/unavailable sections.
    harness = await createHarness({
      compileBrief: compileWebAnnotationBrief,
      composeText: composeWebAnnotationDispatchText,
    });
    const note = await createAnnotation(harness.service);
    await send(harness.service, note.annotationId, "req-omit");
    const request = (await harness.service.getRequest(ENV_A, "req-omit")).request;
    const series = Object.keys(counters(harness.service)).filter(
      (key) => key.startsWith("evidence_omitted|") || key.startsWith("evidence_unavailable|"),
    );
    const expected = request.evidence.items.flatMap((item) => [
      ...item.omitted.map((section) => `evidence_omitted|section=${section}`),
      ...item.unavailable.map((section) => `evidence_unavailable|section=${section}`),
    ]);
    expect(expected.length).toBeGreaterThan(0);
    expect(series.sort()).toEqual(Array.from(new Set(expected)).sort());
  });

  test("anchor resolutions from result captures are counted by state and rule", () => {
    const metrics = new WebAnnotationMetrics();
    metrics.recordTargetResolution({
      state: "matched",
      rule: "stable-id",
      candidateCount: 1,
      documentGeneration: 2,
      rect: null,
    });
    expect(metrics.snapshot().counters).toEqual({
      "anchor_resolutions|source=result-capture|state=matched|rule=stable-id": 1,
    });
  });
});
