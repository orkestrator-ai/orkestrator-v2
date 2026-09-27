import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_ANNOTATION_DEGRADED } from "@orkestrator/protocol/web-annotations";
import {
  WEB_ANNOTATION_MANIFEST_VERSION,
  recordDirectoryName,
  requestTextRecordId,
  type WebAnnotationFaultStage,
} from "./web-annotation-storage.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import {
  environmentDir,
  readJsonFile,
  rejectionDetail,
  sendRequest,
} from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
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

const SECRET_INSTRUCTION = "SECRET-INSTRUCTION-7f3a make the button bigger";

describe("listing index contents", () => {
  test("the manifest holds no instructions, response text, or draft text", async () => {
    harness = await createHarness();
    // Only bounded summaries (title, 280-char intent excerpt) may be indexed.
    const receipt = await createAnnotation(
      harness.service,
      ENV_A,
      `Short summary\n${"padding ".repeat(60)}SECRET-BODY-TAIL`,
    );
    await sendRequest(harness.service, receipt.annotationId, "req-1", {
      instruction: SECRET_INSTRUCTION,
    });
    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();
    await harness.service.requestResponse(ENV_A, "req-1");
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "SECRET-DRAFT-TEXT",
    });
    const dir = environmentDir(harness.dir);
    const manifest = await readFile(join(dir, "manifest.json"), "utf8");
    expect(manifest).not.toContain("SECRET-INSTRUCTION");
    expect(manifest).not.toContain("SECRET-DRAFT-TEXT");
    expect(manifest).not.toContain("Done.");
    expect(manifest).not.toContain("SECRET-BODY-TAIL");
    const parsed = JSON.parse(manifest);
    expect(parsed.version).toBe(WEB_ANNOTATION_MANIFEST_VERSION);
    expect(parsed.drafts).toBeUndefined();
    expect(parsed.requests["req-1"].instruction).toBeUndefined();
    expect(parsed.requests["req-1"].text.revision).toBeGreaterThanOrEqual(1);
    const drafts = await readJsonFile(join(dir, "drafts.json"));
    expect(Object.keys(drafts.drafts)).toEqual(["ed-1"]);
    expect(JSON.stringify(drafts)).not.toContain("SECRET-DRAFT-TEXT");

    // The text lives in bounded per-request records and survives a restart.
    const restarted = await harness.restart();
    const { request } = await restarted.getRequest(ENV_A, "req-1");
    expect(request.instruction).toContain("SECRET-INSTRUCTION");
    expect(request.response?.text).toBe("Done.");
    expect((await restarted.getDraft(ENV_A, "ed-1"))?.text).toBe("SECRET-DRAFT-TEXT");
  });

  test("draft autosave rewrites only the draft index, never the listing index", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A);
    const dir = environmentDir(harness.dir);
    const manifestPath = join(dir, "manifest.json");
    const before = await stat(manifestPath);
    const revision = harness.service.storage.loadedEnvironmentIds().length;
    let draftRevision = 0;
    for (let index = 0; index < 5; index++) {
      const draft = await harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: draftRevision,
        text: `typing ${index}`,
      });
      draftRevision = draft.revision;
    }
    const after = await stat(manifestPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(revision).toBe(1);
    expect((await harness.service.storage.environment(ENV_A)).revision).toBe(1);
    // Superseded draft text revisions are removed after the next commit;
    // only the current and previous generation remain.
    const draftDir = join(
      dir,
      "records",
      recordDirectoryName((await harness.service.getDraft(ENV_A, "ed-1"))!.id),
    );
    expect((await readdir(draftDir)).sort()).toEqual(["4.json", "5.json"]);
  });

  test("the previous manifest generation stays loadable with its request text", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    await sendRequest(harness.service, receipt.annotationId, "req-1", {
      instruction: "first instruction",
    });
    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();
    // Response excerpt: the request text record moves to revision 2.
    await harness.service.requestResponse(ENV_A, "req-1");
    const dir = environmentDir(harness.dir);
    await writeFile(join(dir, "manifest.json"), "{ corrupt");
    const restarted = await harness.restart();
    expect((await restarted.capabilities(ENV_A)).storage).toBe("degraded");
    const { request } = await restarted.getRequest(ENV_A, "req-1");
    // The previous generation references text revision 1, which was kept.
    expect(request.instruction).toBe("first instruction");
    expect(
      (await restarted.get(ENV_A, receipt.annotationId)).annotation.unavailable,
    ).toBeUndefined();
  });
});

