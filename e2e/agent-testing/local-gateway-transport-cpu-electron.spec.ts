import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  listenCode,
  waitCode,
  resourceActivityCode,
  resourceQuietCode,
  parseRunCount,
} from "./local-gateway-transport-cpu-page";
import { withProfilers } from "./local-gateway-transport-lifecycle";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ownProcessGroup, stopProcessGroup, waitForStopped } from "../process-cleanup";
import { recordProcessOutput } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import {
  countsDir,
  electronExecutable,
  electronMain,
  packageRoot,
  repositoryRoot,
  startTransportStack,
  type TransportMode,
} from "./local-gateway-transport-stack";

/**
 * Electron main's CPU on each local window transport with no DevTools client
 * attached (to-do 5760). Opt in with `ORKESTRATOR_LOCAL_TRANSPORT_CPU=1`;
 * `ORKESTRATOR_LOCAL_TRANSPORT_CPU_RUNS` sets the runs per transport (default
 * three, alternating relay and gateway).
 *
 * `local-gateway-transport-electron.spec.ts` drives its windows through
 * Playwright, which holds a DevTools session on every page with the network
 * domain enabled, and a development window also opens its own DevTools window.
 * On the direct transport every load and stream chunk the page receives then
 * becomes a DevTools event that main forwards to those clients, which a
 * shipped window never pays. Here Electron starts with only main's Node
 * inspector (`--inspect=0`, which sees main's JavaScript and none of the
 * pages), the development DevTools windows are closed before anything is
 * measured, and the pages are driven with `executeJavaScript`. The load is the
 * same as that spec's: one terminal printing LINE_COUNT lines, then a
 * BURST_LINES burst, with one window and then two windows listening. A load
 * ends when every listening window has seen its marker, which each window
 * reports by resolving the one `executeJavaScript` call that waits for it, so
 * nothing polls.
 */

const LINE_COUNT = 300;
const BURST_LINES = 200_000;
const IDLE_MS = 5_000;
/**
 * `ORKESTRATOR_LOCAL_TRANSPORT_PROFILE=1` also records a V8 CPU profile of
 * main and a Chromium trace for the idle window and the two-window loads of
 * the first run (`no-devtools-<mode>-<window>.cpuprofile` and
 * `.perfetto-trace`, which Perfetto's `trace_processor` reads); those windows'
 * figures then include the profilers' overhead.
 */
const PROFILE = process.env.ORKESTRATOR_LOCAL_TRANSPORT_PROFILE === "1";
const TRACE_CATEGORIES = ["toplevel", "toplevel.flow", "mojom", "ipc", "net", "loading"];

type CpuWindow = {
  wallMs: number;
  mainCpuMs: number;
  rendererCpuMs: number;
  relayed: number;
  desyncs?: number[];
};
type RunResult = {
  mode: TransportMode;
  run: number;
  workload: "mounted-terminals";
  idle: CpuWindow;
  load: CpuWindow;
  burst: CpuWindow;
  twoWindows: { load: CpuWindow; burst: CpuWindow };
};

/** A minimal DevTools protocol client for main's Node inspector. */
class MainInspector {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: {
          result?: { value?: unknown };
          exceptionDetails?: { exception?: { description?: string }; text?: string };
        };
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      const failure =
        message.error?.message ??
        message.result?.exceptionDetails?.exception?.description ??
        message.result?.exceptionDetails?.text;
      if (failure) waiter.reject(new Error(failure));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("inspector closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<MainInspector> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("inspector refused")), {
        once: true,
      });
    });
    return new MainInspector(socket);
  }

  /** Evaluates `expression` in main, awaiting a promise, and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value as T;
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Runs `code` in window `windowId`'s page and returns its (awaited) value. */
function inPage(windowId: number, code: string): string {
  return `globalThis.__electron.BrowserWindow.fromId(${windowId}).webContents.executeJavaScript(${JSON.stringify(code)}, true)`;
}

