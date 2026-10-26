/**
 * Hidden-document resume cost at a large retained history (real Chrome, not
 * part of any suite).
 *
 *   mise exec -- bun e2e/perf/hidden-resume-perf.ts \
 *     [--runs 3] [--retained-mib 8] [--hidden-seconds 10,60] [--stream timer,network]
 *     [--port 1480]
 *
 * `rich-transcripts-perf.ts` cannot measure this, and nor can any Playwright
 * run, headless or headed: a page with a DevTools session attached stays
 * `visible`, with timers at full rate, when it is covered, minimized or
 * frozen (checked on 2026-10-26 with Chrome 155, also with the background
 * flags removed and focus emulation off). Only an unattached page hides. So
 * this script launches installed Google Chrome itself, with a fresh profile
 * and Chrome's default background behaviour (the Electron window never
 * disables `backgroundThrottling` either). It serves the
 * `/rich-transcript-perf` fixture through a local proxy that injects a small
 * probe into the page, and drives only the browser target over CDP
 * (`Browser.setWindowBounds`) to minimize and restore the window. The probe
 * times itself and reports over HTTP.
 *
 * Per run and hidden duration, while a response streams into the tail (12
 * characters every 50 ms, as in the gate):
 *  - the page opens the fixture with `?retainedMiB=N`, scrolls to the tail and
 *    starts the stream;
 *  - the window is minimized for the hidden duration, then restored;
 *  - the probe records the visibility it saw, stream ticks while hidden, the
 *    time from `visibilitychange` to the next frame, long tasks and long
 *    animation frames in the 3 s after, and the JS heap before and after.
 *
 * Two stream drivers: `timer` is the fixture's own interval, which Chrome
 * throttles while the page is hidden; `network` ticks it from a server-sent
 * event every 50 ms instead (`streamTick`), which a hidden page still receives
 * at full rate, as it would a real backend's updates.
 *
 * A headed Chrome window appears on screen for each run. Output is numbers
 * only; a JSON report is written to
 * output/benchmarks/hidden-resume/<run-id>.json.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startOwnedPreview } from "./preview-server";
import { stopProcessGroup } from "../process-cleanup";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const CHROME =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome";
const STREAM_INTERVAL_MS = 50;
const STREAM_CHARS_PER_TICK = 12;
/** How long after the page shows again its long tasks are counted. */
const SHOWN_WINDOW_MS = 3_000;
/** How long a shown page may take to report before the run records that it did not. */
const SHOWN_REPORT_TIMEOUT_MS = 180_000;

interface Options {
  runs: number;
  retainedMiB: number;
  hiddenSeconds: number[];
  streams: Array<"timer" | "network">;
  basePort: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 3,
    retainedMiB: 8,
    hiddenSeconds: [10, 60],
    streams: ["timer", "network"],
    basePort: 1480,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--runs") options.runs = Number(value());
    else if (arg === "--retained-mib") options.retainedMiB = Number(value());
    else if (arg === "--hidden-seconds") options.hiddenSeconds = value().split(",").map(Number);
    else if (arg === "--stream") {
      options.streams = value()
        .split(",")
        .map((stream) => {
          if (stream !== "timer" && stream !== "network") {
            throw new Error("--stream expects timer, network or both");
          }
          return stream;
        });
    } else if (arg === "--port") options.basePort = Number(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 1) throw new Error("--runs >= 1");
  if (options.hiddenSeconds.some((seconds) => !Number.isFinite(seconds) || seconds < 1)) {
    throw new Error("--hidden-seconds expects seconds, at least 1 each");
  }
  return options;
}

// ---------------------------------------------------------------------------
// The in-page probe, injected ahead of the fixture's own scripts.

interface ProbeReport {
  kind: "ready" | "progress" | "visible" | "shown";
  /** `performance.now()` in the page when the report was made. */
  at?: number;
  ticks?: number;
  visibility?: string;
  sawHidden?: boolean;
  hiddenMs?: number;
  ticksWhileHidden?: number;
  firstFrameMs?: number;
  longTasks?: number[];
  longAnimationFrames?: Array<[number, number]>;
  heapBeforeMiB?: number | null;
  heapAfterMiB?: number | null;
  messages?: number;
  transcriptMiB?: number;
}

