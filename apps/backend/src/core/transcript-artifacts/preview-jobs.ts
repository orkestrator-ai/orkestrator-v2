/**
 * Preview job execution. Runs ONLY inside a supervised worker process (a
 * local child process or a container); the backend never imports this into
 * its own event loop. The supervisor outside owns every deadline and kills the
 * whole process tree; the waits here are bounded only so a cooperative failure
 * can report diagnostics first.
 *
 * Isolation inside the worker (defense in depth; container mode adds the OS
 * network boundary):
 * - a fresh owned browser per job via `chromium.launchServer()` with
 *   Chromium's sandbox required (`chromiumSandbox: true`, never --no-sandbox);
 * - launch flags that resolve every host to NOTFOUND, send traffic to a dead
 *   proxy (including loopback), disable non-proxied WebRTC UDP and background
 *   networking;
 * - a fresh context with no storage state, service workers blocked, downloads
 *   off, deterministic viewport/scale/theme and reduced motion;
 * - request interception installed before the page exists: everything is
 *   aborted except the single in-memory document fulfillment, and WebSockets
 *   are closed; popups, dialogs, permissions and navigations are denied.
 */
import { randomUUID } from "node:crypto";

import { chromium, type Browser, type BrowserServer, type Page } from "playwright-core";

import { designBootstrap } from "@orkestrator/protocol/design-runtime";
import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";
import { INTERACTIVE_HTML_POLICY, MERMAID_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactDiagnostic } from "@orkestrator/protocol/transcript-artifacts";

import { RENDERER_BUNDLES, loadPinnedBundle } from "./dependency-manifest.js";
import { runProbes } from "./preview-probes.js";
import {
  JobFailure,
  PREVIEW_DOCUMENT_URL,
  PREVIEW_ORIGIN,
  capture,
  checkProfile,
  deadline,
  increment,
  isolatedContext,
  readinessListener,
  settleAssets,
} from "./preview-worker-browser.js";
import { runHtmlPrint, runPdfThumbnail } from "./preview-worker-print.js";
import type { WorkerEvent, WorkerJobPackage, WorkerResult } from "./preview-worker-protocol.js";

export { PREVIEW_DOCUMENT_URL } from "./preview-worker-browser.js";

export const NETWORK_DENIAL_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-pings",
  "--dns-prefetch-disable",
  "--disable-features=NetworkPrediction,InterestFeedContentSuggestions,OptimizationHints,MediaRouter,DialMediaRouteProvider",
  "--metrics-recording-only",
  "--no-first-run",
  "--disable-default-apps",
  "--mute-audio",
];

/** Port 9 is "discard"; nothing should listen on it, and the proxy fails closed. */
export const DEAD_PROXY = { server: "http://127.0.0.1:9", bypass: "<-loopback>" };

type Emit = (event: WorkerEvent) => void;

function emptyResult(kind: WorkerResult["kind"], browserBuild: string): WorkerResult {
  return { ok: false, kind, browserBuild, diagnostics: [], blockedRequests: {}, captures: [] };
}

async function elementCount(page: Page, timeoutMs: number): Promise<number> {
  return deadline(
    page.evaluate(() => document.getElementsByTagName("*").length),
    timeoutMs,
    () => new JobFailure("render_timeout", "The page stopped responding"),
  );
}

interface LaunchedBrowser {
  server: BrowserServer;
  browser: Browser;
  build: string;
}

async function launch(pkg: WorkerJobPackage, emit: Emit): Promise<LaunchedBrowser> {
  let server: BrowserServer;
  try {
    server = await chromium.launchServer({
      headless: true,
      // Required. A sandbox failure is a capability failure, never a reason to drop it.
      chromiumSandbox: true,
      ...(pkg.executablePath ? { executablePath: pkg.executablePath } : {}),
      args: NETWORK_DENIAL_ARGS,
      proxy: DEAD_PROXY,
      timeout: Math.max(1_000, Math.min(15_000, pkg.limits.workerWallMs)),
      handleSIGINT: false,
      handleSIGTERM: true,
      handleSIGHUP: false,
      // Loopback only: the worker connects to its own server.
      host: "127.0.0.1",
    });
  } catch {
    throw new JobFailure(
      "renderer_unavailable",
      "Chromium could not start with its sandbox enabled in the preview worker",
      "browser-launch",
    );
  }
  const pid = server.process()?.pid ?? null;
  const browser = await chromium.connect(server.wsEndpoint(), { timeout: 10_000 });
  const build = `chromium/${browser.version()}`;
  emit({ t: "launched", browserPid: pid, browserBuild: build });
  return { server, browser, build };
}

