/**
 * Browser-side building blocks shared by the preview worker's jobs (see
 * preview-jobs.ts and preview-worker-print.ts). Runs ONLY inside a
 * supervised worker process or container, never in the backend event loop.
 */
import type { Browser, BrowserContext, Page, Route } from "playwright-core";

import { PREVIEW_CAPTURE_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactPreviewProfile } from "@orkestrator/protocol/transcript-artifacts";

import type { WorkerCapture, WorkerResult } from "./preview-worker-protocol.js";

/** The only URL a preview page may load; `.invalid` never resolves. */
export const PREVIEW_DOCUMENT_URL = "https://artifact-preview.invalid/document";
export const PREVIEW_ORIGIN = "https://artifact-preview.invalid";

export class JobFailure extends Error {
  constructor(
    readonly code: NonNullable<WorkerResult["failure"]>["code"],
    message: string,
    readonly resource?: string,
  ) {
    super(message);
  }
}

export function deadline<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), Math.max(1, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function checkProfile(profile: ArtifactPreviewProfile): void {
  const { width, height } = profile.viewport;
  const p = PREVIEW_CAPTURE_POLICY;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < p.minDimension ||
    height < p.minDimension ||
    width > p.maxDimension ||
    height > p.maxDimension ||
    width * height > p.maxPixels
  ) {
    throw new JobFailure(
      "invalid_input",
      "Preview viewport is outside the capture limits",
      "viewport",
    );
  }
}

export async function capture(
  page: Page,
  profile: ArtifactPreviewProfile,
  label: WorkerCapture["label"],
  timeoutMs: number,
): Promise<WorkerCapture> {
  // Viewport-only capture: never an unbounded full-page allocation.
  const png = await page.screenshot({
    type: "png",
    animations: "disabled",
    timeout: Math.max(1, timeoutMs),
    fullPage: false,
  });
  if (png.byteLength > PREVIEW_CAPTURE_POLICY.maxPngBytes) {
    throw new JobFailure(
      "package_size_exceeded",
      `Capture is ${png.byteLength} bytes; the limit is ${PREVIEW_CAPTURE_POLICY.maxPngBytes}`,
      "capture-bytes",
    );
  }
  return {
    pngBase64: png.toString("base64"),
    width: profile.viewport.width,
    height: profile.viewport.height,
    label,
  };
}

/** Runs in the page: settle fonts and images, bounded so capture cannot hang. */
export async function settleAssets(maxMs: number): Promise<void> {
  const images = Array.from(document.images).map((image) =>
    image.complete ? undefined : image.decode().catch(() => undefined),
  );
  await Promise.race([
    Promise.all([document.fonts?.ready, ...images]).then(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    ),
    new Promise((resolve) => setTimeout(resolve, maxMs)),
  ]);
}

export async function isolatedContext(
  browser: Browser,
  profile: { theme: "light" | "dark"; viewport: { width: number; height: number } },
  blocked: Record<string, number>,
  allow: (route: Route) => Promise<boolean>,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
    deviceScaleFactor: 1,
    colorScheme: profile.theme,
    reducedMotion: "reduce",
    forcedColors: "none",
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
    locale: "en-US",
    timezoneId: "UTC",
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
  });
  // Interception is installed before any page exists.
  await context.route("**/*", async (route) => {
    if (await allow(route)) return;
    const request = route.request();
    if (request.isNavigationRequest()) {
      increment(blocked, "navigation");
      // A 204 answer cancels the navigation without committing an error page,
      // so the document under test stays in place (and stays observable).
      await route.fulfill({ status: 204, body: "" }).catch(() => undefined);
      return;
    }
    increment(blocked, request.resourceType());
    await route.abort("blockedbyclient").catch(() => undefined);
  });
  await context.routeWebSocket(/.*/, (socket) => {
    increment(blocked, "websocket");
    socket.close({ code: 1008, reason: "blocked" }).catch(() => undefined);
  });
  context.on("page", (page) => {
    page.on("dialog", (dialog) => {
      increment(blocked, "dialog");
      dialog.dismiss().catch(() => undefined);
    });
  });
  return context;
}

/** Init script: records the runtime's ready message (a presentation signal only). */
export function readinessListener(expectedNonce: string | null) {
  const channel = "orkestrator-artifact";
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { channel?: unknown; type?: unknown; nonce?: unknown } | null;
    if (!data || data.channel !== channel || data.type !== "ready") return;
    if (expectedNonce !== null && data.nonce !== expectedNonce) return;
    (window as unknown as { __orkPreviewReady?: boolean }).__orkPreviewReady = true;
  });
}
