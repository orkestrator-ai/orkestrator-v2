/**
 * Rich-transcript performance gate (real browser, not part of any suite).
 *
 *   mise exec -- bun e2e/perf/rich-transcripts-perf.ts \
 *     [--root change=.] [--root baseline=/path/to/base-worktree] \
 *     [--runs 3] [--cycles 20] [--keystrokes 240] [--cpu-profile] [--retained-mib 8]
 *
 * Each `--root` is a repository checkout. Its `e2e/fixture` app is built with
 * that checkout's Vite config (production React) into a temporary directory
 * and served by `vite preview` on its own port. Runs are interleaved across
 * roots, each in a fresh installed Google Chrome (`channel: "chrome"`,
 * headless), against `/rich-transcript-perf`
 * (`e2e/fixture/RichTranscriptPerfFixture.tsx`).
 *
 * Per run, while a response streams into a code fence at a steady rate:
 *  - load: first-row time and long tasks while the 3,000-message transcript opens;
 *  - typing: keystroke-to-next-frame latency (rAF + message-channel turn) in the
 *    real composer, Event Timing entries, long tasks;
 *  - scroll: rAF frame intervals while wheel-scrolling up through history,
 *    long tasks, long animation frames, sampled queued work;
 *  - renderer mount counts, highlighter invocations, backend calls per phase;
 *  - covered: another tab in front for 10 s while the response keeps
 *    streaming, then the page brought back: time to the first frame, long tasks
 *    and long animation frames in the 3 s after. A page Playwright drives
 *    stays `visible` with timers at full rate when covered, minimized or
 *    frozen, headless or `--headed`, because a DevTools session is attached to
 *    it, so this phase never measures a hidden document; the report records
 *    the visibility the page saw. `hidden-resume-perf.ts` measures one;
 *  - cycles: N scroll/expand/reopen cycles, sampling settled cache entries and
 *    bytes, queued work, view-state entries, live workers, DOM nodes and the
 *    post-GC JS heap, then checking they converge within FRONTEND_RENDER_POLICY.
 *
 * Output is numbers only (no transcript content). A JSON report is written to
 * output/benchmarks/rich-transcripts/<run-id>.json. With two roots the first is
 * the change and the second the baseline; the summary compares medians of the
 * per-run medians and fails when composer latency or scroll-frame time regresses
 * by more than 10%.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";
import { FRONTEND_RENDER_POLICY } from "../../packages/protocol/src/rich-content-policy";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

interface Options {
  roots: Array<{ label: string; root: string }>;
  runs: number;
  cycles: number;
  keystrokes: number;
  basePort: number;
  cpuProfile: boolean;
  headed: boolean;
  cpuThrottle: number;
  minify: boolean;
  stream: boolean;
  /** Grow the fixture's 3,000 messages to about this many MiB (`?retainedMiB`). */
  retainedMiB: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    roots: [],
    runs: 3,
    cycles: 20,
    keystrokes: 240,
    basePort: 1460,
    cpuProfile: false,
    headed: false,
    cpuThrottle: 1,
    minify: true,
    stream: true,
    retainedMiB: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--root") {
      const [label, root] = value().split("=", 2);
      if (!label || !root) throw new Error("--root expects label=path");
      options.roots.push({ label, root: path.resolve(root) });
    } else if (arg === "--runs") options.runs = Number(value());
    else if (arg === "--cycles") options.cycles = Number(value());
    else if (arg === "--keystrokes") options.keystrokes = Number(value());
    else if (arg === "--port") options.basePort = Number(value());
    else if (arg === "--cpu-profile") options.cpuProfile = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--cpu-throttle") options.cpuThrottle = Number(value());
    else if (arg === "--no-minify") options.minify = false;
    // Diagnostic: measure typing and scrolling without the streaming response.
    else if (arg === "--no-stream") options.stream = false;
    else if (arg === "--retained-mib") options.retainedMiB = Number(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.roots.length === 0) options.roots.push({ label: "change", root: repositoryRoot });
  return options;
}

// ---------------------------------------------------------------------------
// Fixture servers.

interface Server {
  label: string;
  url: string;
  process: ChildProcess;
}

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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Fixture server did not start: ${url}`);
}

async function startServer(
  label: string,
  root: string,
  port: number,
  workDir: string,
  minify: boolean,
): Promise<Server> {
  const webDir = path.join(root, "apps/web");
  const outDir = path.join(workDir, `${label}-dist`);
  const vite = path.join(webDir, "node_modules/vite/bin/vite.js");
  await run(
    [
      process.execPath,
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
      // Readable function names in CPU profiles (`--no-minify`).
      ...(minify ? [] : ["--minify", "false"]),
    ],
    webDir,
    path.join(workDir, `${label}-build.log`),
  );
  // Run Vite's own entry with Bun in a fresh process group so stopping the
  // group stops the server without matching processes by name or port.
  const child = spawn(
    process.execPath,
    [
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
      String(port),
      "--strictPort",
    ],
    { cwd: webDir, stdio: "ignore", detached: true },
  );
  const url = `http://127.0.0.1:${port}`;
  await waitForUrl(url, 60_000);
  return { label, url, process: child };
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

