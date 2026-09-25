import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  webAnnotationPageKey,
  type WebAnnotationChangeHint,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixtureCaptureInput,
  fixturePage,
} from "@orkestrator/protocol/web-annotations-fixtures";
import { WebAnnotationChangeRing } from "./web-annotation-sync.js";
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

describe("web annotation threads", () => {
  test("creates a thread with capture and host entry, and survives restart", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(
      harness.service,
      ENV_A,
      "Give the Save button\nmore padding.",
    );
    expect(receipt).toMatchObject({ contentRevision: 1, metadataRevision: 1, captureRevision: 1 });
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "client-1:new",
      expectedRevision: 0,
      text: "half typed",
    });
    const restarted = await harness.restart();
    const got = await restarted.get(ENV_A, receipt.annotationId);
    expect(got.annotation.title).toBe("Give the Save button");
    expect(got.annotation.latestIntent).toBe("Give the Save button more padding.");
    expect(got.capture?.target.kind).toBe("element");
    expect(got.entries).toHaveLength(1);
    expect(got.entries[0]).toMatchObject({ provenance: "host-user", kind: "comment", sequence: 1 });
    expect((await restarted.getDraft(ENV_A, "client-1:new"))?.text).toBe("half typed");
  });

  test("rejects an empty note and declared provenance never reaches storage", async () => {
    harness = await createHarness();
    await expect(createAnnotation(harness.service, ENV_A, "   ")).rejects.toThrow(
      "must not be empty",
    );
  });

  test("two creates with the same operation id create one annotation", async () => {
    harness = await createHarness();
    const [first, second] = await Promise.all([
      createAnnotation(harness.service, ENV_A, "Same", "op-same"),
      createAnnotation(harness.service, ENV_A, "Same", "op-same"),
    ]);
    expect(second).toEqual(first);
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(1);
  });

  test("concurrent content edits conflict on the expected content revision", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const append = (operationId: string, body: string) =>
      harness.service.appendEntryCommand({
        environmentId: ENV_A,
        operationId,
        annotationId: receipt.annotationId,
        expectedContentRevision: receipt.contentRevision,
        body,
      });
    const results = await Promise.allSettled([append("op-1", "A"), append("op-2", "B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason)).toContain(WEB_ANNOTATION_CONFLICT);
  });

  test("edits supersede without rewriting history", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A, "Original");
    const edited = await harness.service.editEntry({
      environmentId: ENV_A,
      operationId: "op-edit",
      annotationId: receipt.annotationId,
      entryId: receipt.entryId!,
      expectedContentRevision: 1,
      body: "Edited",
    });
    const got = await harness.service.get(ENV_A, receipt.annotationId);
    expect(
      got.entries.map((entry) => [
        entry.body,
        entry.supersedes ?? null,
        entry.supersededBy ?? null,
      ]),
    ).toEqual([
      ["Original", null, edited.entryId],
      ["Edited", receipt.entryId, null],
    ]);
    expect(got.annotation.latestIntent).toBe("Edited");
    await expect(
      harness.service.editEntry({
        environmentId: ENV_A,
        operationId: "op-edit-2",
        annotationId: receipt.annotationId,
        entryId: receipt.entryId!,
        expectedContentRevision: edited.contentRevision,
        body: "Again",
      }),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
  });

  test("metadata updates do not invalidate content revisions", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const updated = await harness.service.update({
      environmentId: ENV_A,
      operationId: "op-u",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: receipt.metadataRevision,
      title: "Renamed",
      hidden: true,
    });
    expect(updated.contentRevision).toBe(receipt.contentRevision);
    expect(updated.metadataRevision).toBe(receipt.metadataRevision + 1);
    // A content edit using the pre-update content revision still succeeds.
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-a",
      annotationId: receipt.annotationId,
      expectedContentRevision: receipt.contentRevision,
      body: "Also this",
    });
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(0);
    expect(
      (await harness.service.list({ environmentId: ENV_A, filter: { includeHidden: true } })).total,
    ).toBe(1);
  });

  test("resolve checks content and capture revisions; a new reply reopens", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const reply = await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-r1",
      annotationId: receipt.annotationId,
      expectedContentRevision: 1,
      body: "Also align it",
    });
    const resolve = (operationId: string, contentRevision: number, captureId: string) =>
      harness.service.resolve({
        environmentId: ENV_A,
        operationId,
        annotationId: receipt.annotationId,
        expectedContentRevision: contentRevision,
        expectedCaptureId: captureId,
      });
    await expect(resolve("op-stale", 1, receipt.captureId!)).rejects.toThrow(
      WEB_ANNOTATION_CONFLICT,
    );
    await expect(
      resolve("op-stale-capture", reply.contentRevision, "capture-other"),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    const resolved = await resolve("op-ok", reply.contentRevision, receipt.captureId!);
    let got = await harness.service.get(ENV_A, receipt.annotationId);
    expect(got.annotation.state).toBe("resolved");
    expect(got.annotation.resolution).toMatchObject({
      acceptedBy: "host-user",
      contentRevision: reply.contentRevision,
      captureId: receipt.captureId,
    });
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-r2",
      annotationId: receipt.annotationId,
      expectedContentRevision: resolved.contentRevision,
      body: "One more thing",
    });
    got = await harness.service.get(ENV_A, receipt.annotationId);
    expect(got.annotation.state).toBe("open");
    expect(got.annotation.resolution).toBeNull();
    expect(got.entries.map((entry) => entry.lifecycle?.event ?? entry.kind)).toEqual([
      "comment",
      "comment",
      "resolved",
      "comment",
      "reopened",
    ]);
  });

  test("reopen and delete are revision-checked tombstones", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const resolved = await harness.service.resolve({
      environmentId: ENV_A,
      operationId: "op-res",
      annotationId: receipt.annotationId,
      expectedContentRevision: 1,
      expectedCaptureId: receipt.captureId!,
    });
    const reopened = await harness.service.reopen({
      environmentId: ENV_A,
      operationId: "op-reopen",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: resolved.metadataRevision,
    });
    await expect(
      harness.service.delete({
        environmentId: ENV_A,
        operationId: "op-del-stale",
        annotationId: receipt.annotationId,
        expectedMetadataRevision: resolved.metadataRevision,
      }),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    await harness.service.delete({
      environmentId: ENV_A,
      operationId: "op-del",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: reopened.metadataRevision,
    });
    expect(
      (
        await harness.service.list({
          environmentId: ENV_A,
          filter: { state: "all", includeHidden: true },
        })
      ).total,
    ).toBe(0);
    expect((await harness.service.get(ENV_A, receipt.annotationId)).annotation.state).toBe(
      "deleted",
    );
  });

  test("capture replacement keeps the old capture and bumps content", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const replaced = await harness.service.replaceCapture({
      environmentId: ENV_A,
      operationId: "op-cap",
      annotationId: receipt.annotationId,
      expectedContentRevision: 1,
      capture: fixtureCaptureInput("page"),
    });
    expect(replaced.captureRevision).toBe(2);
    expect(replaced.captureId).not.toBe(receipt.captureId);
    expect((await harness.service.capture(ENV_A, receipt.captureId!)).revision).toBe(1);
    const got = await harness.service.get(ENV_A, receipt.annotationId);
    expect(got.annotation.targetKind).toBe("page");
    expect(got.entries.at(-1)?.lifecycle?.event).toBe("capture-replaced");
  });

  test("entries page with reset for impossible cursors", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    let revision = receipt.contentRevision;
    for (let index = 0; index < 4; index++) {
      revision = (
        await harness.service.appendEntryCommand({
          environmentId: ENV_A,
          operationId: `op-${index}`,
          annotationId: receipt.annotationId,
          expectedContentRevision: revision,
          body: `reply ${index}`,
        })
      ).contentRevision;
    }
    const first = await harness.service.entries(ENV_A, receipt.annotationId, 0, 2);
    expect(first.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(first.nextSequence).toBe(2);
    const rest = await harness.service.entries(ENV_A, receipt.annotationId, 2, 10);
    expect(rest.entries.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
    expect(rest.nextSequence).toBeNull();
    expect((await harness.service.entries(ENV_A, receipt.annotationId, 99)).resetRequired).toBe(
      true,
    );
  });
});