async function closeQuietly(launched: LaunchedBrowser | undefined): Promise<void> {
  if (!launched) return;
  await deadline(launched.browser.close(), 1_000, () => new Error("close")).catch(() => undefined);
  // BrowserServer.kill() terminates the browser process and waits for it.
  await deadline(launched.server.kill(), 1_000, () => new Error("kill")).catch(() => undefined);
}

export async function runWorkerJob(pkg: WorkerJobPackage, emit: Emit): Promise<WorkerResult> {
  const { job } = pkg;
  const started = Date.now();
  const remaining = () => Math.max(1, pkg.limits.workerWallMs - (Date.now() - started) - 500);
  let launched: LaunchedBrowser | undefined;
  const result = emptyResult(job.kind, "unknown");
  try {
    launched = await launch(pkg, emit);
    result.browserBuild = launched.build;
    switch (job.kind) {
      case "probe":
        result.ok = true;
        return result;
      case "html-static":
        await runStatic(launched.browser, job, result, remaining);
        return result;
      case "html-interactive":
        await runInteractive(launched.browser, job, pkg, result, remaining, emit);
        return result;
      case "mermaid":
        await runMermaid(launched.browser, job, pkg, result, emit);
        return result;
      case "html-print":
        await runHtmlPrint(launched.browser, job, pkg, result, remaining, emit);
        return result;
      case "pdf-thumbnail":
        await runPdfThumbnail(launched.browser, job, result, remaining, emit);
        return result;
    }
  } catch (error) {
    result.ok = false;
    if (error instanceof JobFailure) {
      result.failure = {
        code: error.code,
        message: error.message,
        ...(error.resource ? { resource: error.resource } : {}),
      };
    } else if (error instanceof Error && error.name === "TimeoutError") {
      // A driver wait (screenshot, evaluation) that ran out: the page stopped responding.
      result.failure = {
        code: "render_timeout",
        message: "The page stopped responding within its time budget",
        resource: "runtime",
      };
    } else {
      result.failure = {
        code: "renderer_unavailable",
        message: "The preview worker failed unexpectedly",
      };
    }
    return result;
  } finally {
    await closeQuietly(launched);
  }
}

async function runStatic(
  browser: Browser,
  job: Extract<WorkerJobPackage["job"], { kind: "html-static" }>,
  result: WorkerResult,
  remaining: () => number,
): Promise<void> {
  checkProfile(job.profile);
  const context = await isolatedContext(
    browser,
    job.profile,
    result.blockedRequests,
    async () => false,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(remaining());
  // Exactly the design renderer's static path: only the nonce-bearing bootstrap runs.
  await page.setContent(designBootstrap(randomUUID()), { waitUntil: "load" });
  const outcome = (await page.evaluate(async (html) => {
    const run = (window as unknown as { orkDesign: (input: unknown) => unknown }).orkDesign;
    try {
      const report = run({ op: "validate", html }) as {
        elementCount: number;
        removed: {
          scripts: number;
          handlers: number;
          externalReferences: number;
          forbiddenElements: number;
          executableUrls: number;
        };
        overElementLimit: boolean;
      };
      run({ op: "render", html });
      return { ok: true as const, report };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : "Runtime failed",
      };
    }
  }, job.html)) as
    | {
        ok: true;
        report: {
          elementCount: number;
          removed: NonNullable<WorkerResult["sanitizer"]>;
          overElementLimit: boolean;
        };
      }
    | { ok: false; message: string };
  if (!outcome.ok) {
    result.diagnostics.push({
      severity: "error",
      code: "static_render_failed",
      message: outcome.message.slice(0, 300),
    });
    throw new JobFailure("validation_failed", outcome.message.slice(0, 300));
  }
  await page.evaluate(settleAssets, Math.min(5_000, Math.floor(remaining() / 3)));
  result.captures.push(await capture(page, job.profile, "initial", remaining()));
  result.effectiveHtml = (await page.evaluate(() =>
    (window as unknown as { orkDesign: (input: unknown) => unknown }).orkDesign({
      op: "serialize",
    }),
  )) as string;
  result.sanitizer = outcome.report.removed;
  result.elementCount = outcome.report.elementCount;
  result.ok = true;
}