const median = (values: number[]) => quantile(values, 0.5);
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function summarizeDurations(values: number[]) {
  return {
    n: values.length,
    median: round(median(values)),
    p95: round(quantile(values, 0.95)),
    max: round(values.length ? Math.max(...values) : Number.NaN),
  };
}

/**
 * Frame intervals against the refresh interval `T` measured on the same page
 * (≈16.7 ms at 60 Hz, ≈8.3 ms at 120 Hz), so budgets hold at either cadence.
 */
function summarizeFrames(intervals: number[], refreshMs: number) {
  const over = (factor: number) =>
    round(
      (100 * intervals.filter((value) => value > factor * refreshMs).length) /
        Math.max(1, intervals.length),
      2,
    );
  return {
    n: intervals.length,
    refreshMs: round(refreshMs),
    p50: round(median(intervals)),
    p95: round(quantile(intervals, 0.95)),
    p99: round(quantile(intervals, 0.99)),
    max: round(intervals.length ? Math.max(...intervals) : Number.NaN),
    over1_5TPct: over(1.5),
    over2TPct: over(2),
  };
}

function longTaskSummary(durations: number[]) {
  return {
    count: durations.length,
    totalMs: round(durations.reduce((sum, value) => sum + value, 0)),
    p95Ms: round(durations.length ? quantile(durations, 0.95) : 0),
    maxMs: round(durations.length ? Math.max(...durations) : 0),
  };
}

// ---------------------------------------------------------------------------
// In-page instrumentation (installed before any page script runs).

const INIT_SCRIPT = `(() => {
  const perf = (window.__perfCollect = {
    longTasks: [],
    loafs: [],
    events: [],
    keyLatencies: [],
    frames: null,
    samples: [],
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        perf.loafs.push([entry.startTime, entry.duration, entry.blockingDuration || 0]);
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "keydown" || entry.name === "keypress" || entry.name === "input" || entry.name === "beforeinput")
          perf.events.push([entry.startTime, entry.duration]);
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
  const channel = new MessageChannel();
  const pending = [];
  channel.port1.onmessage = () => {
    const start = pending.shift();
    if (start !== undefined) perf.keyLatencies.push(performance.now() - start);
  };
  window.addEventListener(
    "keydown",
    (event) => {
      if (!perf.measureKeys) return;
      const start = event.timeStamp;
      requestAnimationFrame(() => {
        pending.push(start);
        channel.port2.postMessage(0);
      });
    },
    true,
  );
  perf.startFrames = () => {
    perf.frames = [];
    const tick = (time) => {
      if (!perf.frames) return;
      perf.frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  perf.stopFrames = () => {
    const frames = perf.frames || [];
    perf.frames = null;
    return frames;
  };
  perf.startSampling = () => {
    perf.samples = [];
    perf.sampler = setInterval(() => {
      const api = window.__richPerf;
      if (!api) return;
      const stats = api.stats();
      const scheduler = stats.scheduler;
      perf.samples.push(scheduler ? [scheduler.queued, scheduler.queuedBytes, scheduler.inflight, scheduler.running] : [0, 0, 0, 0]);
    }, 100);
  };
  perf.stopSampling = () => {
    clearInterval(perf.sampler);
    return perf.samples;
  };
})();`;

interface PageCollect {
  longTasks: Array<[number, number]>;
  loafs: Array<[number, number, number]>;
  events: Array<[number, number]>;
  keyLatencies: number[];
}

type Counters = {
  rowMounts: number;
  richBlockMounts: number;
  codeBlockMounts: number;
  highlighterInvocations: number;
  workersCreated: number;
  workersTerminated: number;
  backendCalls: Record<string, number>;
  unexpectedCommands: number;
  streamTicks: number;
  streamChars: number;
};

function counterDelta(before: Counters, after: Counters) {
  const calls = (value: Counters) =>
    Object.values(value.backendCalls).reduce((sum, count) => sum + count, 0);
  return {
    rowMounts: after.rowMounts - before.rowMounts,
    richBlockMounts: after.richBlockMounts - before.richBlockMounts,
    codeBlockMounts: after.codeBlockMounts - before.codeBlockMounts,
    highlighterInvocations: after.highlighterInvocations - before.highlighterInvocations,
    workersCreated: after.workersCreated - before.workersCreated,
    backendCalls: calls(after) - calls(before),
    streamTicks: after.streamTicks - before.streamTicks,
    streamChars: after.streamChars - before.streamChars,
  };
}

const now = (page: Page) => page.evaluate(() => performance.now());
const counters = (page: Page) => page.evaluate(() => window.__richPerf!.counters() as Counters);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function longTasksBetween(page: Page, start: number, end: number) {
  const collect = await page.evaluate(
    () => (window as unknown as { __perfCollect: PageCollect }).__perfCollect,
  );
  const within = <T extends number[]>(entries: T[]) =>
    entries.filter((entry) => entry[0]! >= start && entry[0]! <= end);
  const loafs = within(collect.loafs);
  return {
    longTasks: longTaskSummary(within(collect.longTasks).map((entry) => entry[1])),
    longAnimationFrames: {
      count: loafs.length,
      blockingMs: round(loafs.reduce((sum, entry) => sum + entry[2], 0)),
    },
    slowInputEvents: within(collect.events).map((entry) => entry[1]),
  };
}

