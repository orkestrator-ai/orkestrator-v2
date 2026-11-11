import { fetchModulesOutsideChromium } from "./browser-test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { relayedNodeEventName } from "@orkestrator/protocol/node-events";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { startLeaf } from "./electron-leaf-backend";
import {
  ELECTRON_TEST_SWITCHES,
  HEADLESS_ELECTRON_SWITCHES,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import { electronSpecEnvironment } from "./electron-spec-environment";
import { watchElectronStartup } from "./electron-startup-recovery";

/**
 * The desktop's relay of another node's events through the real main process,
 * preload and IPC (docs/architecture/command-nodes.md): each window says which
 * per-node events it listens to, and main opens one filtered stream for their
 * union. The leaf is a second backend on loopback. The window is pinned to the
 * relay (`localWindowGatewayTransport: false`): a window on the direct gateway
 * transport reads these events on its own stream.
 */

type Project = { id: string; name: string };
type Frame = { nodeId?: string; kind?: string; event?: string };
type RendererGlobals = typeof globalThis & {
  __relayed?: Frame[];
  orkestrator: {
    invoke<R>(command: string, args?: Record<string, unknown>): Promise<R>;
    listen(event: string, callback: (payload: Frame) => void): () => void;
    eventStreamReady(event: string): Promise<void>;
    connections: {
      connect(input: { address: string; token: string }): Promise<unknown>;
      use(connectionId: string): Promise<unknown>;
      openWindow(connectionId: string): Promise<void>;
    };
  };
};
type MainGlobals = typeof globalThis & {
  __relayedStreams?: string[];
  __activeRelayedStreams?: Array<{ origin: string; filter: string; aborted: boolean }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

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

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("main takes a node's relayed events only for the windows listening", async () => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-relayed-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  let leafChild: ChildProcess | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-relayed-events",
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  // This spec is about main's relay, which a local window takes only with the
  // direct transport turned off (on by default since to-do 4501 task 2).
  await mkdir(profile.dataDir, { recursive: true });
  await writeFile(
    path.join(profile.dataDir, "config.json"),
    JSON.stringify({ repositories: {}, global: { localWindowGatewayTransport: false } }),
  );
  const projectPath = await prepareFixtureRepository(
    profile,
    path.join(repositoryRoot, "test-fixtures", "agent-project"),
  );
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  try {
    const leaf = await startLeaf(temporaryRoot);
    leafChild = leaf.child;
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
    const headless = headlessElectronRequested();
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
        path.join(repositoryRoot, "apps", "desktop", "dist", "electron", "main.js"),
      ],
      cwd: repositoryRoot,
      env: electronSpecEnvironment(headless ? withoutDisplay(process.env) : process.env, {
        HOME: temporaryRoot,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      }),
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    // Modules are fetched outside Chromium below; a load that still lost them
    // to ERR_NETWORK_CHANGED is reloaded, and only that (flake 2340).
    const startup = watchElectronStartup(electronApp);
    dismissStartupDialogs(electronApp);
    await fetchModulesOutsideChromium(electronApp.context());
    const window = await electronApp.firstWindow();
    // Wait for main's initial loadURL before replacing the possibly partial document.
    await window.waitForURL((url) => url.protocol === "http:");
    await window.reload();
    window.setDefaultTimeout(20_000);
    await startup.waitForTitle(window, profile.electronTitle, { timeoutMs: 60_000 });
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      window.evaluate(
        ({ command, args }) => (globalThis as RendererGlobals).orkestrator.invoke<T>(command, args),
        { command, args },
      );

    // Every filtered stream main opens from here on, and the filter it asked for.
    await electronApp.evaluate(() => {
      const main = globalThis as MainGlobals;
      main.__relayedStreams = [];
      main.__activeRelayedStreams = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input, init) => {
        const url = new URL(String(input));
        const filter = url.searchParams.get("includeEvents");
        if (url.pathname === "/__orkestrator/events" && filter) {
          main.__relayedStreams?.push(filter);
          const stream = { origin: url.origin, filter, aborted: false };
          main.__activeRelayedStreams?.push(stream);
          init?.signal?.addEventListener("abort", () => {
            stream.aborted = true;
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
    });
    const relayedStreams = () =>
      electronApp.evaluate(() => (globalThis as MainGlobals).__relayedStreams ?? []);

    await invoke<Project>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    await invoke("add_node", {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }],
      token: leaf.token,
    });
    await expect
      .poll(
        async () =>
          (
            await invoke<{ nodes: Array<{ environments: unknown[] }> }>("get_node_summaries")
          ).nodes.some((node) => node.environments.length > 0),
        { timeout: 60_000 },
      )
      .toBe(true);
    const leafEvent = relayedNodeEventName(leaf.nodeId as never);
    const lease = await invoke<{ perNodeEvents?: true }>("watch_node_events", {
      nodeId: leaf.nodeId,
      prefixes: ["resource-changed"],
      watchId: "relayed-electron-qa",
    });
    expect(lease.perNodeEvents).toBe(true);

    /** What a renderer's view does: listen, then wait for the stream that carries it. */
    const listenInWindow = (page: Page) =>
      page.evaluate((name) => {
        const renderer = globalThis as RendererGlobals;
        renderer.__relayed = [];
        renderer.orkestrator.listen(name, (frame) => void renderer.__relayed?.push(frame));
        return renderer.orkestrator.eventStreamReady(name);
      }, leafEvent);
    const framesIn = (page: Page) =>
      page.evaluate(() => (globalThis as RendererGlobals).__relayed ?? []);
    let changes = 0;
    const changeLeaf = () =>
      leaf.invoke("create_environment", {
        projectId: leaf.project.id,
        name: `leaf-change-${(changes += 1)}`,
        environmentType: "local",
      });
    const hasEventFrame = (frames: Frame[]) =>
      frames.some((frame) => frame.nodeId === leaf.nodeId && frame.kind === "event");

    // The window asks, and main's filter names that node and no other.
    await listenInWindow(window);
    await expect.poll(relayedStreams, { timeout: 30_000 }).toContainEqual(leafEvent);
    await changeLeaf();
    await expect
      .poll(async () => hasEventFrame(await framesIn(window)), { timeout: 30_000 })
      .toBe(true);

    // A reload starts empty and asks again, in that order over the real IPC pipe.
    const streamsBeforeReload = (await relayedStreams()).length;
    await window.reload();
    await expect(
      window
        .locator(`[data-testid="federated-environment-row"][data-machine="${leaf.nodeId}"]`)
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await listenInWindow(window);
    await expect
      .poll(async () => (await relayedStreams()).length, { timeout: 30_000 })
      .toBeGreaterThan(streamsBeforeReload);
    await expect
      .poll(
        async () => {
          await invoke("watch_node_events", {
            nodeId: leaf.nodeId,
            prefixes: ["resource-changed"],
            watchId: "relayed-electron-qa",
          });
          await changeLeaf();
          return hasEventFrame(await framesIn(window));
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(true);

    // A second window on the same command node, on the same one stream.
    const opened = electronApp.waitForEvent("window");
    await window.evaluate(() =>
      (globalThis as RendererGlobals).orkestrator.connections.openWindow("local"),
    );
    const second = await opened;
    second.setDefaultTimeout(20_000);
    await startup.waitForTitle(second, profile.electronTitle, { timeoutMs: 60_000 });
    startup.dispose();
    await expect
      .poll(() => second.evaluate(() => Boolean((globalThis as RendererGlobals).orkestrator)), {
        timeout: 60_000,
      })
      .toBe(true);
    await listenInWindow(second);
    await changeLeaf();
    await expect
      .poll(async () => hasEventFrame(await framesIn(second)), { timeout: 30_000 })
      .toBe(true);

    // Give only the second window a second name, so closing it must narrow
    // main's stream even while the first keeps its original subscription.
    const secondOnlyEvent = relayedNodeEventName("bk_second_only" as never);
    await second.evaluate((name) => {
      const renderer = globalThis as RendererGlobals;
      renderer.orkestrator.listen(name, () => undefined);
      return renderer.orkestrator.eventStreamReady(name);
    }, secondOnlyEvent);
    const activeFilters = () =>
      electronApp.evaluate(
        () =>
          (globalThis as MainGlobals).__activeRelayedStreams?.filter((stream) => !stream.aborted) ??
          [],
      );
    await expect
      .poll(async () =>
        (await activeFilters()).some((stream) =>
          stream.filter.split(",").includes(secondOnlyEvent),
        ),
      )
      .toBe(true);
    // Closes the BrowserWindow: main's real close path drops its listens.
    const secondWindow = await electronApp.browserWindow(second);
    await secondWindow.evaluate((browserWindow) => browserWindow.close());
    await expect
      .poll(async () =>
        (await activeFilters()).some((stream) =>
          stream.filter.split(",").includes(secondOnlyEvent),
        ),
      )
      .toBe(false);
    await changeLeaf();
    await expect.poll(async () => hasEventFrame(await framesIn(window))).toBe(true);

    // Drive main's real connection callbacks with a live subscribed window.
    // The listens follow the window to the new client and back to Local.
    await window.evaluate(
      ({ address, token }) =>
        (globalThis as RendererGlobals).orkestrator.connections.connect({ address, token }),
      { address: leaf.origin, token: leaf.token },
    );
    await expect
      .poll(async () =>
        (await activeFilters()).some(
          (stream) => stream.origin === leaf.origin && stream.filter === leafEvent,
        ),
      )
      .toBe(true);
    await window.evaluate(() =>
      (globalThis as RendererGlobals).orkestrator.connections.use("local"),
    );
    await expect
      .poll(async () => (await activeFilters()).some((stream) => stream.origin === leaf.origin))
      .toBe(false);
    await listenInWindow(window);
    await changeLeaf();
    await expect
      .poll(async () => hasEventFrame(await framesIn(window)), { timeout: 30_000 })
      .toBe(true);

    // Every filter main ever asked for was for what a renderer listens to, and
    // no relayed frame reached this desktop under the old name.
    for (const filter of await relayedStreams()) {
      for (const name of filter.split(",")) expect([leafEvent, secondOnlyEvent]).toContain(name);
    }
    const usage = await invoke<{ paths: Record<string, unknown> }>("get_compatibility_path_usage");
    expect(usage.paths["relayed-node-event.legacy-stream"]).toBeUndefined();
    expect(usage.paths["relayed-node-event.legacy-desktop-stream"]).toBeUndefined();
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    if (leafChild && leafChild.exitCode === null) {
      const exited = new Promise<void>((resolve) => leafChild!.once("exit", () => resolve()));
      leafChild.kill("SIGTERM");
      const timer = setTimeout(() => leafChild?.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
