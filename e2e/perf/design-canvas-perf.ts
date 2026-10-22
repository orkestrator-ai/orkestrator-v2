/**
 * Design-canvas client performance (real browser, not part of any suite).
 *
 *   mise exec -- bun e2e/perf/design-canvas-perf.ts \
 *     [--runs 3] [--samples 20] [--moves 3] [--html-samples 5] [--cycles 12] \
 *     [--library-samples 5] [--frames 1,16,64] [--library 1,50,256] \
 *     [--skip-canvas] [--skip-library] [--port 1470] [--headed] [--no-minify] \
 *     [--dist output/tmp/design-canvas-perf-dist] [--rev HEAD]
 *
 * The `e2e/fixture` app is built with `apps/web`'s Vite config (production
 * React) into a temporary directory (or `--dist`, which is reused when it
 * already holds a build: delete it after changing web code) and served by
 * `vite preview`. `--rev` builds the web code of a committed revision instead of
 * the working tree (`git archive` of `apps/web`, `e2e` and `packages`, with
 * this checkout's node_modules linked in and this harness's own fixture files,
 * `DesignLibraryPerfFixture.tsx` and `main.tsx`, laid over it), so uncommitted
 * product edits in the checkout cannot leak into the measurement. Modules
 * resolved through node_modules (`@orkestrator/protocol`) still come from this
 * checkout; the report records whether those paths were clean. Each run
 * launches a fresh installed Google Chrome (`channel: "chrome"`, headless).
 * Every backend command goes through `page.exposeFunction("designInvoke")` to a
 * real `DesignService` and command registry hosted in a Bun child process
 * (`e2e/design-service-host.ts`), exactly as `e2e/DesignCanvas.spec.ts` does.
 *
 * Canvases are seeded with 1, 16 and 64 synthetic frames (fixture-only HTML of
 * realistic size) and opened at `/design-canvas` (`DesignCanvasFixture.tsx`).
 * Per run and frame count:
 *  - rest: live iframes, frame placeholders, mounted layer rows, DOM nodes,
 *    post-GC JS heap and renderer process RSS at fit-all and at 100%;
 *  - gestures: pointer move during a frame move/resize drag -> next painted
 *    frame whose DOM shows the preview; pointer up -> the backend-acknowledged
 *    state (footer revision advanced and the frame's pending preview cleared)
 *    painted;
 *  - iframe accounting per operation: iframe element inserts/removes and
 *    in-frame `render` operations (counted inside each sandboxed frame) for
 *    geometry-only drags and for agent HTML edits;
 *  - pan: rAF intervals during a scripted wheel pan, live iframe count while
 *    panning and while panned away;
 *  - leak check: N cycles of deactivate/activate (the tab's `isActive`) plus a
 *    cull (pan every frame out of view and back), sampling listeners (CDP
 *    metrics and DOMDebugger), iframes, timers, animation frames and blob URLs.
 *
 * The library (`DesignLibrary` in `DesignWorkspaceDialog`) is opened at
 * `/design-library-perf` (`DesignLibraryPerfFixture.tsx`) against 1, 50 and
 * 256 saved canvases: Saved designs tab press -> first page of rows painted.
 *
 * Output is numbers only (no design content). A JSON report is written to
 * output/benchmarks/design-canvas/<run-id>.json and a summary table to stdout.
 * Single-machine timings are evidence for this host only, not thresholds.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { DESIGN_EVENT } from "../../packages/protocol/src/design-canvas";
import { startDesignServiceHost, type DesignServiceHost } from "../design-service-client";
import { DESIGN_FIXTURE_ENVIRONMENT } from "../design-service-protocol";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const ENV = DESIGN_FIXTURE_ENVIRONMENT;
const VIEWPORT = { width: 1440, height: 900 };

interface Options {
  runs: number;
  samples: number;
  moves: number;
  htmlSamples: number;
  cycles: number;
  librarySamples: number;
  frames: number[];
  library: number[];
  skipCanvas: boolean;
  skipLibrary: boolean;
  port: number;
  headed: boolean;
  minify: boolean;
  dist: string | null;
  rev: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 3,
    samples: 20,
    moves: 3,
    htmlSamples: 5,
    cycles: 12,
    librarySamples: 5,
    frames: [1, 16, 64],
    library: [1, 50, 256],
    skipCanvas: false,
    skipLibrary: false,
    port: 1470,
    headed: false,
    minify: true,
    dist: null,
    rev: null,
  };
  const list = (value: string) =>
    value.split(",").map((entry) => {
      const parsed = Number(entry);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Bad list entry ${entry}`);
      return parsed;
    });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--runs") options.runs = Number(value());
    else if (arg === "--samples") options.samples = Number(value());
    else if (arg === "--moves") options.moves = Number(value());
    else if (arg === "--html-samples") options.htmlSamples = Number(value());
    else if (arg === "--cycles") options.cycles = Number(value());
    else if (arg === "--library-samples") options.librarySamples = Number(value());
    else if (arg === "--frames") options.frames = list(value());
    else if (arg === "--library") options.library = list(value());
    else if (arg === "--skip-canvas") options.skipCanvas = true;
    else if (arg === "--skip-library") options.skipLibrary = true;
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--no-minify") options.minify = false;
    else if (arg === "--dist") options.dist = path.resolve(value());
    else if (arg === "--rev") options.rev = value();
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.frames.some((count) => count > 64)) throw new Error("At most 64 frames per canvas");
  if (options.library.some((count) => count > 256)) throw new Error("At most 256 live canvases");
  return options;
}

// ---------------------------------------------------------------------------
// Fixture server (same build and serve path as rich-transcripts-perf.ts).

function run(command: string[], cwd: string, logFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      writeFileSync(logFile, Buffer.concat(chunks));
      if (code === 0) resolve();
      else reject(new Error(`${command.slice(0, 3).join(" ")} exited ${code}; log: ${logFile}`));
    });
  });
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Fixture server did not start: ${url}`);
}

/** Exports `rev`'s web sources into `workDir/source` (see the header). */
function exportRevision(rev: string, workDir: string): string {
  const root = path.join(workDir, "source");
  mkdirSync(root, { recursive: true });
  const archive = spawnSync(
    "git",
    ["archive", "--format=tar", rev, "apps/web", "e2e", "packages"],
    {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  if (archive.status !== 0) throw new Error(`git archive ${rev} failed`);
  const tar = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout });
  if (tar.status !== 0) throw new Error("tar -x failed");
  for (const file of ["e2e/fixture/DesignLibraryPerfFixture.tsx", "e2e/fixture/main.tsx"])
    copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  for (const file of ["package.json", "tsconfig.json"])
    if (existsSync(path.join(repositoryRoot, file)))
      copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"));
  symlinkSync(
    path.join(repositoryRoot, "apps/web/node_modules"),
    path.join(root, "apps/web/node_modules"),
  );
  return root;
}

async function startServer(
  port: number,
  workDir: string,
  minify: boolean,
  dist: string | null,
  sourceRoot: string,
) {
  const webDir = path.join(sourceRoot, "apps/web");
  const outDir = dist ?? path.join(workDir, "dist");
  const vite = path.join(webDir, "node_modules/vite/bin/vite.js");
  const common = ["../../e2e/fixture", "--config", "vite.config.ts", "--outDir", outDir];
  const reuse = dist !== null && existsSync(path.join(dist, "index.html"));
  if (reuse)
    console.log(`[perf] reusing the fixture build in ${path.relative(repositoryRoot, dist)}`);
  else
    await run(
      [
        process.execPath,
        vite,
        "build",
        ...common,
        "--emptyOutDir",
        "--logLevel",
        "warn",
        ...(minify ? [] : ["--minify", "false"]),
      ],
      webDir,
      path.join(workDir, "build.log"),
    );
  // A fresh process group: stopping the group stops the server without
  // matching processes by name or port.
  const child = spawn(
    process.execPath,
    [vite, "preview", ...common, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: webDir, stdio: "ignore", detached: true },
  );
  const url = `http://127.0.0.1:${port}`;
  await waitForUrl(url, 60_000);
  return { url, process: child as ChildProcess };
}

