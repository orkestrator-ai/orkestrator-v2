import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ARTIFACT_TOOL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ARTIFACT_VERSIONS, type ArtifactKind } from "@orkestrator/protocol/transcript-artifacts";
import { conversationKeyForTab } from "./owner.js";
import {
  CONVERSATION,
  ENV,
  PROJECT,
  SAMPLE_CHART,
  TAB,
  createHarness,
  key,
  settle,
  type Harness,
} from "./service-test-support.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function seedMultiReview(id = "mr-1", phase = "completed"): Promise<void> {
  await h.storage.saveMultiReviewWorkflow(id, ENV, 1, {
    version: 1,
    controller: "backend",
    id,
    environmentId: ENV,
    projectId: PROJECT,
    targetBranch: "main",
    reviewers: [
      {
        id: "r1",
        status: "completed",
        agent: "claude",
        model: "opus",
        report: { issues: [{}, {}], testCoverageGaps: [] },
        startedAt: "2026-10-20T10:00:00Z",
        completedAt: "2026-10-20T10:05:00Z",
      },
      { id: "r2", status: "failed", agent: "codex", model: "gpt" },
    ],
    fixModel: { agent: "claude", model: "opus" },
    phase,
    stepRuntimes: {
      prepare: { startedAt: "2026-10-20T09:00:00Z", completedAt: "2026-10-20T09:10:00Z" },
    },
    consolidatedReport: { issues: [{}], testCoverageGaps: [] },
    createdAt: "2026-10-20T09:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z",
    backendRevision: 1,
  });
}

function draftFor(kind: ArtifactKind): Record<string, unknown> {
  switch (kind) {
    case "html-static":
      return {
        title: "Static",
        summary: "s",
        payload: { kind, html: "<h1>Hi</h1><script>alert(1)</script>" },
      };
    case "html-interactive":
      return {
        title: "Calc",
        summary: "calculator",
        payload: {
          kind,
          html: '<input data-artifact-test="a" type="number"><output data-artifact-test="out"></output><script>/* calc */</script>',
          probes: [
            { op: "set-number", target: "a", value: 2 },
            { op: "expect-number", target: "out", equals: 4 },
          ],
        },
      };
    case "mermaid":
      return { title: "Flow", summary: "", payload: { kind, source: "graph TD; A-->B; é" } };
    case "chart":
      return { title: "Chart", summary: "", payload: { kind, spec: SAMPLE_CHART } };
    case "workflow-snapshot":
      return {
        title: "Review",
        summary: "",
        payload: { kind, workflowId: "multi-review", runId: "mr-1" },
      };
  }
}

async function createPreviewPublish(kind: ArtifactKind) {
  const created = await h.call("create_artifact", { requestKey: key(), draft: draftFor(kind) });
  expect(created.isError).toBe(false);
  const preview = await h.call("preview_artifact", {
    requestKey: key(),
    artifactId: created.artifactId,
    revision: 1,
  });
  expect(preview).toMatchObject({ ok: true, status: "queued" });
  const operation = await settle(h, preview.operationId);
  expect(operation.operation.status).toBe("succeeded");
  const published = await h.call("publish_artifact", {
    requestKey: key(),
    artifactId: created.artifactId,
    expectedRevision: 1,
    receiptId: operation.operation.receiptId,
  });
  expect(published.isError).toBe(false);
  return { created, operation, published };
}

