/**
 * The `pdf` representation: produced on request by the (fake) supervised
 * runner from exactly the verified bytes, bound to the receipt and the print
 * profile, stored once per profile, refused for the wrong kinds, fenced
 * against deletion, and the media first-page preview's refusals and cache.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PDF_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ARTIFACT_VERSIONS, type ArtifactKind } from "@orkestrator/protocol/transcript-artifacts";

import { referencedAssets } from "./gc.js";
import { sha256Hex } from "./hashing.js";
import {
  ARTIFACT_PRINT_PROFILE_VERSION,
  artifactPrintProfile,
  printProfileIdentity,
} from "./print-profile.js";
import {
  CONVERSATION,
  ENV,
  SAMPLE_CHART,
  createHarness,
  fakePdf,
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

const SCOPE = { environmentId: ENV, logicalSessionKey: CONVERSATION };

function draftFor(kind: ArtifactKind): Record<string, unknown> {
  if (kind === "html-static")
    return {
      title: "Report: Q3/2026",
      summary: "s",
      payload: { kind, html: "<h1>Hi</h1><script>alert(1)</script>" },
    };
  if (kind === "html-interactive")
    return {
      title: "Calc",
      summary: "calculator",
      payload: {
        kind,
        html: '<output data-artifact-test="out">4</output><script>/* x */</script>',
      },
    };
  return { title: "Chart", summary: "", payload: { kind: "chart", spec: SAMPLE_CHART } };
}

async function publish(kind: ArtifactKind): Promise<string> {
  const created = await h.call("create_artifact", { requestKey: key(), draft: draftFor(kind) });
  const preview = await h.call("preview_artifact", {
    requestKey: key(),
    artifactId: created.artifactId,
    revision: 1,
  });
  const operation = await settle(h, preview.operationId);
  expect(operation.operation.status).toBe("succeeded");
  const published = await h.call("publish_artifact", {
    requestKey: key(),
    artifactId: created.artifactId,
    expectedRevision: 1,
    receiptId: operation.operation.receiptId,
  });
  expect(published.isError).toBe(false);
  return published.publicationId as string;
}

const printCalls = () => h.runner.calls.filter((call) => call.job.kind === "html-print");

