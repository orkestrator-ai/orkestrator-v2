import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  type WebAnnotationChangeHint,
} from "@orkestrator/protocol/web-annotations";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import { rejectionDetail, sendRequest } from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function withEntries(count: number) {
  harness = await createHarness();
  const staged = await harness.service.stageAsset({
    environmentId: ENV_A,
    operationId: "op-img",
    mediaType: "image/png",
    data: makePng().toString("base64"),
  });
  const receipt = await createAnnotation(harness.service, ENV_A, "First note", "op-1", [
    staged.asset.id,
  ]);
  let revision = receipt.contentRevision;
  for (let index = 2; index <= count; index++) {
    const next = await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: `op-append-${index}`,
      annotationId: receipt.annotationId,
      expectedContentRevision: revision,
      body: `Note ${index}`,
    });
    revision = next.contentRevision;
  }
  return { receipt, assetId: staged.asset.id };
}

describe("archive and continuation", () => {
  test("archives a thread into read-only history and continues it with a linked copy", async () => {
    const { receipt, assetId } = await withEntries(3);
    const service = harness!.service;
    const source = await service.get(ENV_A, receipt.annotationId);
    harness!.events.length = 0;
    const result = await service.archive({
      environmentId: ENV_A,
      operationId: "op-archive",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: source.annotation.metadataRevision,
      body: "Continue with a smaller padding change",
    });
    const continuationId = result.continuation.annotationId;
    expect(result.archivedAnnotationId).toBe(receipt.annotationId);

    const archived = await service.get(ENV_A, receipt.annotationId);
    expect(archived.annotation).toMatchObject({
      continuationId,
      archivedAt: expect.any(String),
      state: "open",
    });
    expect(archived.entries.at(-1)).toMatchObject({
      provenance: "system",
      kind: "lifecycle",
      lifecycle: { event: "archived", relatedAnnotationId: continuationId },
    });

    const continuation = await service.get(ENV_A, continuationId);
    expect(continuation.annotation).toMatchObject({
      continuedFromId: receipt.annotationId,
      title: `${source.annotation.title} (continued)`,
      latestIntent: "Continue with a smaller padding change",
      state: "open",
    });
    // Carries the same target and evidence as a new immutable capture.
    expect(continuation.capture?.id).not.toBe(source.capture?.id);
    expect(continuation.capture?.target).toEqual(source.capture!.target);
    expect(continuation.capture?.page).toEqual(source.capture!.page);
    expect(continuation.capture?.assetIds).toEqual([assetId]);
    expect(continuation.entries.map((entry) => [entry.provenance, entry.kind])).toEqual([
      ["system", "lifecycle"],
      ["host-user", "comment"],
    ]);
    expect(continuation.entries[0]?.lifecycle).toEqual({
      event: "created",
      relatedAnnotationId: receipt.annotationId,
    });

    // One commit, one hint naming both threads.
    const hints = harness!.events
      .filter((event) => event.event === WEB_ANNOTATIONS_CHANGED_EVENT)
      .map((event) => event.payload as WebAnnotationChangeHint);
    expect(hints).toHaveLength(1);
    expect(new Set(hints[0]!.annotationIds)).toEqual(
      new Set([receipt.annotationId, continuationId]),
    );

    // Default lists show the continuation only; archived history on request.
    const list = await service.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.id)).toEqual([continuationId]);
    const all = await service.list({ environmentId: ENV_A, filter: { includeArchived: true } });
    expect(new Set(all.items.map((item) => item.id))).toEqual(
      new Set([receipt.annotationId, continuationId]),
    );
  });

  test("archived threads are read-only with a typed error naming the continuation", async () => {
    const { receipt } = await withEntries(1);
    const service = harness!.service;
    const { annotation } = await service.get(ENV_A, receipt.annotationId);
    const result = await service.archive({
      environmentId: ENV_A,
      operationId: "op-archive",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
    const refused = await rejectionDetail(
      service.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-late",
        annotationId: receipt.annotationId,
        expectedContentRevision: annotation.contentRevision,
        body: "late",
      }),
    );
    expect(refused.detail).toEqual({
      code: "archived",
      continuationId: result.continuation.annotationId,
    });
    // Retrying the same operation returns the original result; a second
    // archive of the same thread is refused.
    expect(
      await service.archive({
        environmentId: ENV_A,
        operationId: "op-archive",
        annotationId: receipt.annotationId,
        expectedMetadataRevision: annotation.metadataRevision,
      }),
    ).toEqual(result);
    expect(
      (
        await rejectionDetail(
          service.archive({
            environmentId: ENV_A,
            operationId: "op-archive-2",
            annotationId: receipt.annotationId,
            expectedMetadataRevision: annotation.metadataRevision + 1,
          }),
        )
      ).detail?.code,
    ).toBe("archived");
    // A restart keeps the archive and its link.
    const restarted = await harness!.restart();
    expect((await restarted.get(ENV_A, receipt.annotationId)).annotation.continuationId).toBe(
      result.continuation.annotationId,
    );
  });

  test("archiving is refused while an implementation is still active", async () => {
    const { receipt } = await withEntries(1);
    const service = harness!.service;
    await sendRequest(service, receipt.annotationId, "req-1");
    const { annotation } = await service.get(ENV_A, receipt.annotationId);
    const refused = await rejectionDetail(
      service.archive({
        environmentId: ENV_A,
        operationId: "op-archive",
        annotationId: receipt.annotationId,
        expectedMetadataRevision: annotation.metadataRevision,
      }),
    );
    expect(refused.detail?.code).toBe("conflict");
    expect(refused.message).toContain("req-1");
    expect((await service.get(ENV_A, receipt.annotationId)).annotation.archivedAt).toBeUndefined();
  });
});

describe("entry paging", () => {
  test("pages the newest entries first and older history backwards", async () => {
    const { receipt } = await withEntries(WEB_ANNOTATION_LIMITS.entryPageItems + 7);
    const service = harness!.service;
    const total = WEB_ANNOTATION_LIMITS.entryPageItems + 7;
    const latest = await service.get(ENV_A, receipt.annotationId, 20, "latest");
    expect(latest.entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => total - 19 + index),
    );
    expect(latest.nextEntrySequence).toBeNull();
    expect(latest.previousEntrySequence).toBe(total - 19);
    const older = await service.entries(ENV_A, receipt.annotationId, 0, 20, total - 19);
    expect(older.entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => total - 39 + index),
    );
    expect(older.previousSequence).toBe(total - 39);
    const oldest = await service.entries(
      ENV_A,
      receipt.annotationId,
      0,
      50,
      older.previousSequence!,
    );
    expect(oldest.entries[0]?.sequence).toBe(1);
    expect(oldest.previousSequence).toBeNull();
    // Forward paging is unchanged and bounded by the 50-item page.
    const first = await service.get(ENV_A, receipt.annotationId);
    expect(first.entries).toHaveLength(WEB_ANNOTATION_LIMITS.entryPageItems);
    expect(first.nextEntrySequence).toBe(WEB_ANNOTATION_LIMITS.entryPageItems);
    // Out-of-range backward cursors ask for a reset instead of guessing.
    expect(
      (await service.entries(ENV_A, receipt.annotationId, 0, 10, total + 5)).resetRequired,
    ).toBe(true);
    expect((await service.entries(ENV_A, receipt.annotationId, 3, 10, 10)).resetRequired).toBe(
      true,
    );
  });
});