/** Main-thread busy time (ms) from the CDP Performance domain. */
async function mainThread(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const read = (name: string) =>
    (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return {
    task: read("TaskDuration"),
    script: read("ScriptDuration"),
    layout: read("LayoutDuration"),
    style: read("RecalcStyleDuration"),
  };
}

function mainThreadDelta(
  before: Awaited<ReturnType<typeof mainThread>>,
  after: Awaited<ReturnType<typeof mainThread>>,
  elapsedMs: number,
) {
  const task = after.task - before.task;
  return {
    taskMs: round(task),
    scriptMs: round(after.script - before.script),
    layoutMs: round(after.layout - before.layout),
    styleMs: round(after.style - before.style),
    busyPct: round((100 * task) / Math.max(1, elapsedMs), 1),
  };
}

async function startProfile(cdp: CDPSession | null) {
  if (!cdp) return;
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}

async function stopProfile(cdp: CDPSession | null, file: string) {
  if (!cdp) return;
  const { profile } = await cdp.send("Profiler.stop");
  writeFileSync(file, JSON.stringify(profile));
}

// ---------------------------------------------------------------------------
// One measured run.

/**
 * Scroll workloads beyond the upward history wheel: each must actually move
 * the viewport (a wheel at a list boundary measures nothing), so every phase
 * reports the distance it travelled.
 */
const SCROLL_PHASES: Array<{ name: string; deltas: (index: number) => number; events: number }> = [
  { name: "down", events: 150, deltas: () => 300 },
  { name: "slowUp", events: 240, deltas: (index) => -(1 + (index % 3)) },
  {
    name: "alternating",
    events: 200,
    deltas: (index) => (Math.floor(index / 10) % 2 === 0 ? -160 : 160),
  },
  { name: "fling", events: 40, deltas: (index) => (index < 20 ? -1200 : 1200) },
];

/** Median rAF interval at rest: the display's refresh interval for this run. */
async function calibrateRefresh(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const times: number[] = [];
        const tick = (time: number) => {
          times.push(time);
          if (times.length < 90) requestAnimationFrame(tick);
          else {
            const intervals = times
              .slice(1)
              .map((value, index) => value - times[index]!)
              .sort((a, b) => a - b);
            resolve(intervals[Math.floor(intervals.length / 2)]!);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** The candidate's transcript scroll controller counters; null where absent (baseline). */
async function scrollControllerCounters(page: Page): Promise<Record<string, number> | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector("[data-virtuoso-scroller]") as
      | (Element & { orkTranscriptScrollDiagnostics?: () => Record<string, number> })
      | null;
    return scroller?.orkTranscriptScrollDiagnostics?.() ?? null;
  });
}

const STREAM_INTERVAL_MS = 50;
const STREAM_CHARS_PER_TICK = 12;
const WHEEL_EVENTS = 300;
const WHEEL_DELTA = -300;
const KEY_TEXT = "the quick brown fox jumps over the lazy dog ";

async function measureRun(
  browser: Browser,
  server: Server,
  options: Options,
  profileDir: string | null,
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const profiling = profileDir ? cdp : null;
  await cdp.send("Performance.enable");
  if (options.cpuThrottle > 1) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
  }

  // --- load
  const navigationStart = Date.now();
  await page.goto(
    `${server.url}/rich-transcript-perf${options.retainedMiB > 0 ? `?retainedMiB=${options.retainedMiB}` : ""}`,
  );
  await page.waitForFunction(() => window.__richPerf?.ready === true, null, { timeout: 60_000 });
  await page.waitForSelector("[data-item-index]", { timeout: 60_000 });
  const firstRowMs = Date.now() - navigationStart;
  await sleep(2_000);
  const loadEnd = await now(page);
  const loadStats = await page.evaluate(() => window.__richPerf!.stats());
  const load = {
    firstRowMs,
    messages: await page.evaluate(() => window.__richPerf!.messageCount()),
    transcriptBytes: loadStats.transcriptBytes as number,
    ...(await longTasksBetween(page, 0, loadEnd)),
  };
  const loadCounters = await counters(page);
  const scroller = page.locator("[data-virtuoso-scroller]").first();
  const box = (await scroller.boundingBox())!;
  const refreshMs = await calibrateRefresh(page);

  // --- typing while streaming
  if (options.stream) {
    await page.evaluate(
      ([interval, chars]) => window.__richPerf!.startStream(interval!, chars!),
      [STREAM_INTERVAL_MS, STREAM_CHARS_PER_TICK],
    );
  }
  const composer = page.locator('[role="textbox"][aria-label="Send a message"]');
  await composer.click();
  await sleep(1_000);
  const typingCountersBefore = await counters(page);
  const typingMainBefore = await mainThread(cdp);
  const typingStart = await now(page);
  await startProfile(profiling);
  await page.evaluate(() => {
    const collect = (window as unknown as { __perfCollect: { measureKeys: boolean } })
      .__perfCollect;
    collect.measureKeys = true;
  });
  for (let i = 0; i < options.keystrokes; i++) {
    if (i > 0 && i % 60 === 0) {
      await page.evaluate(() => {
        (
          window as unknown as { __perfCollect: { measureKeys: boolean } }
        ).__perfCollect.measureKeys = false;
        window.__richPerf!.clearComposer();
      });
      await sleep(100);
      await page.evaluate(() => {
        (
          window as unknown as { __perfCollect: { measureKeys: boolean } }
        ).__perfCollect.measureKeys = true;
      });
    }
    const key = KEY_TEXT[i % KEY_TEXT.length]!;
    await page.keyboard.press(key === " " ? "Space" : key);
    await sleep(35);
  }
  await sleep(300);
  if (profileDir)
    await stopProfile(profiling, path.join(profileDir, `${server.label}-typing.cpuprofile`));
  const typingEnd = await now(page);
  const typingMain = mainThreadDelta(
    typingMainBefore,
    await mainThread(cdp),
    typingEnd - typingStart,
  );
  const keyLatencies = await page.evaluate(() => {
    const collect = (window as unknown as { __perfCollect: PageCollect & { measureKeys: boolean } })
      .__perfCollect;
    collect.measureKeys = false;
    return collect.keyLatencies.splice(0);
  });
  const typingWindow = await longTasksBetween(page, typingStart, typingEnd);
  const typing = {
    latency: summarizeDurations(keyLatencies),
    longTasks: typingWindow.longTasks,
    longAnimationFrames: typingWindow.longAnimationFrames,
    eventTimingOver16: typingWindow.slowInputEvents.length,
    eventTimingOver50: typingWindow.slowInputEvents.filter((value) => value > 50).length,
    mainThread: typingMain,
    counters: counterDelta(typingCountersBefore, await counters(page)),
  };

  // --- wheel scroll through history while streaming
  if (options.stream) {
    await page.evaluate(
      ([interval, chars]) => window.__richPerf!.startStream(interval!, chars!),
      [STREAM_INTERVAL_MS, STREAM_CHARS_PER_TICK],
    );
  }
  await page.evaluate(() => window.__richPerf!.scrollToBottom());
  await sleep(1_000);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scrollCountersBefore = await counters(page);
  await startProfile(profiling);
  const scrollMainBefore = await mainThread(cdp);
  const scrollStart = await now(page);
  await page.evaluate(() => {
    const collect = (
      window as unknown as { __perfCollect: { startFrames: () => void; startSampling: () => void } }
    ).__perfCollect;
    collect.startFrames();
    collect.startSampling();
  });
  for (let i = 0; i < WHEEL_EVENTS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA);
    await sleep(16);
  }
  await sleep(500);
  const { frames, samples } = await page.evaluate(() => {
    const collect = (
      window as unknown as {
        __perfCollect: { stopFrames: () => number[]; stopSampling: () => number[][] };
      }
    ).__perfCollect;
    return { frames: collect.stopFrames(), samples: collect.stopSampling() };
  });
  const scrollEnd = await now(page);
  const scrollMain = mainThreadDelta(
    scrollMainBefore,
    await mainThread(cdp),
    scrollEnd - scrollStart,
  );
  if (profileDir)
    await stopProfile(profiling, path.join(profileDir, `${server.label}-scroll.cpuprofile`));
  const intervals = frames.slice(1).map((time, index) => time - frames[index]!);
  const scrollWindow = await longTasksBetween(page, scrollStart, scrollEnd);
  const scroll = {
    frameInterval: summarizeDurations(intervals),
    frames: summarizeFrames(intervals, refreshMs),
    framesOver33Pct: round(
      (100 * intervals.filter((value) => value > 33.4).length) / Math.max(1, intervals.length),
      1,
    ),
    longTasks: scrollWindow.longTasks,
    longAnimationFrames: scrollWindow.longAnimationFrames,
    mainThread: scrollMain,
    queuedWork: {
      maxQueued: Math.max(0, ...samples.map((sample) => sample[0]!)),
      maxQueuedBytes: Math.max(0, ...samples.map((sample) => sample[1]!)),
      maxInflight: Math.max(0, ...samples.map((sample) => sample[2]!)),
      maxRunning: Math.max(0, ...samples.map((sample) => sample[3]!)),
    },
    counters: counterDelta(scrollCountersBefore, await counters(page)),
  };

  // --- further scroll workloads, still while streaming
  const scrollPhases: Record<string, unknown> = {};
  for (const phase of SCROLL_PHASES) {
    // Total path, not net displacement: alternating and fling phases return.
    await scroller.evaluate((element) => {
      const state = { last: element.scrollTop, path: 0 };
      (window as unknown as { __phasePath: typeof state }).__phasePath = state;
      element.addEventListener("scroll", () => {
        state.path += Math.abs(element.scrollTop - state.last);
        state.last = element.scrollTop;
      });
    });
    const phaseStart = await now(page);
    await page.evaluate(() => {
      (
        window as unknown as { __perfCollect: { startFrames: () => void } }
      ).__perfCollect.startFrames();
    });
    for (let i = 0; i < phase.events; i++) {
      await page.mouse.wheel(0, phase.deltas(i));
      await sleep(16);
    }
    await sleep(300);
    const phaseFrames = await page.evaluate(() =>
      (
        window as unknown as { __perfCollect: { stopFrames: () => number[] } }
      ).__perfCollect.stopFrames(),
    );
    const phaseEnd = await now(page);
    const travelled = await page.evaluate(
      () => (window as unknown as { __phasePath: { path: number } }).__phasePath.path,
    );
    const phaseIntervals = phaseFrames.slice(1).map((time, index) => time - phaseFrames[index]!);
    const phaseWindow = await longTasksBetween(page, phaseStart, phaseEnd);
    scrollPhases[phase.name] = {
      travelledPx: round(travelled),
      frames: summarizeFrames(phaseIntervals, refreshMs),
      longTasks: phaseWindow.longTasks,
      longAnimationFrames: phaseWindow.longAnimationFrames,
    };
  }
  const controller = await scrollControllerCounters(page);

  // --- covered by another tab while streaming, then brought back
  await page.evaluate(() => window.__richPerf!.scrollToBottom());
  await sleep(500);
  const ticksBeforeHidden = (await counters(page)).streamTicks;
  const cover = await context.newPage();
  await cover.goto("about:blank");
  await cover.bringToFront();
  await sleep(10_000);
  const hiddenState = await page.evaluate(() => document.visibilityState);
  const hiddenTicks = (await counters(page)).streamTicks;
  const shownAt = await now(page);
  await page.bringToFront();
  const firstFrameMs = await page.evaluate(
    (start) =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => resolve(performance.now() - start)),
      ),
    shownAt,
  );
  await sleep(3_000);
  const shownEnd = await now(page);
  const shownWindow = await longTasksBetween(page, shownAt, shownEnd);
  const covered = {
    visibilityWhileCovered: hiddenState,
    streamTicksWhileCovered: hiddenTicks - ticksBeforeHidden,
    firstFrameAfterShownMs: round(firstFrameMs),
    longTasks: shownWindow.longTasks,
    longAnimationFrames: shownWindow.longAnimationFrames,
  };
  await cover.close();
  await page.evaluate(() => window.__richPerf!.stopStream());

  // --- scroll / expand / reopen cycles
  const cycles = await runCycles(page, cdp, box, options.cycles);

  const result = {
    load: { ...load, counters: counterDelta(ZERO_COUNTERS, loadCounters) },
    typing,
    scroll,
    scrollPhases,
    /** Null where the checkout has no transcript scroll controller (baseline). */
    controller,
    refreshMs: round(refreshMs),
    covered,
    cycles,
    unexpectedCommands: (await counters(page)).unexpectedCommands,
  };
  await context.close();
  return result;
}