describe("pdf representation", () => {
  test("static HTML: printed once per print profile from the verified source, then stored", async () => {
    const publicationId = await publish("html-static");
    const first = await h.service.readRepresentation({
      ...SCOPE,
      publicationId,
      representation: "pdf",
    });
    expect(first).toMatchObject({
      representation: "pdf",
      mimeType: "application/pdf",
      encoding: "base64",
      revision: 1,
      nextOffsetBytes: null,
      executableOutsideOrkestrator: false,
      filename: "Report Q3 2026.pdf",
    });
    const bytes = Buffer.from(first.data, "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(first.sha256).toBe(sha256Hex(bytes));
    expect(first.print).toMatchObject({
      profileVersion: ARTIFACT_PRINT_PROFILE_VERSION,
      paper: "a4",
      pageCount: 1,
    });
    expect(printCalls()).toHaveLength(1);
    const job = printCalls()[0]!;
    // The exact verified source, the receipt's profile, and the owner conversation's scope.
    expect(job.job).toMatchObject({
      kind: "html-print",
      document: { type: "static", html: "<h1>Hi</h1>" },
      print: { paper: "a4", printBackground: true, reducedMotion: "reduce" },
    });
    expect(job.scope).toMatchObject({ environmentId: ENV, conversationKey: CONVERSATION });

    // Stored: a second read returns the same bytes without printing again.
    const again = await h.service.readRepresentation({
      ...SCOPE,
      publicationId,
      representation: "pdf",
      paper: "a4",
    });
    expect(again.sha256).toBe(first.sha256);
    expect(printCalls()).toHaveLength(1);

    // A different profile is a different representation.
    const letter = await h.service.readRepresentation({
      ...SCOPE,
      publicationId,
      representation: "pdf",
      paper: "letter",
    });
    expect(letter.print?.paper).toBe("letter");
    expect(letter.print?.profileHash).not.toBe(first.print?.profileHash);
    expect(printCalls()).toHaveLength(2);

    // Recorded on the revision's derived row and kept by the collector.
    const records = h.service.store.records(ENV);
    const artifactId = first.artifactId;
    const derived = records.get("derived", `${artifactId}/1`)!;
    expect(derived.printed?.map((entry) => entry.paper).sort()).toEqual(["a4", "letter"]);
    expect(derived.printed?.[0]?.printProfileHash).toBe(
      printProfileIdentity(
        artifactPrintProfile("a4", {
          theme: "light",
          viewport: { width: 960, height: 640, deviceScaleFactor: 1 },
        }),
      ),
    );
    expect(referencedAssets(records).has(first.sha256)).toBe(true);
  });

  test("concurrent requests share one print job", async () => {
    const publicationId = await publish("html-static");
    h.runner.hold();
    const reads = [1, 2, 3].map(() =>
      h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" }),
    );
    await h.runner.started.promise;
    h.runner.release();
    const results = await Promise.all(reads);
    expect(new Set(results.map((result) => result.sha256)).size).toBe(1);
    expect(printCalls()).toHaveLength(1);
  });

  test("a printed document that differs from the receipt is refused, never stored", async () => {
    const publicationId = await publish("html-static");
    h.runner.respond = (job) =>
      job.kind === "html-print"
        ? {
            kind: "html-print",
            ok: true,
            pdf: fakePdf("other"),
            pageCount: 1,
            effectiveHtmlSha256: "0".repeat(64),
            browserBuild: "chromium-test-1",
            rendererBundleHash: "bundle-1",
            diagnostics: [],
            omittedDiagnostics: 0,
            blockedRequests: {},
          }
        : null;
    await expect(
      h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" }),
    ).rejects.toMatchObject({ error: { code: "preview_stale" } });
    const records = h.service.store.records(ENV);
    const [artifactId] = records.keys("head");
    expect(records.get("derived", `${artifactId}/1`)?.printed ?? []).toHaveLength(0);
  });

  test("interactive HTML prints the stored prepared package under its own CSP", async () => {
    const publicationId = await publish("html-interactive");
    const result = await h.service.readRepresentation({
      ...SCOPE,
      publicationId,
      representation: "pdf",
    });
    expect(result.mimeType).toBe("application/pdf");
    const job = printCalls()[0]!.job;
    if (job.kind !== "html-print" || job.document.type !== "interactive")
      throw new Error("expected an interactive print job");
    expect(job.document.preparedDocument).toContain("<!-- prepared");
    expect(job.document.contentSecurityPolicy).toContain("sandbox allow-scripts");
    expect(job.document.identity).toEqual({ artifactId: result.artifactId, revision: 1 });
  });

  test("interactive bytes prepared under an older policy are never printed", async () => {
    const publicationId = await publish("html-interactive");
    const records = h.service.store.records(ENV);
    const [artifactId] = records.keys("head");
    const keyName = `${artifactId}/1`;
    h.service.store.transact(ENV, (tx) => {
      const derived = tx.get("derived", keyName)!;
      tx.put("derived", keyName, {
        ...derived,
        prepared: derived.prepared.map((entry) => ({ ...entry, policyVersion: "old-policy" })),
      });
    });
    expect(ARTIFACT_VERSIONS.interactivePolicyVersion).not.toBe("old-policy");
    await expect(
      h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" }),
    ).rejects.toMatchObject({ error: { code: "policy_denied" } });
    expect(printCalls()).toHaveLength(0);
  });

  test("non-HTML kinds have no PDF; another conversation cannot read it", async () => {
    const chart = await publish("chart");
    await expect(
      h.service.readRepresentation({ ...SCOPE, publicationId: chart, representation: "pdf" }),
    ).rejects.toMatchObject({ error: { code: "invalid_input" } });
    const html = await publish("html-static");
    await expect(
      h.service.readRepresentation({
        environmentId: ENV,
        logicalSessionKey: "env-env-1:other-tab",
        publicationId: html,
        representation: "pdf",
      }),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
    expect(printCalls()).toHaveLength(0);
  });

  test("runner failures surface as typed errors; an unavailable runner says so", async () => {
    const publicationId = await publish("html-static");
    h.runner.respond = (job) =>
      job.kind === "html-print"
        ? {
            kind: "html-print",
            ok: false,
            error: {
              code: "package_size_exceeded",
              message: "The document prints to more than 100 pages",
              retryClass: "never",
              resource: "pdf-pages",
            },
            diagnostics: [],
            omittedDiagnostics: 0,
            captures: [],
            blockedRequests: {},
            browserBuild: "chromium-test-1",
          }
        : null;
    await expect(
      h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" }),
    ).rejects.toMatchObject({ error: { code: "package_size_exceeded", resource: "pdf-pages" } });
    h.runner.respond = null;
    h.runner.available = false;
    await expect(
      h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" }),
    ).rejects.toMatchObject({ error: { code: "renderer_unavailable" } });
  });

  test("environment deletion cancels a running print and nothing is stored", async () => {
    const publicationId = await publish("html-static");
    h.runner.hold();
    const read = h.service.readRepresentation({ ...SCOPE, publicationId, representation: "pdf" });
    const outcome = read.then(
      () => "resolved",
      (error: { error?: { code?: string } }) => error.error?.code,
    );
    await h.runner.started.promise;
    await h.service.deleteEnvironment(ENV);
    h.runner.release();
    expect(await outcome).toBe("cancelled");
  });
});

describe("media first-page previews", () => {
  const pdf = fakePdf("attachment");

  test("renders through the runner and caches by content hash", async () => {
    const reads: number[] = [];
    const read = async () => {
      reads.push(1);
      return pdf;
    };
    const first = await h.service.mediaPdfPreview(ENV, read);
    expect(first).toMatchObject({
      status: "ready",
      sha256: sha256Hex(pdf),
      byteLength: pdf.byteLength,
      pageCount: 3,
      thumbnail: { mimeType: "image/png", width: 120, height: 160 },
      limits: { maxPages: PDF_POLICY.maxPages, maxBytes: PDF_POLICY.maxBytes },
    });
    const second = await h.service.mediaPdfPreview(ENV, read);
    expect(second).toEqual(first);
    // Bytes are re-read (authorization applies every time), but rendered once.
    expect(reads).toHaveLength(2);
    expect(h.runner.calls.filter((call) => call.job.kind === "pdf-thumbnail")).toHaveLength(1);
  });

  test("oversized, non-PDF and unreadable files are refused before any worker", async () => {
    const big = new Uint8Array(PDF_POLICY.maxBytes + 1);
    big.set(new TextEncoder().encode("%PDF-1.7"));
    expect(await h.service.mediaPdfPreview(ENV, async () => big)).toMatchObject({
      status: "refused",
      reason: "byte-limit",
      pageCount: null,
    });
    expect(
      await h.service.mediaPdfPreview(ENV, async () => new TextEncoder().encode("<html>")),
    ).toMatchObject({ status: "refused", reason: "not-pdf" });
    expect(
      await h.service.mediaPdfPreview(ENV, async () => {
        throw new Error("ENOENT");
      }),
    ).toMatchObject({ status: "unavailable", reason: "read-failed", sha256: null });
    expect(h.runner.calls.filter((call) => call.job.kind === "pdf-thumbnail")).toHaveLength(0);
  });

  test("page-limit refusals keep the page count and no image", async () => {
    h.runner.respond = (job) =>
      job.kind === "pdf-thumbnail"
        ? {
            kind: "pdf-thumbnail",
            ok: true,
            pageCount: 140,
            thumbnail: null,
            refusal: "page-limit",
            browserBuild: "chromium-test-1",
            rendererBundleHash: "bundle-1",
            diagnostics: [],
            omittedDiagnostics: 0,
            blockedRequests: {},
          }
        : null;
    const response = await h.service.mediaPdfPreview(ENV, async () => fakePdf("long"));
    expect(response).toMatchObject({ status: "refused", reason: "page-limit", pageCount: 140 });
    expect(response.thumbnail).toBeUndefined();
  });

  test("no runner: unavailable with a reason", async () => {
    h.runner.available = false;
    expect(await h.service.mediaPdfPreview(ENV, async () => fakePdf("x"))).toMatchObject({
      status: "unavailable",
      reason: "renderer-unavailable",
    });
  });
});
