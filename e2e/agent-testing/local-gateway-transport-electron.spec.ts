import type { OrkestratorElectronApi } from "../../apps/desktop/electron/preload-api";
import type { ElectronApplication, Page } from "playwright";
import { _electron as electron } from "playwright";
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { stopProcessGroup } from "../process-cleanup";
import { closeElectronWithin } from "./design-electron-cleanup";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import {
  ELECTRON_TEST_SWITCHES,
  HEADLESS_ELECTRON_SWITCHES,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import {
  countsDir,
  electronExecutable,
  electronMain,
  packageRoot,
  repositoryRoot,
  startTransportStack,
  webRoot,
} from "./local-gateway-transport-stack";
import { electronSpecEnvironment } from "./electron-spec-environment";
import { terminalVisibleText } from "./terminal-visible-text";
import { watchElectronStartup } from "./electron-startup-recovery";

/**
 * The `localWindowGatewayTransport` setting in a real Electron window, off and
 * on (to-do 1202 task 12). Each run writes the counts recorded in that to-do: one
 * terminal printing LINE_COUNT lines with one window open. It also records
 * Electron main's CPU time (`process.cpuUsage()`) and the window's renderer CPU
 * time while idle, during that load and during a BURST_LINES burst with no
 * pauses, which is the main-process baseline the E26 report asked for. Ends of
 * the loads are detected from the page's own terminal listener, so the waiting
 * adds no command through main.
 *
 * Playwright drives these windows over the DevTools protocol, and with the
 * direct transport every stream chunk the page receives becomes a DevTools
 * network event that main forwards to it (to-do 5760). So main's figures
 * here overstate the direct transport; `local-gateway-transport-cpu-electron.spec.ts`
 * measures main with no DevTools client attached.
 */

type RendererWindow = Window & {
  orkestrator?: OrkestratorElectronApi & {
    eventStreamConnection?: { state(): string };
  };
  orkestratorDesktopHost?: { api: OrkestratorElectronApi };
};

type Project = { id: string; name: string };
type MainTransport = {
  invokes: number;
  events: string[];
  writes: string[];
  streamBytes: number;
};
type PageTransport = {
  invokes: number;
  events: string[];
  writes: string[];
  streams: AbortController[];
  sources: EventSource[];
};
type Environment = { id: string; name: string };
type CpuSample = { mainMicros: number; rendererSeconds: number; at: number };
type CpuWindow = { wallMs: number; mainCpuMs: number; rendererCpuMs: number };
type Frames = { count: number; desynced: number; tail: string };
type Counts = {
  mode: "relay" | "gateway";
  idle: CpuWindow;
  /** Idle again, polling the page as the load windows do: the harness's own floor. */
  idlePolled: CpuWindow;
  load: CpuWindow;
  burst: CpuWindow & { lines: number; relayedEvents: number; framesDelivered: number };
  /** The same two loads with a second window showing the same terminal. */
  twoWindows: { load: CpuWindow; burst: CpuWindow; relayedEvents: number };
  relayedEvents: number;
  relayedTerminalEvents: number;
  mainInvokes: number;
  mainStreamBytes: number;
  mainEventStreamUrls: string[];
  pageInvokes: number;
  pageEventStreamUrls: string[];
  terminalFramesDelivered: number;
};

const previewDir = path.join(repositoryRoot, "output", "visual-previews");
const LINE_COUNT = 300;
const BURST_LINES = 200_000;
const IDLE_MS = 5_000;

/** Counts what main sends a window and what it asks of the backend. */
async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & { __transport?: MainTransport };
    if (state.__transport) return;
    const transport: MainTransport = { invokes: 0, events: [], writes: [], streamBytes: 0 };
    state.__transport = transport;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/__orkestrator/invoke")) {
        transport.invokes += 1;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body.command === "local_terminal_write") transport.writes.push(body.args.sessionId);
      }
      if (!url.includes("/__orkestrator/events")) return original(input, init);
      transport.events.push(url);
      const response = await original(input, init);
      if (!response.body) return response;
      const [consumer, counted] = response.body.tee();
      void (async () => {
        const reader = counted.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          transport.streamBytes += value.byteLength;
        }
      })().catch(() => undefined);
      return new Response(consumer, response);
    }) as typeof fetch;
  });
}

