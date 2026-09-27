import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CONFLICT,
  parseWebAnnotationRequestMarker,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { fixtureDestination } from "@orkestrator/protocol/web-annotations-fixtures";
import { recordDirectoryName } from "./web-annotation-storage.js";
import type { WebAnnotationService } from "./web-annotation-service.js";
import {
  ENV_A,
  ENV_B,
  createAnnotation,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness;
afterEach(async () => {
  await harness?.cleanup();
});

async function prepare(
  service: WebAnnotationService,
  annotationIds: string[],
  operation: WebAnnotationRequestOperation = "implement",
  instruction = "",
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
  return service.prepare({
    environmentId: ENV_A,
    operation,
    destination: fixtureDestination,
    annotations,
    instruction,
  });
}

async function send(
  service: WebAnnotationService,
  annotationIds: string[],
  requestId: string,
  operation?: WebAnnotationRequestOperation,
) {
  const preparation = await prepare(service, annotationIds, operation);
  return service.send({
    environmentId: ENV_A,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
}

describe("web annotation request send", () => {
  test("commits the request, reservation, and lifecycle, then publishes once", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    expect(sent.deduplicated).toBe(false);
    expect(sent.request).toMatchObject({
      id: "req-1",
      state: "queued",
      reservation: true,
      queueKey: `claude\0${fixtureDestination.logicalSessionKey}`,
    });
    expect(sent.request.queueReceiptAt).not.toBeNull();
    expect(harness.dispatch.published).toHaveLength(1);
    expect(parseWebAnnotationRequestMarker(harness.dispatch.published[0]!.text)).toEqual({
      requestId: "req-1",
      operation: "implement",
      annotationCount: 1,
    });
    const got = await harness.service.get(ENV_A, note.annotationId);
    expect(got.annotation.activeRequestId).toBe("req-1");
    expect(got.annotation.contentRevision).toBe(note.contentRevision);
    expect(got.entries.at(-1)?.lifecycle).toEqual({
      event: "request-sent",
      requestId: "req-1",
      state: "prepared",
    });
  });

  test("same id and body deduplicates; a changed body conflicts", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const preparation = await prepare(harness.service, [note.annotationId]);
    const input = {
      environmentId: ENV_A,
      preparationId: preparation.preparationId,
      requestId: "req-1",
      bodyHash: preparation.bodyHash,
    };
    const first = await harness.service.send(input);
    const retry = await harness.service.send(input);
    expect(retry.deduplicated).toBe(true);
    expect(retry.request.id).toBe(first.request.id);
    expect(harness.dispatch.published).toHaveLength(1);
    await expect(harness.service.send({ ...input, bodyHash: "f".repeat(64) })).rejects.toThrow(
      WEB_ANNOTATION_CONFLICT,
    );
  });

  test("competing request ids for the same annotation conflict", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const first = await prepare(harness.service, [note.annotationId]);
    const second = await prepare(harness.service, [note.annotationId]);
    await harness.service.send({
      environmentId: ENV_A,
      preparationId: first.preparationId,
      requestId: "req-a",
      bodyHash: first.bodyHash,
    });
    await expect(
      harness.service.send({
        environmentId: ENV_A,
        preparationId: second.preparationId,
        requestId: "req-b",
        bodyHash: second.bodyHash,
      }),
    ).rejects.toThrow(`active implementation already reserved for ${note.annotationId}`);
    expect(
      (await harness.service.listRequests(ENV_A)).requests.map((request) => request.id),
    ).toEqual(["req-a"]);
    const again = await prepare(harness.service, [note.annotationId]);
    expect(again.sendable).toBe(false);
    expect(again.issues.map((issue) => issue.code)).toContain("active-implementation");
  });

  test("batch reservations are all-or-none", async () => {
    harness = await createHarness();
    const x = await createAnnotation(harness.service, ENV_A, "X");
    const y = await createAnnotation(harness.service, ENV_A, "Y");
    const batch = await prepare(harness.service, [x.annotationId, y.annotationId]);
    await send(harness.service, [y.annotationId], "req-y");
    await expect(
      harness.service.send({
        environmentId: ENV_A,
        preparationId: batch.preparationId,
        requestId: "req-xy",
        bodyHash: batch.bodyHash,
      }),
    ).rejects.toThrow(y.annotationId);
    expect(
      (await harness.service.get(ENV_A, x.annotationId)).annotation.activeRequestId,
    ).toBeNull();
    expect((await harness.service.get(ENV_A, x.annotationId)).annotation.requestIds).toEqual([]);
    const ok = await send(harness.service, [x.annotationId], "req-x");
    expect(ok.request.selections.map((selection) => selection.annotationId)).toEqual([
      x.annotationId,
    ]);
  });

  test("a batch of two reserves both and discussion does not take a reservation", async () => {
    harness = await createHarness();
    const x = await createAnnotation(harness.service, ENV_A, "X");
    const y = await createAnnotation(harness.service, ENV_A, "Y");
    const discuss = await send(harness.service, [x.annotationId], "req-discuss", "discuss");
    expect(discuss.request.reservation).toBe(false);
    const batch = await send(harness.service, [x.annotationId, y.annotationId], "req-batch");
    expect(batch.request.selections.map((selection) => selection.reference)).toEqual([1, 2]);
    for (const id of [x.annotationId, y.annotationId]) {
      expect((await harness.service.get(ENV_A, id)).annotation.activeRequestId).toBe("req-batch");
    }
  });

  test("content changed after preparation rejects send and keeps nothing", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const preparation = await prepare(harness.service, [note.annotationId]);
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-more",
      annotationId: note.annotationId,
      expectedContentRevision: note.contentRevision,
      body: "Actually make it blue",
    });
    await expect(
      harness.service.send({
        environmentId: ENV_A,
        preparationId: preparation.preparationId,
        requestId: "req-1",
        bodyHash: preparation.bodyHash,
      }),
    ).rejects.toThrow("changed after preparation");
    expect(harness.dispatch.published).toHaveLength(0);
  });

  test("an unavailable destination blocks preparation", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    harness.dispatch.destinationOk = false;
    const preparation = await prepare(harness.service, [note.annotationId]);
    expect(preparation.sendable).toBe(false);
    expect(preparation.issues[0]).toMatchObject({
      code: "destination-unavailable",
      severity: "blocker",
    });
  });

  test("materializes attachments before publishing and scopes asset reads", async () => {
    harness = await createHarness();
    const asset = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-asset",
      mediaType: "image/png",
      data: makePng().toString("base64"),
    });
    const note = await createAnnotation(harness.service, ENV_A, "with image", "op-1", [
      asset.asset.id,
    ]);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    expect(harness.dispatch.materializeCalls).toHaveLength(1);
    await expect(harness.dispatch.materializeCalls[0]!.readAsset("asset-other")).rejects.toThrow(
      "not part of this request",
    );
    expect(sent.request.attachments[0]?.materializedPath).toMatch(
      /^\/workspace\/\.orkestrator\/annotations\//,
    );
    expect(sent.request.state).toBe("queued");
  });

  test("a rejected publication fails the request and releases the reservation", async () => {
    harness = await createHarness();
    harness.dispatch.publishReceipt = { status: "rejected", reason: "Queue is full" };
    const note = await createAnnotation(harness.service);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    expect(sent.request).toMatchObject({
      state: "failed",
      reservation: false,
      stateReason: "Queue is full",
    });
    expect(
      (await harness.service.get(ENV_A, note.annotationId)).annotation.activeRequestId,
    ).toBeNull();
  });
});