// ---------------------------------------------------------------------------
// Statistics.

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function summarize(values: number[]) {
  return {
    n: values.length,
    p50: round(quantile(values, 0.5)),
    p95: round(quantile(values, 0.95)),
    max: round(values.length ? Math.max(...values) : Number.NaN),
  };
}

const FRAME_BUDGET_MS = 1000 / 60;

/** rAF interval summary: strict over-budget count and an estimate of skipped vsyncs. */
function frameSummary(intervals: number[]) {
  const over = intervals.filter((value) => value > FRAME_BUDGET_MS + 0.1).length;
  const dropped = sum(
    intervals.map((value) => Math.max(0, Math.round(value / FRAME_BUDGET_MS) - 1)),
  );
  return {
    frames: intervals.length,
    p50Ms: round(quantile(intervals, 0.5)),
    p95Ms: round(quantile(intervals, 0.95)),
    maxMs: round(intervals.length ? Math.max(...intervals) : Number.NaN),
    overBudget: over,
    overBudgetPct: round((100 * over) / Math.max(1, intervals.length), 1),
    droppedFrames: dropped,
    droppedPct: round((100 * dropped) / Math.max(1, intervals.length + dropped), 1),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Synthetic fixture content. Never logged; only sizes are reported.

function frameHtml(seed: number, variant = 0): string {
  const style = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#1f2933;background:#f8fafc}
header{display:flex;align-items:center;justify-content:space-between;padding:16px 40px;background:#fff;border-bottom:1px solid #e4e7eb}
header nav a{margin-left:20px;color:#3e4c59;text-decoration:none;font-size:14px}.logo{font-weight:700;font-size:18px}
.hero{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;padding:64px 40px;background:linear-gradient(135deg,#e0e8f9,#fff)}
.hero h1{font-size:44px;line-height:1.1;margin:0 0 16px}.hero p{font-size:18px;color:#52606d}.art{border-radius:16px;background:linear-gradient(160deg,#4c63b6,#9fb3c8);min-height:260px}
.btn{display:inline-block;padding:12px 20px;border-radius:8px;background:#3a4ed5;color:#fff;margin-right:12px;font-weight:600}.btn.ghost{background:transparent;color:#3a4ed5;border:1px solid #3a4ed5}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:48px 40px}.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card .thumb{height:120px;border-radius:8px;background:#d9e2ec;margin-bottom:12px}.card h3{margin:0 0 8px;font-size:18px}.card p{margin:0;font-size:14px;color:#616e7c}
table{width:calc(100% - 80px);margin:0 40px 48px;border-collapse:collapse;background:#fff}th,td{padding:12px 16px;border-bottom:1px solid #e4e7eb;text-align:left;font-size:14px}th{background:#f0f4f8}
.quote{margin:0 40px 48px;padding:32px;border-left:4px solid #3a4ed5;background:#fff;font-size:18px}
footer{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:40px;background:#1f2933;color:#cbd2d9}footer h4{color:#fff;margin:0 0 12px}footer a{display:block;color:#9aa5b1;font-size:13px;margin-bottom:6px}
.v${variant}{outline:0}`;
  const words =
    "Plan ship review iterate measure deploy observe refine collaborate document automate secure";
  const sentence = (index: number, length: number) =>
    Array.from({ length }, (_, word) => words.split(" ")[(index * 7 + word * 3 + seed) % 12]).join(
      " ",
    );
  const nav = Array.from({ length: 6 }, (_, i) => `<a href="#s${i}">${sentence(i, 1)}</a>`).join(
    "",
  );
  const cards = Array.from(
    { length: 9 },
    (_, i) =>
      `<article class="card"><div class="thumb"></div><h3>${sentence(i, 3)}</h3><p>${sentence(i + 3, 28)}</p><p><a class="btn ghost" href="#c${i}">Learn more</a></p></article>`,
  ).join("");
  const rows = Array.from(
    { length: 10 },
    (_, i) =>
      `<tr><td>${sentence(i, 2)}</td><td>${(i + 1) * 12} seats</td><td>$${(i + 1) * 9}.00</td><td>${sentence(i + 5, 4)}</td></tr>`,
  ).join("");
  const columns = Array.from(
    { length: 4 },
    (_, c) =>
      `<div><h4>${sentence(c, 1)}</h4>${Array.from({ length: 6 }, (_, l) => `<a href="#f${c}${l}">${sentence(c + l, 2)}</a>`).join("")}</div>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body class="v${variant}">
<header><span class="logo">Fixture ${seed}</span><nav>${nav}</nav></header>
<section class="hero"><div><h1 id="title">${sentence(seed, 6)} ${variant}</h1><p>${sentence(seed + 1, 40)}</p><p><a class="btn" href="#start">Get started</a><a class="btn ghost" href="#demo">Book a demo</a></p></div><div class="art"></div></section>
<section class="cards">${cards}</section>
<table><thead><tr><th>Plan</th><th>Capacity</th><th>Price</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
<blockquote class="quote">${sentence(seed + 2, 36)}</blockquote>
<footer>${columns}</footer></body></html>`;
}

const FRAME_WIDTH = 800;
const FRAME_HEIGHT = 600;

function seedDocument(name: string, frameCount: number, seedBase = 0, htmlFor = frameHtml) {
  const columns = Math.ceil(Math.sqrt(frameCount));
  return JSON.stringify({
    format: "orkdes",
    version: 1,
    id: randomUUID(),
    environmentId: ENV,
    name,
    revision: 1,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      id: randomUUID(),
      name: `Frame ${index + 1}`,
      x: (index % columns) * (FRAME_WIDTH + 100),
      y: Math.floor(index / columns) * (FRAME_HEIGHT + 100),
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      html: htmlFor(seedBase + index),
      revision: 1,
    })),
  });
}

// ---------------------------------------------------------------------------
// In-page instrumentation (installed before any page script runs, in every frame).

const INIT_SCRIPT = `(() => {
  if (window !== window.top) {
    // A sandboxed design frame: report each render operation to the parent.
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (event.source === window.parent && data && data.channel === "orkestrator-design" &&
          data.operation && data.operation.op === "render") {
        try { window.parent.postMessage({ channel: "design-perf-render" }, "*"); } catch {}
      }
    }, true);
    return;
  }
  const native = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
  };
  const timeouts = new Set(), intervals = new Set(), rafs = new Set(), blobs = new Set();
  const created = { timeouts: 0, intervals: 0, blobs: 0 };
  window.setTimeout = function (handler, delay, ...rest) {
    if (typeof handler !== "function") return native.setTimeout(handler, delay, ...rest);
    let id = 0;
    id = native.setTimeout(function (...args) { timeouts.delete(id); return handler.apply(this, args); }, delay, ...rest);
    timeouts.add(id); created.timeouts++;
    return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); intervals.delete(id); return native.clearTimeout(id); };
  window.setInterval = function (...args) { const id = native.setInterval(...args); intervals.add(id); created.intervals++; return id; };
  window.clearInterval = function (id) { intervals.delete(id); timeouts.delete(id); return native.clearInterval(id); };
  // True from the first page rAF callback of a frame until a task posted from it
  // runs, i.e. through that frame's rendering update (style, layout, paint).
  let renderingPhase = false;
  const phaseChannel = new MessageChannel();
  phaseChannel.port1.onmessage = () => { renderingPhase = false; };
  window.requestAnimationFrame = function (callback) {
    let id = 0;
    id = native.raf((time) => {
      rafs.delete(id);
      if (!renderingPhase) { renderingPhase = true; phaseChannel.port2.postMessage(0); }
      callback(time);
    });
    rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(id); return native.caf(id); };
  const createObjectURL = URL.createObjectURL.bind(URL), revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (object) { const url = createObjectURL(object); blobs.add(url); created.blobs++; return url; };
  URL.revokeObjectURL = function (url) { blobs.delete(url); return revokeObjectURL(url); };

  // Iframe element inserts/removes and render operations, per design frame id.
  const counts = { iframeAdds: 0, iframeRemoves: 0, renders: 0, unattributedRenders: 0 };
  const perFrame = new Map();
  const bump = (frameId, key) => {
    counts[key]++;
    if (!frameId) { if (key === "renders") counts.unattributedRenders++; return; }
    let entry = perFrame.get(frameId);
    if (!entry) perFrame.set(frameId, (entry = { iframeAdds: 0, iframeRemoves: 0, renders: 0 }));
    entry[key]++;
  };
  const sectionOf = (node) => (node && node.closest ? node.closest("section[data-frame-id]") : null);
  const frameIdOf = (node, fallback) => {
    const section = sectionOf(node) || sectionOf(fallback);
    return section ? section.getAttribute("data-frame-id") : null;
  };
  const iframesIn = (node) =>
    node.nodeType !== 1 ? [] : node.tagName === "IFRAME" ? [node] : Array.from(node.querySelectorAll("iframe"));
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) for (const iframe of iframesIn(node)) bump(frameIdOf(iframe), "iframeAdds");
      for (const node of record.removedNodes)
        for (const iframe of iframesIn(node)) bump(frameIdOf(iframe, record.target), "iframeRemoves");
    }
  }).observe(document, { childList: true, subtree: true });
  window.addEventListener("message", (event) => {
    if (!event.data || event.data.channel !== "design-perf-render") return;
    let frameId = null;
    for (const iframe of document.querySelectorAll("iframe"))
      if (iframe.contentWindow === event.source) { frameId = frameIdOf(iframe); break; }
    bump(frameId, "renders");
  }, true);

  const longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  // One armed latency watcher: start = the triggering input event's timeStamp
  // (or arm time), end = the frame after the DOM satisfied the test has painted
  // (rAF, then a message-channel turn that runs after that frame's paint).
  let watch = null;
  let lastDone = Promise.resolve(null);
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const w = watch;
    if (!w || !w.painted) return;
    watch = null;
    native.clearTimeout(w.timer);
    w.resolve({
      ms: performance.now() - w.start,
      inFrame: w.inFrame,
      domMs: w.domAt - w.start,
      dispatchMs: w.dispatchedAt === null ? 0 : w.dispatchedAt - w.start,
      ...w.extra,
    });
  };
  const check = () => {
    const w = watch;
    if (!w || w.start === null || w.painted) return;
    const extra = w.test();
    if (!extra) return;
    w.painted = true;
    w.domAt = performance.now();
    w.extra = extra;
    w.observer.disconnect();
    // A change made during a frame's rAF phase is painted by that frame: a task
    // posted now runs after it. Otherwise the next frame paints it.
    w.inFrame = renderingPhase;
    if (renderingPhase) channel.port2.postMessage(0);
    else native.raf(() => channel.port2.postMessage(0));
  };
  const arm = (kind, test, timeoutMs, startNow) => {
    if (watch) watch.cancel();
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const w = { kind, test, start: startNow ? performance.now() : null, dispatchedAt: null, domAt: 0, painted: false, extra: null, resolve };
    w.observer = new MutationObserver(check);
    w.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    w.timer = native.setTimeout(() => { if (watch === w) watch = null; w.observer.disconnect(); resolve(null); }, timeoutMs);
    w.cancel = () => { w.observer.disconnect(); native.clearTimeout(w.timer); resolve(null); };
    watch = w;
    lastDone = done;
    if (startNow) check();
  };
  const startOn = (kind) => (event) => {
    if (watch && watch.kind === kind && watch.start === null) {
      watch.start = event.timeStamp;
      watch.dispatchedAt = performance.now();
      native.setTimeout(check, 0);
    }
  };
  window.addEventListener("pointermove", startOn("preview"), true);
  window.addEventListener("pointerup", startOn("ack"), true);
  window.addEventListener("pointerdown", startOn("rows"), true);

  const section = (frameId) => document.querySelector('section[data-frame-id="' + frameId + '"]');
  const main = () => document.querySelector('main[aria-label="Canvas viewport"]');
  const revision = () => {
    const text = document.querySelector('footer [title="Canvas revision"]')?.textContent || "";
    const match = /Revision (\\d+)/.exec(text);
    return match ? Number(match[1]) : -1;
  };
  let frames = null, samples = [], sampler = 0;
  window.__designPerf = {
    revision,
    armPreview(frameId, prop) {
      const initial = section(frameId)?.style[prop];
      arm("preview", () => {
        const value = section(frameId)?.style[prop];
        return value !== undefined && value !== initial ? { value: parseFloat(value) } : null;
      }, 2000, false);
    },
    armAck(frameId, startRevision) {
      let sawPending = false;
      arm("ack", () => {
        const target = section(frameId);
        if (!target) return null;
        if (target.hasAttribute("data-pending")) { sawPending = true; return null; }
        const current = revision();
        if (current <= startRevision) return null;
        return { revision: current, sawPending, left: parseFloat(target.style.left), width: parseFloat(target.style.width) };
      }, 20000, false);
    },
    armRender(frameId, base) {
      arm("render", () => {
        const entry = perFrame.get(frameId);
        const target = section(frameId);
        if (!entry || entry.renders <= base || !target || target.querySelector(".animate-spin")) return null;
        return { renders: entry.renders };
      }, 20000, true);
    },
    armRows(expected) {
      arm("rows", () => {
        const rows = document.querySelectorAll('ul[aria-label="Designs"] > li').length;
        return rows >= expected ? { rows } : null;
      }, 30000, false);
    },
    waitArmed: () => lastDone,
    counters: () => ({ ...counts }),
    frameCounters: (frameId) => ({ iframeAdds: 0, iframeRemoves: 0, renders: 0, ...perFrame.get(frameId) }),
    stats() {
      const viewport = main();
      return {
        frames: document.querySelectorAll("section[data-frame-id]").length,
        offscreen: viewport ? viewport.querySelectorAll('section[aria-label$="(offscreen)"]').length : 0,
        iframes: document.querySelectorAll("iframe").length,
        placeholders: viewport ? viewport.querySelectorAll('section[data-frame-id] > button[aria-label^="Show "]').length : 0,
        loading: viewport ? viewport.querySelectorAll(".animate-spin").length : 0,
        layerRows: document.querySelectorAll('[role="tree"][aria-label="Layers"] [role="treeitem"]').length,
        domNodes: document.getElementsByTagName("*").length,
        timeouts: timeouts.size,
        intervals: intervals.size,
        animationFrames: rafs.size,
        blobUrls: blobs.size,
        created: { ...created },
        ...counts,
      };
    },
    /** The live frame nearest the viewport center, with its drag handles. */
    pickTarget() {
      const viewport = main();
      if (!viewport) return null;
      const bounds = viewport.getBoundingClientRect();
      const cx = bounds.left + bounds.width / 2, cy = bounds.top + bounds.height / 2;
      let best = null;
      for (const candidate of document.querySelectorAll("section[data-frame-id]")) {
        if (!candidate.querySelector("iframe")) continue;
        const rect = candidate.getBoundingClientRect();
        const distance = Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy);
        if (!best || distance < best.distance) best = { element: candidate, rect, distance };
      }
      if (!best) return null;
      const title = best.element.querySelector("button[data-frame-title-id]").getBoundingClientRect();
      const resize = best.element.querySelector(':scope > button[aria-label^="Resize frame"]').getBoundingClientRect();
      return {
        frameId: best.element.getAttribute("data-frame-id"),
        offset: { x: best.rect.left + best.rect.width / 2 - cx, y: best.rect.top + best.rect.height / 2 - cy },
        center: { x: cx, y: cy },
        title: { x: title.left + Math.min(24, title.width / 2), y: title.top + title.height / 2 },
        resize: { x: resize.left + resize.width / 2, y: resize.top + resize.height / 2 },
        inside: best.rect.left >= bounds.left && best.rect.right <= bounds.right &&
          title.top >= bounds.top && resize.bottom <= bounds.bottom && best.rect.right + 80 <= bounds.right &&
          resize.bottom + 80 <= bounds.bottom,
      };
    },
    startFrames() {
      frames = [];
      const tick = (time) => { if (!frames) return; frames.push(time); native.raf(tick); };
      native.raf(tick);
      samples = [];
      sampler = native.setInterval(() => samples.push(document.querySelectorAll("iframe").length), 50);
    },
    stopFrames() {
      const recorded = frames || [];
      frames = null;
      native.clearInterval(sampler);
      return { frames: recorded, iframeSamples: samples };
    },
    longTasksSince: (start) => longTasks.filter((entry) => entry[0] >= start).map((entry) => entry[1]),
    now: () => performance.now(),
  };
})();`;

type PerfApi = Record<string, (...args: unknown[]) => unknown>;

/** Calls one `window.__designPerf` method in the page. */
function api<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, values]) =>
      (window as unknown as { __designPerf: PerfApi }).__designPerf[name as string]!(
        ...(values as unknown[]),
      ),
    [method, args] as const,
  ) as Promise<T>;
}

interface PageStats {
  frames: number;
  offscreen: number;
  iframes: number;
  placeholders: number;
  loading: number;
  layerRows: number;
  domNodes: number;
  timeouts: number;
  intervals: number;
  animationFrames: number;
  blobUrls: number;
  created: { timeouts: number; intervals: number; blobs: number };
  iframeAdds: number;
  iframeRemoves: number;
  renders: number;
  unattributedRenders: number;
}

interface Target {
  frameId: string;
  offset: { x: number; y: number };
  center: { x: number; y: number };
  title: { x: number; y: number };
  resize: { x: number; y: number };
  inside: boolean;
}

// ---------------------------------------------------------------------------
// Memory and listeners.

async function cdpMetrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const read = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return {
    jsHeapUsedMiB: round(read("JSHeapUsedSize") / (1024 * 1024)),
    jsHeapTotalMiB: round(read("JSHeapTotalSize") / (1024 * 1024)),
    nodes: read("Nodes"),
    jsEventListeners: read("JSEventListeners"),
    documents: read("Documents"),
    frames: read("Frames"),
    layoutObjects: read("LayoutObjects"),
  };
}

async function listenerCounts(cdp: CDPSession) {
  const count = async (expression: string) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression });
    if (!result.objectId) return -1;
    try {
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId,
      });
      return listeners.length;
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
    }
  };
  return { window: await count("window"), document: await count("document") };
}

/** Resident memory of every renderer process of this browser (MiB), from the OS. */
async function rendererMemory(browserCdp: CDPSession) {
  const { processInfo } = (await browserCdp.send("SystemInfo.getProcessInfo")) as {
    processInfo: Array<{ type: string; id: number }>;
  };
  const renderers = processInfo.filter((entry) => entry.type === "renderer");
  if (renderers.length === 0) return { processes: 0, rssMiB: Number.NaN };
  const ps = spawnSync("ps", ["-o", "rss=", "-p", renderers.map((entry) => entry.id).join(",")], {
    encoding: "utf8",
  });
  const kib = sum(
    ps.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  return { processes: renderers.length, rssMiB: round(kib / 1024) };
}

async function memory(page: Page, cdp: CDPSession, browserCdp: CDPSession) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(200);
  return {
    ...(await cdpMetrics(cdp)),
    listeners: await listenerCounts(cdp),
    renderer: await rendererMemory(browserCdp),
    page: await api<PageStats>(page, "stats"),
    playwrightFrames: page.frames().length,
  };
}

// ---------------------------------------------------------------------------
// Canvas measurement.

interface Binding {
  calls: Record<string, number>;
  durations: Record<string, number[]>;
  completed: Record<string, number>;
}

async function bindHost(page: Page, host: DesignServiceHost): Promise<Binding> {
  const binding: Binding = { calls: {}, durations: {}, completed: {} };
  await page.exposeFunction(
    "designInvoke",
    async (command: string, args: Record<string, unknown>) => {
      binding.calls[command] = (binding.calls[command] ?? 0) + 1;
      const start = performance.now();
      try {
        return await host.invoke(command, args);
      } finally {
        (binding.durations[command] ??= []).push(performance.now() - start);
        binding.completed[command] = (binding.completed[command] ?? 0) + 1;
      }
    },
  );
  return binding;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Live frames finished rendering, twice in a row 150 ms apart. */
async function waitRendered(page: Page, timeoutMs = 60_000) {
  let stable = 0;
  await waitFor(
    async () => {
      const stats = await api<PageStats>(page, "stats");
      stable = stats.frames > 0 && stats.loading === 0 ? stable + 1 : 0;
      if (stable < 2) await sleep(100);
      return stable >= 2;
    },
    timeoutMs,
    "live frames to render",
  );
}

async function waitRendererIdle(host: DesignServiceHost) {
  await waitFor(
    async () => {
      const readiness = (await host.invoke("design_readiness", { probe: false })) as {
        ok: boolean;
        value?: { renderer?: { queued?: number; running?: number } };
      };
      const renderer = readiness.value?.renderer;
      return !renderer || ((renderer.queued ?? 0) === 0 && (renderer.running ?? 0) === 0);
    },
    120_000,
    "the design renderer to go idle",
  );
}

async function viewportCenter(page: Page) {
  const box = (await page.locator('main[aria-label="Canvas viewport"]').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One wheel pan, in screen pixels (positive moves the view right/down). */
async function wheelPan(page: Page, dx: number, dy: number, steps = 1) {
  const center = await viewportCenter(page);
  await page.mouse.move(center.x, center.y);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx / steps, dy / steps);
    await sleep(16);
  }
}

interface OpDelta {
  targetIframeAdds: number;
  targetIframeRemoves: number;
  targetRenders: number;
  iframeAdds: number;
  iframeRemoves: number;
  renders: number;
}

async function opCounters(page: Page, frameId: string) {
  const [all, target] = await Promise.all([
    api<PageStats>(page, "counters"),
    api<{ iframeAdds: number; iframeRemoves: number; renders: number }>(
      page,
      "frameCounters",
      frameId,
    ),
  ]);
  return { all, target };
}

function opDelta(
  before: Awaited<ReturnType<typeof opCounters>>,
  after: Awaited<ReturnType<typeof opCounters>>,
): OpDelta {
  return {
    targetIframeAdds: after.target.iframeAdds - before.target.iframeAdds,
    targetIframeRemoves: after.target.iframeRemoves - before.target.iframeRemoves,
    targetRenders: after.target.renders - before.target.renders,
    iframeAdds: after.all.iframeAdds - before.all.iframeAdds,
    iframeRemoves: after.all.iframeRemoves - before.all.iframeRemoves,
    renders: after.all.renders - before.all.renders,
  };
}

interface GestureResult {
  previewMs: number[];
  /** Input event timeStamp -> the preview's DOM mutation observed (before paint). */
  previewDomMs: number[];
  /** Input event timeStamp -> its listener ran in the page. */
  previewDispatchMs: number[];
  /** Previews whose DOM change happened inside a frame's rAF phase. */
  previewInFrame: number;
  ackMs: number[];
  ackDomMs: number[];
  missedPreviews: number;
  missedAcks: number;
  acksWithoutPendingSeen: number;
  committedMismatches: number;
  ops: OpDelta[];
}

async function measureDrags(
  page: Page,
  mode: "move" | "resize",
  options: Options,
): Promise<GestureResult> {
  const result: GestureResult = {
    previewMs: [],
    previewDomMs: [],
    previewDispatchMs: [],
    previewInFrame: 0,
    ackMs: [],
    ackDomMs: [],
    missedPreviews: 0,
    missedAcks: 0,
    acksWithoutPendingSeen: 0,
    committedMismatches: 0,
    ops: [],
  };
  const step = 24;
  const prop = mode === "move" ? "left" : "width";
  for (let sample = 0; sample < options.samples; sample++) {
    const target = (await api<Target | null>(page, "pickTarget"))!;
    const handle = mode === "move" ? target.title : target.resize;
    // Alternate direction so the frame returns to where it started.
    const direction = sample % 2 === 0 ? 1 : -1;
    const startRevision = await api<number>(page, "revision");
    const before = await opCounters(page, target.frameId);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await sleep(80);
    let lastValue = Number.NaN;
    for (let move = 1; move <= options.moves; move++) {
      await api(page, "armPreview", target.frameId, prop);
      const offset = direction * move * step;
      await page.mouse.move(handle.x + offset, handle.y + (mode === "move" ? offset / 2 : offset));
      const latency = await api<{
        ms: number;
        domMs: number;
        dispatchMs: number;
        inFrame: boolean;
        value: number;
      } | null>(page, "waitArmed");
      if (latency) {
        result.previewMs.push(latency.ms);
        result.previewDomMs.push(latency.domMs);
        result.previewDispatchMs.push(latency.dispatchMs);
        if (latency.inFrame) result.previewInFrame++;
        lastValue = latency.value;
      } else result.missedPreviews++;
      await sleep(40 + ((sample * 7 + move * 13) % 30));
    }
    await api(page, "armAck", target.frameId, startRevision);
    await page.mouse.up();
    const ack = await api<{
      ms: number;
      domMs: number;
      sawPending: boolean;
      left: number;
      width: number;
    } | null>(page, "waitArmed");
    if (ack) {
      result.ackMs.push(ack.ms);
      result.ackDomMs.push(ack.domMs);
      if (!ack.sawPending) result.acksWithoutPendingSeen++;
      const committed = mode === "move" ? ack.left : ack.width;
      if (Number.isFinite(lastValue) && committed !== lastValue) result.committedMismatches++;
    } else result.missedAcks++;
    await sleep(400);
    result.ops.push(opDelta(before, await opCounters(page, target.frameId)));
  }
  return result;
}

async function measureHtmlEdits(
  page: Page,
  host: DesignServiceHost,
  canvasId: string,
  options: Options,
) {
  const renderMs: number[] = [];
  const ops: OpDelta[] = [];
  let missed = 0;
  for (let sample = 0; sample < options.htmlSamples; sample++) {
    const target = (await api<Target | null>(page, "pickTarget"))!;
    const frame = await host.getFrame(canvasId, ENV, target.frameId);
    const before = await opCounters(page, target.frameId);
    // An agent-side HTML replacement, then the content-free change hint.
    const result = await host.mutate(canvasId, ENV, target.frameId, frame.revision, {
      html: frameHtml(1000 + sample, sample + 1),
    });
    await api(page, "armRender", target.frameId, before.target.renders);
    await page.evaluate(
      ({ event, canvasId: id, revision }) =>
        window.dispatchEvent(
          new CustomEvent(`orkestrator-fixture:${event}`, {
            detail: { canvasId: id, revision },
          }),
        ),
      {
        event: DESIGN_EVENT,
        canvasId,
        revision: result.canvasRevision,
      },
    );
    const rendered = await api<{ ms: number } | null>(page, "waitArmed");
    if (rendered) renderMs.push(rendered.ms);
    else missed++;
    await sleep(400);
    ops.push(opDelta(before, await opCounters(page, target.frameId)));
  }
  return { hintToRenderedMs: renderMs, missed, ops };
}

async function measurePan(page: Page) {
  const center = await viewportCenter(page);
  await page.mouse.move(center.x, center.y);
  const before = await api<PageStats>(page, "counters");
  const start = await api<number>(page, "now");
  await api(page, "startFrames");
  // A rectangle: right, down, left, up; 60 wheel events of 40 px per leg.
  const legs: Array<[number, number]> = [
    [40, 0],
    [0, 40],
    [-40, 0],
    [0, -40],
  ];
  for (const [dx, dy] of legs) {
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(dx, dy);
      await sleep(16);
    }
  }
  await sleep(300);
  const recorded = await api<{ frames: number[]; iframeSamples: number[] }>(page, "stopFrames");
  const after = await api<PageStats>(page, "counters");
  const intervals = recorded.frames.slice(1).map((time, index) => time - recorded.frames[index]!);
  const longTasks = await api<number[]>(page, "longTasksSince", start);
  return {
    frames: frameSummary(intervals),
    iframesDuringPan: {
      min: Math.min(...recorded.iframeSamples),
      max: Math.max(...recorded.iframeSamples),
      samples: recorded.iframeSamples.length,
    },
    iframeAdds: after.iframeAdds - before.iframeAdds,
    iframeRemoves: after.iframeRemoves - before.iframeRemoves,
    renders: after.renders - before.renders,
    longTasks: { count: longTasks.length, totalMs: round(sum(longTasks)) },
    intervals: intervals.map((value) => round(value)),
  };
}

const CULL_DISTANCE = 12_000;

async function leakCycles(page: Page, cdp: CDPSession, browserCdp: CDPSession, cycles: number) {
  const switchTab = page.getByRole("button", { name: "Switch tab" });
  const sample = async (cycle: number) => {
    const snapshot = await memory(page, cdp, browserCdp);
    return {
      cycle,
      jsEventListeners: snapshot.jsEventListeners,
      windowListeners: snapshot.listeners.window,
      documentListeners: snapshot.listeners.document,
      nodes: snapshot.nodes,
      documents: snapshot.documents,
      cdpFrames: snapshot.frames,
      playwrightFrames: snapshot.playwrightFrames,
      iframes: snapshot.page.iframes,
      timeouts: snapshot.page.timeouts,
      intervals: snapshot.page.intervals,
      animationFrames: snapshot.page.animationFrames,
      blobUrls: snapshot.page.blobUrls,
      heapMiB: snapshot.jsHeapUsedMiB,
      rendererRssMiB: snapshot.renderer.rssMiB,
      rendererProcesses: snapshot.renderer.processes,
    };
  };
  type Sample = Awaited<ReturnType<typeof sample>>;
  const samples: Sample[] = [await sample(0)];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    // Deactivate and reactivate the canvas the way a tab switch does (isActive).
    await switchTab.click();
    await sleep(300);
    await switchTab.click();
    await waitRendered(page);
    // Cull: pan every frame out of view, then back.
    await wheelPan(page, CULL_DISTANCE, 0, 6);
    await waitFor(
      async () => (await api<PageStats>(page, "stats")).iframes === 0,
      10_000,
      "frames to cull",
    );
    await sleep(300);
    await wheelPan(page, -CULL_DISTANCE, 0, 6);
    await waitRendered(page);
    // Let exited frame processes and deferred cleanups finish before sampling.
    await sleep(1_500);
    samples.push(await sample(cycle));
  }
  // Converged: after the first cycle (warm-up), the second half of the cycles
  // does not exceed the first half beyond a small slack.
  const failures: string[] = [];
  const settled = samples.slice(1);
  const half = Math.floor(settled.length / 2);
  const early = settled.slice(0, half);
  const late = settled.slice(half);
  const check = (key: keyof Sample, absolute: number, relative: number) => {
    if (early.length === 0 || late.length === 0) return;
    const earlyMax = Math.max(...early.map((entry) => Number(entry[key])));
    const lateMax = Math.max(...late.map((entry) => Number(entry[key])));
    if (lateMax > earlyMax * (1 + relative) + absolute)
      failures.push(`${String(key)} grew from ${earlyMax} to ${lateMax}`);
  };
  check("jsEventListeners", 2, 0);
  check("windowListeners", 0, 0);
  check("documentListeners", 0, 0);
  check("iframes", 0, 0);
  check("cdpFrames", 0, 0);
  check("documents", 0, 0);
  check("timeouts", 2, 0);
  check("intervals", 0, 0);
  check("animationFrames", 1, 0);
  check("blobUrls", 0, 0);
  check("nodes", 0, 0.05);
  check("rendererProcesses", 1, 0);
  check("heapMiB", 0, 0.1);
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const growth = Object.fromEntries(
    (Object.keys(first) as Array<keyof Sample>)
      .filter((key) => key !== "cycle")
      .map((key) => [key, round(Number(last[key]) - Number(first[key]))]),
  );
  return {
    samples,
    growthFromBaseline: growth,
    verdict: { converged: !failures.length, failures },
  };
}

function restSummary(snapshot: Awaited<ReturnType<typeof memory>>) {
  return {
    liveIframes: snapshot.page.iframes,
    framesInDom: snapshot.page.frames,
    offscreenSections: snapshot.page.offscreen,
    placeholders: snapshot.page.placeholders,
    layerRows: snapshot.page.layerRows,
    domNodes: snapshot.page.domNodes,
    cdpNodes: snapshot.nodes,
    jsHeapUsedMiB: snapshot.jsHeapUsedMiB,
    jsEventListeners: snapshot.jsEventListeners,
    documents: snapshot.documents,
    rendererProcesses: snapshot.renderer.processes,
    rendererRssMiB: snapshot.renderer.rssMiB,
  };
}

async function measureCanvas(
  browser: Browser,
  url: string,
  host: DesignServiceHost,
  canvasId: string,
  options: Options,
) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const browserCdp = await browser.newBrowserCDPSession();
  await cdp.send("Performance.enable");
  const binding = await bindHost(page, host);
  try {
    const openStart = Date.now();
    await page.goto(`${url}/design-canvas?canvasId=${canvasId}`);
    await page.waitForSelector("section[data-frame-id]", { timeout: 60_000 });
    await waitRendered(page);
    const openToRenderedMs = Date.now() - openStart;
    await sleep(1_500);
    const restFit = restSummary(await memory(page, cdp, browserCdp));

    // 100% zoom, centred on the frame nearest the middle.
    await page.keyboard.press("Control+0");
    await sleep(300);
    await waitRendered(page);
    const target = await api<Target | null>(page, "pickTarget");
    if (!target) throw new Error("No live frame to centre");
    await wheelPan(page, target.offset.x, target.offset.y);
    await sleep(300);
    await waitRendered(page);
    await sleep(1_000);
    const centred = await api<Target | null>(page, "pickTarget");
    if (!centred?.inside) throw new Error("The centred frame does not fit the viewport");
    const rest100 = restSummary(await memory(page, cdp, browserCdp));

    const move = await measureDrags(page, "move", options);
    const resize = await measureDrags(page, "resize", options);
    const html = await measureHtmlEdits(page, host, canvasId, options);
    await waitRendered(page);
    await sleep(500);

    const pan = await measurePan(page);
    await waitRendered(page);
    // Panned away by one viewport diagonal: culling evidence while panned.
    await wheelPan(page, 1_600, 1_000, 4);
    await sleep(300);
    await waitFor(
      async () => (await api<PageStats>(page, "stats")).loading === 0,
      30_000,
      "panned frames to render",
    );
    await sleep(800);
    const panned = restSummary(await memory(page, cdp, browserCdp));
    await wheelPan(page, -1_600, -1_000, 4);
    await waitRendered(page);
    await sleep(500);

    const cycles = await leakCycles(page, cdp, browserCdp, options.cycles);
    const after = restSummary(await memory(page, cdp, browserCdp));
    return {
      openToRenderedMs,
      rest: { fitAll: restFit, zoom100: rest100, panned, afterCycles: after },
      gestures: { move, resize },
      html,
      pan,
      cycles,
      invokes: binding.calls,
    };
  } finally {
    await browserCdp.detach().catch(() => undefined);
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Library measurement.

async function measureLibrary(
  browser: Browser,
  url: string,
  host: DesignServiceHost,
  canvases: number,
  options: Options,
) {
  const expected = Math.min(50, canvases);
  const openMs: number[] = [];
  const reopenMs: number[] = [];
  const loadAllMs: number[] = [];
  const backendListMs: number[] = [];
  let missed = 0;
  for (let sample = 0; sample < options.librarySamples; sample++) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();
    const binding = await bindHost(page, host);
    try {
      await page.goto(`${url}/design-library-perf`);
      await page.getByRole("button", { name: "New design workspace" }).click();
      const dialog = page.getByRole("dialog", { name: "Design workspace" });
      await dialog.waitFor();
      await waitFor(
        async () => (binding.completed.design_readiness ?? 0) >= 1,
        60_000,
        "design readiness",
      );
      await sleep(500);
      const savedTab = dialog.getByRole("tab", { name: "Saved designs" });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await dialog.getByRole("tab", { name: "New design" }).click();
          await sleep(300);
        }
        await api(page, "armRows", expected);
        await savedTab.click();
        const result = await api<{ ms: number } | null>(page, "waitArmed");
        if (!result) missed++;
        else (attempt === 0 ? openMs : reopenMs).push(result.ms);
        await sleep(300);
      }
      if (canvases > 50) {
        const start = Date.now();
        const list = dialog.locator('ul[aria-label="Designs"] > li');
        while ((await list.count()) < canvases) {
          const before = await list.count();
          await dialog.getByRole("button", { name: "Load more" }).click();
          await waitFor(async () => (await list.count()) > before, 30_000, "the next page");
        }
        loadAllMs.push(Date.now() - start);
      }
      backendListMs.push(...(binding.durations.design_library ?? []));
    } finally {
      await context.close();
    }
  }
  return { canvases, expectedRows: expected, openMs, reopenMs, loadAllMs, backendListMs, missed };
}

async function seedLibrary(host: DesignServiceHost, from: number, to: number) {
  for (let index = from; index < to; index++) {
    await host.create(ENV, `Library ${index + 1}`, seedDocument(`Library ${index + 1}`, 2, index));
  }
}

// ---------------------------------------------------------------------------
// Environment facts (numbers and versions only).

function git(args: string[]) {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
}

function hostFacts() {
  const totalCpu = sum(
    spawnSync("ps", ["-Ao", "pcpu="], { encoding: "utf8" })
      .stdout.split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value)),
  );
  return { loadAverage1m: round(os.loadavg()[0]!), processCpuPctTotal: round(totalCpu, 0) };
}

// ---------------------------------------------------------------------------
// Main.

type CanvasRun = Awaited<ReturnType<typeof measureCanvas>>;
type LibraryRun = Awaited<ReturnType<typeof measureLibrary>>;

function summarizeCanvas(runs: CanvasRun[]) {
  const pool = <T>(pick: (run: CanvasRun) => T[]) => runs.flatMap(pick);
  const perRun = (pick: (run: CanvasRun) => number) => runs.map((run) => round(pick(run)));
  const ops = (pick: (run: CanvasRun) => OpDelta[]) => {
    const all = pool(pick);
    const total = (key: keyof OpDelta) => sum(all.map((op) => op[key]));
    return {
      ops: all.length,
      targetIframeReplacements: total("targetIframeAdds") + total("targetIframeRemoves"),
      targetRenders: total("targetRenders"),
      iframeInsertsAnyFrame: total("iframeAdds"),
      iframeRemovesAnyFrame: total("iframeRemoves"),
      rendersAnyFrame: total("renders"),
      targetRendersPerOp: round(total("targetRenders") / Math.max(1, all.length)),
      targetIframeReplacementsPerOp: round(
        (total("targetIframeAdds") + total("targetIframeRemoves")) / Math.max(1, all.length),
      ),
    };
  };
  const intervals = pool((run) => run.pan.intervals);
  return {
    runs: runs.length,
    openToRenderedMs: perRun((run) => run.openToRenderedMs),
    previewMove: summarize(pool((run) => run.gestures.move.previewMs)),
    previewResize: summarize(pool((run) => run.gestures.resize.previewMs)),
    preview: summarize(
      pool((run) => [...run.gestures.move.previewMs, ...run.gestures.resize.previewMs]),
    ),
    ackMove: summarize(pool((run) => run.gestures.move.ackMs)),
    ackResize: summarize(pool((run) => run.gestures.resize.ackMs)),
    ack: summarize(pool((run) => [...run.gestures.move.ackMs, ...run.gestures.resize.ackMs])),
    previewDom: summarize(
      pool((run) => [...run.gestures.move.previewDomMs, ...run.gestures.resize.previewDomMs]),
    ),
    previewDispatch: summarize(
      pool((run) => [
        ...run.gestures.move.previewDispatchMs,
        ...run.gestures.resize.previewDispatchMs,
      ]),
    ),
    previewInFramePct: round(
      (100 *
        sum(
          runs.map((run) => run.gestures.move.previewInFrame + run.gestures.resize.previewInFrame),
        )) /
        Math.max(
          1,
          sum(
            runs.map(
              (run) => run.gestures.move.previewMs.length + run.gestures.resize.previewMs.length,
            ),
          ),
        ),
      1,
    ),
    ackDom: summarize(
      pool((run) => [...run.gestures.move.ackDomMs, ...run.gestures.resize.ackDomMs]),
    ),
    missedPreviews: sum(
      runs.map((run) => run.gestures.move.missedPreviews + run.gestures.resize.missedPreviews),
    ),
    missedAcks: sum(
      runs.map((run) => run.gestures.move.missedAcks + run.gestures.resize.missedAcks),
    ),
    committedMismatches: sum(
      runs.map(
        (run) => run.gestures.move.committedMismatches + run.gestures.resize.committedMismatches,
      ),
    ),
    acksWithoutPendingSeen: sum(
      runs.map(
        (run) =>
          run.gestures.move.acksWithoutPendingSeen + run.gestures.resize.acksWithoutPendingSeen,
      ),
    ),
    geometryOps: ops((run) => [...run.gestures.move.ops, ...run.gestures.resize.ops]),
    htmlOps: ops((run) => run.html.ops),
    htmlHintToRendered: summarize(pool((run) => run.html.hintToRenderedMs)),
    pan: frameSummary(intervals),
    panPerRun: runs.map((run) => run.pan.frames),
    panIframesMax: Math.max(...runs.map((run) => run.pan.iframesDuringPan.max)),
    panIframeInserts: perRun((run) => run.pan.iframeAdds),
    panRenders: perRun((run) => run.pan.renders),
    panLongTasks: perRun((run) => run.pan.longTasks.count),
    rest: {
      fitAll: runs.map((run) => run.rest.fitAll),
      zoom100: runs.map((run) => run.rest.zoom100),
      panned: runs.map((run) => run.rest.panned),
      afterCycles: runs.map((run) => run.rest.afterCycles),
    },
    leak: {
      converged: runs.every((run) => run.cycles.verdict.converged),
      failures: runs.flatMap((run) => run.cycles.verdict.failures),
      growthFromBaseline: runs.map((run) => run.cycles.growthFromBaseline),
    },
  };
}

function summarizeLibrary(runs: LibraryRun[]) {
  return {
    expectedRows: runs[0]?.expectedRows ?? 0,
    open: summarize(runs.flatMap((run) => run.openMs)),
    reopen: summarize(runs.flatMap((run) => run.reopenMs)),
    loadAll: summarize(runs.flatMap((run) => run.loadAllMs)),
    backendList: summarize(runs.flatMap((run) => run.backendListMs)),
    missed: sum(runs.map((run) => run.missed)),
  };
}

function printTable(title: string, columns: string[], rows: Array<[string, ...unknown[]]>) {
  const cells = [["metric", ...columns], ...rows.map((row) => row.map((cell) => String(cell)))];
  const widths = cells[0]!.map((_, index) => Math.max(...cells.map((row) => row[index]!.length)));
  console.log(`\n${title}`);
  for (const [index, row] of cells.entries()) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join("  "));
    if (index === 0) console.log(widths.map((width) => "-".repeat(width)).join("  "));
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const workDir = mkdtempSync(path.join(os.tmpdir(), "design-canvas-perf-"));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(repositoryRoot, "output/benchmarks/design-canvas");
  mkdirSync(outputDir, { recursive: true });
  const dirtyPaths = git(["status", "--porcelain"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const dirty = dirtyPaths.length;
  const environment = {
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryGiB: round(os.totalmem() / 1024 ** 3, 0),
    os: `${os.type()} ${os.release()} ${spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.trim() ?? ""}`.trim(),
    bun: process.versions.bun ?? "unknown",
    commit: git(["rev-parse", "HEAD"]),
    webRevision: options.rev ? git(["rev-parse", options.rev]) : "working tree",
    /** Uncommitted paths in the checkout (names only); see `webRevision`. */
    dirtyPaths,
    /** Uncommitted paths that still reach the build or the hosted backend. */
    dirtyPathsInMeasurement: dirtyPaths.filter((file) =>
      options.rev
        ? file.startsWith("packages/") ||
          file.startsWith("apps/backend/src/") ||
          file === "e2e/fixture/main.tsx" ||
          file.startsWith("e2e/design-service")
        : file.startsWith("apps/web/") ||
          file.startsWith("packages/") ||
          file.startsWith("apps/backend/src/") ||
          file.startsWith("e2e/fixture/") ||
          file.startsWith("e2e/design-service"),
    ),
    build: options.minify
      ? "vite build (production React, minified), vite preview"
      : "vite build (production React, unminified), vite preview",
    viewport: VIEWPORT,
    browser: "",
  };
  const load: Array<{ phase: string } & ReturnType<typeof hostFacts>> = [];
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  const hosts: DesignServiceHost[] = [];
  const canvasResults: Record<string, CanvasRun[]> = {};
  const libraryResults: Record<string, LibraryRun[]> = {};
  const seeding: Record<string, number> = {};
  const launch = () =>
    chromium.launch({
      channel: "chrome",
      headless: !options.headed,
      args: [
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ],
    });
  try {
    console.log("[perf] building and serving the fixture app");
    const sourceRoot = options.rev ? exportRevision(options.rev, workDir) : repositoryRoot;
    server = await startServer(options.port, workDir, options.minify, options.dist, sourceRoot);

    if (!options.skipCanvas) {
      for (let runIndex = 1; runIndex <= options.runs; runIndex++) {
        // A fresh service, data directory and browser per run.
        const dataDir = mkdtempSync(path.join(workDir, `canvas-${runIndex}-`));
        const worktree = path.join(dataDir, "worktree");
        mkdirSync(worktree);
        const host = startDesignServiceHost(path.join(dataDir, "data"), worktree);
        hosts.push(host);
        const canvases: Record<number, string> = {};
        for (const count of options.frames) {
          const start = performance.now();
          const canvas = await host.create(
            ENV,
            `Perf ${count}`,
            seedDocument(`Perf ${count}`, count),
            "user",
          );
          canvases[count] = canvas.id;
          seeding[`canvas-${count}-run-${runIndex}`] = round(performance.now() - start);
        }
        await waitRendererIdle(host);
        // Alternate size order each run so no size always goes first.
        const order = runIndex % 2 === 1 ? options.frames : [...options.frames].reverse();
        for (const count of order) {
          load.push({ phase: `canvas-${count}-run-${runIndex}-start`, ...hostFacts() });
          const browser = await launch();
          environment.browser = browser.version();
          try {
            const result = await measureCanvas(
              browser,
              server.url,
              host,
              canvases[count]!,
              options,
            );
            (canvasResults[count] ??= []).push(result);
            const preview = summarize([
              ...result.gestures.move.previewMs,
              ...result.gestures.resize.previewMs,
            ]);
            const ack = summarize([...result.gestures.move.ackMs, ...result.gestures.resize.ackMs]);
            console.log(
              `[perf] run ${runIndex} ${count} frames: preview p50 ${preview.p50} p95 ${preview.p95} ms; ack p50 ${ack.p50} p95 ${ack.p95} ms; pan p95 ${result.pan.frames.p95Ms} ms, dropped ${result.pan.frames.droppedPct}%; iframes rest ${result.rest.zoom100.liveIframes}, pan max ${result.pan.iframesDuringPan.max}; converged ${result.cycles.verdict.converged}`,
            );
          } finally {
            await browser.close();
          }
          load.push({ phase: `canvas-${count}-run-${runIndex}-end`, ...hostFacts() });
        }
        await host.close();
      }
    }

    if (!options.skipLibrary) {
      const dataDir = mkdtempSync(path.join(workDir, "library-"));
      const worktree = path.join(dataDir, "worktree");
      mkdirSync(worktree);
      const host = startDesignServiceHost(path.join(dataDir, "data"), worktree);
      hosts.push(host);
      let seeded = 0;
      for (const count of [...options.library].sort((a, b) => a - b)) {
        const start = performance.now();
        await seedLibrary(host, seeded, count);
        seeding[`library-${seeded}-to-${count}`] = round(performance.now() - start);
        seeded = count;
        await waitRendererIdle(host);
        for (let runIndex = 1; runIndex <= options.runs; runIndex++) {
          load.push({ phase: `library-${count}-run-${runIndex}-start`, ...hostFacts() });
          const browser = await launch();
          environment.browser = browser.version();
          try {
            const result = await measureLibrary(browser, server.url, host, count, options);
            (libraryResults[count] ??= []).push(result);
            const open = summarize(result.openMs);
            console.log(
              `[perf] run ${runIndex} library ${count}: open p50 ${open.p50} p95 ${open.p95} ms (${result.expectedRows} rows)`,
            );
          } finally {
            await browser.close();
          }
        }
      }
      await host.close();
    }

    const summary = {
      canvas: Object.fromEntries(
        Object.entries(canvasResults).map(([count, runs]) => [count, summarizeCanvas(runs)]),
      ),
      library: Object.fromEntries(
        Object.entries(libraryResults).map(([count, runs]) => [count, summarizeLibrary(runs)]),
      ),
    };
    const report = {
      runId,
      environment,
      options,
      load,
      seedingMs: seeding,
      frameHtmlBytes: Buffer.byteLength(frameHtml(0)),
      summary,
      canvasResults,
      libraryResults,
    };
    const reportFile = path.join(outputDir, `${runId}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    console.log(
      `\n[perf] host ${environment.cpu} (${environment.logicalCpus} logical), ${environment.os}; ${environment.browser ? `Chrome ${environment.browser}` : ""}; commit ${environment.commit.slice(0, 12)}; web code from ${options.rev ? `${options.rev} (${environment.webRevision.slice(0, 12)})` : "the working tree"}; ${dirty} uncommitted paths in the checkout, ${environment.dirtyPathsInMeasurement.length} reaching the measurement; ${environment.build}`,
    );
    const sizes = Object.keys(summary.canvas);
    if (sizes.length) {
      const c = (pick: (entry: ReturnType<typeof summarizeCanvas>) => unknown) =>
        sizes.map((size) => pick(summary.canvas[size]!));
      const restAt = (
        key: "fitAll" | "zoom100" | "panned" | "afterCycles",
        field: keyof CanvasRun["rest"]["fitAll"],
      ) =>
        c((entry) =>
          round(
            quantile(
              entry.rest[key].map((rest) => Number(rest[field])),
              0.5,
            ),
          ),
        );
      printTable(
        `Canvas (${options.runs} runs; medians of runs for rest values)`,
        sizes.map((size) => `${size} frames`),
        [
          ["gesture->preview p50 ms", ...c((entry) => entry.preview.p50)],
          ["gesture->preview p95 ms", ...c((entry) => entry.preview.p95)],
          ["  preview samples", ...c((entry) => entry.preview.n)],
          [
            "  move p50/p95 ms",
            ...c((entry) => `${entry.previewMove.p50}/${entry.previewMove.p95}`),
          ],
          [
            "  resize p50/p95 ms",
            ...c((entry) => `${entry.previewResize.p50}/${entry.previewResize.p95}`),
          ],
          [
            "  input->DOM preview p50/p95",
            ...c((entry) => `${entry.previewDom.p50}/${entry.previewDom.p95}`),
          ],
          ["  preview DOM change in rAF phase %", ...c((entry) => entry.previewInFramePct)],
          [
            "  input->listener p50/p95",
            ...c((entry) => `${entry.previewDispatch.p50}/${entry.previewDispatch.p95}`),
          ],
          ["release->ack p50 ms", ...c((entry) => entry.ack.p50)],
          ["release->ack p95 ms", ...c((entry) => entry.ack.p95)],
          ["  ack samples", ...c((entry) => entry.ack.n)],
          [
            "  release->ack DOM p50/p95",
            ...c((entry) => `${entry.ackDom.p50}/${entry.ackDom.p95}`),
          ],
          [
            "  missed previews/acks",
            ...c((entry) => `${entry.missedPreviews}/${entry.missedAcks}`),
          ],
          ["pan frame p50 ms", ...c((entry) => entry.pan.p50Ms)],
          ["pan frame p95 ms", ...c((entry) => entry.pan.p95Ms)],
          ["pan intervals >16.7ms %", ...c((entry) => entry.pan.overBudgetPct)],
          ["pan dropped frames %", ...c((entry) => entry.pan.droppedPct)],
          ["  pan frames (pooled)", ...c((entry) => entry.pan.frames)],
          ["live iframes, fit all", ...restAt("fitAll", "liveIframes")],
          ["live iframes, 100%", ...restAt("zoom100", "liveIframes")],
          ["live iframes, panned", ...restAt("panned", "liveIframes")],
          ["live iframes, pan max", ...c((entry) => entry.panIframesMax)],
          ["placeholders, fit all", ...restAt("fitAll", "placeholders")],
          ["layer rows, fit all", ...restAt("fitAll", "layerRows")],
          ["layer rows, 100%", ...restAt("zoom100", "layerRows")],
          ["layer rows, panned", ...restAt("panned", "layerRows")],
          [
            "geometry op: target iframe repl/op",
            ...c((entry) => entry.geometryOps.targetIframeReplacementsPerOp),
          ],
          ["geometry op: target renders/op", ...c((entry) => entry.geometryOps.targetRendersPerOp)],
          [
            "geometry ops: any-frame ins/rm/render",
            ...c(
              (entry) =>
                `${entry.geometryOps.iframeInsertsAnyFrame}/${entry.geometryOps.iframeRemovesAnyFrame}/${entry.geometryOps.rendersAnyFrame} of ${entry.geometryOps.ops}`,
            ),
          ],
          [
            "html op: target iframe repl/op",
            ...c((entry) => entry.htmlOps.targetIframeReplacementsPerOp),
          ],
          ["html op: target renders/op", ...c((entry) => entry.htmlOps.targetRendersPerOp)],
          [
            "html hint->rendered p50/p95 ms",
            ...c((entry) => `${entry.htmlHintToRendered.p50}/${entry.htmlHintToRendered.p95}`),
          ],
          ["JS heap MiB, 100% (post-GC)", ...restAt("zoom100", "jsHeapUsedMiB")],
          ["JS heap MiB, after cycles", ...restAt("afterCycles", "jsHeapUsedMiB")],
          ["DOM nodes, 100%", ...restAt("zoom100", "domNodes")],
          ["renderer RSS MiB, 100%", ...restAt("zoom100", "rendererRssMiB")],
          ["renderer processes, 100%", ...restAt("zoom100", "rendererProcesses")],
          ["open->rendered ms (per run)", ...c((entry) => entry.openToRenderedMs.join("/"))],
          ["leak check converged", ...c((entry) => entry.leak.converged)],
        ],
      );
    }
    const librarySizes = Object.keys(summary.library);
    if (librarySizes.length) {
      const l = (pick: (entry: ReturnType<typeof summarizeLibrary>) => unknown) =>
        librarySizes.map((size) => pick(summary.library[size]!));
      printTable(
        `Library (${options.runs} runs x ${options.librarySamples} fresh pages)`,
        librarySizes.map((size) => `${size} canvases`),
        [
          ["rows on first page", ...l((entry) => entry.expectedRows)],
          ["open p50 ms", ...l((entry) => entry.open.p50)],
          ["open p95 ms", ...l((entry) => entry.open.p95)],
          ["  open samples", ...l((entry) => entry.open.n)],
          ["reopen p50/p95 ms", ...l((entry) => `${entry.reopen.p50}/${entry.reopen.p95}`)],
          [
            "backend list p50/p95 ms",
            ...l((entry) => `${entry.backendList.p50}/${entry.backendList.p95}`),
          ],
          ["load all pages p50 ms", ...l((entry) => entry.loadAll.p50)],
          ["missed", ...l((entry) => entry.missed)],
        ],
      );
    }
    console.log(`\n[perf] load ${JSON.stringify(load)}`);
    console.log(`[perf] report ${path.relative(repositoryRoot, reportFile)}`);
  } finally {
    for (const host of hosts) await host.close().catch(() => undefined);
    if (server?.process.pid) process.kill(-server.process.pid, "SIGTERM");
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
