/**
 * PDF jobs of the preview worker. Runs ONLY inside a supervised worker
 * process or container (see preview-jobs.ts for the isolation it shares):
 *
 * - `html-print`: prints one verified HTML revision to PDF under the fixed
 *   print profile (paper, margins, backgrounds, reduced motion). Static HTML
 *   goes through exactly the design runtime path its preview used; prepared
 *   interactive documents are served from memory under their own CSP, wait for
 *   the runtime's readiness signal and are printed in that initial settled
 *   state. Printing uses the DevTools print-to-PDF path; authored content's
 *   `window.print()` is replaced by a no-op before any document script runs and
 *   is never called. Output is bounded in pages and bytes.
 * - `pdf-thumbnail`: renders page 1 of a PDF attachment to a bounded PNG with
 *   the pinned pdf.js, loaded as application-owned modules in an empty,
 *   request-denied page (no pdf.js worker thread, no scripting sandbox, no XFA,
 *   no font-face or WebAssembly, no fetches). PDF JavaScript never runs:
 *   pdf.js core does not execute it and the scripting bundle is not shipped.
 */
import { createHash, randomUUID } from "node:crypto";

import type { Browser, BrowserContext, Page } from "playwright-core";

import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";
import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import {
  INTERACTIVE_HTML_POLICY,
  PDF_POLICY,
  PREVIEW_CAPTURE_POLICY,
} from "@orkestrator/protocol/rich-content-policy";

import { RENDERER_BUNDLES, loadPinnedBundle } from "./dependency-manifest.js";
import { PRINT_PAPER_FORMAT, countPrintedPdfPages, looksLikePdf } from "./print-profile.js";
import {
  JobFailure,
  PREVIEW_DOCUMENT_URL,
  PREVIEW_ORIGIN,
  checkProfile,
  deadline,
  increment,
  isolatedContext,
  readinessListener,
  settleAssets,
} from "./preview-worker-browser.js";
import type { WorkerEvent, WorkerJobPackage, WorkerResult } from "./preview-worker-protocol.js";

type Emit = (event: WorkerEvent) => void;
type PrintJob = Extract<WorkerJobPackage["job"], { kind: "html-print" }>;
type ThumbnailJob = Extract<WorkerJobPackage["job"], { kind: "pdf-thumbnail" }>;

/** Init script: authored `window.print()` becomes a counted no-op (never a dialog or a print). */
function neutralizePrint() {
  const counter = window as unknown as { __orkPrintCalls?: number };
  counter.__orkPrintCalls = 0;
  const print = () => {
    counter.__orkPrintCalls = (counter.__orkPrintCalls ?? 0) + 1;
  };
  try {
    Object.defineProperty(window, "print", {
      value: print,
      writable: false,
      configurable: false,
    });
  } catch {
    window.print = print;
  }
}

const stopped = () => new JobFailure("render_timeout", "The page stopped responding", "runtime");

async function printStatic(
  context: BrowserContext,
  job: PrintJob & { document: { type: "static" } },
  result: WorkerResult,
  remaining: () => number,
): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(remaining());
  await page.setContent(designBootstrap(randomUUID()), { waitUntil: "load" });
  const outcome = (await page.evaluate(async (html) => {
    const run = (window as unknown as { orkDesign: (input: unknown) => unknown }).orkDesign;
    try {
      run({ op: "validate", html });
      run({ op: "render", html });
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : "Runtime failed",
      };
    }
  }, job.document.html)) as { ok: true } | { ok: false; message: string };
  if (!outcome.ok) throw new JobFailure("validation_failed", outcome.message.slice(0, 300));
  await page.evaluate(settleAssets, Math.min(5_000, Math.floor(remaining() / 3)));
  const effective = (await page.evaluate(() =>
    (window as unknown as { orkDesign: (input: unknown) => unknown }).orkDesign({
      op: "serialize",
    }),
  )) as string;
  // Binds the PDF to the receipt: the backend compares this with the
  // revision's recorded effective-document hash before storing anything.
  result.effectiveHtmlSha256 = createHash("sha256").update(effective, "utf8").digest("hex");
  return page;
}

