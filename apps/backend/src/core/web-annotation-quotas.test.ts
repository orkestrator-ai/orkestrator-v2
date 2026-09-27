import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_LIMITS,
} from "@orkestrator/protocol/web-annotations";
import { fixtureAnnotation } from "@orkestrator/protocol/web-annotations-fixtures";
import { MATERIALIZED_EVIDENCE_RETENTION_MS } from "./web-annotation-materialization.js";
import { recordDirectoryName, requestTextRecordId } from "./web-annotation-storage.js";
import type { WebAnnotationFaultStage } from "./web-annotation-storage.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import {
  environmentDir,
  readJsonFile,
  rejectionDetail,
  sendRequest,
} from "./web-annotation-test-helpers.js";

const MiB = 1024 * 1024;

let harness: ServiceHarness | undefined;
const temporary: string[] = [];
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

function faultOnce(stage: WebAnnotationFaultStage) {
  const state = { armed: false, fired: 0 };
  return {
    state,
    hook: (current: WebAnnotationFaultStage) => {
      if (state.armed && current === stage) {
        state.armed = false;
        state.fired++;
        throw new Error(`injected ${stage}`);
      }
    },
  };
}

async function stage(service: ServiceHarness["service"], seed: number, operationId = `op-${seed}`) {
  return service.stageAsset({
    environmentId: ENV_A,
    operationId,
    mediaType: "image/png",
    data: makePng(4, 3, seed).toString("base64"),
  });
}