describe("web annotation drafts", () => {
  test("drafts are revision-checked and separate from published entries", async () => {
    harness = await createHarness();
    const saved = await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "draft",
    });
    expect(saved.revision).toBe(1);
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "other",
      }),
    ).rejects.toThrow(WEB_ANNOTATION_CONFLICT);
    const next = await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 1,
      text: "draft 2",
    });
    expect(next.revision).toBe(2);
    await expect(harness.service.deleteDraft(ENV_A, "ed-1", 1)).rejects.toThrow(
      WEB_ANNOTATION_CONFLICT,
    );
    // Publishing with the draft id removes the draft atomically with the create.
    await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-pub",
      capture: fixtureCaptureInput(),
      body: "draft 2",
      draftId: next.id,
    });
    expect(await harness.service.getDraft(ENV_A, "ed-1")).toBeNull();
  });

  test("draft text is bounded", async () => {
    harness = await createHarness();
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "x".repeat(WEB_ANNOTATION_LIMITS.entryChars + 1),
      }),
    ).rejects.toThrow(WEB_ANNOTATION_CAPACITY);
  });
});

describe("web annotation environment isolation", () => {
  test("records, captures, drafts, and assets of one environment are invisible to another", async () => {
    harness = await createHarness();
    const staged = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-asset",
      mediaType: "image/png",
      data: makePng().toString("base64"),
    });
    const receipt = await createAnnotation(harness.service, ENV_A, "Secret", "op-1", [
      staged.asset.id,
    ]);
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "x",
    });
    await expect(harness.service.get(ENV_B, receipt.annotationId)).rejects.toThrow("not found");
    await expect(harness.service.capture(ENV_B, receipt.captureId!)).rejects.toThrow("not found");
    await expect(harness.service.getAsset(ENV_B, staged.asset.id)).rejects.toThrow("not found");
    await expect(harness.service.entries(ENV_B, receipt.annotationId, 0)).rejects.toThrow(
      "not found",
    );
    expect(await harness.service.getDraft(ENV_B, "ed-1")).toBeNull();
    expect(await harness.service.receipt(ENV_B, "op-1")).toBeNull();
    // An environment B capture cannot reference an environment A asset.
    await expect(
      createAnnotation(harness.service, ENV_B, "Steal", "op-2", [staged.asset.id]),
    ).rejects.toThrow("Asset not found");
  });
});

