import type { OrkestratorElectronApi } from "../../apps/desktop/electron/preload-api";
import type { ElectronApplication, Page } from "playwright";
import { _electron as electron } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { closeElectronWithin } from "./design-electron-cleanup";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The `localWindowGatewayTransport` setting in a real Electron window, off and
 * on (to-do 1202 task 12). Each run writes the counts recorded in that to-do: one
 * terminal printing LINE_COUNT lines with one window open.
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
type Counts = {
  mode: "relay" | "gateway";
  relayedEvents: number;
  relayedTerminalEvents: number;
  mainInvokes: number;
  mainStreamBytes: number;
  mainEventStreamUrls: string[];
  pageInvokes: number;
  pageEventStreamUrls: string[];
  terminalFramesDelivered: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const previewDir = path.join(repositoryRoot, "output", "visual-previews");
const countsDir = path.join(repositoryRoot, "output", "agent-testing", "local-transport-counts");
const LINE_COUNT = 300;

const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 30_000 },
    )
    .toBe(true);
}

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

async function countRelay(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const state = globalThis as typeof globalThis & {
      __relay?: { events: number; terminal: number };
    };
    const relay = { events: 0, terminal: 0 };
    state.__relay = relay;
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel: string, ...args: unknown[]) => {
      if (channel === "orkestrator:event") {
        relay.events += 1;
        if (String(args[0]).startsWith("terminal-output-")) relay.terminal += 1;
      }
      send(channel, ...args);
    };
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
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: `electron-transport-${mode}`,
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(root, "dev"),
      productionDataDir: path.join(root, "production"),
      homeDir: root,
    },
  });
  const profilePath = await initializeProfile(profile);
  const projectPath = await prepareFixtureRepository(
    profile,
    path.join(repositoryRoot, "test-fixtures", "agent-project"),
  );
  // The relay run starts from no config at all: off is the default.
  if (mode === "gateway") {
    await mkdir(profile.dataDir, { recursive: true });
    await writeFile(
      path.join(profile.dataDir, "config.json"),
      JSON.stringify({ repositories: {}, global: { localWindowGatewayTransport: true } }),
    );
  }
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  try {
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
      },
    });
    ownProcessGroup(vite);
    recordProcessOutput("vite", vite);
    await waitForUrl(rendererUrl);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        path.join(repositoryRoot, "apps", "desktop", "dist", "electron", "main.js"),
      ],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      },
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    dismissStartupDialogs(electronApp);
    await instrumentMain(electronApp);
    const window = await electronApp.firstWindow();
    window.setDefaultTimeout(20_000);
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });

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
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    const openEnvironment = async (name: string) => {
      const expand = window.getByRole("button", { name: `Expand project ${project.name}` });
      const entry = window.getByText(name, { exact: true }).first();
      // A startup dialog can cover the sidebar for a moment, so ask again until the row shows.
      await expect(async () => {
        if (await expand.isVisible()) await expand.click();
        await expect(entry).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await window.mouse.move(0, 0);
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

    const renderedOutput = () =>
      window.evaluate(
        async ({ environmentId }) => {
          const module = await import(
            /* @vite-ignore */ String("/src/stores/terminalPortalStore.ts")
          );
          const data = module.useTerminalPortalStore
            .getState()
            .getTerminal(environmentId, "tab-shell");
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
      visibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    await expect.poll(output, { timeout: 30_000 }).toContain("READY-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("READY-42");
    await window.evaluate((session) => {
      const state = globalThis as typeof globalThis & {
        __frames?: { count: number; desynced: number };
      };
      const frames = { count: 0, desynced: 0 };
      state.__frames = frames;
      (globalThis.window as RendererWindow).orkestrator!.listen<{ desynced?: boolean }>(
        `terminal-output-${session}`,
        (payload) => {
          frames.count += 1;
          if (payload && typeof payload === "object" && payload.desynced) frames.desynced += 1;
        },
      );
    }, sessionId);
    const frames = () =>
      window.evaluate(
        () => (globalThis as unknown as { __frames: { count: number; desynced: number } }).__frames,
      );

    // The measured load: one window, one terminal printing a known number of lines.
    const before = { main: await mainState(), page: await pageState() };
    await countRelay(electronApp);
    await runInTerminal(
      `for i in $(seq 1 ${LINE_COUNT}); do echo LINE-$i; sleep 0.01; done; echo LOAD-$((40+2))`,
    );
    await expect.poll(output, { timeout: 60_000 }).toContain("LOAD-42");
    await expect.poll(renderedOutput, { timeout: 30_000 }).toContain("LOAD-42");
    await expect.poll(async () => (await frames()).count, { timeout: 30_000 }).toBeGreaterThan(0);
    await mkdir(previewDir, { recursive: true });
    await window.screenshot({ path: path.join(previewDir, `local-transport-${mode}.png`) });

    const relay = await electronApp.evaluate(
      () => (globalThis as unknown as { __relay: { events: number; terminal: number } }).__relay,
    );
    const main = await mainState();
    const page = await pageState();
    const counts: Counts = {
      mode,
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

    // A reload rehydrates from the backend, on the same transport.
    await window.reload();
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
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
      await electronApp.evaluate(({ Menu }) => {
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
      const second = await opened;
      await expect(second).toHaveTitle(/electron-transport-relay/, { timeout: 60_000 });
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
      app = await electron.launch({
        executablePath: electronExecutable,
        args: [...ELECTRON_TEST_SWITCHES, bootstrap],
        cwd: repositoryRoot,
        env: { ...process.env, ELECTRON_DEV: "0", ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath },
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
