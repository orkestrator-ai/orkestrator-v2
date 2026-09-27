import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_CONFLICT,
  parseWebAnnotationRequestMarker,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/web-annotations-fixtures";
import type { CompileBriefInput } from "./web-annotation-contracts.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import {
  ENV_A,
  ENV_B,
  createAnnotation,
  createHarness,
  fakeCompileBrief,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness;
afterEach(async () => {
  await harness?.cleanup();
});

const SCOPE = { environmentId: ENV_A, tabId: fixtureDestination.tabId };

async function send(
  service: WebAnnotationService,
  annotationIds: string[],
  requestId: string,
  operation: WebAnnotationRequestOperation = "implement",
) {
  const annotations = [];
  for (const annotationId of annotationIds) {
    const { annotation } = await service.get(ENV_A, annotationId);
    annotations.push({
      annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
    });
  }
  const preparation = await service.prepare({
    environmentId: ENV_A,
    operation,
    destination: fixtureDestination,
    annotations,
    instruction: "",
  });
  return service.send({
    environmentId: ENV_A,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
}

function report(annotationIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    expectedResultRevision: null,
    summary: "Increased padding",
    outcomes: annotationIds.map((annotationId) => ({
      annotationId,
      outcome: "addressed" as const,
      note: null,
    })),
    files: ["src/Save.tsx"],
    checks: [{ description: "unit tests", outcome: "passed" as const }],
    limitations: [],
    questions: [],
    ...overrides,
  };
}

describe("web annotation results and review", () => {
  test("resolve checks the result revision; stale results conflict", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const first = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-rc1",
      requestId: "req-1",
      capture: fixtureCaptureInput(),
    });
    const second = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-rc2",
      requestId: "req-1",
      capture: fixtureCaptureInput(),
    });
    expect(second.result).toMatchObject({
      revision: 2,
      supersedes: first.result.id,
      provenance: "user-capture",
      provisional: true,
    });
    const replay = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-rc1",
      requestId: "req-1",
      capture: fixtureCaptureInput(),
    });
    expect(replay.result.id).toBe(first.result.id);
    const current = (await harness.service.get(ENV_A, note.annotationId)).annotation;
    const resolve = (resultId: string, expectedResultRevision: number, operationId: string) =>
      harness.service.resolve({
        environmentId: ENV_A,
        operationId,
        annotationId: note.annotationId,
        expectedContentRevision: current.contentRevision,
        expectedCaptureId: current.currentCaptureId,
        requestId: "req-1",
        resultId,
        expectedResultRevision,
      });
    await expect(resolve(first.result.id, 1, "op-old")).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    await resolve(second.result.id, 2, "op-new");
    const resolution = (await harness.service.get(ENV_A, note.annotationId)).annotation.resolution;
    expect(resolution).toMatchObject({
      requestId: "req-1",
      resultId: second.result.id,
      resultRevision: 2,
    });
  });

  test("the tool host is scoped to the assigned request and cannot resolve", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const other = await createAnnotation(harness.service, ENV_A, "other");
    await send(harness.service, [note.annotationId], "req-1");
    const host = harness.service.toolHost();
    const assigned = await host.assignedRequest(SCOPE);
    expect(assigned?.request.id).toBe("req-1");
    expect(assigned?.latestResult).toBeNull();
    expect(parseWebAnnotationRequestMarker(assigned!.brief)?.requestId).toBe("req-1");
    expect(await host.assignedRequest({ environmentId: ENV_A, tabId: "tab-other" })).toBeNull();
    expect(
      await host.assignedRequest({ environmentId: ENV_B, tabId: fixtureDestination.tabId }),
    ).toBeNull();
    const evidence = await host.evidence(SCOPE, "req-1", note.annotationId);
    expect(evidence.entries.map((entry) => entry.provenance)).toEqual(["host-user"]);
    await expect(host.evidence(SCOPE, "req-1", other.annotationId)).rejects.toThrow(
      "not part of this request",
    );
    await expect(
      host.evidence({ environmentId: ENV_A, tabId: "tab-other" }, "req-1", note.annotationId),
    ).rejects.toThrow("not assigned");

    const result = await host.reportResult(SCOPE, report([note.annotationId]));
    expect(result).toMatchObject({ provenance: "agent-reported", provisional: true, revision: 1 });
    expect(result.checks[0]?.provenance).toBe("agent-reported");
    expect((await host.assignedRequest(SCOPE))?.latestResult).toMatchObject({
      id: result.id,
      revision: 1,
    });
    await expect(host.reportResult(SCOPE, report([note.annotationId]))).rejects.toThrow(
      WEB_ANNOTATION_CONFLICT,
    );
    await expect(
      host.reportResult(SCOPE, {
        ...report([other.annotationId]),
        expectedResultRevision: 1,
      }),
    ).rejects.toThrow("only annotations in this request");
    await expect(
      host.reportResult(SCOPE, {
        ...report([note.annotationId]),
        expectedResultRevision: 1,
        evidenceIds: ["capture-forged"],
      }),
    ).rejects.toThrow("evidenceIds");
    await expect(
      host.reportResult(
        { environmentId: ENV_A, tabId: "tab-other" },
        { ...report([note.annotationId]), expectedResultRevision: 1 },
      ),
    ).rejects.toThrow("not assigned");
    expect((await harness.service.get(ENV_A, note.annotationId)).annotation.state).toBe("open");
  });

  test("user captures carry the agent report forward; the revision chain keeps both", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    const host = harness.service.toolHost();
    const agent = await host.reportResult(SCOPE, {
      ...report([note.annotationId]),
      evidenceIds: [sent.request.selections[0]!.captureId],
      checks: [
        { description: "unit tests", outcome: "passed" as const },
        { description: "visual check", outcome: "failed" as const },
      ],
    });
    const first = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-c1",
      requestId: "req-1",
      capture: fixtureCaptureInput(),
    });
    const second = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-c2",
      requestId: "req-1",
      capture: fixtureCaptureInput(),
    });
    // The newest revision shows the agent's report *and* both app observations.
    expect(second.result).toMatchObject({
      revision: 3,
      provenance: "user-capture",
      reportedRevision: 1,
      supersedes: first.result.id,
      summary: "Increased padding",
      outcomes: [{ annotationId: note.annotationId, outcome: "addressed" }],
      checks: [
        { outcome: "passed", provenance: "agent-reported" },
        { outcome: "failed", provenance: "agent-reported" },
      ],
      captureIds: [first.captureId, second.captureId],
      evidenceIds: agent.evidenceIds,
    });
    expect(second.result.observations?.map((item) => item.captureId)).toEqual([
      first.captureId,
      second.captureId,
    ]);
    expect(second.result.observations?.every((item) => item.provenance === "app-observed")).toBe(
      true,
    );
    // The agent revises against the latest revision of any provenance and keeps
    // the observations attached.
    await expect(
      host.reportResult(SCOPE, { ...report([note.annotationId]), expectedResultRevision: 1 }),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    const revised = await host.reportResult(SCOPE, {
      ...report([note.annotationId]),
      summary: "Revised padding",
      expectedResultRevision: 3,
    });
    expect(revised).toMatchObject({
      revision: 4,
      reportedRevision: 4,
      supersedes: second.result.id,
      captureIds: [first.captureId, second.captureId],
    });
    expect(revised.observations).toHaveLength(2);
    const chain = (await harness.service.getRequest(ENV_A, "req-1")).results;
    expect(chain.map((result) => [result.revision, result.provenance])).toEqual([
      [1, "agent-reported"],
      [2, "user-capture"],
      [3, "user-capture"],
      [4, "agent-reported"],
    ]);
  });

  test("a batch result capture names its annotation and records comparison metadata", async () => {
    harness = await createHarness();
    const x = await createAnnotation(harness.service, ENV_A, "X");
    const y = await createAnnotation(harness.service, ENV_A, "Y");
    await send(harness.service, [x.annotationId, y.annotationId], "req-1");
    await expect(
      harness.service.captureResult({
        environmentId: ENV_A,
        operationId: "op-missing",
        requestId: "req-1",
        capture: fixtureCaptureInput(),
      }),
    ).rejects.toThrow("annotationId is required");
    await expect(
      harness.service.captureResult({
        environmentId: ENV_A,
        operationId: "op-foreign",
        requestId: "req-1",
        annotationId: "annotation-elsewhere",
        capture: fixtureCaptureInput(),
      }),
    ).rejects.toThrow("not part of this request");

    const asset = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-after-image",
      mediaType: "image/png",
      data: makePng(4, 3, 9).toString("base64"),
    });
    const after = fixtureCaptureInput();
    const captured = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-y",
      requestId: "req-1",
      annotationId: y.annotationId,
      capture: {
        ...after,
        assetIds: [asset.asset.id],
        page: { ...after.page, route: "/settings/moved" },
        redaction: { ...after.redaction, manualRegions: 1, sensitiveRegionsMasked: 1 },
      },
      zoomFactor: 1.25,
      deviceScaleFactor: 1,
      scroll: { x: 0, y: 120 },
      stability: "unstable",
      masks: [{ source: "manual", rect: { x: 1, y: 1, width: 2, height: 1 } }],
    });
    const capture = await harness.service.capture(ENV_A, captured.captureId);
    expect(capture).toMatchObject({
      annotationId: y.annotationId,
      producer: "result-capture",
      resultOf: { requestId: "req-1", resultId: captured.result.id },
      redaction: { manualRegions: 1, sensitiveRegionsMasked: 1 },
      comparison: {
        zoomFactor: 1.25,
        deviceScaleFactor: 1,
        scroll: { x: 0, y: 120 },
        stability: "unstable",
        masks: [{ source: "manual", rect: { x: 1, y: 1, width: 2, height: 1 } }],
        contentRevision: y.contentRevision,
        comparedCaptureId: y.captureId,
        targetMatch: "same-target",
      },
    });
    expect(capture.comparison?.differences).toEqual(
      expect.arrayContaining(["route", "zoom", "device-scale", "unstable"]),
    );
    expect(captured.result.observations?.[0]).toMatchObject({
      annotationId: y.annotationId,
      assetIds: [asset.asset.id],
    });
    expect(captured.result.evidenceAssetIds).toEqual([asset.asset.id]);
    await expect(
      harness.service.captureResult({
        environmentId: ENV_A,
        operationId: "op-bad-mask",
        requestId: "req-1",
        annotationId: y.annotationId,
        capture: fixtureCaptureInput(),
        stability: "maybe" as never,
      }),
    ).rejects.toThrow("stability");
  });

  test("reported files are checked for workspace containment and existence", async () => {
    harness = await createHarness();
    const checked: string[][] = [];
    (harness.dispatch as { checkWorkspacePaths?: unknown }).checkWorkspacePaths = async (
      _environment: unknown,
      paths: readonly string[],
    ) => {
      checked.push([...paths]);
      return paths.map((path) => ({
        path,
        status: path === "src/Save.tsx" ? ("exists" as const) : ("missing" as const),
      }));
    };
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const result = await harness.service.toolHost().reportResult(SCOPE, {
      ...report([note.annotationId]),
      files: ["src/Save.tsx", "src/Gone.tsx"],
    });
    expect(checked).toEqual([["src/Save.tsx", "src/Gone.tsx"]]);
    expect(result.fileChecks).toEqual([
      { path: "src/Save.tsx", status: "exists" },
      { path: "src/Gone.tsx", status: "missing" },
    ]);
  });

  test("a thread discussed with another session gets an attributed excerpt", async () => {
    const compiled: CompileBriefInput[] = [];
    harness = await createHarness({
      compileBrief: (input) => {
        compiled.push(input);
        return fakeCompileBrief(input);
      },
    });
    const note = await createAnnotation(harness.service, ENV_A, "Original note");
    await send(harness.service, [note.annotationId], "req-1", "discuss");
    harness.dispatch.observe_("req-1", "completed");
    await harness.service.reconcileOnce();
    await harness.service.requestResponse(ENV_A, "req-1");
    const current = (await harness.service.get(ENV_A, note.annotationId)).annotation;
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-next",
      annotationId: note.annotationId,
      expectedContentRevision: current.contentRevision,
      body: "Now implement option B",
    });
    const latest = (await harness.service.get(ENV_A, note.annotationId)).annotation;
    compiled.length = 0;
    await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: { ...fixtureDestination, tabId: "tab-9", logicalSessionKey: "env-a:tab-9" },
      annotations: [
        {
          annotationId: note.annotationId,
          expectedContentRevision: latest.contentRevision,
          expectedCaptureId: latest.currentCaptureId,
        },
      ],
      instruction: "",
    });
    const summary = compiled[0]!.annotations[0]!.threadSummary!;
    expect(summary.context).toBe("other-session");
    expect(summary.text.includes("Original note")).toBe(true);
    expect(summary.text.includes("response from")).toBe(true);
    // The newest human note stays the instruction, not part of the excerpt.
    expect(summary.text.includes("Now implement option B")).toBe(false);
  });

  test("settlement clears provisional on results reported during the turn", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "running");
    await harness.service.reconcileOnce();
    const reported = await harness.service
      .toolHost()
      .reportResult(SCOPE, report([note.annotationId]));
    expect(reported.provisional).toBe(true);
    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();
    const { results } = await harness.service.getRequest(ENV_A, "req-1");
    expect(results.map((result) => result.provisional)).toEqual([false]);
    const got = await harness.service.get(ENV_A, note.annotationId);
    expect(got.results.map((result) => result.provisional)).toEqual([false]);
    const restarted = await harness.restart();
    expect((await restarted.getRequest(ENV_A, "req-1")).results[0]?.provisional).toBe(false);
  });

  test("mixed outcomes, accept and reopen, then a follow-up of only the remaining items", async () => {
    const compiled: CompileBriefInput[] = [];
    harness = await createHarness({
      compileBrief: (input) => {
        compiled.push(input);
        return fakeCompileBrief(input);
      },
    });
    const a = await createAnnotation(harness.service, ENV_A, "A: fix copy");
    const b = await createAnnotation(harness.service, ENV_A, "B: fix spacing");
    const c = await createAnnotation(harness.service, ENV_A, "C: fix focus");
    const d = await createAnnotation(harness.service, ENV_A, "D: fix color");
    const ids = [a, b, c, d].map((item) => item.annotationId);
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-b-more",
      annotationId: b.annotationId,
      expectedContentRevision: b.contentRevision,
      body: "B: and check it on mobile",
    });
    await send(harness.service, ids, "req-1");
    await expect(harness.service.followUp(ENV_A, "req-1")).rejects.toThrow("still active");
    await harness.service.toolHost().reportResult(SCOPE, {
      ...report(ids),
      outcomes: [
        { annotationId: a.annotationId, outcome: "addressed" as const, note: null },
        { annotationId: b.annotationId, outcome: "partly-addressed" as const, note: "one left" },
        { annotationId: d.annotationId, outcome: "addressed" as const, note: null },
      ],
    });
    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();

    // Accept A; accept then reopen B (a reopened item is remaining again).
    for (const item of [a, b]) {
      const current = (await harness.service.get(ENV_A, item.annotationId)).annotation;
      await harness.service.resolve({
        environmentId: ENV_A,
        operationId: `op-accept-${item.annotationId}`,
        annotationId: item.annotationId,
        expectedContentRevision: current.contentRevision,
        expectedCaptureId: current.currentCaptureId,
      });
    }
    const resolvedB = (await harness.service.get(ENV_A, b.annotationId)).annotation;
    await harness.service.reopen({
      environmentId: ENV_A,
      operationId: "op-reopen-b",
      annotationId: b.annotationId,
      expectedMetadataRevision: resolvedB.metadataRevision,
    });

    const candidates = await harness.service.followUp(ENV_A, "req-1");
    expect(candidates.remaining.map((item) => [item.annotationId, item.reason])).toEqual([
      [b.annotationId, "not-addressed"],
      [c.annotationId, "unreported"],
    ]);
    expect(candidates.excluded.map((item) => [item.annotationId, item.reason])).toEqual([
      [a.annotationId, "accepted"],
      [d.annotationId, "addressed"],
    ]);

    compiled.length = 0;
    const preparation = await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: fixtureDestination,
      annotations: [],
      instruction: "",
      followUpOf: "req-1",
    });
    expect(preparation).toMatchObject({ sendable: true, followUpOf: "req-1" });
    expect(preparation.selections.map((selection) => selection.annotationId)).toEqual([
      b.annotationId,
      c.annotationId,
    ]);
    const input = compiled[0]!;
    expect(input.followUp).toMatchObject({
      requestId: "req-1",
      state: "awaiting-review",
      summary: "Increased padding",
    });
    expect(input.annotations.map((item) => item.previousOutcome?.outcome)).toEqual([
      "partly-addressed",
      "unreported",
    ]);
    // The entries already delivered are summarized for the follow-up.
    const summary = input.annotations[0]!.threadSummary!;
    expect(summary.context).toBe("follow-up");
    expect(summary.text.includes("B: fix spacing")).toBe(true);
    // The latest note stays the explicit instruction; it is not excerpted.
    expect(summary.text.includes("check it on mobile")).toBe(false);
    const followUp = await harness.service.send({
      environmentId: ENV_A,
      preparationId: preparation.preparationId,
      requestId: "req-2",
      bodyHash: preparation.bodyHash,
    });
    expect(followUp.request).toMatchObject({ followUpOf: "req-1", reservation: true });
    expect((await harness.service.get(ENV_A, a.annotationId)).annotation.state).toBe("resolved");
  });
});