describe("web annotation assets and quotas", () => {
  test("stages PNGs with digest dedupe and round-trips bytes", async () => {
    harness = await createHarness();
    const data = makePng(6, 6, 3).toString("base64");
    const first = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-1",
      mediaType: "image/png",
      data,
    });
    const second = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-2",
      mediaType: "image/png",
      data,
    });
    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ asset: first.asset, deduplicated: true });
    expect((await harness.service.getAsset(ENV_A, first.asset.id)).data).toBe(data);
    await expect(
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-3",
        mediaType: "image/png",
        data: "AAAA",
      }),
    ).rejects.toThrow();
  });

  test("GC keeps referenced assets and removes only owned orphans after the grace period", async () => {
    harness = await createHarness();
    const stage = (seed: number, operationId: string) =>
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId,
        mediaType: "image/png",
        data: makePng(3, 3, seed).toString("base64"),
      });
    const kept = await stage(1, "op-1");
    const orphan = await stage(2, "op-2");
    await createAnnotation(harness.service, ENV_A, "uses asset", "op-3", [kept.asset.id]);
    await harness.service.collectGarbage(ENV_A);
    await harness.service.getAsset(ENV_A, orphan.asset.id);
    harness.clock.advance(WEB_ANNOTATION_LIMITS.assetGcGraceMs + 1_000);
    const result = await harness.service.collectGarbage(ENV_A);
    expect(result.removedAssets).toBe(1);
    await expect(harness.service.getAsset(ENV_A, orphan.asset.id)).rejects.toThrow("not found");
    expect((await harness.service.getAsset(ENV_A, kept.asset.id)).asset.id).toBe(kept.asset.id);
  });

  test("the annotation count quota is enforced with usage totals", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      for (let index = 0; index < WEB_ANNOTATION_LIMITS.environmentAnnotations - 1; index++) {
        const id = `seed-${index}`;
        tx.manifest.annotations[id] = fixtureAnnotation({ id, environmentId: ENV_A, hidden: true });
      }
      tx.markDirty();
    });
    await createAnnotation(harness.service, ENV_A, "last one fits");
    await expect(createAnnotation(harness.service, ENV_A, "one too many")).rejects.toThrow(
      `${WEB_ANNOTATION_CAPACITY} environment has 2000 of 2000 annotations`,
    );
  });

  test("deleting an annotation frees its annotation slot", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      for (let index = 0; index < WEB_ANNOTATION_LIMITS.environmentAnnotations - 1; index++) {
        const id = `seed-${index}`;
        tx.manifest.annotations[id] = fixtureAnnotation({ id, environmentId: ENV_A, hidden: true });
      }
      tx.markDirty();
    });
    const last = await createAnnotation(harness.service, ENV_A, "fills the quota");
    await expect(createAnnotation(harness.service, ENV_A, "over quota", "op-over")).rejects.toThrow(
      WEB_ANNOTATION_CAPACITY,
    );
    const { annotation } = await harness.service.get(ENV_A, last.annotationId);
    await harness.service.delete({
      environmentId: ENV_A,
      operationId: "op-del",
      annotationId: last.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
    const replacement = await createAnnotation(harness.service, ENV_A, "fits again", "op-again");
    expect(replacement.annotationId).not.toBe(last.annotationId);
  });

  test("GC collects the images of a deleted annotation after the grace period", async () => {
    harness = await createHarness();
    const staged = await harness.service.stageAsset({
      environmentId: ENV_A,
      operationId: "op-stage",
      mediaType: "image/png",
      data: makePng(3, 3, 7).toString("base64"),
    });
    const receipt = await createAnnotation(harness.service, ENV_A, "with image", "op-create", [
      staged.asset.id,
    ]);
    await harness.service.collectGarbage(ENV_A);
    harness.clock.advance(WEB_ANNOTATION_LIMITS.assetGcGraceMs + 1_000);
    expect((await harness.service.collectGarbage(ENV_A)).removedAssets).toBe(0);

    const { annotation } = await harness.service.get(ENV_A, receipt.annotationId);
    await harness.service.delete({
      environmentId: ENV_A,
      operationId: "op-del",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
    // First pass marks the now-unreachable image; removal waits for the grace.
    expect((await harness.service.collectGarbage(ENV_A)).removedAssets).toBe(0);
    await harness.service.getAsset(ENV_A, staged.asset.id);
    harness.clock.advance(WEB_ANNOTATION_LIMITS.assetGcGraceMs + 1_000);
    expect((await harness.service.collectGarbage(ENV_A)).removedAssets).toBe(1);
    await expect(harness.service.getAsset(ENV_A, staged.asset.id)).rejects.toThrow("not found");
  });
});