async function printInteractive(
  browser: Browser,
  job: PrintJob & { document: { type: "interactive" } },
  pkg: WorkerJobPackage,
  result: WorkerResult,
  emit: Emit,
): Promise<{ context: BrowserContext; page: Page }> {
  const prepared = job.document;
  let served = 0;
  let mainPage: Page | undefined;
  const context = await isolatedContext(
    browser,
    job.profile,
    result.blockedRequests,
    async (route) => {
      const request = route.request();
      if (
        served === 0 &&
        request.url() === PREVIEW_DOCUMENT_URL &&
        request.method() === "GET" &&
        request.isNavigationRequest() &&
        mainPage !== undefined &&
        request.frame() === mainPage.mainFrame()
      ) {
        served++;
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": prepared.contentSecurityPolicy,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
          body: prepared.preparedDocument,
        });
        return true;
      }
      if (request.url() === `${PREVIEW_ORIGIN}/favicon.ico`) {
        await route.abort("blockedbyclient").catch(() => undefined);
        return true;
      }
      return false;
    },
  );
  await context.addInitScript(neutralizePrint);
  await context.addInitScript(readinessListener, prepared.readinessNonce ?? null);
  const page = await context.newPage();
  mainPage = page;
  page.on("popup", (popup) => {
    increment(result.blockedRequests, "popup");
    popup.close().catch(() => undefined);
  });
  emit({ t: "phase", phase: "navigating" });
  const readinessDeadline = Date.now() + pkg.limits.readinessMs;
  try {
    await page.goto(PREVIEW_DOCUMENT_URL, {
      waitUntil: "load",
      timeout: pkg.limits.readinessMs,
    });
    await page.waitForFunction(
      () => (window as unknown as { __orkPreviewReady?: boolean }).__orkPreviewReady === true,
      undefined,
      { timeout: Math.max(1, readinessDeadline - Date.now()), polling: 50 },
    );
  } catch {
    throw new JobFailure(
      "render_timeout",
      "The interactive document did not become ready in time",
      "readiness",
    );
  }
  emit({ t: "phase", phase: "ready" });
  if (prepared.identity) {
    await deadline(
      page.evaluate((message) => window.postMessage(message, "*"), {
        channel: ARTIFACT_FRAME_CHANNEL,
        v: 1,
        type: "theme",
        artifactId: prepared.identity.artifactId,
        revision: prepared.identity.revision,
        generation: "print",
        appearance: job.profile.theme,
        reducedMotion: true,
        viewport: {
          width: job.profile.viewport.width,
          height: job.profile.viewport.height,
        },
        tokens: {},
      }),
      2_000,
      stopped,
    );
  }
  await deadline(page.evaluate(settleAssets, 1_000), 3_000, stopped);
  const elements = await deadline(
    page.evaluate(() => document.getElementsByTagName("*").length),
    2_000,
    stopped,
  );
  if (elements > INTERACTIVE_HTML_POLICY.maxRuntimeElements)
    throw new JobFailure(
      "validation_failed",
      "The document exceeded its element budget",
      "dom-elements",
    );
  return { context, page };
}

export async function runHtmlPrint(
  browser: Browser,
  job: PrintJob,
  pkg: WorkerJobPackage,
  result: WorkerResult,
  remaining: () => number,
  emit: Emit,
): Promise<void> {
  checkProfile(job.profile);
  const { print } = job;
  if (print.paper !== "a4" && print.paper !== "letter")
    throw new JobFailure("invalid_input", "Unknown print paper", "print-profile");
  const maxPages = Math.min(print.maxPages, PDF_POLICY.maxPages);
  const maxBytes = Math.min(print.maxBytes, PDF_POLICY.maxBytes);
  let page: Page;
  if (job.document.type === "static") {
    const context = await isolatedContext(
      browser,
      job.profile,
      result.blockedRequests,
      async () => false,
    );
    await context.addInitScript(neutralizePrint);
    page = await printStatic(
      context,
      job as PrintJob & { document: { type: "static" } },
      result,
      remaining,
    );
  } else {
    page = (
      await printInteractive(
        browser,
        job as PrintJob & { document: { type: "interactive" } },
        pkg,
        result,
        emit,
      )
    ).page;
  }
  emit({ t: "phase", phase: "capturing" });
  const margin = `${print.marginMm}mm`;
  // One page past the ceiling: Chromium clips the range to the document, so
  // more than `maxPages` pages in the output means the document is too long.
  const pdf = await deadline(
    page.pdf({
      format: PRINT_PAPER_FORMAT[print.paper],
      printBackground: true,
      scale: 1,
      margin: { top: margin, right: margin, bottom: margin, left: margin },
      pageRanges: `1-${maxPages + 1}`,
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      outline: false,
      tagged: false,
    }),
    Math.max(1, remaining()),
    () => new JobFailure("render_timeout", "Printing exceeded its time budget", "print"),
  );
  if (pdf.byteLength > maxBytes)
    throw new JobFailure(
      "package_size_exceeded",
      `The PDF is ${pdf.byteLength} bytes; the limit is ${maxBytes}`,
      "pdf-bytes",
    );
  if (!looksLikePdf(pdf))
    throw new JobFailure("renderer_unavailable", "The browser did not produce a PDF", "print");
  const pages = countPrintedPdfPages(pdf);
  if (pages < 1)
    throw new JobFailure("renderer_unavailable", "The printed PDF has no pages", "print");
  if (pages > maxPages)
    throw new JobFailure(
      "package_size_exceeded",
      `The document prints to more than ${maxPages} pages`,
      "pdf-pages",
    );
  result.pdfBase64 = pdf.toString("base64");
  result.pageCount = pages;
  result.ok = true;
}