describe("web annotation request recovery", () => {
  test("a lost publication is re-driven with the same id after restart", async () => {
    harness = await createHarness();
    harness.dispatch.publishFailures = 1;
    const note = await createAnnotation(harness.service);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    expect(sent.request.state).toBe("prepared");
    expect(sent.request.enqueueIntentAt).toBeDefined();
    const restarted = await harness.restart();
    await restarted.reconcileOnce();
    const { request } = await restarted.getRequest(ENV_A, "req-1");
    expect(request.state).toBe("queued");
    expect(harness.dispatch.published.map((input) => input.request.id)).toEqual(["req-1"]);
  });

  test("reconciler applies valid transitions, never regresses, and releases only on terminal", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "queued", {
      blockedReason: "compose-draft",
      dispatchConfirmed: false,
    });
    await harness.service.reconcileOnce();
    let request = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(request).toMatchObject({
      state: "queued",
      blockedReason: "compose-draft",
      reservation: true,
    });

    harness.dispatch.observe_("req-1", "running");
    await harness.service.reconcileOnce();
    request = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(request.state).toBe("running");
    expect(request.dispatchConfirmedAt).not.toBeNull();
    expect((await harness.service.get(ENV_A, note.annotationId)).annotation.activeRequestId).toBe(
      "req-1",
    );

    // Progress bumps metadata only: a content edit at the old revision succeeds.
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-during-run",
      annotationId: note.annotationId,
      expectedContentRevision: note.contentRevision,
      body: "while it runs",
    });

    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();
    request = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(request).toMatchObject({ state: "awaiting-review", reservation: false });
    expect(request.settledAt).not.toBeNull();
    const got = await harness.service.get(ENV_A, note.annotationId);
    expect(got.annotation.state).toBe("open");
    expect(got.annotation.activeRequestId).toBeNull();
    expect(got.entries.at(-1)?.lifecycle).toEqual({
      event: "request-settled",
      requestId: "req-1",
      state: "awaiting-review",
    });

    harness.dispatch.observe_("req-1", "running");
    const calls = harness.dispatch.observeCalls;
    await harness.service.reconcileOnce();
    expect(harness.dispatch.observeCalls).toBe(calls); // settled requests are no longer observed
    expect((await harness.service.getRequest(ENV_A, "req-1")).request.state).toBe(
      "awaiting-review",
    );
  });

  test("an invalid suggested transition keeps the request active", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "prepared");
    await harness.service.reconcileOnce();
    expect((await harness.service.getRequest(ENV_A, "req-1")).request).toMatchObject({
      state: "queued",
      reservation: true,
    });
  });

  test("delete is rejected while an implementation is active", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const { annotation } = await harness.service.get(ENV_A, note.annotationId);
    await expect(
      harness.service.delete({
        environmentId: ENV_A,
        operationId: "op-del",
        annotationId: note.annotationId,
        expectedMetadataRevision: annotation.metadataRevision,
      }),
    ).rejects.toThrow("req-1");
    harness.dispatch.observe_("req-1", "failed", { reason: "provider error" });
    await harness.service.reconcileOnce();
    const settled = (await harness.service.get(ENV_A, note.annotationId)).annotation;
    await harness.service.delete({
      environmentId: ENV_A,
      operationId: "op-del-2",
      annotationId: note.annotationId,
      expectedMetadataRevision: settled.metadataRevision,
    });
  });

  test("a corrupt record never clears a request reservation", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const record = join(
      harness.dir,
      "web-annotations",
      ENV_A,
      "records",
      recordDirectoryName(note.captureId!),
      "1.json",
    );
    await writeFile(record, "corrupt");
    const restarted = await harness.restart();
    const got = await restarted.get(ENV_A, note.annotationId);
    expect(got.annotation.unavailable).toBeDefined();
    expect(got.annotation.activeRequestId).toBe("req-1");
    expect((await restarted.getRequest(ENV_A, "req-1")).request).toMatchObject({
      state: "queued",
      reservation: true,
    });
    harness.dispatch.observe_("req-1", "running");
    await restarted.reconcileOnce();
    expect((await restarted.getRequest(ENV_A, "req-1")).request.state).toBe("running");
  });

  test("cancel is revision-checked and settles through the port", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const sent = await send(harness.service, [note.annotationId], "req-1");
    await expect(
      harness.service.cancelRequest(ENV_A, "req-1", sent.request.revision - 1),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    const cancelled = await harness.service.cancelRequest(ENV_A, "req-1", sent.request.revision);
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.request).toMatchObject({ state: "cancelled", reservation: false });
    expect(cancelled.request.cancelRequestedAt).not.toBeNull();
  });

  test("a running request reports cancelling until settlement", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "running");
    await harness.service.reconcileOnce();
    harness.dispatch.cancelOutcome = { outcome: "cancelling" };
    const revision = (await harness.service.getRequest(ENV_A, "req-1")).request.revision;
    const result = await harness.service.cancelRequest(ENV_A, "req-1", revision);
    expect(result).toMatchObject({
      outcome: "cancelling",
      request: { state: "cancelling", reservation: true },
    });
  });

  test("response capture stores an attributed excerpt once", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1", "discuss");
    const response = await harness.service.requestResponse(ENV_A, "req-1");
    expect(response.response?.text).toBe("Done.");
    await harness.service.requestResponse(ENV_A, "req-1");
    const entries = (await harness.service.get(ENV_A, note.annotationId)).entries.filter(
      (entry) => entry.kind === "agent-response",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provenance: "agent-reference", body: "Done." });
  });
});