describe("artifact lifecycle per kind", () => {
  for (const kind of [
    "html-static",
    "html-interactive",
    "mermaid",
    "chart",
    "workflow-snapshot",
  ] as const) {
    test(`${kind}: create → preview → publish → reload returns the exact source`, async () => {
      if (kind === "workflow-snapshot") await seedMultiReview();
      const draft = draftFor(kind);
      const { created, published } = await createPreviewPublish(kind);
      expect(published.ref).toMatchObject({
        schemaVersion: 1,
        artifactId: created.artifactId,
        revision: 1,
        kind,
      });
      expect(published.conversationSequence).toBe(1);

      // Reload: a new service instance on the same data dir.
      const reopened = await h.reopen();
      const ledger = reopened.publicationsForConversation(ENV, CONVERSATION);
      expect(ledger.map((entry) => entry.publicationId)).toEqual([published.publicationId]);
      expect(reopened.ledgerRevision(ENV, CONVERSATION)).toBe(1);

      const read = await h.call("get_artifact", {
        artifactId: created.artifactId,
        sourceRange: { offsetBytes: 0, limitBytes: ARTIFACT_TOOL_POLICY.maxSourceSliceBytes },
      });
      expect(read.isError).toBe(false);
      const payload = draft.payload as Record<string, unknown>;
      if (kind === "html-static" || kind === "html-interactive")
        expect(read.source.text).toBe(payload.html);
      if (kind === "mermaid") expect(read.source.text).toBe(payload.source);
      if (kind === "chart") expect(JSON.parse(read.source.text)).toEqual(SAMPLE_CHART);
      if (kind === "workflow-snapshot") {
        const snapshot = JSON.parse(read.source.text);
        expect(snapshot).toMatchObject({
          workflowId: "multi-review",
          runId: "mr-1",
          sourceRevision: "1",
          status: "succeeded",
        });
      }

      // The renderer view and exact source representation.
      const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
      const view = await reopened.getPublication(scope, published.publicationId);
      expect(view.availability).toBe("available");
      expect(view.ref.revision).toBe(1);
      const source = await reopened.readRepresentation({
        ...scope,
        publicationId: published.publicationId,
        representation: "source",
      });
      expect(source.data).toBe(read.source.text);
      expect(source.executableOutsideOrkestrator).toBe(
        kind === "html-static" || kind === "html-interactive",
      );
      expect(source.filename).not.toContain("/");
    });
  }

  test("static HTML stores the sanitized effective document separately from the source (I-01)", async () => {
    const { published, operation } = await createPreviewPublish("html-static");
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const effective = await h.service.readRepresentation({
      ...scope,
      publicationId: published.publicationId,
      representation: "effective-html",
    });
    expect(effective.data).not.toContain("<script>");
    const source = await h.service.readRepresentation({
      ...scope,
      publicationId: published.publicationId,
      representation: "source",
    });
    expect(source.data).toContain("<script>");
    expect(operation.evidence.captures).toHaveLength(1);
    expect(operation.visualInspection).toBe("not-assessed");
  });

  test("interactive HTML records the prepared document, probes and a live session", async () => {
    const { published } = await createPreviewPublish("html-interactive");
    const scope = { environmentId: ENV, logicalSessionKey: CONVERSATION };
    const view = await h.service.getPublication(scope, published.publicationId);
    expect(view.receipt.probeSummary).toEqual({ total: 2, passed: 2 });
    expect(view.receipt.semantics).toBe("probes-passed");
    const live = await h.service.openLiveSession(scope, published.publicationId);
    expect(live.preparedSha256).toBe(view.source.effectiveSha256);
    const loaded = await h.content.minted[0]!.load();
    expect(new TextDecoder().decode(loaded)).toContain("<!-- prepared");
    h.flags.liveInteractive = false;
    await expect(h.service.openLiveSession(scope, published.publicationId)).rejects.toMatchObject({
      error: { code: "policy_denied" },
    });
    // Rollback keeps history readable.
    expect((await h.service.getPublication(scope, published.publicationId)).availability).toBe(
      "available",
    );
  });

  test("a failed probe keeps its diagnostic capture on the operation and creates no receipt", async () => {
    h.runner.respond = (job) =>
      job.kind === "html-interactive"
        ? {
            kind: "html-interactive",
            ok: true,
            browserBuild: h.runner.browserBuild,
            rendererBundleHash: "b",
            diagnostics: [],
            omittedDiagnostics: 0,
            blockedRequests: { "network-denied": 2 },
            captures: [
              {
                png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
                width: 960,
                height: 640,
                label: "diagnostic",
              },
            ],
            probeResults: [
              { index: 0, op: "set-number", target: "a", status: "passed" },
              {
                index: 1,
                op: "expect-number",
                target: "out",
                status: "failed",
                observed: 5,
                errorCode: "mismatch",
              },
            ],
            runtimeErrors: 0,
            elementCount: 3,
          }
        : null;
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: draftFor("html-interactive"),
    });
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      revision: 1,
    });
    const operation = await h.call("get_artifact_operation", {
      operationId: preview.operationId,
      includePreviewImage: true,
    });
    await h.service.drain();
    const settled = await h.call("get_artifact_operation", {
      operationId: preview.operationId,
      includePreviewImage: true,
    });
    expect(operation.ok).toBe(true);
    expect(settled.operation.status).toBe("failed");
    expect(settled.operation.receiptId).toBeUndefined();
    expect(settled.evidence.source).toBe("diagnostic");
    expect(settled.probeResults[1]).toMatchObject({ status: "failed", observed: 5 });
    expect(settled.image).toMatchObject({ mimeType: "image/png" });
    expect(settled.visualInspection).toBe("not-assessed");
    expect(JSON.stringify(settled)).not.toContain(settled.image.data.slice(0, 40) + "x");
    expect(h.service.metrics.total("blocked_requests")).toBe(2);
  });

  test("unchanged revision with a receipt from another artifact cannot publish", async () => {
    const first = await createPreviewPublish("chart");
    const other = await h.call("create_artifact", { requestKey: key(), draft: draftFor("chart") });
    const result = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: other.artifactId,
      expectedRevision: 1,
      receiptId: first.operation.operation.receiptId,
    });
    expect(result.error.code).toBe("preview_required");
  });
});