describe("persisted versions", () => {
  test("a manifest written by a newer version is refused and never overwritten", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "One", "op-1");
    await createAnnotation(harness.service, ENV_A, "Two", "op-2");
    const path = join(environmentDir(harness.dir), "manifest.json");
    const manifest = await readJsonFile(path);
    manifest.version = WEB_ANNOTATION_MANIFEST_VERSION + 1;
    const newer = JSON.stringify(manifest);
    await writeFile(path, newer);
    const restarted = await harness.restart();
    const capabilities = await restarted.capabilities(ENV_A);
    expect(capabilities.storage).toBe("unavailable");
    expect(capabilities.operations.author).toBe(false);
    // Not served from the older previous copy.
    const listed = await rejectionDetail(restarted.list({ environmentId: ENV_A }));
    expect(listed.detail).toMatchObject({ code: "unsupported-version", format: "manifest" });
    expect(listed.message).toContain(WEB_ANNOTATION_DEGRADED);
    await expect(createAnnotation(restarted, ENV_A, "Three", "op-3")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  test("an annotation with an unknown schema version is refused, not guessed", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const path = join(environmentDir(harness.dir), "manifest.json");
    const manifest = await readJsonFile(path);
    manifest.annotations[receipt.annotationId].schemaVersion = 99;
    await writeFile(path, JSON.stringify(manifest));
    const restarted = await harness.restart();
    expect((await restarted.capabilities(ENV_A)).storage).toBe("unavailable");
    const listed = await rejectionDetail(restarted.list({ environmentId: ENV_A }));
    expect(listed.detail).toMatchObject({ code: "unsupported-version", format: "annotation" });
  });

  test("a draft index from a newer version makes drafts unavailable without losing them", async () => {
    harness = await createHarness();
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "keep me",
    });
    const dir = environmentDir(harness.dir);
    const drafts = await readJsonFile(join(dir, "drafts.json"));
    drafts.version = 99;
    const newer = JSON.stringify(drafts);
    await writeFile(join(dir, "drafts.json"), newer);
    await rm(join(dir, "drafts.prev.json"), { force: true });
    const restarted = await harness.restart();
    await expect(restarted.getDraft(ENV_A, "ed-1")).rejects.toThrow(WEB_ANNOTATION_DEGRADED);
    await expect(
      restarted.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 1,
        text: "overwrite",
      }),
    ).rejects.toThrow(WEB_ANNOTATION_DEGRADED);
    // Threads stay writable; the unreadable draft index is never replaced.
    await createAnnotation(restarted, ENV_A);
    expect(await readFile(join(dir, "drafts.json"), "utf8")).toBe(newer);
  });

  test("a version 1 manifest (inline requests and drafts) loads and is rewritten as version 2", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    await sendRequest(harness.service, receipt.annotationId, "req-1", {
      instruction: "legacy instruction",
    });
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "legacy draft",
    });
    const dir = environmentDir(harness.dir);
    const store = await harness.service.storage.environment(ENV_A);
    const snapshot = structuredClone(store.manifest) as Record<string, any>;
    const draftBytes = snapshot.drafts["ed-1"].bytes as number;
    await harness.service.close();
    // Reconstruct what a version 1 backend wrote: everything inline.
    snapshot.version = 1;
    snapshot.usage.recordBytes += draftBytes;
    delete snapshot.consumedDrafts;
    await writeFile(join(dir, "manifest.json"), JSON.stringify(snapshot));
    await rm(join(dir, "drafts.json"), { force: true });
    await rm(join(dir, "drafts.prev.json"), { force: true });
    await rm(join(dir, "records", recordDirectoryName(requestTextRecordId("req-1"))), {
      recursive: true,
      force: true,
    });
    const restarted = await harness.restart();
    expect((await restarted.getRequest(ENV_A, "req-1")).request.instruction).toBe(
      "legacy instruction",
    );
    expect((await restarted.getDraft(ENV_A, "ed-1"))?.text).toBe("legacy draft");
    await createAnnotation(restarted, ENV_A);
    const rewritten = await readJsonFile(join(dir, "manifest.json"));
    expect(rewritten.version).toBe(2);
    expect(rewritten.drafts).toBeUndefined();
    expect(rewritten.requests["req-1"].instruction).toBeUndefined();
    expect(Object.keys((await readJsonFile(join(dir, "drafts.json"))).drafts)).toEqual(["ed-1"]);
    const again = await harness.restart();
    expect((await again.getRequest(ENV_A, "req-1")).request.instruction).toBe("legacy instruction");
    expect((await again.getDraft(ENV_A, "ed-1"))?.text).toBe("legacy draft");
  });
});