/** Main's own CPU time, and the renderers' cumulative CPU time, at one instant. */
async function sampleCpu(app: ElectronApplication): Promise<CpuSample> {
  return app.evaluate(({ app: electronApp }) => {
    const usage = process.cpuUsage();
    const rendererSeconds = electronApp
      .getAppMetrics()
      .filter((metric) => metric.type === "Tab")
      .reduce((total, metric) => total + (metric.cpu.cumulativeCPUUsage ?? 0), 0);
    return { mainMicros: usage.user + usage.system, rendererSeconds, at: Date.now() };
  });
}

/**
 * With `ORKESTRATOR_LOCAL_TRANSPORT_PROFILE=1` the two-window burst is also
 * profiled (to-do 5760): a V8 CPU profile of main's JavaScript (`.cpuprofile`,
 * summarised in `.summary.json`) and a Chromium trace (`.perfetto-trace`,
 * Perfetto protobuf: read it with Perfetto's `trace_processor`), whose
 * `toplevel` tasks carry each thread's own CPU time and whose `mojom` slices
 * name the interface each task served. The profiled run's CPU figures include
 * the profilers' overhead, so measure without it.
 */
const PROFILE = process.env.ORKESTRATOR_LOCAL_TRANSPORT_PROFILE === "1";
const TRACE_CATEGORIES = ["toplevel", "toplevel.flow", "mojom", "ipc", "net", "loading"];

async function startProfiling(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ contentTracing }, categories) => {
    const inspector = process.getBuiltinModule("node:inspector");
    const session = new inspector.Session();
    session.connect();
    const post = (method: string, params?: object) =>
      new Promise<unknown>((resolve, reject) =>
        session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
      );
    (globalThis as typeof globalThis & { __profiler?: typeof post }).__profiler = post;
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 200 });
    await contentTracing.startRecording({
      included_categories: categories,
      excluded_categories: ["*"],
      trace_buffer_size_in_kb: 256 * 1024,
    });
    await post("Profiler.start");
  }, TRACE_CATEGORIES);
}

async function stopProfiling(app: ElectronApplication, base: string): Promise<void> {
  const profile = await app.evaluate(async ({ contentTracing }, tracePath) => {
    const post = (
      globalThis as typeof globalThis & {
        __profiler: (method: string, params?: object) => Promise<{ profile: unknown }>;
      }
    ).__profiler;
    const { profile } = await post("Profiler.stop");
    await contentTracing.stopRecording(tracePath);
    return JSON.stringify(profile);
  }, `${base}.perfetto-trace`);
  await writeFile(`${base}.cpuprofile`, profile);
  await writeFile(
    `${base}.summary.json`,
    `${JSON.stringify(summariseCpuProfile(JSON.parse(profile)), null, 2)}\n`,
  );
}

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
};