const PROBE = `(() => {
  const post = (body) =>
    fetch("/__hidden-probe", { method: "POST", body: JSON.stringify(body), keepalive: true });
  const longTasks = [];
  const loafs = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) loafs.push([e.startTime, e.duration, e.blockingDuration || 0]);
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}
  const heapMiB = () =>
    performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 100) / 100 : null;
  const ticks = () => window.__richPerf.counters().streamTicks;
  let hiddenAt = null;
  let ticksAtHidden = 0;
  let heapBefore = null;
  let sawHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      sawHidden = true;
      hiddenAt = performance.now();
      ticksAtHidden = ticks();
      return;
    }
    if (hiddenAt === null) return;
    const shownAt = performance.now();
    const hiddenMs = shownAt - hiddenAt;
    const ticksWhileHidden = ticks() - ticksAtHidden;
    // Before any frame: tells a page that never reaches one from one that
    // never came back at all.
    post({ kind: "visible", at: Math.round(shownAt), ticks: ticks() });
    requestAnimationFrame(() => {
      const firstFrameMs = performance.now() - shownAt;
      setTimeout(() => {
        const end = shownAt + ${SHOWN_WINDOW_MS};
        post({
          kind: "shown",
          visibility: document.visibilityState,
          sawHidden,
          hiddenMs: Math.round(hiddenMs),
          ticksWhileHidden,
          firstFrameMs: Math.round(firstFrameMs * 100) / 100,
          longTasks: longTasks.filter(([s]) => s >= shownAt && s <= end).map(([, d]) => d),
          longAnimationFrames: loafs
            .filter(([s]) => s >= shownAt && s <= end)
            .map(([, d, b]) => [d, b]),
          heapBeforeMiB: heapBefore,
          heapAfterMiB: heapMiB(),
        });
      }, ${SHOWN_WINDOW_MS});
    });
  });
  const start = () => {
    if (!window.__richPerf || window.__richPerf.ready !== true || !document.querySelector("[data-item-index]")) {
      setTimeout(start, 100);
      return;
    }
    window.__richPerf.scrollToBottom();
    if (new URLSearchParams(location.search).get("stream") === "network") {
      window.__richPerf.startStream(0, ${STREAM_CHARS_PER_TICK});
      let received = 0;
      new EventSource("/__hidden-stream").onmessage = () => {
        window.__richPerf.streamTick();
        // Network events still run while hidden, so they can report progress.
        if (++received % 400 === 0) {
          post({ kind: "progress", at: Math.round(performance.now()), ticks: ticks(), visibility: document.visibilityState });
        }
      };
    } else {
      window.__richPerf.startStream(${STREAM_INTERVAL_MS}, ${STREAM_CHARS_PER_TICK});
    }
    // Let the opening settle before the window is hidden.
    setTimeout(() => {
      heapBefore = heapMiB();
      const stats = window.__richPerf.stats();
      post({
        kind: "ready",
        visibility: document.visibilityState,
        messages: window.__richPerf.messageCount(),
        transcriptMiB: Math.round((stats.transcriptBytes / 1048576) * 100) / 100,
      });
    }, 3000);
  };
  start();
})();`;

// ---------------------------------------------------------------------------
// Fixture build, proxy and browser.