/**
 * A crashed renderer (typically the container's cgroup memory limit killing
 * it, or Chromium's own allocation limits) is reported as such, not as a
 * generic worker failure or a readiness timeout.
 */
async function runInteractive(
  browser: Browser,
  job: Extract<WorkerJobPackage["job"], { kind: "html-interactive" }>,
  pkg: WorkerJobPackage,
  result: WorkerResult,
  remaining: () => number,
  emit: Emit,
): Promise<void> {
  const state = { crashed: false };
  try {
    await runInteractivePage(browser, job, pkg, result, remaining, emit, state);
  } catch (error) {
    if (!state.crashed) throw error;
    result.diagnostics.push({
      severity: "error",
      code: "renderer_crashed",
      message:
        "The page's renderer process crashed, usually because the document exhausted its memory limit",
    });
    throw new JobFailure(
      "validation_failed",
      "The document crashed its renderer (memory or resource limit)",
      "renderer-crash",
    );
  }
}

async function runInteractivePage(
  browser: Browser,
  job: Extract<WorkerJobPackage["job"], { kind: "html-interactive" }>,
  pkg: WorkerJobPackage,
  result: WorkerResult,
  remaining: () => number,
  emit: Emit,
  state: { crashed: boolean },
): Promise<void> {
  checkProfile(job.profile);
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
            "content-security-policy": job.contentSecurityPolicy,
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
          body: job.preparedDocument,
        });
        return true;
      }
      // The browser's own favicon probe is not an artifact request.
      if (request.url() === `${PREVIEW_ORIGIN}/favicon.ico`) {
        await route.abort("blockedbyclient").catch(() => undefined);
        return true;
      }
      return false;
    },
  );
  let runtimeErrors = 0;
  let consoleErrors = 0;
  let unexpectedNavigations = 0;
  await context.addInitScript(readinessListener, job.readinessNonce ?? null);
  const page = await context.newPage();
  mainPage = page;
  page.on("crash", () => {
    state.crashed = true;
  });
  page.on("pageerror", () => runtimeErrors++);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Counted, never logged: console text is artifact content.
    if (/content security policy/i.test(message.text())) increment(result.blockedRequests, "csp");
    else consoleErrors++;
  });
  page.on("popup", (popup) => {
    increment(result.blockedRequests, "popup");
    popup.close().catch(() => undefined);
  });
  let loaded = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && loaded) unexpectedNavigations++;
  });

  emit({ t: "phase", phase: "navigating" });
  const readinessDeadline = Date.now() + pkg.limits.readinessMs;
  try {
    await page.goto(PREVIEW_DOCUMENT_URL, { waitUntil: "load", timeout: pkg.limits.readinessMs });
    loaded = true;
    await page.waitForFunction(
      () => (window as unknown as { __orkPreviewReady?: boolean }).__orkPreviewReady === true,
      undefined,
      { timeout: Math.max(1, readinessDeadline - Date.now()), polling: 50 },
    );
  } catch (error) {
    if (state.crashed) throw error;
    result.diagnostics.push({
      severity: "error",
      code: "readiness_timeout",
      message: `The document did not load and report readiness within ${pkg.limits.readinessMs} ms`,
    });
    throw new JobFailure(
      "render_timeout",
      "The interactive document did not become ready in time",
      "readiness",
    );
  }
  emit({ t: "phase", phase: "ready" });

  // Presentation theme, exactly as a viewer host would send it.
  if (job.identity) {
    await deadline(
      page.evaluate((message) => window.postMessage(message, "*"), {
        channel: ARTIFACT_FRAME_CHANNEL,
        v: 1,
        type: "theme",
        artifactId: job.identity.artifactId,
        revision: job.identity.revision,
        generation: "preview",
        appearance: job.profile.theme,
        reducedMotion: true,
        viewport: { width: job.profile.viewport.width, height: job.profile.viewport.height },
        tokens: {},
      }),
      2_000,
      () => new JobFailure("render_timeout", "The page stopped responding", "runtime"),
    );
  }
  await deadline(
    page.evaluate(settleAssets, 1_000),
    3_000,
    () => new JobFailure("render_timeout", "The page stopped responding", "runtime"),
  );

  const checkDom = async (when: string) => {
    const count = await elementCount(page, Math.min(2_000, remaining()));
    result.elementCount = Math.max(result.elementCount ?? 0, count);
    if (count > INTERACTIVE_HTML_POLICY.maxRuntimeElements) {
      result.diagnostics.push({
        severity: "error",
        code: "dom_limit",
        message: `The document grew to ${count} elements ${when}; at most ${INTERACTIVE_HTML_POLICY.maxRuntimeElements} are allowed`,
      });
      throw new JobFailure(
        "validation_failed",
        "The document exceeded its element budget",
        "dom-elements",
      );
    }
  };
  await checkDom("after loading");
  emit({ t: "phase", phase: "capturing" });
  result.captures.push(await capture(page, job.profile, "initial", remaining()));

  let probesPassed = true;
  if (job.probes.length) {
    const outcome = await runProbes(page, job.probes, {
      stepMs: Math.min(pkg.limits.probeStepMs, INTERACTIVE_HTML_POLICY.maxProbeStepMs),
      onStep: () => checkDom("during probes"),
    });
    result.probeResults = outcome.results;
    result.diagnostics.push(...outcome.diagnostics);
    probesPassed = outcome.passed;
    await deadline(
      page.evaluate(settleAssets, 500),
      2_000,
      () => new JobFailure("render_timeout", "The page stopped responding"),
    ).catch(() => undefined);
    if (!probesPassed) {
      // A failed step may mean the page has stopped responding; a hung page
      // must not hold the worker for its whole budget just for a diagnostic.
      await checkDom("after probes");
    }
    result.captures.push(
      await capture(
        page,
        job.profile,
        probesPassed ? "final" : "diagnostic",
        probesPassed ? remaining() : Math.min(3_000, remaining()),
      ),
    );
  }
  await checkDom("after probes");

  result.runtimeErrors = runtimeErrors + consoleErrors;
  if (unexpectedNavigations > 0) increment(result.blockedRequests, "navigation");
  const prohibited = Object.values(result.blockedRequests).reduce((sum, value) => sum + value, 0);
  if (runtimeErrors > 0) {
    result.diagnostics.push({
      severity: "error",
      code: "runtime_error",
      message: `${runtimeErrors} uncaught JavaScript error${runtimeErrors === 1 ? "" : "s"} during the preview`,
    });
  }
  if (prohibited > 0) {
    result.diagnostics.push({
      severity: "error",
      code: "prohibited_resource",
      message: `Blocked ${prohibited} prohibited resource, navigation or dialog attempt${prohibited === 1 ? "" : "s"} (${Object.entries(
        result.blockedRequests,
      )
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ")})`,
    });
  }
  if (!probesPassed)
    throw new JobFailure("validation_failed", "A declared interaction probe failed", "probes");
  if (runtimeErrors > 0)
    throw new JobFailure(
      "validation_failed",
      "The document raised uncaught JavaScript errors",
      "runtime",
    );
  if (prohibited > 0)
    throw new JobFailure(
      "policy_denied",
      "The document attempted prohibited network, navigation or dialog access",
      "network",
    );
  result.ok = true;
}