const ZERO_COUNTERS: Counters = {
  rowMounts: 0,
  richBlockMounts: 0,
  codeBlockMounts: 0,
  highlighterInvocations: 0,
  workersCreated: 0,
  workersTerminated: 0,
  backendCalls: {},
  unexpectedCommands: 0,
  streamTicks: 0,
  streamChars: 0,
};

interface CycleSample {
  cycle: number;
  liveWorkers: number;
  domNodes: number;
  mountedRows: number;
  heapUsedMiB: number;
  schedulerSettled: number | null;
  schedulerSettledBytes: number | null;
  schedulerQueued: number | null;
  schedulerInflight: number | null;
  artifactRequestEntries: number | null;
  artifactRequestBytes: number | null;
  viewStoreEntries: number | null;
}

/** History regions revisited by the cycles; a leak shows as growth after the first rotation. */
const CYCLE_REGIONS = 5;

async function sampleStats(page: Page, cdp: CDPSession, cycle: number): Promise<CycleSample> {
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const stats = await page.evaluate(() => window.__richPerf!.stats());
  const scheduler = stats.scheduler as
    | { settled: number; settledBytes: number; queued: number; inflight: number }
    | undefined;
  const artifactRequests = stats.artifactRequests as { entries: number; bytes: number } | undefined;
  const viewStore = stats.viewStore as { entries: number } | undefined;
  return {
    cycle,
    liveWorkers: stats.liveWorkers as number,
    domNodes: stats.domNodes as number,
    mountedRows: stats.mountedRows as number,
    heapUsedMiB: round(heap.usedSize / (1024 * 1024)),
    schedulerSettled: scheduler?.settled ?? null,
    schedulerSettledBytes: scheduler?.settledBytes ?? null,
    schedulerQueued: scheduler?.queued ?? null,
    schedulerInflight: scheduler?.inflight ?? null,
    artifactRequestEntries: artifactRequests?.entries ?? null,
    artifactRequestBytes: artifactRequests?.bytes ?? null,
    viewStoreEntries: viewStore?.entries ?? null,
  };
}