describe("environment quotas through the service", () => {
  test("the 512 MiB image quota refuses a new image with usage totals and keeps the draft", async () => {
    harness = await createHarness();
    const existing = await stage(harness.service, 1);
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "unsent note",
    });
    const store = await harness.service.storage.environment(ENV_A);
    const filler = WEB_ANNOTATION_LIMITS.environmentImageBytes - existing.asset.bytes;
    await store.mutate((tx) => {
      tx.markEssential();
      // Account for 512 MiB of stored images without writing them.
      for (let index = 0; index < 64; index++) {
        tx.manifest.assets[`asset-quota-${index}`] = {
          id: `asset-quota-${index}`,
          digest: createHash("sha256").update(`quota-${index}`).digest("hex"),
          bytes: Math.floor(filler / 64) + (index === 0 ? filler % 64 : 0),
          width: 1,
          height: 1,
          createdAt: tx.now,
          orphanedAt: null,
        };
      }
      tx.markDirty();
    });
    const refused = await rejectionDetail(stage(harness.service, 2));
    expect(refused.message).toContain(WEB_ANNOTATION_CAPACITY);
    expect(refused.detail).toMatchObject({
      code: "capacity",
      resource: "image-bytes",
      used: WEB_ANNOTATION_LIMITS.environmentImageBytes,
      limit: WEB_ANNOTATION_LIMITS.environmentImageBytes,
    });
    expect(refused.detail?.requested).toBeGreaterThan(0);
    // Deduplicated bytes are not new usage and are still accepted.
    expect((await stage(harness.service, 1, "op-again")).deduplicated).toBe(true);
    expect((await harness.service.getDraft(ENV_A, "ed-1"))?.text).toBe("unsent note");
    expect(await readdir(join(environmentDir(harness.dir), "staging")).catch(() => [])).toEqual([]);
  });

  test("the 32 MiB metadata quota refuses content but never progress or receipts", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.usage.recordBytes = WEB_ANNOTATION_LIMITS.environmentMetadataBytes;
      tx.markDirty();
    });
    const created = await rejectionDetail(createAnnotation(harness.service, ENV_A, "more"));
    expect(created.detail).toMatchObject({
      code: "capacity",
      resource: "metadata-bytes",
      limit: WEB_ANNOTATION_LIMITS.environmentMetadataBytes,
    });
    expect(created.detail!.used!).toBeGreaterThanOrEqual(
      WEB_ANNOTATION_LIMITS.environmentMetadataBytes,
    );
    const drafted = await rejectionDetail(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "draft",
      }),
    );
    expect(drafted.detail).toMatchObject({ code: "capacity", resource: "metadata-bytes" });
    // Execution progress (essential) still commits at the limit.
    const progress = await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.annotations[receipt.annotationId]!.hidden = true;
      tx.touch({ annotationIds: [receipt.annotationId] });
    });
    expect(progress.committed).toBe(true);
    // Freeing space makes the quota pass again.
    await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.usage.recordBytes = 0;
      tx.markDirty();
    });
    await createAnnotation(harness.service, ENV_A, "fits again");
  });

  test("the annotation count quota ignores tombstones", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      tx.markEssential();
      for (let index = 0; index < WEB_ANNOTATION_LIMITS.environmentAnnotations; index++) {
        const id = `annotation-quota-${index}`;
        tx.manifest.annotations[id] = fixtureAnnotation({ id, environmentId: ENV_A });
      }
      tx.markDirty();
    });
    const refused = await rejectionDetail(createAnnotation(harness.service, ENV_A));
    expect(refused.detail).toMatchObject({
      code: "capacity",
      resource: "annotations",
      used: WEB_ANNOTATION_LIMITS.environmentAnnotations,
      limit: WEB_ANNOTATION_LIMITS.environmentAnnotations,
    });
    await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.annotations["annotation-quota-0"]!.state = "deleted";
      tx.markDirty();
    });
    await createAnnotation(harness.service, ENV_A);
  });

  test("the request count quota refuses a send with usage totals and reserves nothing", async () => {
    harness = await createHarness();
    const first = await createAnnotation(harness.service, ENV_A, "first", "op-1");
    await sendRequest(harness.service, first.annotationId, "req-0");
    const dir = environmentDir(harness.dir);
    const store = await harness.service.storage.environment(ENV_A);
    const snapshot = structuredClone(store.manifest) as Record<string, any>;
    await harness.service.close();
    // A version 1 manifest carries requests inline, so a large fixture needs
    // no per-request text records.
    snapshot.version = 1;
    delete snapshot.consumedDrafts;
    const template = snapshot.requests["req-0"];
    for (let index = 1; index < WEB_ANNOTATION_LIMITS.environmentRequests; index++) {
      const id = `req-${index}`;
      snapshot.requests[id] = { ...template, id, state: "completed", reservation: false };
    }
    await writeFile(join(dir, "manifest.json"), JSON.stringify(snapshot));
    await rm(join(dir, "records", recordDirectoryName(requestTextRecordId("req-0"))), {
      recursive: true,
      force: true,
    });
    const restarted = await harness.restart();
    const second = await createAnnotation(restarted, ENV_A, "second", "op-2");
    const refused = await rejectionDetail(sendRequest(restarted, second.annotationId, "req-new"));
    expect(refused.detail).toMatchObject({
      code: "capacity",
      resource: "requests",
      used: WEB_ANNOTATION_LIMITS.environmentRequests,
      limit: WEB_ANNOTATION_LIMITS.environmentRequests,
    });
    const got = await restarted.get(ENV_A, second.annotationId);
    expect(got.annotation.activeRequestId).toBeNull();
    expect(got.requests).toEqual([]);
  });

  test("a full thread reports an archivable capacity error and continues after archive", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.annotations[receipt.annotationId]!.entryCount =
        WEB_ANNOTATION_LIMITS.threadEntries;
      tx.markDirty();
    });
    const { annotation } = await harness.service.get(ENV_A, receipt.annotationId);
    const refused = await rejectionDetail(
      harness.service.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-full",
        annotationId: receipt.annotationId,
        expectedContentRevision: annotation.contentRevision,
        body: "one more",
      }),
    );
    expect(refused.detail).toMatchObject({
      code: "capacity",
      resource: "thread-entries",
      used: WEB_ANNOTATION_LIMITS.threadEntries,
      limit: WEB_ANNOTATION_LIMITS.threadEntries,
      archivable: true,
    });
    const archived = await harness.service.archive({
      environmentId: ENV_A,
      operationId: "op-archive",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
      body: "one more",
    });
    expect(archived.continuation.entryId).not.toBeNull();
  });
});