describe("validation and bounded reads", () => {
  test("invalid drafts return typed field errors and the same answer on retry", async () => {
    const requestKey = key();
    const draft = {
      title: "",
      summary: "x",
      payload: { kind: "chart", spec: { schemaVersion: 1, kind: "bar" } },
      extra: 1,
    };
    const first = await h.call("create_artifact", { requestKey, draft });
    expect(first.isError).toBe(true);
    expect(first.error.code).toBe("invalid_input");
    expect(first.error.fieldErrors.length).toBeGreaterThan(0);
    expect(first.error.fieldErrors.length).toBeLessThanOrEqual(20);
    const again = await h.call("create_artifact", { requestKey, draft });
    expect(again.error).toEqual(first.error);
    expect(again.replayed).toBe(true);
  });

  test("agents cannot author workflow snapshots", async () => {
    const result = await h.call("create_artifact", {
      requestKey: key(),
      draft: {
        title: "w",
        summary: "",
        payload: { kind: "workflow-snapshot", snapshot: { schemaVersion: 1 } },
      },
    });
    expect(result.error.fieldErrors[0].code).toBe("authoritative_source_required");
  });

  test("source slices respect code point boundaries and report remaining bytes", async () => {
    const html = "<p>" + "é".repeat(5000) + "</p>"; // 2-byte code points
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: { title: "t", summary: "", payload: { kind: "html-static", html } },
    });
    const total = new TextEncoder().encode(html).byteLength;
    const first = await h.call("get_artifact", {
      artifactId: created.artifactId,
      sourceRange: { offsetBytes: 0, limitBytes: 8000 },
    });
    expect(first.source.totalBytes).toBe(total);
    expect(new TextEncoder().encode(first.source.text).byteLength).toBeLessThanOrEqual(8000);
    expect(first.source.text.endsWith("�")).toBe(false);
    expect(first.source.omittedBytes).toBe(
      total - new TextEncoder().encode(first.source.text).byteLength,
    );
    const mid = await h.call("get_artifact", {
      artifactId: created.artifactId,
      sourceRange: { offsetBytes: 4, limitBytes: 10 },
    });
    expect(mid.error.code).toBe("invalid_input");
    let offset: number | null = 0;
    let assembled = "";
    while (offset !== null) {
      const page: Record<string, any> = await h.call("get_artifact", {
        artifactId: created.artifactId,
        sourceRange: { offsetBytes: offset, limitBytes: 8192 },
      });
      expect(JSON.stringify(page).length).toBeLessThan(ARTIFACT_TOOL_POLICY.maxResultBytes);
      assembled += page.source.text;
      offset = page.source.nextOffsetBytes;
    }
    expect(assembled).toBe(html);
  });

  test("HTML cannot verify or publish without the runner while charts and workflows still can", async () => {
    await seedMultiReview();
    h.runner.available = false;
    const html = await h.call("create_artifact", {
      requestKey: key(),
      draft: draftFor("html-static"),
    });
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: html.artifactId,
      revision: 1,
    });
    expect(preview.error.code).toBe("renderer_unavailable");
    // Draft source stays readable.
    expect(
      (await h.call("get_artifact", { artifactId: html.artifactId })).revision.sourceBytes,
    ).toBeGreaterThan(0);
    await createPreviewPublish("chart");
    await createPreviewPublish("workflow-snapshot");
  });

  test("an HTML receipt goes stale when the browser build changes or the runner disappears", async () => {
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: draftFor("html-static"),
    });
    const preview = await h.call("preview_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      revision: 1,
    });
    const operation = await settle(h, preview.operationId);
    h.runner.browserBuild = "chromium-test-2";
    const stale = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });
    expect(stale.error.code).toBe("preview_stale");
    expect(stale.error.message).toContain("browserBuild");
    h.runner.available = false;
    const unavailable = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: operation.operation.receiptId,
    });
    expect(unavailable.error.code).toBe("renderer_unavailable");
    expect(h.service.metrics.total("receipt_mismatches")).toBe(1);
  });

  test("dependency manifest, theme tokens, policy and renderer version changes make receipts stale", async () => {
    const interactive = await h.call("create_artifact", {
      requestKey: key(),
      draft: draftFor("html-interactive"),
    });
    const op = await settle(
      h,
      (
        await h.call("preview_artifact", {
          requestKey: key(),
          artifactId: interactive.artifactId,
          revision: 1,
        })
      ).operationId,
    );
    h.preparer.manifestHash = "dependency-manifest-2";
    const result = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: interactive.artifactId,
      expectedRevision: 1,
      receiptId: op.operation.receiptId,
    });
    expect(result.error.code).toBe("preview_stale");

    const chart = await h.call("create_artifact", { requestKey: key(), draft: draftFor("chart") });
    const chartOp = await settle(
      h,
      (
        await h.call("preview_artifact", {
          requestKey: key(),
          artifactId: chart.artifactId,
          revision: 1,
        })
      ).operationId,
    );
    for (const overrides of [
      { chart: { rendererVersion: "native-chart:v2" } },
      { chart: { policyVersion: "rich-content-policy:v2" } },
      { chart: { themeTokens: () => ({ palette: ["#000"] }) } },
    ]) {
      const bumped = await h.reopen({ identityOverrides: overrides });
      const response = await bumped.handleTool("publish_artifact", TAB, {
        requestKey: key(),
        artifactId: chart.artifactId,
        expectedRevision: 1,
        receiptId: chartOp.operation.receiptId,
      });
      expect((response.value.error as { code: string }).code).toBe("preview_stale");
    }
    const current = await h.reopen({ identityOverrides: {} });
    const ok = await current.handleTool("publish_artifact", TAB, {
      requestKey: key(),
      artifactId: chart.artifactId,
      expectedRevision: 1,
      receiptId: chartOp.operation.receiptId,
    });
    expect(ok.isError).toBe(false);
    expect(ARTIFACT_VERSIONS.interactiveRuntime).toBeTruthy();
  });

  test("a tampered receipt viewport fails its input hash", async () => {
    const created = await h.call("create_artifact", {
      requestKey: key(),
      draft: draftFor("html-static"),
    });
    const op = await settle(
      h,
      (
        await h.call("preview_artifact", {
          requestKey: key(),
          artifactId: created.artifactId,
          revision: 1,
          profile: { theme: "dark", viewport: { width: 800, height: 600, deviceScaleFactor: 1 } },
        })
      ).operationId,
    );
    h.service.store.transact(ENV, (records) => {
      const receipt = records.get("receipt", op.operation.receiptId)!;
      records.put("receipt", receipt.receiptId, {
        ...receipt,
        identity: {
          ...receipt.identity,
          viewport: { width: 960, height: 640, deviceScaleFactor: 1 },
        },
      });
    });
    const result = await h.call("publish_artifact", {
      requestKey: key(),
      artifactId: created.artifactId,
      expectedRevision: 1,
      receiptId: op.operation.receiptId,
    });
    expect(result.error.code).toBe("preview_stale");
  });

  test("conversation key is the native logical session key", () => {
    expect(conversationKeyForTab(ENV, "tab-1")).toBe(CONVERSATION);
  });
});