async function runCycles(
  page: Page,
  cdp: CDPSession,
  box: { x: number; y: number; width: number; height: number },
  count: number,
) {
  const richIndices = await page.evaluate(() => window.__richPerf!.richIndices());
  const samples: CycleSample[] = [];
  for (let cycle = 1; cycle <= count; cycle++) {
    // Jump to one of a fixed set of history regions, expand what is collapsed
    // there, wheel through it, then close and reopen the conversation.
    const region = (cycle - 1) % CYCLE_REGIONS;
    const target = richIndices[Math.floor(((region + 0.5) * richIndices.length) / CYCLE_REGIONS)]!;
    await page.evaluate((index) => window.__richPerf!.scrollToIndex(index), target);
    await sleep(400);
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="rich-transcript-perf"]');
      if (!root) return;
      const viewport = root.querySelector("[data-virtuoso-scroller]")!.getBoundingClientRect();
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(
          'details:not([open]) > summary, button[aria-expanded="false"]',
        ),
      ).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom && rect.height > 0;
      });
      for (const element of candidates.slice(0, 3)) element.click();
    });
    await sleep(300);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, i < 15 ? -300 : 300);
      await sleep(16);
    }
    await sleep(300);
    await page.evaluate(() => window.__richPerf!.remount());
    await page.waitForSelector("[data-item-index]");
    await sleep(800);
    samples.push(await sampleStats(page, cdp, cycle));
  }

  // Sweep: visit every rich message once so more distinct blocks render than
  // the settled cache may hold; it must stay within its entry/byte bounds.
  const sweepMax = { settled: 0, settledBytes: 0, queued: 0, queuedBytes: 0 };
  for (const index of richIndices) {
    await page.evaluate((target) => window.__richPerf!.scrollToIndex(target), index);
    await sleep(120);
    const stats = await page.evaluate(() => window.__richPerf!.stats());
    const scheduler = stats.scheduler as
      | { settled: number; settledBytes: number; queued: number; queuedBytes: number }
      | undefined;
    if (!scheduler) continue;
    sweepMax.settled = Math.max(sweepMax.settled, scheduler.settled);
    sweepMax.settledBytes = Math.max(sweepMax.settledBytes, scheduler.settledBytes);
    sweepMax.queued = Math.max(sweepMax.queued, scheduler.queued);
    sweepMax.queuedBytes = Math.max(sweepMax.queuedBytes, scheduler.queuedBytes);
  }
  await sleep(1_000);
  const afterSweep = await sampleStats(page, cdp, count + 1);
  const sweepCounters = await page.evaluate(
    () => (window.__richPerf!.stats().schedulerCounters ?? null) as Record<string, number> | null,
  );
  const sweep = {
    richMessagesVisited: richIndices.length,
    max: sweepMax,
    after: afterSweep,
    evicted: sweepCounters?.evicted ?? null,
    refused: sweepCounters?.refused ?? null,
  };
  return { samples, sweep, verdict: convergence(samples, sweep) };
}

