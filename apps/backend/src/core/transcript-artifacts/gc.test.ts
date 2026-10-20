import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_RETENTION_POLICY,
  ARTIFACT_TOOL_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import {
  CONVERSATION,
  ENV,
  SAMPLE_CHART,
  TAB,
  createHarness,
  fakePng,
  key,
  settle,
  type Harness,
} from "./service-test-support.js";

let h: Harness;
afterEach(async () => {
  await h.close();
});

const HOUR = 60 * 60 * 1000;
const chartDraft = (title = "Chart", value = 10) => ({
  title,
  summary: "",
  payload: {
    kind: "chart",
    spec: {
      ...SAMPLE_CHART,
      series: [
        {
          id: "rev",
          label: "Revenue",
          points: [
            { categoryId: "q1", value },
            { categoryId: "q2", value: 20 },
          ],
        },
      ],
    },
  },
});

async function publishChart(scope = TAB, value = 10) {
  const created = await h.call(
    "create_artifact",
    { requestKey: key(), draft: chartDraft("Chart", value) },
    scope,
  );
  const preview = await h.call(
    "preview_artifact",
    { requestKey: key(), artifactId: created.artifactId, revision: 1 },
    scope,
  );
  const operation = await settle(h, preview.operationId, scope);
  const published = await h.call(
    "publish_artifact",
    {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    },
    scope,
  );
  return { created, operation, published };
}

const assetsDir = () => join(h.dataDir, "transcript-artifacts", ENV, "assets");

describe("durable storage", () => {
  test("a crash between file promotion and commit leaves an unreferenced file, never a dangling reference", async () => {
    let crash = true;
    h = await createHarness({
      assetResolver: async () => ({ bytes: fakePng(3), mimeType: "image/png" }),
      faults: (stage) => {
        if (stage === "before-commit" && crash) throw new Error("simulated crash");
      },
    });
    const draft = {
      title: "With image",
      summary: "",
      payload: { kind: "html-static", html: '<img src="logo">' },
      assets: [{ name: "logo.png", assetRef: "upload-1" }],
    };
    const failed = await h.call("create_artifact", { requestKey: key(), draft });
    expect(failed.isError).toBe(true);
    const files = await readdir(assetsDir());
    expect(files).toHaveLength(1);
    const records = h.service.store.records(ENV);
    expect(records.count("head")).toBe(0);
    expect(records.count("asset")).toBe(0);
    // Cleanup reclaims it after the grace window.
    h.clock.now += 25 * HOUR;
    expect((await h.service.runCleanup()).assetsRemoved).toBe(1);
    expect(await readdir(assetsDir())).toHaveLength(0);
    // With the crash gone, the same request succeeds and references a present file.
    crash = false;
    const created = await h.call("create_artifact", { requestKey: key(), draft });
    expect(created.isError).toBe(false);
    const revision = h.service.store.records(ENV).get("revision", `${created.artifactId}/1`)!;
    expect(
      h.service.store.assetFileExists(
        ENV,
        revision.assets[0]!.sha256,
        revision.assets[0]!.byteLength,
      ),
    ).toBe(true);
  });

  test("missing or damaged bytes are storage_corrupt, never a blank success", async () => {
    h = await createHarness();
    const { published, operation } = await publishChart();
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const svg = operation.evidence.rendererOutput;
    const file = join(assetsDir(), svg.sha256);
    await writeFile(file, Buffer.alloc(svg.byteLength, 0x20));
    expect((await h.service.getPublication(scope, published.publicationId)).availability).toBe(
      "storage_corrupt",
    );
    await expect(
      h.service.readRepresentation({
        ...scope,
        publicationId: published.publicationId,
        representation: "rendered-svg",
      }),
    ).rejects.toMatchObject({ error: { code: "storage_corrupt" } });
    // Source and metadata stay readable.
    expect(
      (
        await h.service.readRepresentation({
          ...scope,
          publicationId: published.publicationId,
          representation: "source",
        })
      ).data,
    ).toContain("Revenue");
    await rm(file);
    expect((await h.service.getPublication(scope, published.publicationId)).availability).toBe(
      "missing",
    );
    expect(h.service.listPublications(scope).publications[0]!.availability).toBe("missing");

    // Publication refuses a receipt whose evidence no longer verifies.
    const other = await h.call("create_artifact", {
      requestKey: key(),
      draft: chartDraft("Other", 99),
    });
    const op = await settle(
      h,
      (
        await h.call("preview_artifact", {
          requestKey: key(),
          artifactId: other.artifactId,
          revision: 1,
        })
      ).operationId,
    );
    await rm(join(assetsDir(), op.evidence.rendererOutput.sha256));
    const refused = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: other.artifactId,
      expectedRevision: 1,
      receiptId: op.operation.receiptId,
    });
    expect(refused.error.code).toBe("storage_corrupt");
  });

  test("a notification listener failing after commit loses nothing", async () => {
    h = await createHarness();
    const seen: number[] = [];
    h.service.onLedgerChange(() => {
      throw new Error("subscriber crashed");
    });
    h.service.onLedgerChange((change) => seen.push(change.ledgerRevision));
    const { published } = await publishChart();
    expect(published.isError).toBe(false);
    expect(seen).toEqual([1]);
    const reopened = await h.reopen();
    expect(
      reopened.publicationsForConversation(ENV, CONVERSATION).map((entry) => entry.publicationId),
    ).toEqual([published.publicationId]);
    const outbox = reopened.store.records(ENV).list("outbox");
    expect(outbox[0]?.deliveredAt).toBeDefined();
  });
});