describe("web annotation batches from concurrent clients", () => {
  test("overlapping batches from two clients reserve all-or-none", async () => {
    harness = await createHarness();
    const x = await createAnnotation(harness.service, ENV_A, "X");
    const y = await createAnnotation(harness.service, ENV_A, "Y");
    const z = await createAnnotation(harness.service, ENV_A, "Z");
    const first = await prepare(harness.service, [x.annotationId, y.annotationId]);
    const second = await prepare(harness.service, [y.annotationId, z.annotationId]);
    const outcomes = await Promise.allSettled([
      harness.service.send({
        environmentId: ENV_A,
        preparationId: first.preparationId,
        requestId: "req-client-1",
        bodyHash: first.bodyHash,
      }),
      harness.service.send({
        environmentId: ENV_A,
        preparationId: second.preparationId,
        requestId: "req-client-2",
        bodyHash: second.bodyHash,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0]!.status === "fulfilled" ? "req-client-1" : "req-client-2";
    const loserOnly = winner === "req-client-1" ? z.annotationId : x.annotationId;
    // The loser reserved and published nothing, not even its unique item.
    const loser = await harness.service.get(ENV_A, loserOnly);
    expect(loser.annotation.activeRequestId).toBeNull();
    expect(loser.annotation.requestIds).toEqual([]);
    expect(harness.dispatch.published.map((input) => input.request.id)).toEqual([winner]);
    expect((await harness.service.get(ENV_A, y.annotationId)).annotation.activeRequestId).toBe(
      winner,
    );
  });
});

describe("web annotation archived threads", () => {
  test("prepare and send reject an archived annotation with the typed error", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    const preparation = await prepare(harness.service, [note.annotationId]);
    const { annotation } = await harness.service.get(ENV_A, note.annotationId);
    await harness.service.archive({
      environmentId: ENV_A,
      operationId: "op-archive",
      annotationId: note.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
      body: "Continue here",
    });
    const archivedCode = (error: unknown) =>
      (error as { detail?: { code?: string } }).detail?.code ??
      String((error as Error).message).match(/"code":"([a-z-]+)"/)?.[1];
    const sendError = await harness.service
      .send({
        environmentId: ENV_A,
        preparationId: preparation.preparationId,
        requestId: "req-archived",
        bodyHash: preparation.bodyHash,
      })
      .catch((error: unknown) => error);
    expect(archivedCode(sendError)).toBe("archived");
    const prepareError = await prepare(harness.service, [note.annotationId]).catch(
      (error: unknown) => error,
    );
    expect(archivedCode(prepareError)).toBe("archived");
    expect(harness.dispatch.published).toHaveLength(0);
  });
});

describe("web annotation request observation", () => {
  test("turn outcome, interactions, transcript and destination loss are recorded", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "needs-input", {
      interactions: [{ id: "question:1", kind: "question", state: "pending", blocking: true }],
      interactionIds: ["question:1"],
      transcript: { messageId: "user-msg-1", turnId: "turn-1" },
    });
    await harness.service.reconcileOnce();
    let request = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(request).toMatchObject({
      state: "needs-input",
      interactionIds: ["question:1"],
      interactions: [{ id: "question:1", kind: "question" }],
      transcript: { requestId: "req-1", messageId: "user-msg-1", turnId: "turn-1" },
    });
    harness.dispatch.observe_("req-1", "failed", {
      turnOutcome: "failed",
      turnError: "model overloaded",
      reason: "The agent turn failed: model overloaded",
    });
    await harness.service.reconcileOnce();
    request = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(request).toMatchObject({
      state: "failed",
      turnOutcome: "failed",
      turnError: "model overloaded",
      reservation: false,
      interactions: [],
    });
  });

  test("a turn that finished before it was ever seen running still settles", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "awaiting-review", { turnOutcome: "completed" });
    await harness.service.reconcileOnce();
    expect((await harness.service.getRequest(ENV_A, "req-1")).request).toMatchObject({
      state: "awaiting-review",
      turnOutcome: "completed",
      reservation: false,
    });
  });

  test("a stop that fails is stored as a typed refusal", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "running");
    await harness.service.reconcileOnce();
    harness.dispatch.cancelOutcome = {
      outcome: "not-cancellable",
      code: "stop-failed",
      reason: "Stop failed: bridge offline",
    };
    const revision = (await harness.service.getRequest(ENV_A, "req-1")).request.revision;
    const result = await harness.service.cancelRequest(ENV_A, "req-1", revision);
    expect(result).toMatchObject({
      outcome: "not-cancellable",
      refusal: "stop-failed",
      request: {
        state: "running",
        reservation: true,
        cancelRefusal: { code: "stop-failed", message: "Stop failed: bridge offline" },
      },
    });
  });

  test("a chat-queue removal cancels through annotation cancellation", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const handled = await harness.service.cancelFromChatQueue(ENV_A, "req-1");
    expect(handled).toMatchObject({
      removed: true,
      request: { state: "cancelled", cancelSource: "chat-queue", reservation: false },
    });
    expect(await harness.service.cancelFromChatQueue(ENV_A, "req-1")).toBeNull();
    expect(await harness.service.cancelFromChatQueue(ENV_A, "req-unknown")).toBeNull();
  });
});