/** `work`, or a failure naming `what` once `ms` pass, so a stalled load fails instead of hanging. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function measureRun(mode: TransportMode, run: number, root: string): Promise<RunResult> {
  let vite: ChildProcess | null = null;
  let electron: ChildProcess | null = null;
  let inspector: MainInspector | null = null;
  try {
    const stack = await startTransportStack(mode, root, `electron-transport-cpu-${mode}`);
    vite = stack.vite;
    // Keeps the electron module where the inspector can reach it, then starts
    // main exactly as the other spec does (development mode resolves its paths
    // from main's own location, not the entry script's).
    const bootstrap = path.join(root, "main-with-electron.cjs");
    await writeFile(
      bootstrap,
      `globalThis.__electron = require("electron"); import(${JSON.stringify(electronMain)});`,
    );
    const child = spawn(electronExecutable, [...ELECTRON_TEST_SWITCHES, "--inspect=0", bootstrap], {
      cwd: repositoryRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: stack.electronEnv,
    });
    electron = ownProcessGroup(child);
    recordProcessOutput("electron", child);
    const inspectorUrl = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error("main's inspector did not start")), 60_000);
      child.stderr!.on("data", (chunk: Buffer) => {
        seen = (seen + chunk.toString("utf8")).slice(-4096);
        const match = /Debugger listening on (ws:\/\/\S+)/.exec(seen);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
    });
    const main = await MainInspector.connect(inspectorUrl);
    inspector = main;
    await expect
      .poll(
        () =>
          main
            .evaluate<boolean>("Boolean(globalThis.__electron?.app.isReady())")
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);

    /** Waits for a new main window to load its page, and closes its development DevTools. */
    const awaitWindow = async (known: number[]): Promise<number> => {
      let windowId = 0;
      await expect
        .poll(
          async () => {
            const found = await main.evaluate<{ id: number; title: string; ready: boolean } | null>(
              `(() => {
                const known = ${JSON.stringify(known)};
                const window = globalThis.__electron.BrowserWindow.getAllWindows()
                  .find((candidate) => !known.includes(candidate.id) &&
                    candidate.webContents.getURL().startsWith(${JSON.stringify(stack.rendererUrl)}));
                return window ? { id: window.id, title: window.getTitle(), ready: !window.webContents.isLoading() } : null;
              })()`,
            );
            // The window title adds the connection's name to the profile's.
            if (!found?.ready || !found.title.startsWith(stack.profile.electronTitle)) return false;
            windowId = found.id;
            return main
              .evaluate<boolean>(inPage(found.id, "Boolean(window.orkestrator?.invoke)"))
              .catch(() => false);
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const devTools = (action: string) =>
        main.evaluate<boolean>(
          `globalThis.__electron.BrowserWindow.fromId(${windowId}).webContents.${action}`,
        );
      // A development window opens DevTools once its page has loaded.
      await expect.poll(() => devTools("isDevToolsOpened()"), { timeout: 15_000 }).toBe(true);
      await devTools("closeDevTools()");
      await expect.poll(() => devTools("isDevToolsOpened()")).toBe(false);
      expect(
        await main.evaluate<boolean>(inPage(windowId, `"orkestratorDesktopHost" in window`)),
      ).toBe(mode === "gateway");
      return windowId;
    };
    const first = await awaitWindow([]);
    await main.evaluate(inPage(first, resourceActivityCode));
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      main.evaluate<T>(
        inPage(
          first,
          `window.orkestrator.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
        ),
      );

    const project = await invoke<{ id: string; name: string }>("add_project", {
      gitUrl: path.join(stack.profile.fixtureDir, "origin.git"),
      localPath: stack.projectPath,
    });
    const environment = await invoke<{ id: string; name: string }>("create_environment", {
      projectId: project.id,
      name: `transport-cpu-${Date.now()}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: environment.id });
    const { sessionId } = await invoke<{ sessionId: string }>("create_local_terminal_session", {
      environmentId: environment.id,
      cols: 120,
      rows: 30,
      terminalKey: "tab-shell",
    });
    await invoke("start_local_terminal_session", { sessionId });
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
    const mountTerminal = async (id: number) => {
      // Select through the same store action as the sidebar. This keeps setup
      // independent of labels and needs no page DevTools connection.
      await main.evaluate(
        inPage(
          id,
          `(async () => {
        const { useUIStore } = await import("/src/stores/uiStore.ts");
        const { getWindowScope } = await import("/src/lib/node-scope/app-window-scope.ts");
        getWindowScope().commandScope().store(useUIStore.def).getState().selectProjectAndEnvironment(${JSON.stringify(project.id)}, ${JSON.stringify(environment.id)});
      })()`,
        ),
      );
      await expect
        .poll(
          () =>
            main.evaluate<boolean>(
              inPage(
                id,
                `Boolean(Array.from(document.querySelectorAll(".xterm")).find(element => element.getBoundingClientRect().height > 0))`,
              ),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      await main.evaluate(
        inPage(
          id,
          `(async () => {
        const module = await import("/src/stores/terminalPortalStore.ts");
        globalThis.__cpuRendered = () => {
          const buffer = module.useTerminalPortalStore.getState().getTerminal(module.commandTerminalPortalNodeId(), ${JSON.stringify(environment.id)}, "tab-shell")?.terminal.buffer.active;
          return buffer ? Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\\n") : "";
        };
      })()`,
        ),
      );
    };
    await mountTerminal(first);
    await main.evaluate(inPage(first, listenCode(sessionId)));

    // Counts the terminal events main relays to the windows, as the other spec does.
    const countRelay = () =>
      main.evaluate(`(() => {
        globalThis.__relayed ??= 0;
        for (const window of globalThis.__electron.BrowserWindow.getAllWindows()) {
          const contents = window.webContents;
          if (contents.__relayCounted) continue;
          contents.__relayCounted = true;
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            if (channel === "orkestrator:event" && String(args[0]).startsWith("terminal-output-")) {
              globalThis.__relayed += 1;
            }
            send(channel, ...args);
          };
        }
      })()`);
    await countRelay();
    const sample = () =>
      main.evaluate<{ main: number; renderer: number; at: number; relayed: number }>(
        `(() => {
          const usage = process.cpuUsage();
          const renderer = globalThis.__electron.app.getAppMetrics()
            .filter((metric) => metric.type === "Tab")
            .reduce((total, metric) => total + (metric.cpu.cumulativeCPUUsage ?? 0), 0);
          return { main: usage.user + usage.system, renderer, at: Date.now(), relayed: globalThis.__relayed };
        })()`,
      );
    const cpuWindow = (
      start: Awaited<ReturnType<typeof sample>>,
      end: Awaited<ReturnType<typeof sample>>,
    ): CpuWindow => ({
      wallMs: end.at - start.at,
      mainCpuMs: Math.round((end.main - start.main) / 100) / 10,
      rendererCpuMs: Math.round((end.renderer - start.renderer) * 10_000) / 10,
      relayed: end.relayed - start.relayed,
    });
    const listening = [first];
    /** One command, measured from its write until every listening window has its marker. */
    const profiled = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      if (!PROFILE || run !== 1) return work();
      const base = path.join(countsDir, `no-devtools-${mode}-${name}`);
      await mkdir(countsDir, { recursive: true });
      return withProfilers(
        {
          startTrace: () =>
            main.evaluate(
              `globalThis.__electron.contentTracing.startRecording(${JSON.stringify({ included_categories: TRACE_CATEGORIES, excluded_categories: ["*"], trace_buffer_size_in_kb: 256 * 1024 })})`,
            ),
          stopTrace: () =>
            main.evaluate(
              `globalThis.__electron.contentTracing.stopRecording(${JSON.stringify(`${base}.perfetto-trace`)})`,
            ),
          startCpu: async () => {
            await main.send("Profiler.enable");
            await main.send("Profiler.setSamplingInterval", { interval: 200 });
            await main.send("Profiler.start");
          },
          stopCpu: async () => {
            const { profile } = await main.send<{ profile: unknown }>("Profiler.stop");
            await writeFile(`${base}.cpuprofile`, JSON.stringify(profile));
          },
        },
        work,
      );
    };
    const measure = async (line: string, marker: string): Promise<CpuWindow> => {
      const desyncs = () =>
        Promise.all(
          listening.map((id) =>
            main.evaluate<number>(inPage(id, "globalThis.__cpuTerminal.desynced")),
          ),
        );
      const beforeDesyncs = await desyncs();
      const wait = JSON.stringify(waitCode(sessionId, marker));
      await main.evaluate(
        `globalThis.__done = Promise.all(${JSON.stringify(listening)}.map((id) =>
          globalThis.__electron.BrowserWindow.fromId(id).webContents.executeJavaScript(${wait}, true)));
        true`,
      );
      const start = await sample();
      await invoke("local_terminal_write", { sessionId, data: `${line}\n` });
      await within(
        main.evaluate("globalThis.__done"),
        120_000,
        `${mode} run ${run}: ${marker}`,
      ).catch(async (error: Error) => {
        // Which window missed it, and what it did receive (counts and keys only).
        const seen = await Promise.all(
          listening.map((id) =>
            main
              .evaluate(
                inPage(
                  id,
                  `({ window: ${id}, count: globalThis.__cpuTerminal.count, desynced: globalThis.__cpuTerminal.desynced, keys: globalThis.__cpuTerminal.keys })`,
                ),
              )
              .catch(String),
          ),
        );
        throw new Error(`${error.message}: ${JSON.stringify(seen)}`);
      });
      const measured = cpuWindow(start, await sample());
      // Verify the actual xterm buffers outside the measured interval. Every
      // window must finish rendering the same marker its transport received.
      for (const id of listening) {
        await expect
          .poll(
            () =>
              main.evaluate<boolean>(
                inPage(id, `globalThis.__cpuRendered().includes(${JSON.stringify(marker)})`),
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
      }
      console.log(`[transport-cpu] ${mode} run ${run}: ${marker}`);
      return {
        ...measured,
        desyncs: (await desyncs()).map((count, i) => count - beforeDesyncs[i]!),
      };
    };

    /**
     * Waits until no listening window has loaded a resource for three seconds.
     * A development page goes on importing modules from Vite after it first
     * answers, and that loading is main's work too.
     */
    const settle = async () => {
      await expect
        .poll(
          async () => {
            const quiet = await Promise.all(
              listening.map((id) => main.evaluate<boolean>(inPage(id, resourceQuietCode))),
            );
            return quiet.every(Boolean);
          },
          { timeout: 120_000, intervals: [1_000] },
        )
        .toBe(true);
    };

    await measure("echo READY-$((40+2))", "READY-42");
    await settle();
    const idle = await profiled("idle", async () => {
      const idleStart = await sample();
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      return cpuWindow(idleStart, await sample());
    });
    const load = await measure(
      `for i in $(seq 1 ${LINE_COUNT}); do echo LINE-$i; sleep 0.01; done; echo LOAD-$((40+2))`,
      "LOAD-42",
    );
    const burst = await measure(`seq 1 ${BURST_LINES}; echo BURST-$((40+2))`, "BURST-42");

    // A second window on the same terminal, opened the way a user does.
    await main.evaluate(`(() => {
      const find = (items) => {
        for (const item of items) {
          if (item.label === "New Window") return item;
          const nested = item.submenu ? find(item.submenu.items) : undefined;
          if (nested) return nested;
        }
      };
      find(globalThis.__electron.Menu.getApplicationMenu().items).click();
      return true;
    })()`);
    const second = await awaitWindow([first]);
    await main.evaluate(inPage(second, resourceActivityCode));
    await mountTerminal(second);
    await main.evaluate(inPage(second, listenCode(sessionId)));
    listening.push(second);
    await countRelay();
    await measure("echo SECOND-$((40+2))", "SECOND-42");
    await settle();
    const twoLoad = await profiled("two-window-load", () =>
      measure(
        `for i in $(seq 1 ${LINE_COUNT}); do echo TWO-$i; sleep 0.01; done; echo TWO-LOAD-$((40+2))`,
        "TWO-LOAD-42",
      ),
    );
    const twoBurst = await profiled("two-window-burst", () =>
      measure(`seq 1 ${BURST_LINES}; echo TWO-BURST-$((40+2))`, "TWO-BURST-42"),
    );
    if (mode === "relay")
      expect(twoBurst.relayed, "the relay carries terminal output").toBeGreaterThan(0);
    else expect(twoBurst.relayed, "main relays no terminal output").toBe(0);

    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    return {
      mode,
      run,
      workload: "mounted-terminals",
      idle,
      load,
      burst,
      twoWindows: { load: twoLoad, burst: twoBurst },
    };
  } finally {
    if (inspector) {
      // Quitting can drop the connection before the answer arrives.
      await Promise.race([
        inspector.evaluate("globalThis.__electron?.app.quit()").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      inspector.close();
    }
    if (electron?.pid) {
      // A graceful quit stops the backend; the group is killed only if it hangs.
      await waitForStopped([-electron.pid], 30_000).catch(() => undefined);
      await stopProcessGroup(electron).catch(() => undefined);
    }
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

test("resource warm-up observes completions beyond the browser timing buffer", async ({ page }) => {
  await page.route("http://resource-warmup.test/**", async (route) => {
    if (route.request().url().endsWith("/delayed"))
      await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Resource warm-up</title>",
    });
  });
  await page.goto("http://resource-warmup.test/");
  await page.evaluate(() => performance.setResourceTimingBufferSize(250));
  await page.evaluate(resourceActivityCode);
  await page.evaluate(async () => {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        fetch(`/resource-${i}`).then((response) => response.text()),
      ),
    );
    await fetch("/delayed").then((response) => response.text());
  });
  await expect
    .poll(() => page.evaluate(() => performance.getEntriesByType("resource").length))
    .toBe(250);
  await expect
    .poll(() => page.evaluate("globalThis.__cpuResources.activity.count"))
    .toBeGreaterThanOrEqual(301);
  expect(await page.evaluate(resourceQuietCode)).toBe(false);
  await expect.poll(() => page.evaluate(resourceQuietCode), { timeout: 10_000 }).toBe(true);
});

test("Electron main's CPU on each local transport, with no DevTools client", async () => {
  test.skip(
    process.env.ORKESTRATOR_LOCAL_TRANSPORT_CPU !== "1",
    "an opt-in measurement: set ORKESTRATOR_LOCAL_TRANSPORT_CPU=1",
  );
  const RUNS = parseRunCount(process.env.ORKESTRATOR_LOCAL_TRANSPORT_CPU_RUNS);
  test.setTimeout(RUNS * 2 * 360_000);
  const results: RunResult[] = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const mode of ["relay", "gateway"] as const) {
      const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-transport-cpu-"));
      try {
        results.push(await measureRun(mode, run, temporaryRoot));
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
  await mkdir(countsDir, { recursive: true });
  await writeFile(
    path.join(countsDir, "no-devtools.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
});