function build(workDir: string): { webDir: string; outDir: string; vite: string } {
  const webDir = path.join(repositoryRoot, "apps/web");
  const outDir = path.join(workDir, "dist");
  const vite = path.join(webDir, "node_modules/vite/bin/vite.js");
  const result = spawnSync(
    process.execPath,
    [
      vite,
      "build",
      "../../e2e/fixture",
      "--config",
      "vite.config.ts",
      "--outDir",
      outDir,
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    { cwd: webDir, encoding: "utf8" },
  );
  if (result.status !== 0) {
    writeFileSync(path.join(workDir, "build.log"), `${result.stdout}\n${result.stderr}`);
    throw new Error(`Fixture build failed; log: ${path.join(workDir, "build.log")}`);
  }
  return { webDir, outDir, vite };
}

/** Forwards to the preview server and injects the probe into HTML documents. */
function startProxy(port: number, upstream: string, onReport: (report: ProbeReport) => void) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__hidden-probe") {
        onReport((await request.json()) as ProbeReport);
        return new Response("ok");
      }
      if (url.pathname === "/__hidden-stream") {
        let timer: ReturnType<typeof setInterval> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const tick = new TextEncoder().encode("data: t\n\n");
            timer = setInterval(() => {
              try {
                controller.enqueue(tick);
              } catch {
                clearInterval(timer);
              }
            }, STREAM_INTERVAL_MS);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        request.signal.addEventListener("abort", () => clearInterval(timer));
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        });
      }
      const response = await fetch(`${upstream}${url.pathname}${url.search}`);
      // `fetch` has already decoded the body, so its encoding headers no
      // longer describe it.
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      if (!(headers.get("content-type") ?? "").includes("text/html")) {
        return new Response(response.body, { status: response.status, headers });
      }
      const html = await response.text();
      return new Response(html.replace("<head>", `<head><script>${PROBE}</script>`), {
        status: response.status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
}

export class BrowserTarget {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { reply: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private disconnected: Error | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly commandTimeoutMs = 10_000,
  ) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof message.id === "number") this.pending.get(message.id)?.reply(message);
    };
    socket.onclose = () => this.disconnect(new Error("Chrome CDP socket closed"));
    socket.onerror = () => this.disconnect(new Error("Chrome CDP socket error"));
  }

  private disconnect(error: Error): void {
    this.disconnected ??= error;
    for (const request of Array.from(this.pending.values())) request.reject(error);
  }

  static async connect(debugPort: number): Promise<BrowserTarget> {
    const version = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    return new BrowserTarget(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.disconnected) return Promise.reject(this.disconnected);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const fail = (error: Error) => {
        finish();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error(`${method}: CDP command timed out after ${this.commandTimeoutMs} ms`)),
        this.commandTimeoutMs,
      );
      this.pending.set(id, {
        reject: fail,
        reply: (message) => {
          finish();
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
          else resolve((message.result ?? {}) as Record<string, unknown>);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.disconnect(new Error("Chrome CDP connection closed"));
    this.socket.close();
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  return undefined;
}

async function measure(
  options: Options,
  proxyUrl: string,
  debugPort: number,
  hiddenSeconds: number,
  stream: "timer" | "network",
  reports: ProbeReport[],
) {
  reports.length = 0;
  const profile = mkdtempSync(path.join(tmpdir(), "hidden-resume-chrome-"));
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      `${proxyUrl}/rich-transcript-perf?retainedMiB=${options.retainedMiB}&stream=${stream}`,
    ],
    { stdio: "ignore", detached: true },
  );
  let browser: BrowserTarget | undefined;
  try {
    const ready = await waitFor(() => reports.find((report) => report.kind === "ready"), 120_000);
    if (!ready) throw new Error("Timed out waiting for the fixture to open");
    browser = await BrowserTarget.connect(debugPort);
    const { targetInfos } = (await browser.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const page = targetInfos.find(
      (target) => target.type === "page" && target.url.includes("/rich-transcript-perf"),
    );
    if (!page) throw new Error("fixture page target not found");
    const { windowId } = (await browser.send("Browser.getWindowForTarget", {
      targetId: page.targetId,
    })) as { windowId: number };
    await browser.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await Bun.sleep(hiddenSeconds * 1000);
    await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    const restoredAt = Date.now();
    // A page still busy catching up reports late, or not at all: that is a
    // result, not a harness failure, so the run keeps what the page did send.
    const shown = await waitFor(
      () => reports.find((report) => report.kind === "shown"),
      SHOWN_REPORT_TIMEOUT_MS,
    );
    const trail = reports.filter((report) => report.kind !== "ready" && report.kind !== "shown");
    return {
      ready,
      // A `visible` report is only sent after the page saw `hidden`.
      sawHidden:
        shown?.sawHidden === true ||
        trail.some((report) => report.kind === "visible" || report.visibility === "hidden"),
      shown: shown ?? null,
      shownReported: shown !== undefined,
      shownReportAfterRestoreMs: shown ? Date.now() - restoredAt : null,
      trail,
    };
  } finally {
    browser?.close();
    await stopProcessGroup(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main.

type Measurement = Awaited<ReturnType<typeof measure>>;

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function median(values: Array<number | null | undefined>): number | null {
  const sorted = finite(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)]! + sorted[Math.ceil(middle)]!) / 2;
}

function maximum(values: Array<number | null | undefined>): number | null {
  const samples = finite(values);
  return samples.length > 0 ? Math.max(...samples) : null;
}

export function summarizeRuns(runs: Measurement[]) {
  // A missing report is an incomplete run, never a zero-cost observation.
  const completed = runs.filter((run) => run.shownReported && run.shown !== null);
  const shown = completed.map((run) => run.shown!);
  return {
    allHidden: runs.every((run) => run.sawHidden),
    allReported: completed.length === runs.length,
    reportedRuns: completed.length,
    unreportedRuns: runs.length - completed.length,
    maxShownReportAfterRestoreMs: maximum(completed.map((run) => run.shownReportAfterRestoreMs)),
    medianTicksWhileHidden: median(shown.map((report) => report.ticksWhileHidden)),
    medianFirstFrameMs: median(shown.map((report) => report.firstFrameMs)),
    medianShownLongTaskMs: median(
      shown.map((report) => report.longTasks?.reduce((sum, value) => sum + value, 0)),
    ),
    maxShownLongTaskMs: maximum(
      shown.map((report) => (report.longTasks ? Math.max(0, ...report.longTasks) : null)),
    ),
    medianShownLoafBlockingMs: median(
      shown.map((report) =>
        report.longAnimationFrames?.reduce((sum, [, blocking]) => sum + blocking, 0),
      ),
    ),
    medianHeapBeforeMiB: median(shown.map((report) => report.heapBeforeMiB)),
    medianHeapAfterMiB: median(shown.map((report) => report.heapAfterMiB)),
    transcriptMiB: runs[0]?.ready.transcriptMiB,
    messages: runs[0]?.ready.messages,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (process.platform === "darwin" && !existsSync(CHROME)) {
    throw new Error(`Google Chrome is not installed at ${CHROME}`);
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "hidden-resume-perf-"));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(repositoryRoot, "output/benchmarks/hidden-resume");
  mkdirSync(outputDir, { recursive: true });
  const reports: ProbeReport[] = [];
  let preview: Awaited<ReturnType<typeof startOwnedPreview>> | undefined;
  let proxy: ReturnType<typeof startProxy> | undefined;
  try {
    console.log("[hidden] building the fixture");
    const { webDir, outDir, vite } = build(workDir);
    preview = await startOwnedPreview({
      command: [
        process.execPath,
        vite,
        "preview",
        "../../e2e/fixture",
        "--config",
        "vite.config.ts",
        "--outDir",
        outDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(options.basePort),
        "--strictPort",
      ],
      cwd: webDir,
      outDir,
      port: options.basePort,
    });
    proxy = startProxy(options.basePort + 1, preview.url, (report) => reports.push(report));
    const proxyUrl = `http://127.0.0.1:${options.basePort + 1}`;
    const results: Record<string, Array<Awaited<ReturnType<typeof measure>>>> = {};
    for (let run = 1; run <= options.runs; run++) {
      for (const stream of options.streams) {
        for (const hiddenSeconds of options.hiddenSeconds) {
          const result = await measure(
            options,
            proxyUrl,
            options.basePort + 2,
            hiddenSeconds,
            stream,
            reports,
          );
          (results[`${stream}-${hiddenSeconds}s`] ??= []).push(result);
          console.log(
            `[hidden] run ${run} ${stream} ${hiddenSeconds}s: shown report ${result.shownReported ? `after ${result.shownReportAfterRestoreMs} ms` : "never arrived"}, hidden ${result.sawHidden}, ticks while hidden ${result.shown?.ticksWhileHidden}, first frame ${result.shown?.firstFrameMs} ms, long tasks ${result.shown?.longTasks?.length ?? 0} (${(result.shown?.longTasks ?? []).reduce((sum, value) => sum + value, 0)} ms)`,
          );
        }
      }
    }
    const summary = Object.fromEntries(
      Object.entries(results).map(([key, runs]) => [key, summarizeRuns(runs)]),
    );
    const chromeVersion = spawnSync(CHROME, ["--version"], { encoding: "utf8" }).stdout.trim();
    const report = {
      runId,
      chromeVersion,
      environment: { platform: process.platform, arch: process.arch },
      options,
      stream: { intervalMs: STREAM_INTERVAL_MS, charsPerTick: STREAM_CHARS_PER_TICK },
      summary,
      results,
    };
    const reportFile = path.join(outputDir, `${runId}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[hidden] ${chromeVersion}`);
    console.log(`[hidden] summary ${JSON.stringify(summary)}`);
    console.log(`[hidden] report ${path.relative(repositoryRoot, reportFile)}`);
    if (Object.values(summary).some((entry) => !entry.allHidden)) {
      console.error("[hidden] the page never reported hidden; this run measured nothing");
      process.exitCode = 1;
    }
  } finally {
    await proxy?.stop(true);
    if (preview) await stopProcessGroup(preview.process);
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