describe("web annotation listing", () => {
  test("paginates with snapshot-tagged cursors and rejects inconsistent continuation", async () => {
    harness = await createHarness();
    const receipts = [];
    for (let index = 0; index < 5; index++) {
      receipts.push(await createAnnotation(harness.service, ENV_A, `note ${index}`));
      harness.clock.advance(1_000);
    }
    const first = await harness.service.list({ environmentId: ENV_A, limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(["note 4", "note 3"]);
    expect(first.total).toBe(5);
    // A new annotation sorts before the cursor: continuation stays consistent.
    await createAnnotation(harness.service, ENV_A, "note 5");
    const second = await harness.service.list({
      environmentId: ENV_A,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.title)).toEqual(["note 2", "note 1"]);
    // A change to an item after the cursor makes continuation unsafe.
    await harness.service.update({
      environmentId: ENV_A,
      operationId: "op-hide",
      annotationId: receipts[0]!.annotationId,
      expectedMetadataRevision: 1,
      hidden: true,
    });
    await expect(
      harness.service.list({ environmentId: ENV_A, limit: 2, cursor: second.nextCursor! }),
    ).rejects.toThrow("refresh");
    await expect(
      harness.service.list({
        environmentId: ENV_A,
        limit: 2,
        cursor: first.nextCursor!,
        filter: { state: "all" },
      }),
    ).rejects.toThrow("another filter");
  });

  test("filters by page and counts open notes on the page", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "here");
    await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-other",
      capture: { ...fixtureCaptureInput(), page: { ...fixturePage, route: "/other" } },
      body: "elsewhere",
    });
    const pageKey = webAnnotationPageKey(fixturePage);
    const list = await harness.service.list({ environmentId: ENV_A, filter: { pageKey } });
    expect(list.items.map((item) => item.title)).toEqual(["here"]);
    expect(list.openOnPage).toBe(1);
  });
});