describe("web annotation retarget", () => {
  const other = { ...fixtureDestination, tabId: "tab-other", logicalSessionKey: "env-a:tab-other" };

  test("a deleted destination is surfaced; retarget moves the request atomically", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "queued", {
      blockedReason: "destination-unavailable",
      destinationMissing: true,
      dispatchConfirmed: false,
    });
    await harness.service.reconcileOnce();
    const held = (await harness.service.getRequest(ENV_A, "req-1")).request;
    expect(held.blockedReason).toBe("destination-unavailable");
    expect(held.destinationMissingAt).not.toBeNull();

    const preparation = await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: other,
      annotations: [],
      instruction: "",
      retargetOf: "req-1",
    });
    expect(preparation).toMatchObject({ sendable: true, retargetOf: "req-1" });
    expect(preparation.issues.map((issue) => issue.code)).not.toContain("active-implementation");
    const moved = await harness.service.send({
      environmentId: ENV_A,
      preparationId: preparation.preparationId,
      requestId: "req-2",
      bodyHash: preparation.bodyHash,
    });
    expect(moved.request).toMatchObject({
      retargetOf: "req-1",
      destination: { tabId: "tab-other" },
      reservation: true,
    });
    expect((await harness.service.getRequest(ENV_A, "req-1")).request).toMatchObject({
      state: "cancelled",
      cancelSource: "retarget",
      retargetedTo: "req-2",
      reservation: false,
    });
    expect((await harness.service.get(ENV_A, note.annotationId)).annotation.activeRequestId).toBe(
      "req-2",
    );
  });

  test("a request that may have reached its agent cannot be retargeted", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    harness.dispatch.observe_("req-1", "running");
    await harness.service.reconcileOnce();
    const preparation = await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: other,
      annotations: [],
      instruction: "",
      retargetOf: "req-1",
    });
    expect(preparation.sendable).toBe(false);
    expect(preparation.issues).toContainEqual(
      expect.objectContaining({ code: "retarget-unavailable", severity: "blocker" }),
    );
  });

  test("a refused withdrawal sends nothing", async () => {
    harness = await createHarness();
    const note = await createAnnotation(harness.service);
    await send(harness.service, [note.annotationId], "req-1");
    const preparation = await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: other,
      annotations: [],
      instruction: "",
      retargetOf: "req-1",
    });
    harness.dispatch.cancelOutcome = {
      outcome: "not-cancellable",
      code: "claimed",
      reason: "The request is being delivered to the agent",
    };
    await expect(
      harness.service.send({
        environmentId: ENV_A,
        preparationId: preparation.preparationId,
        requestId: "req-2",
        bodyHash: preparation.bodyHash,
      }),
    ).rejects.toThrow("was not retargeted");
    expect((await harness.service.listRequests(ENV_A)).requests.map((r) => r.id)).toEqual([
      "req-1",
    ]);
  });
});

describe("web annotation environment deletion", () => {
  test("stops writes and removes the store", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service);
    const dir = join(harness.dir, "web-annotations", ENV_A);
    expect(existsSync(dir)).toBe(true);
    await harness.service.deleteEnvironment(ENV_A);
    expect(existsSync(dir)).toBe(false);
    await expect(createAnnotation(harness.service)).rejects.toThrow("deleted");
    await createAnnotation(harness.service, ENV_B);
  });
});