/** Self and inclusive time per JavaScript function in main. */
function summariseCpuProfile(profile: {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const label = (node: ProfileNode) =>
    `${node.callFrame.functionName || "(anonymous)"} ${path.basename(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let busy = 0;
  profile.samples.forEach((id, index) => {
    const micros = profile.timeDeltas[index] ?? 0;
    const node = nodes.get(id)!;
    if (node.callFrame.functionName === "(idle)") return;
    busy += micros;
    self.set(label(node), (self.get(label(node)) ?? 0) + micros);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
      const key = label(nodes.get(at)!);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + micros);
    }
  });
  const top = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([fn, micros]) => ({ fn, ms: Math.round(micros / 100) / 10 }));
  return { busyMs: Math.round(busy / 100) / 10, topSelf: top(self), topInclusive: top(inclusive) };
}

function cpuWindow(start: CpuSample, end: CpuSample): CpuWindow {
  return {
    wallMs: end.at - start.at,
    mainCpuMs: Math.round((end.mainMicros - start.mainMicros) / 100) / 10,
    rendererCpuMs: Math.round((end.rendererSeconds - start.rendererSeconds) * 10_000) / 10,
  };
}

async function countRelay(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis as typeof globalThis & {
      __relay?: { events: number; terminal: number };
    };
    // Restarts the count; every open window adds to it, each hooked once.
    const relay = { events: 0, terminal: 0 };
    state.__relay = relay;
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      const contents = browserWindow.webContents as typeof browserWindow.webContents & {
        __relayCounted?: boolean;
      };
      if (contents.__relayCounted) continue;
      contents.__relayCounted = true;
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        const current = (globalThis as typeof globalThis & { __relay?: typeof relay }).__relay;
        if (channel === "orkestrator:event" && current) {
          current.events += 1;
          if (String(args[0]).startsWith("terminal-output-")) current.terminal += 1;
        }
        send(channel, ...args);
      };
    }
  });
}

/**
 * A development window opens a detached DevTools window (`window.ts`), which
 * records every network load and stream chunk of its page and costs main a
 * DevTools message for each. A shipped window has none, so the measured loads
 * run without them (to-do 5760).
 */
async function closeDevTools(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      if (browserWindow.webContents.isDevToolsOpened()) browserWindow.webContents.closeDevTools();
    }
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.webContents.isDevToolsOpened()),
      ),
    )
    .toBe(false);
}

async function clickNewWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === "New Window") return item;
        const nested = item.submenu ? find(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
}

/** Counts what the page asks of the backend, and keeps its streams so a test can drop them. */
async function instrumentPage(window: Page): Promise<void> {
  // The main stream opens as the application loads, so this precedes the page's scripts.
  await window.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __page?: PageTransport };
    if (state.__page) return;
    const page: PageTransport = { invokes: 0, events: [], writes: [], streams: [], sources: [] };
    state.__page = page;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/__orkestrator/invoke")) {
        page.invokes += 1;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body.command === "local_terminal_write") page.writes.push(body.args.sessionId);
      }
      if (!url.includes("/__orkestrator/events")) return originalFetch(input, init);
      page.events.push(url);
      const drop = new AbortController();
      page.streams.push(drop);
      return originalFetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, drop.signal]) : drop.signal,
      });
    }) as typeof fetch;
    const OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = class extends OriginalEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        page.events.push(String(url));
        page.sources.push(this);
      }
    } as typeof EventSource;
  });
}

async function runScenario(mode: Counts["mode"], temporaryRoot: string): Promise<Counts> {
  const root = path.join(temporaryRoot, mode);
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  try {
    const stack = await startTransportStack(mode, root, `electron-transport-${mode}`);
    vite = stack.vite;
    const { profile, profilePath, projectPath, rendererUrl } = stack;
    const headless = headlessElectronRequested();
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
        electronMain,
      ],
      cwd: repositoryRoot,
      env: electronSpecEnvironment(
        headless ? withoutDisplay(stack.electronEnv) : stack.electronEnv,
      ),
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    // Every window here loads its modules from Vite: a load that lost them to
    // ERR_NETWORK_CHANGED is reloaded, and only that (flake 2340).
    const startup = watchElectronStartup(electronApp);
    dismissStartupDialogs(electronApp);
    await instrumentMain(electronApp);
    const window = await electronApp.firstWindow();
    window.setDefaultTimeout(20_000);
    await startup.waitForTitle(window, profile.electronTitle, { timeoutMs: 60_000 });

    const composed = await window.evaluate(() => ({
      host: "orkestratorDesktopHost" in window,
      gateway: "orkestratorGateway" in window,
      hostKeys: Object.keys(
        (window as unknown as { orkestratorDesktopHost?: object }).orkestratorDesktopHost ?? {},
      ).sort(),
      connection: Boolean((globalThis.window as RendererWindow).orkestrator?.eventStreamConnection),
    }));
    expect(composed.gateway, "a local window is never a remote gateway client").toBe(false);
    expect(composed.host).toBe(mode === "gateway");
    expect(composed.connection).toBe(mode === "gateway");
    if (mode === "gateway") expect(composed.hostKeys).toEqual(["api", "baseUrl"]);

    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      window.evaluate(
        ({ command, args }) =>
          (globalThis.window as RendererWindow).orkestrator!.invoke<T>(command, args),
        {
          command,
          args,
        },
      );
    const project = await invoke<Project>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const created: Environment[] = [];
    for (const name of ["transport", "transport-other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: project.id,
        name: `${name}-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      created.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-shell",
          root: {
            kind: "leaf",
            id: "pane-shell",
            activeTabId: "tab-shell",
            tabs: [{ id: "tab-shell", type: "plain" }],
          },
        },
      });
    }
    const [target, other] = created as [Environment, Environment];

    await instrumentPage(window);
    await window.reload();
    await startup.waitForTitle(window, profile.electronTitle, { timeoutMs: 60_000 });
    const openEnvironment = async (name: string, page: Page = window) => {
      const expand = page.getByRole("button", { name: `Expand project ${project.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      // A startup dialog can cover the sidebar for a moment, so ask again until the row shows.
      await expect(async () => {
        if (await expand.isVisible()) await expand.click();
        await expect(entry).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await page.mouse.move(0, 0);
      await entry.click();
    };
    const focusTerminal = async () => {
      const terminal = window.locator(".xterm:visible").first();
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
    };
    const runInTerminal = async (line: string) => {
      await focusTerminal();
      await window.keyboard.type(line, { delay: 15 });
      await window.keyboard.press("Enter");
    };
    /**
     * Types `line`, then samples CPU and presses Enter, so the window measures
     * the command's output and not the typing: main is Chromium's browser
     * process, which handles every synthetic key.
     */
    const measureInTerminal = async (
      line: string,
      marker: string,
      profileAs?: string,
    ): Promise<CpuWindow> => {
      await focusTerminal();
      await window.keyboard.type(line, { delay: 15 });
      if (profileAs) await startProfiling(electronApp);
      const start = await sampleCpu(electronApp);
      await window.keyboard.press("Enter");
      await expect.poll(() => reached(marker), { timeout: 120_000, intervals: [50] }).toBe(true);
      const measured = cpuWindow(start, await sampleCpu(electronApp));
      if (profileAs) {
        await mkdir(countsDir, { recursive: true });
        await stopProfiling(electronApp, path.join(countsDir, profileAs));
      }
      return measured;
    };

    const renderedOutput = () =>
      window.evaluate(
        async ({ environmentId }) => {
          const module = await import(
            /* @vite-ignore */ String("/src/stores/terminalPortalStore.ts")
          );
          const data = module.useTerminalPortalStore
            .getState()
            .getTerminal(module.commandTerminalPortalNodeId(), environmentId, "tab-shell");
          const buffer = data?.terminal.buffer.active;
          if (!buffer) return "";
          return Array.from(
            { length: buffer.length },
            (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
          ).join("\n");
        },
        { environmentId: target.id },
      );
    await openEnvironment(target.name);
    await closeDevTools(electronApp);
    await runInTerminal("echo READY-$((40+2))");
    const mainState = () =>
      electronApp.evaluate(
        () => (globalThis as unknown as { __transport: MainTransport }).__transport,
      );
    const pageState = () =>
      window.evaluate(() => (globalThis as unknown as { __page: PageTransport }).__page);
    const writtenSessions = async () => [
      ...(await mainState()).writes,
      ...(await pageState()).writes,
    ];
    await expect
      .poll(async () => (await writtenSessions()).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const sessionId = (await writtenSessions())[0]!;
    const output = async () =>
      terminalVisibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    await expect.poll(output, { timeout: 30_000 }).toContain("READY-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("READY-42");
    await window.evaluate((session) => {
      const state = globalThis as typeof globalThis & {
        __frames?: { count: number; desynced: number };
      };
      const frames = { count: 0, desynced: 0, tail: "" };
      state.__frames = frames;
      (globalThis.window as RendererWindow).orkestrator!.listen<{
        desynced?: boolean;
        text?: string;
      }>(`terminal-output-${session}`, (payload) => {
        frames.count += 1;
        if (payload && typeof payload === "object" && payload.desynced) frames.desynced += 1;
        if (payload && typeof payload === "object" && typeof payload.text === "string") {
          frames.tail = (frames.tail + payload.text).slice(-4096);
        }
      });
    }, sessionId);
    const frames = () =>
      window.evaluate(() => (globalThis as unknown as { __frames: Frames }).__frames);
    const relayState = () =>
      electronApp.evaluate(
        () => (globalThis as unknown as { __relay: { events: number; terminal: number } }).__relay,
      );
    // Seen by the page's own listener, or, after a desync dropped frames, in the
    // authoritative snapshot.
    const reached = async (marker: string) => {
      const seen = await frames();
      if (terminalVisibleText(seen.tail).includes(marker)) return true;
      return seen.desynced > 0 && (await output()).includes(marker);
    };

    // Idle: nothing running, same window open.
    const idleStart = await sampleCpu(electronApp);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    const idle = cpuWindow(idleStart, await sampleCpu(electronApp));
    const polledStart = await sampleCpu(electronApp);
    while (Date.now() - polledStart.at < IDLE_MS) {
      await reached("NEVER-PRINTED");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const idlePolled = cpuWindow(polledStart, await sampleCpu(electronApp));

    // The measured load: one window, one terminal printing a known number of lines.
    const before = { main: await mainState(), page: await pageState() };
    await countRelay(electronApp);
    const load = await measureInTerminal(
      `for i in $(seq 1 ${LINE_COUNT}); do echo LINE-$i; sleep 0.01; done; echo LOAD-$((40+2))`,
      "LOAD-42",
    );
    await expect.poll(output, { timeout: 60_000 }).toContain("LOAD-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("LOAD-42");
    await expect.poll(async () => (await frames()).count, { timeout: 30_000 }).toBeGreaterThan(0);
    await mkdir(previewDir, { recursive: true });
    await window.screenshot({ path: path.join(previewDir, `local-transport-${mode}.png`) });

    const relay = { ...(await relayState()) };
    const main = await mainState();
    const page = await pageState();

    // A burst with no pauses: the case where relaying terminal output costs main most.
    const framesBeforeBurst = (await frames()).count;
    const burst = {
      ...(await measureInTerminal(`seq 1 ${BURST_LINES}; echo BURST-$((40+2))`, "BURST-42")),
      lines: BURST_LINES,
      relayedEvents: (await relayState()).events - relay.events,
      framesDelivered: (await frames()).count - framesBeforeBurst,
    };
    await expect.poll(output, { timeout: 60_000 }).toContain("BURST-42");

    // Two windows on the same terminal: the relay sends every event to both.
    const secondOpened = electronApp.waitForEvent("window", {
      predicate: (page) => page.url().startsWith(rendererUrl),
      timeout: 60_000,
    });
    await clickNewWindow(electronApp);
    const extra = await secondOpened;
    extra.setDefaultTimeout(20_000);
    await startup.waitForTitle(extra, profile.electronTitle, { timeoutMs: 60_000 });
    expect(await extra.evaluate(() => "orkestratorDesktopHost" in window)).toBe(mode === "gateway");
    await openEnvironment(target.name, extra);
    await expect(extra.locator(".xterm:visible").first()).toBeVisible({ timeout: 60_000 });
    await closeDevTools(electronApp);
    await countRelay(electronApp);
    await window.bringToFront();
    const twoLoad = await measureInTerminal(
      `for i in $(seq 1 ${LINE_COUNT}); do echo TWO-$i; sleep 0.01; done; echo TWO-LOAD-$((40+2))`,
      "TWO-LOAD-42",
    );
    const twoBurst = await measureInTerminal(
      `seq 1 ${BURST_LINES}; echo TWO-BURST-$((40+2))`,
      "TWO-BURST-42",
      PROFILE ? `${mode}-two-window-burst` : undefined,
    );
    const twoWindows = {
      load: twoLoad,
      burst: twoBurst,
      relayedEvents: (await relayState()).events,
    };
    await extra.close();

    const counts: Counts = {
      mode,
      idle,
      idlePolled,
      load,
      burst,
      twoWindows,
      relayedEvents: relay.events,
      relayedTerminalEvents: relay.terminal,
      mainInvokes: main.invokes - before.main.invokes,
      mainStreamBytes: main.streamBytes - before.main.streamBytes,
      mainEventStreamUrls: main.events.map((url) =>
        new URL(url).search.replace(/since=[^&]+&?/, ""),
      ),
      pageInvokes: page.invokes - before.page.invokes,
      pageEventStreamUrls: page.events.map((url) =>
        new URL(url).search.replace(/since=[^&]+&?/, "").replace(/-[0-9a-f-]{36}/g, "-<session>"),
      ),
      terminalFramesDelivered: (await frames()).count,
    };

    if (mode === "relay") {
      expect(relay.terminal, "the relay carries terminal output").toBeGreaterThan(0);
    } else {
      expect(relay.terminal, "main relays no terminal output to this window").toBe(0);
      expect(relay.events, "main relays no backend event to this window").toBe(0);
      expect(main.events.every((url) => url.includes("excludeEvents=terminal-output-"))).toBe(true);
      expect(page.events.some((url) => url.includes("includeEvents=terminal-output-"))).toBe(true);
      expect(page.invokes).toBeGreaterThan(0);

      // Reconnect and resync: every stream this window holds fails at once.
      const desyncedBefore = (await frames()).desynced;
      const opened = await window.evaluate(() => {
        const page = (globalThis as unknown as { __page: PageTransport }).__page;
        const opened = page.events.length;
        for (const controller of page.streams.splice(0)) controller.abort();
        for (const source of page.sources.splice(0)) source.dispatchEvent(new Event("error"));
        return opened;
      });
      await expect
        .poll(async () => (await frames()).desynced, { timeout: 60_000 })
        .toBeGreaterThan(desyncedBefore);
      const reopened = () =>
        window.evaluate(
          (from) => (globalThis as unknown as { __page: PageTransport }).__page.events.slice(from),
          opened,
        );
      // Replay from a known cursor is covered by web-gateway-local-desktop.test.ts:
      // this stream may not have seen an authoritative event to hold one yet.
      await expect
        .poll(
          async () =>
            (await reopened()).some(
              (url) =>
                url.includes("excludeEvents=terminal-output-") && !url.includes("includeEvents"),
            ),
          { timeout: 60_000, message: "the main stream reopens" },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              (globalThis.window as RendererWindow).orkestrator!.eventStreamConnection!.state(),
            ),
          {
            timeout: 60_000,
          },
        )
        .toBe("connected");
      expect((await reopened()).some((url) => url.includes("includeEvents=terminal-output-"))).toBe(
        true,
      );

      // A rotated token reaches this window's requests; the page never held it.
      await window.evaluate(() =>
        (globalThis.window as RendererWindow).orkestratorDesktopHost!.api.webClient!.setToken(
          "local-transport-spec-rotated-token-0123456789",
        ),
      );
      await expect(invoke("get_config")).resolves.toBeTruthy();

      const afterDrop = (await frames()).count;
      await runInTerminal("echo AFTER-RECONNECT-$((40+2))");
      await expect.poll(output, { timeout: 30_000 }).toContain("AFTER-RECONNECT-42");
      await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("AFTER-RECONNECT-42");
      await expect
        .poll(async () => (await frames()).count, { timeout: 30_000 })
        .toBeGreaterThan(afterDrop);
    }

    // Inactive path: output arrives while another environment is showing.
    await runInTerminal("sleep 2; echo BACKGROUND-$((40+2))");
    await openEnvironment(other.name);
    await expect(window.locator(".xterm:visible").first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(output, { timeout: 30_000 }).toContain("BACKGROUND-42");
    await openEnvironment(target.name);
    await focusTerminal();
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("BACKGROUND-42");
    await runInTerminal("echo BACK-ACTIVE-$((40+2))");
    await expect.poll(output, { timeout: 30_000 }).toContain("BACK-ACTIVE-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("BACK-ACTIVE-42");

    if (mode === "gateway") {
      // Delay main's first save so pagehide queues a newer, large revision
      // while the old IPC response is still pending. No renderer promise is
      // awaited by the unload listener.
      await electronApp.evaluate(() => {
        const original = globalThis.fetch;
        let delayed = false;
        globalThis.fetch = (async (input, init) => {
          if (
            !delayed &&
            typeof init?.body === "string" &&
            JSON.parse(init.body).command === "save_file_draft"
          ) {
            delayed = true;
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
          return original(input, init);
        }) as typeof fetch;
      });
      await window.evaluate(async (environmentId) => {
        const drafts = await import(
          /* @vite-ignore */ String("/src/lib/file-draft-persistence.ts")
        );
        const state = drafts.createDraftRevisionState();
        await drafts.loadFileDraft(environmentId, "teardown.txt", state);
        void drafts.persistFileDraft(environmentId, "teardown.txt", "earlier", "baseline", state);
        globalThis.window.addEventListener(
          "pagehide",
          () => {
            void drafts.persistFileDraft(
              environmentId,
              "teardown.txt",
              "latest".repeat(20000),
              "baseline".repeat(20000),
              state,
            );
          },
          { once: true },
        );
      }, target.id);
    }

    // A reload rehydrates from the backend, on the same transport, and the
    // window keeps the project it had selected, which the title names.
    await window.reload();
    await expect(window).toHaveTitle(`${profile.electronTitle} - ${project.name}`, {
      timeout: 60_000,
    });
    await openEnvironment(target.name);
    await expect(window.locator(".xterm:visible").first()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => window.evaluate(() => "orkestratorDesktopHost" in window))
      .toBe(mode === "gateway");
    if (mode === "gateway") {
      await expect
        .poll(
          async () => {
            const saved = await invoke<{ content: string } | null>("get_file_draft", {
              draftKey: `file:${target.id}:${encodeURIComponent("teardown.txt")}`,
            });
            return saved?.content === "latest".repeat(20000);
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    }
    expect(await output()).toContain("BACK-ACTIVE-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("BACK-ACTIVE-42");
    await window.screenshot({
      path: path.join(previewDir, `local-transport-${mode}-after-reload.png`),
    });

    let client = window;
    if (mode === "relay") {
      // The switch changes only the windows created after it: this one stays on
      // the relay, the next one takes the gateway, and main's own stream gives
      // up terminal output once no open window takes it from there.
      await window.getByRole("button", { name: "Global settings", exact: true }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Experimental", exact: true })
        .click();
      const toggle = window.getByRole("switch", {
        name: "Use the direct transport for new windows",
      });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await window.screenshot({ path: path.join(previewDir, "local-transport-setting-off.png") });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => {
          const config = JSON.parse(
            await readFile(path.join(profile.dataDir, "config.json"), "utf8"),
          );
          return config.global.localWindowGatewayTransport;
        })
        .toBe(true);
      await window.screenshot({ path: path.join(previewDir, "local-transport-setting-on.png") });
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setSize(800, 600);
      });
      await toggle.scrollIntoViewIfNeeded();
      await window.screenshot({
        path: path.join(previewDir, "local-transport-setting-on-narrow.png"),
      });

      const opened = electronApp.waitForEvent("window", {
        predicate: (page) => page.url().startsWith(rendererUrl),
        timeout: 60_000,
      });
      await clickNewWindow(electronApp);
      const second = await opened;
      await startup.waitForTitle(second, /electron-transport-relay/, { timeoutMs: 60_000 });
      expect(await second.evaluate(() => "orkestratorDesktopHost" in window)).toBe(true);
      expect(await window.evaluate(() => "orkestratorDesktopHost" in window)).toBe(false);
      expect(
        await second.evaluate(() =>
          (globalThis.window as RendererWindow).orkestrator!.invoke("get_config"),
        ),
      ).toBeTruthy();
      expect((await mainState()).events.at(-1)).not.toContain("excludeEvents");

      await window.close();
      await expect
        .poll(async () => (await mainState()).events.at(-1), { timeout: 30_000 })
        .toContain("excludeEvents=terminal-output-");
      client = second;
    }

    for (const environment of created) {
      await client
        .evaluate(
          (id) =>
            (globalThis.window as RendererWindow).orkestrator!.invoke("stop_environment", {
              environmentId: id,
            }),
          environment.id,
        )
        .catch(() => undefined);
    }
    if (mode === "gateway") {
      // Relaunch in non-development mode: a Vite-mode process correctly refuses
      // IPC from file://. Disposable resources use the production renderer,
      // backend bundle, preload and trust rules, without installing a package.
      // Without those bundles the relaunched window closes at once, which reads
      // as an Electron failure; say what is missing instead.
      for (const bundle of [
        path.join(repositoryRoot, "apps", "backend", "dist", "main.js"),
        path.join(webRoot, "dist", "index.html"),
      ]) {
        expect(
          existsSync(bundle),
          `${path.relative(repositoryRoot, bundle)} is missing: run \`bun run --cwd apps/backend build\` and \`bun run --cwd apps/web build\` first`,
        ).toBe(true);
      }
      await closeElectronWithin(app);
      app = null;
      const resources = path.join(root, "file-resources");
      await mkdir(path.join(resources, "bin"), { recursive: true });
      const bunPath = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      });
      expect(bunPath.status).toBe(0);
      await symlink(bunPath.stdout, path.join(resources, "bin", "bun"));
      await symlink(
        path.join(repositoryRoot, "apps", "backend", "dist"),
        path.join(resources, "backend"),
      );
      await symlink(path.join(webRoot, "dist"), path.join(resources, "web"));
      const bootstrap = path.join(root, "file-main.cjs");
      await writeFile(
        bootstrap,
        `Object.defineProperty(process, "resourcesPath", {value: ${JSON.stringify(resources)}}); import(${JSON.stringify(path.join(packageRoot, "dist", "electron", "main.js"))});`,
      );
      const headless = headlessElectronRequested();
      app = await electron.launch({
        executablePath: electronExecutable,
        args: [
          ...ELECTRON_TEST_SWITCHES,
          ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
          bootstrap,
        ],
        cwd: repositoryRoot,
        env: electronSpecEnvironment(headless ? withoutDisplay(process.env) : process.env, {
          ELECTRON_DEV: "0",
          ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        }),
      });
      recordElectronDiagnostics(app);
      dismissStartupDialogs(app);
      const fileWindow = await app.firstWindow();
      await expect.poll(() => fileWindow.url(), { timeout: 60_000 }).toMatch(/^file:/);
      await expect
        .poll(
          () =>
            fileWindow.evaluate(() =>
              Boolean((globalThis.window as RendererWindow).orkestrator?.eventStreamConnection),
            ),
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
      const fileInvoke = <T>(command: string, args: Record<string, unknown> = {}) =>
        fileWindow.evaluate(
          ({ command, args }) =>
            (globalThis.window as RendererWindow).orkestrator!.invoke<T>(command, args),
          {
            command,
            args,
          },
        );
      expect(await fileInvoke("get_config")).toBeTruthy();
      await fileInvoke("start_environment", { environmentId: target.id });
      const terminal = await fileInvoke<{ sessionId: string }>("create_local_terminal_session", {
        environmentId: target.id,
        cols: 80,
        rows: 24,
        terminalKey: "file-smoke",
      });
      await fileWindow.evaluate((sessionId) => {
        (globalThis as typeof globalThis & { __fileTerminal?: boolean }).__fileTerminal = false;
        let received = "";
        (globalThis.window as RendererWindow).orkestrator!.listen(
          `terminal-output-${sessionId}`,
          (payload: unknown) => {
            if (payload && typeof payload === "object" && "text" in payload)
              received = (received + String(payload.text)).slice(-8192);
            if (received.includes("FILE-ORIGIN-42"))
              (globalThis as typeof globalThis & { __fileTerminal?: boolean }).__fileTerminal =
                true;
          },
        );
      }, terminal.sessionId);
      await fileInvoke("start_local_terminal_session", { sessionId: terminal.sessionId });
      await expect
        .poll(
          async () => {
            await fileInvoke("local_terminal_write", {
              sessionId: terminal.sessionId,
              data: "echo FILE-ORIGIN-42\n",
            });
            return fileWindow.evaluate(
              () => (globalThis as typeof globalThis & { __fileTerminal?: boolean }).__fileTerminal,
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await fileInvoke("stop_environment", { environmentId: target.id });
    }
    return counts;
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
  }
}

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

for (const mode of ["relay", "gateway"] as const) {
  test(`a local window on the ${mode} transport shows terminal output and recovers`, async () => {
    test.setTimeout(300_000);
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-transport-"));
    try {
      const counts = await runScenario(mode, temporaryRoot);
      await mkdir(countsDir, { recursive: true });
      await writeFile(path.join(countsDir, `${mode}.json`), `${JSON.stringify(counts, null, 2)}\n`);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