/** Runs in the page with application-owned Mermaid and DOMPurify bundles. */
async function renderMermaidInPage(input: {
  source: string;
  theme: "light" | "dark";
  maxTextSize: number;
  maxEdges: number;
  maxSvgBytes: number;
  maxSvgElements: number;
  block: boolean;
}) {
  type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    parse: (text: string) => Promise<{ diagramType?: string } | false>;
    render: (id: string, text: string) => Promise<{ svg: string; diagramType?: string }>;
  };
  type Purify = {
    sanitize: (dirty: string, config: Record<string, unknown>) => string;
    addHook: (
      name: string,
      hook: (
        node: Element,
        data: { attrName: string; attrValue: string; keepAttr: boolean },
      ) => void,
    ) => void;
    removed: unknown[];
  };
  const globals = globalThis as unknown as { mermaid: MermaidApi; DOMPurify: Purify };
  const { mermaid, DOMPurify } = globals;
  const secure = [
    "secure",
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "htmlLabels",
    "flowchart",
    "theme",
    "themeCSS",
    "themeVariables",
    "fontFamily",
    "altFontFamily",
    "dompurifyConfig",
    "arrowMarkerAbsolute",
    "deterministicIds",
    "deterministicIDSeed",
    "suppressErrorRendering",
    "legacyMathML",
    "forceLegacyMathML",
    "elk",
    "layout",
    "look",
    "handDrawnSeed",
    "fontSize",
    "markdownAutoWrap",
    "wrap",
  ];
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: input.maxTextSize,
    maxEdges: input.maxEdges,
    secure,
    theme: input.theme === "dark" ? "dark" : "default",
    deterministicIds: true,
    deterministicIDSeed: "orkestrator",
    suppressErrorRendering: true,
    arrowMarkerAbsolute: false,
    logLevel: 5,
  });
  let parsedType: string | undefined;
  try {
    const parsed = await mermaid.parse(input.source);
    parsedType = parsed ? parsed.diagramType : undefined;
  } catch (error) {
    const err = error as {
      message?: string;
      hash?: { line?: number; loc?: { first_line?: number; first_column?: number } };
    };
    // Jison reports the lexer line (0-based) beside the last token's location.
    const line = typeof err.hash?.line === "number" ? err.hash.line + 1 : err.hash?.loc?.first_line;
    const column =
      err.hash?.loc && err.hash.loc.first_line === line ? err.hash.loc.first_column : undefined;
    const message = String(err.message ?? "Syntax error")
      .split("\n")
      .filter(Boolean)
      .slice(0, 4)
      .join(" ")
      .slice(0, 400);
    if (/edge limit exceeded|maximum text size/i.test(message))
      return { ok: false as const, kind: "limit" as const, message };
    return { ok: false as const, kind: "syntax" as const, message, line, column };
  }
  if (input.block) {
    // Test-only: a deliberately blocking renderer proves the external watchdog.
    for (;;) {
      /* spin */
    }
  }
  let rendered: { svg: string; diagramType?: string };
  try {
    rendered = await mermaid.render("ork-mermaid", input.source);
  } catch (error) {
    const message = String((error as { message?: string }).message ?? "Render failed").slice(
      0,
      400,
    );
    return {
      ok: false as const,
      kind: /edge limit/i.test(message) ? ("limit" as const) : ("render" as const),
      message,
    };
  }
  document.querySelectorAll("[id^='dork-mermaid'], #ork-mermaid").forEach((node) => node.remove());
  const countElements = (svg: string) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return doc.getElementsByTagName("*").length;
  };
  const rawBytes = new TextEncoder().encode(rendered.svg).length;
  const rawElements = countElements(rendered.svg);
  const preSanitize = { bytes: rawBytes, elements: rawElements };
  if (rawBytes > input.maxSvgBytes || rawElements > input.maxSvgElements) {
    return {
      ok: false as const,
      kind: "limit" as const,
      message: `Generated SVG is ${rawBytes} bytes with ${rawElements} elements; limits are ${input.maxSvgBytes} bytes and ${input.maxSvgElements} elements`,
      preSanitize,
    };
  }
  // Dedicated SVG profile: no scripts, foreignObject, event attributes or external references.
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue.trim();
    if (name === "href" || name === "xlink:href") {
      if (!value.startsWith("#")) data.keepAttr = false;
      return;
    }
    if (
      /url\s*\(/i.test(value) &&
      !/^url\(\s*['"]?#[^)'"]*['"]?\s*\)$/i.test(value) &&
      name !== "style"
    )
      data.keepAttr = false;
  });
  const clean = DOMPurify.sanitize(rendered.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "script",
      "foreignObject",
      "iframe",
      "image",
      "feImage",
      "use",
      "animate",
      "set",
      "animateMotion",
      "animateTransform",
      "a",
    ],
    FORBID_ATTR: ["target", "ping", "src", "action", "formaction"],
    KEEP_CONTENT: true,
    ALLOW_DATA_ATTR: false,
  });
  const removed = DOMPurify.removed.length;
  const finalBytes = new TextEncoder().encode(clean).length;
  const finalElements = countElements(clean);
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const edges = doc.querySelectorAll(
    ".flowchart-link, .edgePath, .relation, .transition, .messageLine0, .messageLine1, .relationshipLine",
  ).length;
  return {
    ok: true as const,
    svg: clean,
    diagramType: rendered.diagramType ?? parsedType ?? "unknown",
    preSanitize,
    finalBytes,
    finalElements,
    removed,
    edges,
  };
}