describe("interrupted uploads", () => {
  test("a crash while committing an upload leaves no asset; the retry stores it once", async () => {
    const fault = faultOnce("before-manifest-replace");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(stage(harness.service, 7)).rejects.toThrow("injected");
    const dir = environmentDir(harness.dir);
    expect(await readdir(join(dir, "staging"))).toEqual([]);
    const restarted = await harness.restart({ faults: fault.hook });
    const store = await restarted.storage.environment(ENV_A);
    expect(Object.keys(store.manifest.assets)).toEqual([]);
    // The file promoted before the crash is an orphan until the grace period.
    const orphans = await readdir(join(dir, "assets"));
    expect(orphans).toHaveLength(1);
    const retried = await stage(restarted, 7);
    expect(retried.deduplicated).toBe(false);
    expect(Object.keys(store.manifest.assets)).toEqual([retried.asset.id]);
    harness.clock.advance(WEB_ANNOTATION_LIMITS.stagingGraceMs + 60_000);
    const old = new Date(harness.clock.value - WEB_ANNOTATION_LIMITS.stagingGraceMs - 60_000);
    await utimes(join(dir, "assets", orphans[0]!), old, old);
    await restarted.collectGarbage(ENV_A);
    expect(await readdir(join(dir, "assets"))).toEqual([`${retried.asset.id}.png`]);
  });

  test("a truncated or malformed upload is refused before anything is staged", async () => {
    harness = await createHarness();
    const png = makePng().toString("base64");
    await expect(
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-trunc",
        mediaType: "image/png",
        data: png.slice(0, png.length - 8),
      }),
    ).rejects.toThrow();
    await expect(
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-bad",
        mediaType: "image/png",
        data: "not base64!",
      }),
    ).rejects.toThrow("base64");
    expect(existsSync(join(environmentDir(harness.dir), "staging"))).toBe(false);
  });

  test("an upload abandoned mid-write is removed only after the grace period", async () => {
    harness = await createHarness();
    const dir = environmentDir(harness.dir);
    await mkdir(join(dir, "staging"), { recursive: true });
    const partial = join(dir, "staging", "interrupted.png");
    await writeFile(partial, Buffer.from([0x89, 0x50]));
    await harness.service.collectGarbage(ENV_A);
    expect(existsSync(partial)).toBe(true);
    const old = new Date(Date.now() - WEB_ANNOTATION_LIMITS.stagingGraceMs - 60_000);
    await utimes(partial, old, old);
    await harness.service.collectGarbage(ENV_A);
    expect(existsSync(partial)).toBe(false);
  });
});