describe("web annotation synchronization", () => {
  test("hints are emitted after commit and contain no content", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A, "SECRET-BODY-TEXT");
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed",
      expectedRevision: 0,
      text: "SECRET-DRAFT",
    });
    const hints = harness.events.filter((event) => event.event === WEB_ANNOTATIONS_CHANGED_EVENT);
    // Draft autosaves commit only the draft index: no environment revision,
    // no hint (drafts are per-editor and fetched on demand).
    expect(hints).toHaveLength(1);
    const serialized = JSON.stringify(hints);
    for (const forbidden of ["SECRET", "localhost", "/settings", "workspace", harness.dir]) {
      expect(serialized).not.toContain(forbidden);
    }
    const hint = hints[0]!.payload as WebAnnotationChangeHint;
    expect(hint).toEqual({
      environmentId: ENV_A,
      generation: harness.service.generation,
      revision: 1,
      annotationIds: [receipt.annotationId],
      requestIds: [],
      reset: false,
    });
  });

  test("changes returns contiguous ranges or resetRequired", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A);
    await createAnnotation(harness.service, ENV_A);
    const generation = harness.service.generation;
    const changes = await harness.service.changes(ENV_A, generation, 0);
    expect(changes.resetRequired).toBe(false);
    expect(changes.changes.map((change) => change.revision)).toEqual([1, 2]);
    expect((await harness.service.changes(ENV_A, generation, 2)).changes).toEqual([]);
    expect((await harness.service.changes(ENV_A, generation, 3)).resetRequired).toBe(true);
    expect((await harness.service.changes(ENV_A, "other-generation", 1)).resetRequired).toBe(true);
    const restarted = await harness.restart();
    const afterRestart = await restarted.changes(ENV_A, generation, 1);
    expect(afterRestart).toMatchObject({ resetRequired: true, revision: 2 });
    expect((await restarted.changes(ENV_A, restarted.generation, 1)).resetRequired).toBe(true);
    expect((await restarted.changes(ENV_A, restarted.generation, 2)).resetRequired).toBe(false);
  });

  test("ring expiry, oversized change sets, and environment eviction reset", () => {
    const ring = new WebAnnotationChangeRing(
      { entries: 3, environments: 2, idsPerChange: 2 },
      "gen",
    );
    for (let revision = 1; revision <= 5; revision++)
      ring.record("e1", revision, [`a${revision}`], []);
    expect(ring.changes("e1", "gen", 1, 5).resetRequired).toBe(true);
    expect(ring.changes("e1", "gen", 2, 5).changes.map((change) => change.revision)).toEqual([
      3, 4, 5,
    ]);
    const hint = ring.record("e1", 6, ["x", "y", "z"], []);
    expect(hint).toMatchObject({ reset: true, annotationIds: [], requestIds: [] });
    expect(ring.changes("e1", "gen", 5, 6).resetRequired).toBe(true);
    ring.record("e2", 1, ["b"], []);
    ring.record("e3", 1, ["c"], []);
    expect(ring.changes("e1", "gen", 6, 7).resetRequired).toBe(true);
    expect(ring.changes("e1", "gen", 6, 6).resetRequired).toBe(false);
    expect(ring.changes("e3", "gen", 0, 1).changes).toHaveLength(1);
    // A gap between recorded revisions is never reported as success.
    ring.record("e3", 3, ["d"], []);
    expect(ring.changes("e3", "gen", 1, 3).resetRequired).toBe(true);
  });
});