describe("quotas reject instead of evicting", () => {
  test("unpublished drafts per conversation and revisions per artifact", async () => {
    h = await createHarness();
    for (
      let index = 0;
      index < ARTIFACT_TOOL_POLICY.maxUnpublishedArtifactsPerConversation;
      index += 1
    ) {
      const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
      expect(created.isError).toBe(false);
    }
    const refused = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
    expect(refused.error).toMatchObject({
      code: "capacity_exceeded",
      resource: "unpublished-artifacts",
    });
    // Another conversation is unaffected.
    expect(
      (
        await h.call(
          "create_artifact",
          { requestKey: key(), draft: chartDraft() },
          { ...TAB, tabId: "tab-9" },
        )
      ).isError,
    ).toBe(false);

    const artifactId = h.service.store.records(ENV).keys("head")[0]!;
    h.service.store.transact(ENV, (records) => {
      const head = records.get("head", artifactId)!;
      records.put(
        "head",
        artifactId,
        { ...head, currentRevision: ARTIFACT_TOOL_POLICY.maxRevisionsPerArtifact },
        head.owner.conversationKey,
      );
    });
    const full = await h.call("update_artifact", {
      requestKey: key(),
      artifactId,
      expectedRevision: ARTIFACT_TOOL_POLICY.maxRevisionsPerArtifact,
      draft: chartDraft(),
    });
    expect(full.error).toMatchObject({ code: "capacity_exceeded", resource: "revisions" });
  });

  test("the environment asset quota fails the preview cleanly", async () => {
    h = await createHarness({ assetBytesPerEnvironment: 64 });
    const created = await h.call("create_artifact", { requestKey: key(), draft: chartDraft() });
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      revision: 1,
    });
    const operation = await settle(h, preview.operationId);
    expect(operation.operation.status).toBe("failed");
    expect(operation.operation.error).toMatchObject({
      code: "capacity_exceeded",
      resource: "asset-bytes",
    });
  });
});

describe("cleanup", () => {
  test("keeps published and in-flight bytes, expires idle drafts with tombstones, removes stale staging", async () => {
    h = await createHarness();
    const { operation: publishedOp } = await publishChart();
    const publishedSvg = publishedOp.evidence.rendererOutput.sha256;
    // The same bytes, referenced only by another conversation's draft (deduplicated file).
    const otherTab = { ...TAB, tabId: "tab-2" };
    const draftKey = key();
    const draft = await h.call(
      "create_artifact",
      { requestKey: draftKey, draft: chartDraft() },
      otherTab,
    );
    await settle(
      h,
      (
        await h.call(
          "preview_artifact",
          { requestKey: key(), artifactId: draft.artifactId, revision: 1 },
          otherTab,
        )
      ).operationId,
      otherTab,
    );
    // A staged upload left by a crash, and an in-flight write.
    const staging = h.service.store.stagingDirectory(ENV);
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "abandoned.tmp"), "x");
    const inflight = await h.service.store.writeAsset(ENV, new TextEncoder().encode("in flight"));

    h.clock.now += ARTIFACT_RETENTION_POLICY.unpublishedDraftMs + HOUR;
    const first = await h.service.runCleanup();
    expect(first.draftsExpired).toBe(1);
    expect(first.stagingRemoved).toBe(1);
    h.clock.now += 25 * HOUR;
    await h.service.runCleanup();
    expect(existsSync(join(assetsDir(), publishedSvg))).toBe(true);
    expect(existsSync(join(assetsDir(), inflight.sha256))).toBe(true);
    inflight.release();
    await h.service.runCleanup();
    expect(existsSync(join(assetsDir(), inflight.sha256))).toBe(false);
    expect(existsSync(join(assetsDir(), publishedSvg))).toBe(true);
    // Published history still renders.
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const listed = h.service.listPublications(scope).publications;
    expect(listed[0]!.availability).toBe("available");
    // The expired draft's key answers `expired`, never new work.
    const replay = await h.call(
      "create_artifact",
      { requestKey: draftKey, draft: chartDraft() },
      otherTab,
    );
    expect(replay.error.code).toBe("expired");
    expect(
      (await h.call("get_artifact", { artifactId: draft.artifactId }, otherTab)).error.code,
    ).toBe("not_found");
  });
});