async function runMermaid(
  browser: Browser,
  job: Extract<WorkerJobPackage["job"], { kind: "mermaid" }>,
  pkg: WorkerJobPackage,
  result: WorkerResult,
  emit: Emit,
): Promise<void> {
  const sourceBytes = new TextEncoder().encode(job.source).length;
  if (sourceBytes > MERMAID_POLICY.maxSourceBytes) {
    throw new JobFailure(
      "package_size_exceeded",
      `Diagram source is ${sourceBytes} bytes; the limit is ${MERMAID_POLICY.maxSourceBytes}`,
      "source-bytes",
    );
  }
  const [mermaid, purify] = await Promise.all([
    loadPinnedBundle(RENDERER_BUNDLES.mermaid),
    loadPinnedBundle(RENDERER_BUNDLES.dompurify),
  ]).catch(() => {
    throw new JobFailure(
      "renderer_unavailable",
      "The pinned Mermaid renderer bundle is unavailable",
      "mermaid-bundle",
    );
  });
  const context = await isolatedContext(
    browser,
    { theme: job.theme, viewport: { width: 1200, height: 800 } },
    result.blockedRequests,
    async () => false,
  );
  const page = await context.newPage();
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
  );
  await page.addScriptTag({ content: new TextDecoder().decode(purify) });
  await page.addScriptTag({ content: new TextDecoder().decode(mermaid) });
  emit({ t: "phase", phase: "render-start" });
  const output = await deadline(
    page.evaluate(renderMermaidInPage, {
      source: job.source,
      theme: job.theme,
      maxTextSize: MERMAID_POLICY.maxSourceBytes,
      maxEdges: MERMAID_POLICY.maxEdges,
      maxSvgBytes: MERMAID_POLICY.maxSvgBytes,
      maxSvgElements: MERMAID_POLICY.maxSvgElements,
      block: pkg.testing?.blockMermaidRender === true,
    }),
    // Backstop only: the external supervisor kills the worker at exactly
    // mermaidRenderMs after render-start, which a blocked renderer cannot delay.
    pkg.limits.mermaidRenderMs + 2_000,
    () =>
      new JobFailure(
        "render_timeout",
        `Diagram parse/layout exceeded ${pkg.limits.mermaidRenderMs} ms`,
        "mermaid-render",
      ),
  );
  emit({ t: "phase", phase: "render-done" });
  if (!output.ok) {
    if (output.kind === "syntax") {
      const location =
        output.line !== undefined
          ? `line ${output.line}${output.column !== undefined ? `:${output.column + 1}` : ""}`
          : undefined;
      const diagnostic: ArtifactDiagnostic = {
        severity: "error",
        code: "mermaid_syntax",
        message: output.message,
        ...(location ? { location } : {}),
      };
      result.diagnostics.push(diagnostic);
      throw new JobFailure(
        "validation_failed",
        `Mermaid syntax error${location ? ` at ${location}` : ""}: ${output.message}`.slice(0, 450),
      );
    }
    result.diagnostics.push({
      severity: "error",
      code: output.kind === "limit" ? "mermaid_limit" : "mermaid_render",
      message: output.message,
    });
    if ("preSanitize" in output && output.preSanitize) result.preSanitize = output.preSanitize;
    const resource =
      output.kind !== "limit"
        ? undefined
        : /edge limit/i.test(output.message)
          ? "edges"
          : /text size/i.test(output.message)
            ? "source-bytes"
            : "svg";
    throw new JobFailure(
      output.kind === "limit" ? "package_size_exceeded" : "validation_failed",
      output.message,
      resource,
    );
  }
  if (output.removed > 0) {
    result.diagnostics.push({
      severity: "info",
      code: "mermaid_sanitized",
      message: `The SVG sanitizer removed ${output.removed} node(s) or attribute(s)`,
    });
  }
  result.svg = output.svg;
  result.diagramType = output.diagramType;
  result.preSanitize = output.preSanitize;
  result.svgElements = output.finalElements;
  result.edges = output.edges;
  result.ok = true;
}