/** Runs in the empty preview page: pdf.js from in-memory module sources, page 1 to PNG. */
async function renderFirstPage(input: {
  library: string;
  worker: string;
  pdfBase64: string;
  maxDimension: number;
  maxPages: number;
  maxImagePixels: number;
}) {
  const moduleUrl = (source: string) =>
    URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  type PdfPage = {
    getViewport: (options: { scale: number }) => {
      width: number;
      height: number;
    };
    render: (options: Record<string, unknown>) => { promise: Promise<void> };
  };
  type PdfDocument = {
    numPages: number;
    getPage: (index: number) => Promise<PdfPage>;
  };
  type PdfLoadingTask = {
    promise: Promise<PdfDocument>;
    destroy: () => Promise<void>;
  };
  type PdfLib = {
    getDocument: (options: Record<string, unknown>) => PdfLoadingTask;
  };
  // The worker module runs on this thread ("fake worker"): pdf.js picks it up
  // from `globalThis.pdfjsWorker` and never constructs a Worker or fetches a URL.
  (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = await import(
    moduleUrl(input.worker)
  );
  const pdfjs = (await import(moduleUrl(input.library))) as PdfLib;
  const binary = atob(input.pdfBase64);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  let pdfDocument: PdfDocument;
  const task = pdfjs.getDocument({
    data,
    // No eval-compiled fonts or functions (a no-op in pdf.js 6, which removed them).
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableHWA: false,
    stopAtErrors: false,
    maxImageSize: input.maxImagePixels,
    verbosity: 0,
  });
  try {
    pdfDocument = await task.promise;
  } catch (error) {
    await Promise.resolve(task.destroy()).catch(() => undefined);
    const name = (error as { name?: string }).name ?? "";
    return {
      ok: false as const,
      reason: name === "PasswordException" ? ("encrypted" as const) : ("invalid-pdf" as const),
    };
  }
  try {
    const pages = pdfDocument.numPages;
    if (pages > input.maxPages) return { ok: false as const, reason: "page-limit" as const, pages };
    const page = await pdfDocument.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(
      2,
      input.maxDimension / Math.max(1, natural.width),
      input.maxDimension / Math.max(1, natural.height),
    );
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(input.maxDimension, Math.floor(viewport.width)));
    canvas.height = Math.max(1, Math.min(input.maxDimension, Math.floor(viewport.height)));
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) return { ok: false as const, reason: "invalid-pdf" as const, pages };
    canvasContext.fillStyle = "#ffffff";
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    // Canvas only: no annotation or form layer (no HTML from the PDF).
    await page.render({ canvas, canvasContext, viewport, annotationMode: 1 }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    return {
      ok: true as const,
      pages,
      width: canvas.width,
      height: canvas.height,
      pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    };
  } finally {
    await Promise.resolve(task.destroy()).catch(() => undefined);
  }
}

export async function runPdfThumbnail(
  browser: Browser,
  job: ThumbnailJob,
  result: WorkerResult,
  remaining: () => number,
  emit: Emit,
): Promise<void> {
  const decodedBytes = Math.floor((job.pdfBase64.length * 3) / 4);
  if (decodedBytes > PDF_POLICY.maxBytes + 3)
    throw new JobFailure("package_size_exceeded", "The PDF exceeds its preview limit", "pdf-bytes");
  const maxDimension = Math.max(
    64,
    Math.min(
      job.maxDimension,
      PDF_POLICY.thumbnailMaxDimension,
      PREVIEW_CAPTURE_POLICY.maxDimension,
    ),
  );
  const [library, worker] = await Promise.all([
    loadPinnedBundle(RENDERER_BUNDLES.pdfjs),
    loadPinnedBundle(RENDERER_BUNDLES.pdfjsWorker),
  ]).catch(() => {
    throw new JobFailure(
      "renderer_unavailable",
      "The pinned PDF renderer bundle is unavailable",
      "pdf-bundle",
    );
  });
  const context = await isolatedContext(
    browser,
    { theme: "light", viewport: { width: maxDimension, height: maxDimension } },
    result.blockedRequests,
    async () => false,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(Math.max(1, remaining()));
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
  );
  emit({ t: "phase", phase: "capturing" });
  const decoder = new TextDecoder();
  const output = await deadline(
    page.evaluate(renderFirstPage, {
      library: decoder.decode(library),
      worker: decoder.decode(worker),
      pdfBase64: job.pdfBase64,
      maxDimension,
      maxPages: Math.min(job.maxPages, PDF_POLICY.maxPages),
      maxImagePixels: PDF_POLICY.imageDecodeMaxPixels,
    }),
    Math.max(1, remaining()),
    () => new JobFailure("render_timeout", "Rendering the PDF exceeded its time budget", "pdf"),
  );
  if (!output.ok) {
    result.pdfRefusal = output.reason;
    if ("pages" in output && typeof output.pages === "number") result.pageCount = output.pages;
    result.ok = true;
    return;
  }
  const png = Buffer.from(output.pngBase64, "base64");
  if (png.byteLength > PDF_POLICY.thumbnailMaxPngBytes)
    throw new JobFailure("package_size_exceeded", "The page preview is too large", "thumbnail");
  result.pageCount = output.pages;
  result.captures.push({
    pngBase64: output.pngBase64,
    width: output.width,
    height: output.height,
    label: "initial",
  });
  result.ok = true;
}
