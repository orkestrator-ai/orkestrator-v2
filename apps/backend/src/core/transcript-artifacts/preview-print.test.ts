/**
 * PDF jobs through the supervised worker with real Chromium (process mode):
 * printing verified HTML under the fixed print profile, and first-page
 * previews of PDF attachments with the pinned pdf.js. Browser cases skip with
 * a printed reason when no Chromium executable is found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { PDF_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import {
  RENDERER_BUNDLES,
  loadPinnedBundle,
  pdfRendererBundleHash,
  sha256Hex,
} from "./dependency-manifest.js";
import type { PreviewJob, PreviewJobResult } from "./contracts.js";
import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import {
  ARTIFACT_PRINT_PROFILE_VERSION,
  artifactPrintProfile,
  countPrintedPdfPages,
  looksLikePdf,
  printProfileIdentity,
} from "./print-profile.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[preview-print.test] browser cases skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const browserTest = CHROMIUM ? test : test.skip;
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imageHasPdfJs =
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "ls",
      IMAGE,
      "/opt/artifact-preview-worker/pdf.min.mjs",
    ],
    { stdio: "ignore", timeout: 30_000 },
  ).status === 0;
if (!imageHasPdfJs)
  console.warn(
    `[preview-print.test] container cases skipped: Docker or an image ${IMAGE} with pdf.js is unavailable (rebuild with docker/artifact-preview-worker/build.sh)`,
  );
const containerTest = imageHasPdfJs && CHROMIUM ? test : test.skip;

let runner: TranscriptPreviewRunner;
let strictRunner: TranscriptPreviewRunner;
let operation = 0;
const scope = () => ({
  environmentId: `env-p${++operation}`,
  conversationKey: "conv",
  operationId: `op_print${String(operation).padStart(8, "0")}`,
});
const run = (job: PreviewJob, target = runner) =>
  target.run(job, scope(), new AbortController().signal);

const STATIC_HTML = `<!doctype html><html><head><style>
  body { background: #123456; color: white; font: 16px sans-serif }
  section { height: 900px; border: 4px solid #fc0 }
</style></head><body><h1>Quarterly report</h1><section>One</section><section>Two</section></body></html>`;

function mediaBox(pdf: Uint8Array): number[] {
  const match = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(
    Buffer.from(pdf).toString("latin1"),
  );
  return match ? match.slice(1).map(Number) : [];
}

function printJob(html: string, paper: "a4" | "letter" = "a4"): PreviewJob {
  return {
    kind: "html-print",
    print: artifactPrintProfile(paper, DEFAULT_PREVIEW_PROFILE),
    profile: DEFAULT_PREVIEW_PROFILE,
    document: { type: "static", html },
  };
}

function expectOk<K extends PreviewJobResult["kind"]>(
  result: PreviewJobResult,
  kind: K,
): Extract<PreviewJobResult, { kind: K; ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(result.kind).toBe(kind);
  return result as Extract<PreviewJobResult, { kind: K; ok: true }>;
}

async function chromiumPdf(html: string): Promise<Uint8Array> {
  const browser = await chromium.launch({
    executablePath: CHROMIUM!,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    return new Uint8Array(await page.pdf({ format: "A4" }));
  } finally {
    await browser.close();
  }
}

beforeAll(() => {
  // Interactive printing runs authored JavaScript: process mode needs the
  // explicit opt-in (container isolation is the production default).
  runner = new TranscriptPreviewRunner({
    isolation: "process",
    allowProcessInteractive: true,
  });
  strictRunner = new TranscriptPreviewRunner({ isolation: "process" });
});
afterAll(async () => {
  await Promise.all([runner?.close(), strictRunner?.close()]);
});

describe("print profile", () => {
  test("identity covers every fixed field and changes with the paper", () => {
    const a4 = artifactPrintProfile("a4", DEFAULT_PREVIEW_PROFILE);
    expect(a4).toMatchObject({
      version: ARTIFACT_PRINT_PROFILE_VERSION,
      printBackground: true,
      reducedMotion: "reduce",
      scale: 1,
      maxPages: PDF_POLICY.maxPages,
      maxBytes: PDF_POLICY.maxBytes,
    });
    const letter = artifactPrintProfile("letter", DEFAULT_PREVIEW_PROFILE);
    expect(printProfileIdentity(a4)).toMatch(/^[0-9a-f]{64}$/);
    expect(printProfileIdentity(a4)).toBe(
      printProfileIdentity(artifactPrintProfile("a4", DEFAULT_PREVIEW_PROFILE)),
    );
    expect(printProfileIdentity(a4)).not.toBe(printProfileIdentity(letter));
  });

  test("page counting and signature checks", () => {
    const pdf = new TextEncoder().encode(
      "%PDF-1.7\n<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>",
    );
    expect(looksLikePdf(pdf)).toBe(true);
    expect(countPrintedPdfPages(pdf)).toBe(2);
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false);
  });

  test("interactive printing is refused without an OS boundary", async () => {
    const job: PreviewJob = {
      kind: "html-print",
      print: artifactPrintProfile("a4", DEFAULT_PREVIEW_PROFILE),
      profile: DEFAULT_PREVIEW_PROFILE,
      document: {
        type: "interactive",
        preparedDocument: "<!doctype html><p>x</p>",
        contentSecurityPolicy: "default-src 'none'; sandbox allow-scripts",
      },
    };
    await expect(run(job, strictRunner)).rejects.toMatchObject({
      error: { code: "renderer_unavailable" },
    });
  });
});

describe("html-print through the worker", () => {
  browserTest(
    "prints the static document on A4 and Letter with backgrounds",
    async () => {
      const a4 = expectOk(await run(printJob(STATIC_HTML, "a4")), "html-print");
      expect(looksLikePdf(a4.pdf)).toBe(true);
      expect(a4.pageCount).toBeGreaterThanOrEqual(2);
      expect(a4.pageCount).toBe(countPrintedPdfPages(a4.pdf));
      expect(a4.effectiveHtmlSha256).toMatch(/^[0-9a-f]{64}$/);
      const box = mediaBox(a4.pdf);
      expect(Math.round(box[2]!)).toBe(596);
      expect(Math.round(box[3]!)).toBe(843);
      const letter = expectOk(await run(printJob(STATIC_HTML, "letter")), "html-print");
      const letterBox = mediaBox(letter.pdf);
      expect(Math.round(letterBox[2]!)).toBe(612);
      expect(Math.round(letterBox[3]!)).toBe(792);
      // Same document, same sanitized bytes printed.
      expect(letter.effectiveHtmlSha256).toBe(a4.effectiveHtmlSha256!);
    },
    60_000,
  );

  browserTest(
    "refuses a document longer than the page ceiling",
    async () => {
      const html = `<!doctype html><body>${'<div style="break-after: page">page</div>'.repeat(
        PDF_POLICY.maxPages + 20,
      )}</body>`;
      const result = await run(printJob(html));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("package_size_exceeded");
      expect(result.error.resource).toBe("pdf-pages");
    },
    60_000,
  );

  browserTest(
    "prints an interactive document's settled initial state without running window.print",
    async () => {
      const preparer = new TranscriptInteractivePreparer({
        frameAncestors: ["http://127.0.0.1:*"],
      });
      const prepared = await preparer.prepare({
        artifactId: "art_printinteractive01",
        revision: 1,
        html: `<!doctype html><html><body><p id="out">loading</p><script>
          window.print();
          document.getElementById("out").textContent = "ready " + typeof window.print;
        </script></body></html>`,
        dependencyIds: [],
        assets: [],
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const started = Date.now();
      const result = expectOk(
        await run({
          kind: "html-print",
          print: artifactPrintProfile("a4", DEFAULT_PREVIEW_PROFILE),
          profile: DEFAULT_PREVIEW_PROFILE,
          document: {
            type: "interactive",
            preparedDocument: prepared.prepared.document,
            contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
            readinessNonce: prepared.prepared.readinessNonce,
            identity: { artifactId: "art_printinteractive01", revision: 1 },
          },
        }),
        "html-print",
      );
      expect(result.pageCount).toBe(1);
      expect(result.effectiveHtmlSha256).toBeUndefined();
      expect(result.blockedRequests.dialog ?? 0).toBe(0);
      expect(Date.now() - started).toBeLessThan(30_000);
    },
    60_000,
  );
});

describe("pdf-thumbnail through the worker", () => {
  browserTest(
    "renders page 1 to a bounded PNG with the page count",
    async () => {
      const pdf = await chromiumPdf(
        `<body style="margin:0">${'<div style="height:1100px;background:#c33;break-after:page">x</div>'.repeat(3)}</body>`,
      );
      const result = expectOk(
        await run({ kind: "pdf-thumbnail", pdf, maxDimension: 512 }),
        "pdf-thumbnail",
      );
      expect(result.pageCount).toBe(countPrintedPdfPages(pdf));
      expect(result.refusal).toBeUndefined();
      const thumbnail = result.thumbnail!;
      expect(Math.max(thumbnail.width, thumbnail.height)).toBeLessThanOrEqual(512);
      expect(thumbnail.height).toBeGreaterThan(thumbnail.width);
      expect(Array.from(thumbnail.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
    60_000,
  );

  browserTest(
    "ignores PDF JavaScript and external actions; nothing is fetched",
    async () => {
      const pdf = new TextEncoder().encode(
        [
          "%PDF-1.4",
          "1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R /AA << /WC 4 0 R >> >> endobj",
          "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
          "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [5 0 R] >> endobj",
          "4 0 obj << /S /JavaScript /JS (app.launchURL('https://canary.invalid/js'); this.submitForm('https://canary.invalid/form');) >> endobj",
          "5 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 200 200] /A << /S /URI /URI (https://canary.invalid/link) >> >> endobj",
          "trailer << /Root 1 0 R >>",
          "%%EOF",
        ].join("\n"),
      );
      const result = expectOk(
        await run({ kind: "pdf-thumbnail", pdf, maxDimension: 256 }),
        "pdf-thumbnail",
      );
      expect(result.pageCount).toBe(1);
      expect(result.thumbnail).not.toBeNull();
      expect(result.blockedRequests).toEqual({});
    },
    60_000,
  );

  browserTest(
    "refuses over the page ceiling with metadata only, and invalid documents",
    async () => {
      const long = await chromiumPdf(
        `<body>${'<div style="break-after:page">p</div>'.repeat(PDF_POLICY.maxPages + 5)}</body>`,
      );
      const refused = expectOk(
        await run({ kind: "pdf-thumbnail", pdf: long, maxDimension: 256 }),
        "pdf-thumbnail",
      );
      expect(refused.refusal).toBe("page-limit");
      expect(refused.thumbnail).toBeNull();
      expect(refused.pageCount).toBe(PDF_POLICY.maxPages + 5);

      const invalid = expectOk(
        await run({
          kind: "pdf-thumbnail",
          pdf: new TextEncoder().encode("%PDF-1.7\nthis is not a document"),
          maxDimension: 256,
        }),
        "pdf-thumbnail",
      );
      expect(invalid.refusal).toBe("invalid-pdf");
      expect(invalid.thumbnail).toBeNull();
    },
    90_000,
  );

  test("non-PDF bytes and oversized documents never reach a worker", async () => {
    const notPdf = await run({
      kind: "pdf-thumbnail",
      pdf: new TextEncoder().encode("<html>"),
      maxDimension: 256,
    });
    expect(notPdf).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const big = new Uint8Array(PDF_POLICY.maxBytes + 1);
    big.set(new TextEncoder().encode("%PDF-1.7"));
    const tooBig = await run({
      kind: "pdf-thumbnail",
      pdf: big,
      maxDimension: 256,
    });
    expect(tooBig).toMatchObject({
      ok: false,
      error: { code: "package_size_exceeded", resource: "pdf-bytes" },
    });
  });
});

test("the worker bundle ships pdf.js but never its scripting sandbox", () => {
  const dockerfile = readFileSync(
    path.resolve(import.meta.dir, "../../../../../docker/artifact-preview-worker/Dockerfile"),
    "utf8",
  );
  expect(dockerfile).toMatch(/^COPY pdf\.min\.mjs pdf\.worker\.min\.mjs \.\/$/m);
  expect(dockerfile).not.toContain("pdf.sandbox");
});

test("pdf.js bundles are pinned, verified at load and licensed Apache-2.0", async () => {
  for (const bundle of [RENDERER_BUNDLES.pdfjs, RENDERER_BUNDLES.pdfjsWorker]) {
    expect(bundle.version).toBe("6.4.299");
    expect(bundle.license).toBe("Apache-2.0");
    expect(bundle.notice).toContain("Mozilla Foundation");
    const bytes = await loadPinnedBundle(bundle);
    expect(sha256Hex(bytes)).toBe(bundle.sha256);
  }
  expect(pdfRendererBundleHash()).toMatch(/^[0-9a-f]{64}$/);
});

describe("container worker", () => {
  containerTest(
    "prints and previews PDFs inside the network-less container",
    async () => {
      const container = new TranscriptPreviewRunner({
        isolation: "container",
        container: {
          docker: "docker",
          image: IMAGE,
          seccompProfile: resolveSeccompProfile()!,
          user: PREVIEW_WORKER_USER,
        },
      });
      try {
        const printed = expectOk(
          await run(printJob(STATIC_HTML, "letter"), container),
          "html-print",
        );
        expect(printed.pageCount).toBeGreaterThanOrEqual(2);
        expect(Math.round(mediaBox(printed.pdf)[2]!)).toBe(612);
        const local = expectOk(await run(printJob(STATIC_HTML, "letter")), "html-print");
        // The same sanitized document is printed in either boundary.
        expect(printed.effectiveHtmlSha256).toBe(local.effectiveHtmlSha256!);
        const thumbnail = expectOk(
          await run({ kind: "pdf-thumbnail", pdf: printed.pdf, maxDimension: 300 }, container),
          "pdf-thumbnail",
        );
        expect(thumbnail.pageCount).toBe(printed.pageCount);
        expect(
          Math.max(thumbnail.thumbnail!.width, thumbnail.thumbnail!.height),
        ).toBeLessThanOrEqual(300);
        expect(thumbnail.blockedRequests).toEqual({});
      } finally {
        await container.close();
      }
    },
    120_000,
  );
});
