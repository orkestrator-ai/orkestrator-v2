import { chromium } from "playwright-core";
import { resolveDesignChromiumPath } from "../design/index.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
/**
 * Behaviour added to close verified gaps: live change hints, publication
 * anchors, draft inspection, staged assets, receipt freshness, the live
 * session policy gate, admission semantics, result hygiene, persisted record
 * migration and explicit conversation deletion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ARTIFACT_TOOL_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";
import { requestIdentity, reserveRequest } from "./service-context.js";
import { identityInputHash } from "./service-identity.js";
import {
  CONVERSATION,
  ENV,
  PROJECT,
  SAMPLE_CHART,
  TAB,
  createHarness,
  fakePng,
  key,
  settle,
  type Harness,
} from "./service-test-support.js";
import { decodeRecord, RECORD_MIGRATIONS, migrateRecord } from "./store-records.js";
import { fitToolResult } from "./tools.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  h.runner.release();
  await h.close();
});

const SCOPE = { environmentId: ENV, logicalSessionKey: CONVERSATION };
const OTHER_TAB = { environmentId: ENV, projectId: PROJECT, tabId: "tab-2" };
const OTHER_SCOPE = { environmentId: ENV, logicalSessionKey: `env-${ENV}:tab-2` };

const chartDraft = (title = "Chart") => ({
  title,
  summary: "s",
  payload: { kind: "chart", spec: SAMPLE_CHART },
});
const staticDraft = (html = "<p>v1</p>", assets?: unknown[]) => ({
  title: "Doc",
  summary: "",
  payload: { kind: "html-static", html },
  ...(assets ? { assets } : {}),
});

async function previewed(artifactId: string, revision = 1, scope = TAB) {
  const preview = await h.call(
    "preview_artifact",
    { requestKey: key(), artifactId, revision },
    scope,
  );
  return settle(h, preview.operationId, scope);
}

async function publishedChart(meta: { toolCallId?: string } = {}) {
  const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
  const operation = await previewed(created.artifactId);
  const response = await h.service.handleTool(
    "publish_artifact",
    TAB,
    {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    },
    meta,
  );
  return { artifactId: created.artifactId as string, published: response.value as any };
}

describe("live change hints", () => {
  test("announce the conversation after committed draft, operation and publication changes", async () => {
    const { published } = await publishedChart();
    expect(published.ok).toBe(true);
    expect(h.announcements.length).toBeGreaterThanOrEqual(4); // create, admit, complete, publish
    expect(new Set(h.announcements.map((entry) => entry.conversationKey))).toEqual(
      new Set([CONVERSATION]),
    );
    expect(new Set(h.announcements.map((entry) => entry.environmentId))).toEqual(new Set([ENV]));
    // Content-free: identifiers only.
    expect(Object.keys(h.announcements[0]!).sort()).toEqual(["conversationKey", "environmentId"]);
  });

  test("a replayed or refused request announces nothing", async () => {
    const requestKey = key();
    await h.call("create_artifact", { requestKey, draft: chartDraft() });
    const count = h.announcements.length;
    await h.call("create_artifact", { requestKey, draft: chartDraft() });
    await h.call("create_artifact", { requestKey: key(), draft: { title: "" } });
    expect(h.announcements.length).toBe(count);
  });

  test("the storage broadcaster carries the transcript-artifact kind with the conversation id", async () => {
    const changes: Array<{ resource: string; id: string }> = [];
    const off = h.storage.addResourceChangeListener((change) => changes.push(change));
    h.storage.announceTranscriptArtifact(CONVERSATION);
    off();
    expect(changes).toEqual([
      expect.objectContaining({ resource: "transcript-artifact", id: CONVERSATION }),
    ]);
  });
});

describe("publication anchors", () => {
  test("the publication view exposes the turn and tool call that published it", async () => {
    h.service.noteDispatchedTurn(ENV, CONVERSATION, "turn-7");
    const { published } = await publishedChart({ toolCallId: "toolu_publish" });
    const view = await h.service.getPublication(SCOPE, published.publicationId);
    expect(view.anchor).toEqual({ turnId: "turn-7", toolCallId: "toolu_publish" });
    const listed = h.service.listPublications(SCOPE);
    expect(listed.publications[0]!.anchor).toEqual({
      turnId: "turn-7",
      toolCallId: "toolu_publish",
    });
  });
});

describe("draft inspection", () => {
  test("lists owner-scoped drafts newest first with their latest operation", async () => {
    const first = await h.call("create_artifact", { requestKey: key(), draft: chartDraft("A") });
    h.clock.now += 1_000;
    const second = await h.call("create_artifact", {
      requestKey: key(),
      draft: staticDraft("<p>BROKEN</p>"),
    });
    h.runner.respond = (job) =>
      job.kind === "html-static" && job.html.includes("BROKEN")
        ? {
            kind: job.kind,
            ok: false,
            error: { code: "validation_failed", message: "broken", retryClass: "after-edit" },
            diagnostics: [{ severity: "error", code: "broken", message: "Broken markup" }],
            omittedDiagnostics: 0,
            captures: [{ png: fakePng(9), width: 960, height: 640, label: "diagnostic" }],
            blockedRequests: {},
            browserBuild: h.runner.browserBuild,
          }
        : null;
    const failed = await previewed(second.artifactId);
    expect(failed.operation.status).toBe("failed");
    await h.call("create_artifact", { requestKey: key(), draft: chartDraft("other") }, OTHER_TAB);

    const listed = h.service.listDrafts(SCOPE);
    expect(listed.drafts.map((draft) => draft.artifactId)).toEqual([
      second.artifactId,
      first.artifactId,
    ]);
    expect(listed.drafts[0]!.latestOperation).toMatchObject({
      operationId: failed.operation.operationId,
      status: "failed",
      diagnosticCaptureCount: 1,
      diagnostics: [expect.objectContaining({ code: "broken" })],
    });
    expect(listed.drafts[1]).toMatchObject({ title: "A", summary: "s", latestOperation: null });
    expect(h.service.listDrafts(SCOPE, { limit: 1 }).drafts).toHaveLength(1);

    // Exact source through the get_artifact slicing.
    const source = await h.service.readDraft({
      ...SCOPE,
      artifactId: second.artifactId,
      representation: "source",
      sourceRange: { offsetBytes: 3, limitBytes: 6 },
    });
    expect(source).toMatchObject({
      representation: "source",
      encoding: "utf8",
      data: "BROKEN",
      totalBytes: "<p>BROKEN</p>".length,
      nextOffsetBytes: 9,
      executableOutsideOrkestrator: true,
    });
    // The failed preview's diagnostic capture, re-hashed on read.
    const capture = await h.service.readDraft({
      ...SCOPE,
      artifactId: second.artifactId,
      representation: "diagnostic-capture",
      operationId: failed.operation.operationId,
    });
    expect(capture).toMatchObject({ representation: "capture", encoding: "base64" });
    expect(Buffer.from(capture.data, "base64")).toEqual(Buffer.from(fakePng(9)));

    // Another conversation sees the same not_found as a missing record.
    for (const request of [
      { ...OTHER_SCOPE, artifactId: second.artifactId, representation: "source" as const },
      { ...SCOPE, artifactId: "art_missing00000", representation: "source" as const },
      {
        ...OTHER_SCOPE,
        artifactId: second.artifactId,
        representation: "diagnostic-capture" as const,
        operationId: failed.operation.operationId,
      },
    ]) {
      await expect(h.service.readDraft(request)).rejects.toMatchObject({
        error: { code: "not_found" },
      });
    }
  });
});

describe("staged assets", () => {
  test("a staged upload is usable by its conversation only", async () => {
    const staged = await h.service.stageAsset({
      ...SCOPE,
      name: "logo.png",
      mimeType: "image/png",
      dataBase64: Buffer.from(fakePng(4)).toString("base64"),
    });
    expect(staged.assetRef).toMatch(/^stg-[0-9a-f]{32}$/);
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: staticDraft("<img src='artifact-asset:logo.png'>", [
        { name: "logo.png", assetRef: staged.assetRef },
      ]),
    });
    expect(created.isError).toBe(false);
    const read = await h.call("get_artifact", { artifactId: created.artifactId });
    expect(read.revision.assets).toEqual([
      expect.objectContaining({ name: "logo.png", mimeType: "image/png", byteLength: 64 }),
    ]);

    const foreign = await h.call(
      "create_artifact",
      {
        requestKey: key(),
        draft: staticDraft("<p>x</p>", [{ name: "logo.png", assetRef: staged.assetRef }]),
      },
      OTHER_TAB,
    );
    expect(foreign.error.code).toBe("not_found");
    expect(foreign.error.fieldErrors[0].path).toBe("draft.assets[0].assetRef");
    // Anything that is not a staged id (paths, URLs) is never read.
    const path = await h.call("create_artifact", {
      requestKey: key(),
      draft: staticDraft("<p>x</p>", [{ name: "x.png", assetRef: "etc:passwd" }]),
    });
    expect(path.error.code).toBe("not_found");
  });

  test("staging checks names, MIME by magic bytes, encoding and size", async () => {
    const png = Buffer.from(fakePng(1)).toString("base64");
    const attempts: Array<[Record<string, string>, string]> = [
      [{ name: "../x.png", mimeType: "image/png", dataBase64: png }, "invalid_input"],
      [{ name: "x.exe", mimeType: "application/x-msdownload", dataBase64: png }, "invalid_input"],
      [{ name: "x.txt", mimeType: "text/plain", dataBase64: png }, "policy_denied"],
      [{ name: "x.jpg", mimeType: "image/jpeg", dataBase64: png }, "policy_denied"],
      [{ name: "x.png", mimeType: "image/png", dataBase64: "not base64!" }, "invalid_input"],
      [
        {
          name: "big.txt",
          mimeType: "text/plain",
          dataBase64: "A".repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4),
        },
        "package_size_exceeded",
      ],
    ];
    for (const [fields, code] of attempts) {
      await expect(h.service.stageAsset({ ...SCOPE, ...fields } as never)).rejects.toMatchObject({
        error: { code },
      });
    }
    const csv = await h.service.stageAsset({
      ...SCOPE,
      name: "data.csv",
      mimeType: "text/csv",
      dataBase64: Buffer.from("a,b\n1,2\n").toString("base64"),
    });
    expect(csv.byteLength).toBe(8);
    await expect(
      h.service.stageAsset({
        environmentId: "env-missing",
        logicalSessionKey: "env-env-missing:tab",
        name: "a.png",
        mimeType: "image/png",
        dataBase64: png,
      }),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
  });
});

describe("receipt freshness at publish", () => {
  async function receiptFor(draft: Record<string, unknown>) {
    const created = await h.call("create_artifact", { requestKey: key(), draft });
    const operation = await previewed(created.artifactId);
    expect(operation.operation.status).toBe("succeeded");
    return { artifactId: created.artifactId as string, receiptId: operation.operation.receiptId };
  }
  const publish = (artifactId: string, receiptId: string) =>
    h.call("publish_artifact", { requestKey: key(), artifactId, expectedRevision: 1, receiptId });

  test("a changed renderer bundle makes HTML and Mermaid receipts stale", async () => {
    const html = await receiptFor(staticDraft());
    const mermaid = await receiptFor({
      title: "M",
      summary: "",
      payload: { kind: "mermaid", source: "graph TD; A-->B" },
    });
    h.runner.bundleHashes = {
      ...h.runner.bundleHashes,
      "html-static": "bundle-2",
      mermaid: "bundle-2",
    };
    for (const target of [html, mermaid]) {
      const stale = await publish(target.artifactId, target.receiptId);
      expect(stale.error.code).toBe("preview_stale");
      expect(stale.error.message).toContain("rendererBundleHash");
    }
  });

  test("a different browser build makes a Mermaid receipt stale when a browser is known", async () => {
    const mermaid = await receiptFor({
      title: "M",
      summary: "",
      payload: { kind: "mermaid", source: "graph TD; A-->B" },
    });
    h.runner.browserBuild = "chromium-test-2";
    const stale = await publish(mermaid.artifactId, mermaid.receiptId);
    expect(stale.error.code).toBe("preview_stale");
    expect(stale.error.message).toContain("browserBuild");
    h.runner.browserBuild = "chromium-test-1";
    expect((await publish(mermaid.artifactId, mermaid.receiptId)).ok).toBe(true);
  });

  test("a chart receipt binds the versioned chart renderer bundle", async () => {
    const chart = await receiptFor(chartDraft());
    // Simulate a receipt made by another chart renderer: identity and its
    // input hash rewritten consistently, so only freshness can reject it.
    h.service.store.transact(ENV, (records) => {
      const receipt = records.get("receipt", chart.receiptId)!;
      expect(receipt.identity.rendererBundleHash).toMatch(/^[0-9a-f]{64}$/);
      const identity = { ...receipt.identity, rendererBundleHash: "chart-renderer-old" };
      records.put("receipt", chart.receiptId, {
        ...receipt,
        identity,
        inputHash: identityInputHash(identity),
      });
    });
    const stale = await publish(chart.artifactId, chart.receiptId);
    expect(stale.error.code).toBe("preview_stale");
    expect(stale.error.message).toContain("rendererBundleHash");
  });
});

describe("live session policy gate", () => {
  test("refuses to run bytes prepared under an older policy or runtime", async () => {
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: { title: "I", summary: "", payload: { kind: "html-interactive", html: "<p>i</p>" } },
    });
    const operation = await previewed(created.artifactId);
    const published = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });
    const rewrite = (fields: Record<string, string>) =>
      h.service.store.transact(ENV, (records) => {
        const derived = records.get("derived", `${created.artifactId}/1`)!;
        records.put("derived", `${created.artifactId}/1`, {
          ...derived,
          prepared: derived.prepared.map((entry) => ({ ...entry, ...fields })),
        });
      });
    const current = h.service.store.records(ENV).get("derived", `${created.artifactId}/1`)!
      .prepared[0]!;
    rewrite({ policyVersion: "html-interactive-policy:v0" });
    await expect(h.service.openLiveSession(SCOPE, published.publicationId)).rejects.toMatchObject({
      error: { code: "policy_denied" },
    });
    rewrite({
      policyVersion: current.policyVersion,
      runtimeVersion: "html-interactive-runtime:v0",
    });
    await expect(h.service.openLiveSession(SCOPE, published.publicationId)).rejects.toMatchObject({
      error: { code: "preview_stale" },
    });
    expect(h.content.minted).toHaveLength(0);
    rewrite({ runtimeVersion: current.runtimeVersion });
    await expect(h.service.openLiveSession(SCOPE, published.publicationId)).resolves.toMatchObject({
      artifactId: created.artifactId,
    });
  });
});

describe("serve-time authorization", () => {
  test("the content origin re-checks authority on every request and fails closed", async () => {
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: { title: "I", summary: "", payload: { kind: "html-interactive", html: "<p>i</p>" } },
    });
    const operation = await previewed(created.artifactId);
    const published = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });
    const first = await h.service.openLiveSession(SCOPE, published.publicationId);
    const firstMint = h.content.minted.at(-1)!;
    expect(firstMint.generation).toBe(first.generation);
    expect(await firstMint.authorize!()).toBe(true);

    // Closing the live session revokes it.
    h.service.closeLiveSession(first.generation);
    expect(await firstMint.authorize!()).toBe(false);

    // Disabling live viewing revokes every session.
    const second = await h.service.openLiveSession(SCOPE, published.publicationId);
    const secondMint = h.content.minted.at(-1)!;
    expect(second.generation).toBe(secondMint.generation);
    expect(await secondMint.authorize!()).toBe(true);
    h.flags.liveInteractive = false;
    expect(await secondMint.authorize!()).toBe(false);
    h.flags.liveInteractive = true;
    expect(await secondMint.authorize!()).toBe(true);

    // Deleting the environment revokes it.
    await h.service.deleteEnvironment(ENV);
    expect(await secondMint.authorize!()).toBe(false);
  });
});

describe("admission semantics", () => {
  test("concurrent duplicates of one create resolve to one artifact", async () => {
    const requestKey = key();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        h.call("create_artifact", { requestKey, draft: chartDraft() }),
      ),
    );
    expect(new Set(results.map((result) => result.artifactId)).size).toBe(1);
    expect(results.every((result) => result.isError === false)).toBe(true);
    expect(h.service.store.records(ENV).count("head")).toBe(1);
  });

  test("concurrent creates cannot exceed the unpublished-draft quota", async () => {
    const limit = ARTIFACT_TOOL_POLICY.maxUnpublishedArtifactsPerConversation;
    for (let index = 0; index < limit - 2; index += 1) {
      const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
      expect(created.isError).toBe(false);
    }
    const racing = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.call("create_artifact", { requestKey: key(), draft: chartDraft() }),
      ),
    );
    expect(racing.filter((result) => result.isError === false)).toHaveLength(2);
    expect(
      racing.filter((result) => result.error?.resource === "unpublished-artifacts"),
    ).toHaveLength(3);
    expect(h.service.store.records(ENV).count("head")).toBe(limit);
  });

  test("a live reservation in another process answers in-progress; a lapsed one is taken over", async () => {
    const requestKey = key();
    const draft = chartDraft();
    h.service.store.transact(ENV, (records) => {
      const request = requestIdentity(
        {
          backendId: h.service.backendId(),
          environmentId: ENV,
          projectId: PROJECT,
          conversationKey: CONVERSATION,
        },
        "create",
        requestKey,
        { draft },
      );
      expect(reserveRequest(records, request, "another-process", h.clock.now)).toBeNull();
    });
    const busy = await h.call("create_artifact", { requestKey, draft });
    expect(busy.error).toMatchObject({
      code: "capacity_exceeded",
      resource: "request-in-progress",
      retryClass: "transient",
    });
    const conflict = await h.call("create_artifact", { requestKey, draft: chartDraft("other") });
    expect(conflict.error.code).toBe("idempotency_conflict");
    h.clock.now += 3 * 60_000;
    const taken = await h.call("create_artifact", { requestKey, draft });
    expect(taken.isError).toBe(false);
    expect((await h.call("create_artifact", { requestKey, draft })).replayed).toBe(true);
  });

  test("a busy preview runner answers capacity_exceeded at admission without an operation", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: staticDraft() });
    h.runner.refuse = "global-queue";
    const requestKey = key();
    const busy = await h.call("preview_artifact", {
      requestKey,
      artifactId: created.artifactId,
      revision: 1,
    });
    expect(busy.error).toMatchObject({
      code: "capacity_exceeded",
      resource: "global-queue",
      retryClass: "transient",
    });
    expect(h.service.store.records(ENV).count("operation")).toBe(0);
    // Charts never need the runner.
    const chart = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
    expect((await previewed(chart.artifactId)).operation.status).toBe("succeeded");
    h.runner.refuse = null;
    const admitted = await h.call("preview_artifact", {
      requestKey,
      artifactId: created.artifactId,
      revision: 1,
    });
    expect(admitted.isError).toBe(false);
    expect((await settle(h, admitted.operationId)).operation.status).toBe("succeeded");
  });

  test("a crashed worker is a transient failure retried at most twice", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: staticDraft() });
    h.runner.crashes = 2;
    const recovered = await previewed(created.artifactId);
    expect(recovered.operation.status).toBe("succeeded");
    expect(h.runner.calls).toHaveLength(3);

    const again = await h.call("create_artifact", {
      requestKey: key(),
      draft: staticDraft("<p>2</p>"),
    });
    h.runner.crashes = 3;
    const failed = await previewed(again.artifactId);
    expect(failed.operation.status).toBe("failed");
    expect(failed.operation.error).toMatchObject({ retryClass: "transient" });
    expect(h.service.metrics.total("transient_retries")).toBe(4);
  });
});

describe("tool result hygiene", () => {
  test("an oversized success is trimmed with a marker, never reported as a failure", () => {
    const value = {
      schemaVersion: 1,
      ok: true,
      artifactId: "art_x",
      revision: 3,
      source: { text: "x".repeat(20_000) },
      publications: [{ publicationId: "pub_y" }],
    };
    const fitted = fitToolResult(value);
    expect(utf8ByteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(
      ARTIFACT_TOOL_POLICY.maxResultBytes,
    );
    expect(fitted).toMatchObject({
      ok: true,
      artifactId: "art_x",
      revision: 3,
      truncated: true,
      omittedFields: ["source"],
      publications: [{ publicationId: "pub_y" }],
    });
    expect(fitToolResult({ ok: true, small: 1 })).toEqual({ ok: true, small: 1 });
  });

  test("an attached preview image is offered, not claimed as seen", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: staticDraft() });
    const operation = await previewed(created.artifactId);
    const withImage = await h.service.handleTool("get_artifact_operation", TAB, {
      operationId: operation.operation.operationId,
      includePreviewImage: true,
    });
    expect(withImage.value).toMatchObject({
      visualInspection: "not-assessed",
      imageDelivery: "attached-if-supported",
      image: { attached: true, captureIndex: 0 },
    });
    expect(withImage.image?.mimeType).toBe("image/png");
    expect(JSON.stringify(withImage.value)).not.toContain(withImage.image!.data);
    expect(operation).toMatchObject({
      visualInspection: "not-assessed",
      imageDelivery: "not-attached",
      image: { attached: false },
    });
  });
});

describe("persisted record decode", () => {
  test("runs the explicit migration chain and refuses unknown versions", () => {
    expect(Object.keys(RECORD_MIGRATIONS)).toEqual(["1"]);
    const row = { schemaVersion: 1, sha256: "a".repeat(64), byteLength: 1, mimeType: "text/plain" };
    expect(migrateRecord("asset", row)).toBe(row);
    expect(decodeRecord("asset", JSON.stringify(row))).toEqual(row as never);
    for (const version of [0, 2, "1"]) {
      expect(() =>
        decodeRecord("asset", JSON.stringify({ ...row, schemaVersion: version })),
      ).toThrow(ArtifactFailure);
    }
  });

  test("revalidates payload, asset and evidence shapes", async () => {
    const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
    const records = h.service.store.records(ENV);
    const revision = records.get("revision", `${created.artifactId}/1`)!;
    const broken = [
      { ...revision, payload: { kind: "chart", spec: "not an object" } },
      { ...revision, payload: { kind: "mermaid" } },
      { ...revision, assets: [{ name: "a", sha256: "nope" }] },
      { ...revision, title: 7 },
    ];
    for (const value of broken) {
      expect(() => decodeRecord("revision", JSON.stringify(value))).toThrow(
        expect.objectContaining({ error: expect.objectContaining({ code: "storage_corrupt" }) }),
      );
    }
    const operation = await previewed(created.artifactId);
    const receipt = records.get("receipt", operation.operation.receiptId)!;
    expect(() =>
      decodeRecord("receipt", JSON.stringify({ ...receipt, evidence: { kind: "html-static" } })),
    ).toThrow(ArtifactFailure);
  });
});

describe("conversation deletion", () => {
  test("removes one conversation's records, fences late work and keeps others", async () => {
    const { artifactId, published } = await publishedChart();
    const other = await h.call(
      "create_artifact",
      { requestKey: key(), draft: chartDraft("kept") },
      OTHER_TAB,
    );
    const pending = await h.call("create_artifact", { requestKey: key(), draft: staticDraft() });
    h.runner.hold();
    const running = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: pending.artifactId,
      revision: 1,
    });
    await h.runner.started.promise;
    const grant = h.service.mintArtifactGrant({
      environmentId: ENV,
      projectId: PROJECT,
      conversationKey: CONVERSATION,
      turnId: "turn-1",
    });

    const result = await h.service.deleteConversation(ENV, CONVERSATION);
    expect(result.removed).toBeGreaterThan(0);
    h.runner.release();
    await h.service.drain();

    const records = h.service.store.records(ENV);
    expect(records.get("head", artifactId)).toBeNull();
    expect(records.get("publication", published.publicationId)).toBeNull();
    expect(records.get("operation", running.operationId)).toBeNull();
    expect(records.list("receipt").filter((r) => r.owner.conversationKey === CONVERSATION)).toEqual(
      [],
    );
    expect(h.service.publicationsForConversation(ENV, CONVERSATION)).toEqual([]);
    expect(h.service.listDrafts(SCOPE).drafts).toEqual([]);
    // The other conversation is untouched.
    expect(records.get("head", other.artifactId)).not.toBeNull();
    // The grant is revoked and nothing can be recreated for the conversation.
    const viaGrant = await h.service.handleTool(
      "get_artifact",
      { environmentId: ENV, projectId: PROJECT },
      { artifactId: other.artifactId, scopeCapability: grant.grant },
    );
    expect((viaGrant.value as any).error.code).toBe("policy_denied");
    const recreated = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
    expect(recreated.error.code).toBe("not_found");
    expect(h.announcements.at(-1)).toEqual({ environmentId: ENV, conversationKey: CONVERSATION });
    // Unreferenced bytes are left for the collector's grace period.
    expect(records.list("asset").some((row) => row.unreferencedSince !== null)).toBe(true);
  });
});

test("an unreadable publication store is storage_unavailable, never a successful empty ledger", () => {
  const original = h.service.store.records;
  h.service.store.records = () => {
    throw new Error("storage offline");
  };
  try {
    expect(() => h.service.listPublications(SCOPE)).toThrow(ArtifactFailure);
  } finally {
    h.service.store.records = original;
  }
});

test("requests after close cannot reopen or mutate the artifact store", async () => {
  await h.service.close();
  const response = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
  expect(response.error.code).toBe("storage_unavailable");
  expect(() => h.service.store.records(ENV)).toThrow(ArtifactFailure);
  await expect(h.service.store.writeAsset(ENV, new Uint8Array([1]))).rejects.toThrow(
    ArtifactFailure,
  );
});

test("post-deletion mutations leave every record count unchanged", async () => {
  await publishedChart();
  await h.service.deleteConversation(ENV, CONVERSATION);
  const counts = () =>
    (["head", "revision", "operation", "publication", "idempotency"] as const).map((kind) =>
      h.service.store.records(ENV).count(kind),
    );
  const before = counts();
  const result = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
  expect(result.error.code).toBe("not_found");
  expect(counts()).toEqual(before);
});
const assetChromium = resolveDesignChromiumPath();
(assetChromium ? test : test.skip)(
  "staged static assets appear in real preview capture and printed PDF pixels",
  async () => {
    const runner = new TranscriptPreviewRunner({
      isolation: "process",
      scratchRoot: previewTestScratchRoot(),
      executablePath: () => assetChromium!,
    });
    h.service = h.fork({ runtime: { runner, preparer: h.preparer, contentServer: h.content } });
    const browser = await chromium.launch({ executablePath: assetChromium!, headless: true });
    try {
      const page = await browser.newPage();
      const asset = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 100;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, 100, 100);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const staged = await h.service.stageAsset({
        ...SCOPE,
        name: "logo.png",
        mimeType: "image/png",
        dataBase64: asset,
      });
      const created = await h.call("create_artifact", {
        requestKey: key(),
        draft: staticDraft('<img style="width:100px;height:100px" src="artifact-asset:logo.png">', [
          { name: "logo.png", assetRef: staged.assetRef },
        ]),
      });
      expect(created.isError).toBe(false);
      const preview = await h.call("preview_artifact", {
        requestKey: key(),
        artifactId: created.artifactId,
        revision: 1,
      });
      await h.service.drain();
      const operation = await h.call("get_artifact_operation", {
        operationId: preview.operationId,
      });
      expect(operation.operation.status).toBe("succeeded");
      const published = await h.call("publish_artifact", {
        requestKey: key(),
        artifactId: created.artifactId,
        expectedRevision: 1,
        receiptId: operation.operation.receiptId,
      });
      expect(published.isError).toBe(false);
      const capture = await h.service.readRepresentation({
        ...SCOPE,
        publicationId: published.publicationId,
        representation: "capture",
      });
      const isRed = (base64: string) =>
        page.evaluate(async (data) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
          let red = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i]! > 240 && pixels[i + 1]! < 20 && pixels[i + 2]! < 20) red++;
          return red > 100;
        }, base64);
      expect(await isRed(capture.data)).toBe(true);
      const pdf = await h.service.readRepresentation({
        ...SCOPE,
        publicationId: published.publicationId,
        representation: "pdf",
      });
      const thumbnail = await runner.run(
        { kind: "pdf-thumbnail", pdf: Buffer.from(pdf.data, "base64"), maxDimension: 960 },
        { environmentId: ENV, conversationKey: CONVERSATION, operationId: "op_staticassetpdf" },
        new AbortController().signal,
      );
      expect(thumbnail.ok).toBe(true);
      if (!thumbnail.ok || thumbnail.kind !== "pdf-thumbnail" || !thumbnail.thumbnail)
        throw new Error("Expected rendered PDF thumbnail");
      expect(await isRed(Buffer.from(thumbnail.thumbnail.png).toString("base64"))).toBe(true);
    } finally {
      await browser.close();
      await runner.close();
    }
  },
  60_000,
);