describe("startup validation", () => {
  test("a parseable capture record for the wrong annotation is detected at startup", async () => {
    harness = await createHarness();
    const first = await createAnnotation(harness.service, ENV_A, "First", "op-1");
    const second = await createAnnotation(harness.service, ENV_A, "Second", "op-2");
    const recordsDir = join(environmentDir(harness.dir), "records");
    const secondPath = join(recordsDir, recordDirectoryName(second.captureId!), "1.json");
    const secondRecord = await readJsonFile(secondPath);
    // Swap in a well-formed record that belongs to another annotation.
    secondRecord.value.annotationId = first.annotationId;
    await writeFile(secondPath, JSON.stringify(secondRecord));
    const restarted = await harness.restart();
    const list = await restarted.list({ environmentId: ENV_A });
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(second.annotationId)?.unavailable).toBe("capture record unreadable");
    expect(byId.get(first.annotationId)?.unavailable).toBeUndefined();
  });

  test("a damaged active request keeps its reservation and marks its note read-only", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    await sendRequest(harness.service, receipt.annotationId, "req-1", { instruction: "go" });
    const recordsDir = join(environmentDir(harness.dir), "records");
    await writeFile(join(recordsDir, recordDirectoryName("req-1"), "1.json"), "{ corrupt");
    const textDir = join(recordsDir, recordDirectoryName(requestTextRecordId("req-1")));
    for (const name of await readdir(textDir)) await writeFile(join(textDir, name), "{}");
    const restarted = await harness.restart();
    const got = await restarted.get(ENV_A, receipt.annotationId);
    expect(got.annotation.unavailable).toBe("request record unreadable");
    // Never cleared as if execution had not happened.
    expect(got.annotation.activeRequestId).toBe("req-1");
    expect(got.requests[0]?.reservation).toBe(true);
    expect(got.requests[0]?.state).toBe("queued");
    await expect(
      restarted.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-more",
        annotationId: receipt.annotationId,
        expectedContentRevision: got.annotation.contentRevision,
        body: "more",
      }),
    ).rejects.toThrow("read-only");
    // A later commit does not overwrite the damaged text with an empty one.
    await createAnnotation(restarted, ENV_A);
    for (const name of await readdir(textDir)) {
      expect(await readFile(join(textDir, name), "utf8")).toBe("{}");
    }
  });
});

describe("draft index crash recovery", () => {
  test("a crash before the draft index replaces it keeps the previous draft text", async () => {
    const fault = faultOnce("before-drafts-replace");
    harness = await createHarness({ faults: fault.hook });
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "saved",
    });
    fault.state.armed = true;
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 1,
        text: "lost in the crash",
      }),
    ).rejects.toThrow("injected");
    const restarted = await harness.restart({ faults: fault.hook });
    const draft = await restarted.getDraft(ENV_A, "ed-1");
    expect(draft).toMatchObject({ revision: 1, text: "saved" });
    // The uncommitted draft text record is an orphan, not a resurrected draft.
    await restarted.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 1,
      text: "retried",
    });
    expect((await restarted.getDraft(ENV_A, "ed-1"))?.text).toBe("retried");
  });

  test("publishing a note from its draft survives a crash before the draft index write", async () => {
    const fault = faultOnce("before-drafts-replace");
    harness = await createHarness({ faults: fault.hook });
    const draft = await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "Publish me",
    });
    fault.state.armed = true;
    // The listing index commits; the draft index write "crashes" after it.
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-publish",
      capture: (
        await import("@orkestrator/protocol/web-annotations-fixtures")
      ).fixtureCaptureInput(),
      body: "Publish me",
      draftId: draft.id,
    });
    expect(fault.state.fired).toBe(1);
    const dir = environmentDir(harness.dir);
    // On disk the draft index still lists the published draft...
    expect(Object.keys((await readJsonFile(join(dir, "drafts.json"))).drafts)).toEqual(["ed-1"]);
    const restarted = await harness.restart({ faults: fault.hook });
    // ...but the committed listing index names it consumed: it is not resurrected.
    expect(await restarted.getDraft(ENV_A, "ed-1")).toBeNull();
    expect((await restarted.get(ENV_A, receipt.annotationId)).entries[0]?.body).toBe("Publish me");
    await restarted.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-2",
      expectedRevision: 0,
      text: "next",
    });
    expect(Object.keys((await readJsonFile(join(dir, "drafts.json"))).drafts)).toEqual(["ed-2"]);
  });

  test("a crash before draft record write commits nothing", async () => {
    const fault = faultOnce("before-record-write");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "never",
      }),
    ).rejects.toThrow("injected");
    const restarted = await harness.restart({ faults: fault.hook });
    expect(await restarted.getDraft(ENV_A, "ed-1")).toBeNull();
  });
});