describe("materialized evidence ownership and cleanup", () => {
  async function materializedRequest(options: { environmentType: "local" | "docker" }) {
    harness = await createHarness();
    const worktree = await mkdtemp(join(tmpdir(), "ork-wa-evidence-"));
    temporary.push(worktree);
    harness.host.environments.set(ENV_A, {
      id: ENV_A,
      environmentType: options.environmentType,
      ...(options.environmentType === "local" ? { worktreePath: worktree } : {}),
      containerId: options.environmentType === "docker" ? "container-1" : null,
    });
    const staged = await stage(harness.service, 3);
    const receipt = await createAnnotation(harness.service, ENV_A, "note", "op-note", [
      staged.asset.id,
    ]);
    const sent = await sendRequest(harness.service, receipt.annotationId, "req-1");
    const attachment = sent.request.attachments[0]!;
    expect(attachment.materializedPath).toBeDefined();
    const file = join(worktree, attachment.relativePath);
    await mkdir(join(worktree, ".orkestrator", "annotations"), { recursive: true });
    await writeFile(file, makePng(4, 3, 3));
    return { receipt, attachment, file, worktree };
  }

  test("settled evidence is kept for the retention period, then removed and untracked", async () => {
    const { file } = await materializedRequest({ environmentType: "local" });
    await harness!.service.collectGarbage(ENV_A);
    expect(existsSync(file)).toBe(true); // queued: never removed while active
    harness!.dispatch.observe_("req-1", "awaiting-review");
    await harness!.service.reconcileOnce();
    await harness!.service.collectGarbage(ENV_A);
    expect(existsSync(file)).toBe(true); // settled but within retention
    harness!.clock.advance(MATERIALIZED_EVIDENCE_RETENTION_MS + 1_000);
    const result = await harness!.service.collectGarbage(ENV_A);
    expect(result.removedEvidence).toBe(1);
    expect(existsSync(file)).toBe(false);
    const { request } = await harness!.service.getRequest(ENV_A, "req-1");
    expect(request.attachments[0]?.removedAt).toBeDefined();
  });

  test("a file overwritten by someone else is never deleted, only untracked", async () => {
    const { file } = await materializedRequest({ environmentType: "local" });
    harness!.dispatch.observe_("req-1", "completed");
    await harness!.service.reconcileOnce();
    await writeFile(file, "user content");
    harness!.clock.advance(MATERIALIZED_EVIDENCE_RETENTION_MS + 1_000);
    const result = await harness!.service.collectGarbage(ENV_A);
    expect(result.removedEvidence).toBe(0);
    expect(existsSync(file)).toBe(true);
    const { request } = await harness!.service.getRequest(ENV_A, "req-1");
    expect(request.attachments[0]?.removedAt).toBeDefined();
  });

  test("deleting the note releases its settled evidence without waiting for retention", async () => {
    const { file, receipt } = await materializedRequest({ environmentType: "local" });
    harness!.dispatch.observe_("req-1", "completed");
    await harness!.service.reconcileOnce();
    const { annotation } = await harness!.service.get(ENV_A, receipt.annotationId);
    await harness!.service.delete({
      environmentId: ENV_A,
      operationId: "op-del",
      annotationId: receipt.annotationId,
      expectedMetadataRevision: annotation.metadataRevision,
    });
    await harness!.service.collectGarbage(ENV_A);
    expect(existsSync(file)).toBe(false);
  });

  test("missing containers count as removed; unreachable ones are retried later", async () => {
    await materializedRequest({ environmentType: "docker" });
    harness!.dispatch.observe_("req-1", "completed");
    await harness!.service.reconcileOnce();
    harness!.clock.advance(MATERIALIZED_EVIDENCE_RETENTION_MS + 1_000);
    // No invoke wired (a stopped/unreachable container): stays tracked.
    await harness!.service.collectGarbage(ENV_A);
    expect(
      (await harness!.service.getRequest(ENV_A, "req-1")).request.attachments[0]?.removedAt,
    ).toBeUndefined();
    // The container is gone: the workspace (and the file) no longer exist.
    harness!.host.environments.set(ENV_A, {
      id: ENV_A,
      environmentType: "docker",
      containerId: null,
    });
    await harness!.service.collectGarbage(ENV_A);
    expect(
      (await harness!.service.getRequest(ENV_A, "req-1")).request.attachments[0]?.removedAt,
    ).toBeDefined();
  });

  test("a legacy screenshot in a missing container becomes explicit missing evidence", async () => {
    harness = await createHarness();
    harness.host.environments.set(ENV_A, {
      id: ENV_A,
      environmentType: "docker",
      containerId: null,
    });
    const key = `claude:${ENV_A}:${encodeURIComponent(`env-${ENV_A}:tab-1`)}`;
    harness.host.putDraft(key, ENV_A, {
      text: "",
      annotations: [
        {
          id: "legacy-1",
          source: "browser",
          text: "Browser element annotation",
          comment: "resize",
          screenshotPath: "/workspace/.orkestrator/annotations/legacy-1.png",
        },
      ],
      attachments: [],
    });
    await harness.service.migrate(ENV_A);
    const list = await harness.service.list({
      environmentId: ENV_A,
      filter: { importedOnly: true },
    });
    const thread = await harness.service.get(ENV_A, list.items[0]!.id);
    expect(thread.capture).toMatchObject({
      state: "missing",
      stateReason: "The legacy screenshot could not be imported",
      assetIds: [],
    });
    const manifest = await readJsonFile(join(environmentDir(harness.dir), "manifest.json"));
    const record = manifest.migration.drafts[key];
    expect(record.screenshots).toEqual([
      {
        legacyId: "legacy-1",
        referenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        assetId: null,
        outcome: "missing",
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain("legacy-1.png");
  });
});

describe("storage sizes", () => {
  test("image bytes stay within one MiB-bounded index regardless of image size", async () => {
    harness = await createHarness();
    await stage(harness.service, 9);
    const manifest = await readJsonFile(join(environmentDir(harness.dir), "manifest.json"));
    expect(JSON.stringify(manifest).length).toBeLessThan(MiB);
  });
});