function convergence(
  samples: CycleSample[],
  sweep: { max: { settled: number; settledBytes: number; queued: number; queuedBytes: number } },
) {
  const failures: string[] = [];
  const last = samples.at(-1)!;
  const maxOf = (list: CycleSample[], key: keyof CycleSample) =>
    Math.max(...list.map((sample) => Number(sample[key] ?? 0)));
  const bound = (key: keyof CycleSample, limit: number) => {
    const max = maxOf(samples, key);
    if (max > limit) failures.push(`${key} max ${max} exceeds ${limit}`);
  };
  const rich = last.schedulerSettled !== null;
  if (rich) {
    bound("schedulerSettled", FRONTEND_RENDER_POLICY.maxSettledCacheEntries);
    bound("schedulerSettledBytes", FRONTEND_RENDER_POLICY.maxSettledCacheBytes);
    bound("schedulerQueued", FRONTEND_RENDER_POLICY.maxQueuedJobs);
    if (sweep.max.settled > FRONTEND_RENDER_POLICY.maxSettledCacheEntries)
      failures.push(`sweep settled ${sweep.max.settled} exceeds the entry bound`);
    if (sweep.max.settledBytes > FRONTEND_RENDER_POLICY.maxSettledCacheBytes)
      failures.push(`sweep settled bytes ${sweep.max.settledBytes} exceed the byte bound`);
    if (sweep.max.queued > FRONTEND_RENDER_POLICY.maxQueuedJobs)
      failures.push(`sweep queued ${sweep.max.queued} exceeds the queue bound`);
    if (sweep.max.queuedBytes > FRONTEND_RENDER_POLICY.maxQueuedSourceBytes)
      failures.push(`sweep queued bytes ${sweep.max.queuedBytes} exceed the queue byte bound`);
  }
  if (last.viewStoreEntries !== null) {
    bound(
      "viewStoreEntries",
      FRONTEND_RENDER_POLICY.maxInactiveViewStateEntries +
        FRONTEND_RENDER_POLICY.maxActiveViewStateEntries +
        FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries,
    );
  }
  // One highlighter worker per window at most.
  bound("liveWorkers", 1);
  // Converged: once every region has been visited (the first rotation), later
  // revisits of the same regions do not grow retained state beyond slack.
  const warm = samples.slice(0, CYCLE_REGIONS);
  const later = samples.slice(CYCLE_REGIONS);
  const grows = (key: keyof CycleSample, slack: number) => {
    if (later.length < CYCLE_REGIONS) return;
    const early = maxOf(warm, key);
    const late = maxOf(later, key);
    if (late > early * (1 + slack) + 1) failures.push(`${key} grew from ${early} to ${late}`);
  };
  grows("domNodes", 0.05);
  grows("heapUsedMiB", 0.1);
  grows("liveWorkers", 0);
  if (rich) {
    grows("schedulerSettled", 0);
    grows("schedulerSettledBytes", 0.05);
  }
  if (last.artifactRequestEntries !== null) grows("artifactRequestEntries", 0);
  if (last.viewStoreEntries !== null) grows("viewStoreEntries", 0.1);
  return { converged: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Main.

/** Commit and dirty state of a measured checkout, so a report names what it measured. */
function checkoutMetadata(root: string): { commit: string | null; dirty: boolean | null } {
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

type RunResult = Awaited<ReturnType<typeof measureRun>>;

function gateMetrics(result: RunResult) {
  return {
    composerMedianMs: result.typing.latency.median,
    composerP95Ms: result.typing.latency.p95,
    scrollFrameMedianMs: result.scroll.frameInterval.median,
    scrollFrameP95Ms: result.scroll.frameInterval.p95,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const workDir = mkdtempSync(path.join(tmpdir(), "rich-transcripts-perf-"));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(repositoryRoot, "output/benchmarks/rich-transcripts");
  mkdirSync(outputDir, { recursive: true });
  const profileDir = options.cpuProfile ? path.join(outputDir, `${runId}-profiles`) : null;
  if (profileDir) mkdirSync(profileDir, { recursive: true });

  const servers: Server[] = [];
  try {
    for (const [index, { label, root }] of options.roots.entries()) {
      console.log(`[perf] building and serving ${label}`);
      servers.push(
        await startServer(label, root, options.basePort + index, workDir, options.minify),
      );
    }
    const results: Record<string, RunResult[]> = {};
    let browserVersion = "";
    for (let runIndex = 1; runIndex <= options.runs; runIndex++) {
      // Alternate order each run so neither target always goes first.
      const order = runIndex % 2 === 1 ? servers : [...servers].reverse();
      for (const server of order) {
        const browser = await chromium.launch({
          channel: "chrome",
          headless: !options.headed,
          args: [
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
          ],
        });
        browserVersion = browser.version();
        try {
          const result = await measureRun(browser, server, options, profileDir);
          (results[server.label] ??= []).push(result);
          const gate = gateMetrics(result);
          console.log(
            `[perf] run ${runIndex} ${server.label}: composer median ${gate.composerMedianMs} p95 ${gate.composerP95Ms} ms; scroll frame median ${gate.scrollFrameMedianMs} p95 ${gate.scrollFrameP95Ms} ms; long tasks typing ${result.typing.longTasks.count} scroll ${result.scroll.longTasks.count}; converged ${result.cycles.verdict.converged}`,
          );
        } finally {
          await browser.close();
        }
      }
    }

    const summary: Record<string, unknown> = {};
    for (const [label, runs] of Object.entries(results)) {
      const metric = (pick: (run: RunResult) => number) => {
        const values = runs.map(pick);
        const mid = median(values);
        return {
          medianOfRuns: round(mid),
          runs: values.map((value) => round(value)),
          spreadPct: round((100 * (Math.max(...values) - Math.min(...values))) / mid, 1),
        };
      };
      summary[label] = {
        composerMedianMs: metric((run) => run.typing.latency.median),
        composerP95Ms: metric((run) => run.typing.latency.p95),
        scrollFrameMedianMs: metric((run) => run.scroll.frameInterval.median),
        scrollFrameP95Ms: metric((run) => run.scroll.frameInterval.p95),
        scrollFramesOver33Pct: metric((run) => run.scroll.framesOver33Pct),
        refreshMs: metric((run) => run.refreshMs),
        scrollFrameP99Ms: metric((run) => run.scroll.frames.p99),
        scrollFramesOver1_5TPct: metric((run) => run.scroll.frames.over1_5TPct),
        scrollFramesOver2TPct: metric((run) => run.scroll.frames.over2TPct),
        ...Object.fromEntries(
          SCROLL_PHASES.flatMap((phase) => {
            const pick = (run: RunResult) =>
              run.scrollPhases[phase.name] as {
                travelledPx: number;
                frames: ReturnType<typeof summarizeFrames>;
              };
            return [
              [`${phase.name}TravelledPx`, metric((run) => pick(run).travelledPx)],
              [`${phase.name}FrameP95Ms`, metric((run) => pick(run).frames.p95)],
              [`${phase.name}FrameP99Ms`, metric((run) => pick(run).frames.p99)],
              [`${phase.name}FramesOver2TPct`, metric((run) => pick(run).frames.over2TPct)],
            ];
          }),
        ),
        controllerWrites: runs.every((run) => run.controller)
          ? metric((run) => run.controller!.writes ?? 0)
          : "unavailable",
        controllerStaleCallbacksRefused: runs.every((run) => run.controller)
          ? metric((run) => run.controller!.staleCallbacksRefused ?? 0)
          : "unavailable",
        typingLongTasks: metric((run) => run.typing.longTasks.count),
        typingLongTaskMs: metric((run) => run.typing.longTasks.totalMs),
        scrollLongTasks: metric((run) => run.scroll.longTasks.count),
        scrollLongTaskMs: metric((run) => run.scroll.longTasks.totalMs),
        scrollLongTaskP95Ms: metric((run) => run.scroll.longTasks.p95Ms),
        typingMainThreadBusyPct: metric((run) => run.typing.mainThread.busyPct),
        typingScriptMs: metric((run) => run.typing.mainThread.scriptMs),
        scrollMainThreadBusyPct: metric((run) => run.scroll.mainThread.busyPct),
        scrollScriptMs: metric((run) => run.scroll.mainThread.scriptMs),
        scrollRowMounts: metric((run) => run.scroll.counters.rowMounts),
        scrollRichBlockMounts: metric((run) => run.scroll.counters.richBlockMounts),
        scrollHighlighterInvocations: metric((run) => run.scroll.counters.highlighterInvocations),
        typingHighlighterInvocations: metric((run) => run.typing.counters.highlighterInvocations),
        scrollMaxQueued: metric((run) => run.scroll.queuedWork.maxQueued),
        finalSettledCacheBytes: metric(
          (run) => run.cycles.samples.at(-1)?.schedulerSettledBytes ?? 0,
        ),
        finalHeapMiB: metric((run) => run.cycles.samples.at(-1)?.heapUsedMiB ?? 0),
        loadFirstRowMs: metric((run) => run.load.firstRowMs),
        loadLongTaskMs: metric((run) => run.load.longTasks.totalMs),
        loadMessages: metric((run) => run.load.messages),
        loadTranscriptMiB: metric((run) => run.load.transcriptBytes / (1024 * 1024)),
        shownFirstFrameMs: metric((run) => run.covered.firstFrameAfterShownMs),
        shownLongTasks: metric((run) => run.covered.longTasks.count),
        shownLongTaskMs: metric((run) => run.covered.longTasks.totalMs),
        shownLongAnimationFrameBlockingMs: metric(
          (run) => run.covered.longAnimationFrames.blockingMs,
        ),
        coveredWasHidden: runs.every((run) => run.covered.visibilityWhileCovered === "hidden"),
        allConverged: runs.every((run) => run.cycles.verdict.converged),
        unexpectedCommands: runs.reduce((sum, run) => sum + run.unexpectedCommands, 0),
      };
    }

    let gate: Record<string, unknown> | null = null;
    if (servers.length >= 2) {
      const [change, baseline] = [servers[0]!.label, servers[1]!.label];
      const pick = (label: string, key: string) =>
        (summary[label] as Record<string, { medianOfRuns: number }>)[key]!.medianOfRuns;
      const compare = (key: string) => {
        const base = pick(baseline, key);
        const next = pick(change, key);
        const regressionPct = round((100 * (next - base)) / base, 1);
        return { baseline: base, change: next, regressionPct, pass: regressionPct <= 10 };
      };
      const checks = {
        composerMedianMs: compare("composerMedianMs"),
        composerP95Ms: compare("composerP95Ms"),
        scrollFrameMedianMs: compare("scrollFrameMedianMs"),
        scrollFrameP95Ms: compare("scrollFrameP95Ms"),
      };
      const supplementary = Object.fromEntries(
        [
          "typingMainThreadBusyPct",
          "scrollMainThreadBusyPct",
          "typingLongTaskMs",
          "scrollLongTaskMs",
          "scrollFramesOver33Pct",
          "loadFirstRowMs",
          "loadLongTaskMs",
        ].map((key) => {
          const base = pick(baseline, key);
          const next = pick(change, key);
          return [key, { baseline: base, change: next }];
        }),
      );
      gate = {
        change,
        baseline,
        checks,
        supplementary,
        pass: Object.values(checks).every((check) => check.pass),
      };
    }

    const report = {
      runId,
      browserVersion,
      roots: options.roots.map((root) => ({ label: root.label, ...checkoutMetadata(root.root) })),
      environment: {
        platform: process.platform,
        arch: process.arch,
        viewport: { width: 1280, height: 900 },
        headless: !options.headed,
        minified: options.minify,
        cpuThrottle: options.cpuThrottle,
        stream: options.stream
          ? { intervalMs: STREAM_INTERVAL_MS, charsPerTick: STREAM_CHARS_PER_TICK }
          : null,
        upwardWheel: { events: WHEEL_EVENTS, delta: WHEEL_DELTA },
        scrollPhases: SCROLL_PHASES.map((phase) => ({ name: phase.name, events: phase.events })),
      },
      options: { ...options, roots: options.roots.map((root) => root.label) },
      summary,
      gate,
      results,
    };
    const reportFile = path.join(outputDir, `${runId}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[perf] browser ${browserVersion}`);
    console.log(`[perf] summary ${JSON.stringify(summary)}`);
    if (gate) console.log(`[perf] gate ${JSON.stringify(gate)}`);
    console.log(`[perf] report ${path.relative(repositoryRoot, reportFile)}`);
    const converged = Object.values(results).every((runs) =>
      runs.every((run) => run.cycles.verdict.converged),
    );
    if ((gate && gate.pass !== true) || !converged) process.exitCode = 1;
  } finally {
    for (const server of servers) {
      if (server.process.pid) process.kill(-server.process.pid, "SIGTERM");
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
