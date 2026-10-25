import type { Page } from "@playwright/test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import type { ArtifactHostApi, ArtifactHostEvent } from "@orkestrator/protocol/artifact-host-ipc";
import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LoopbackArtifactContentServer } from "../../apps/backend/src/core/transcript-artifacts/content-server";
import { sha256Hex } from "../../apps/backend/src/core/transcript-artifacts/dependency-manifest";
import {
  buildInteractiveCsp,
  DESKTOP_ARTIFACT_SHELL_ORIGIN,
  inlineScriptHash,
} from "../../apps/backend/src/core/transcript-artifacts/interactive-csp";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The desktop live interactive-artifact host through the real app: the
 * production main bundle, preload, sender-checked IPC and the per-window
 * `ArtifactHostManager`, driven from the real renderer exactly as
 * `ArtifactLiveHost` drives it (`window.orkestrator.artifactHost`).
 *
 * The document is served by the backend's real `LoopbackArtifactContentServer`
 * (capability URL, integrity re-hash, nosniff/no-store/no-referrer, header
 * CSP with `sandbox allow-scripts` and `frame-ancestors` rebinding) with a
 * policy built by the real `buildInteractiveCsp` around the real frame
 * runtime. What is not covered here: seeding a published `html-interactive`
 * artifact into a transcript and pressing the Run interactive button. Creating
 * one needs an agent-tool credential that only a live provider dispatch mints,
 * and preview publication needs the container worker; that path is covered by
 * rich-transcripts-live.spec.ts in the browser.
 */

type Bounds = { x: number; y: number; width: number; height: number };
type HostSnapshot = {
  windowAlive: boolean;
  zoom: number;
  views: Array<{
    id: number;
    bounds: Bounds;
    visible: boolean;
    pid: number;
    framePids: number[];
    sandbox: unknown;
    contextIsolation: unknown;
    nodeIntegration: unknown;
    preload: boolean;
    persistent: boolean;
  }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const SHELL_PREFIX = `${DESKTOP_ARTIFACT_SHELL_ORIGIN}/`;
const IDENTITY = { artifactId: "art_electron_e2e", revision: 1 };
const NONCE = "nonce_electron_e2e";
const HOST_ID = "electron-e2e-host";

const AUTHORED_SCRIPT = `(() => {
  let count = 0;
  const button = document.getElementById("bump");
  const grow = document.getElementById("grow");
  window.orkestratorArtifact.onTheme((theme) => {
    document.body.dataset.appearance = theme.appearance;
  });
  button.addEventListener("click", () => {
    count += 1;
    button.textContent = "Count " + count;
    grow.style.height = count * 300 + "px";
    window.orkestratorArtifact.requestLink("https://example.com/clicked", "count:" + count);
  });
})();`;

function preparedDocument(): { bytes: Uint8Array; csp: string } {
  const runtime = artifactFrameRuntimeScript({ ...IDENTITY, nonce: NONCE });
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<style>body{margin:0;font:14px sans-serif}",
    "#bump{display:block;width:100%;height:160px;margin:0}#grow{height:0}</style>",
    "</head><body>",
    '<button id="bump" type="button">Count 0</button><div id="grow"></div>',
    `<script>${runtime}</script>`,
    `<script>${AUTHORED_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
  return {
    bytes: new TextEncoder().encode(html),
    // Ancestors are rebound by the content server on every response.
    csp: buildInteractiveCsp([inlineScriptHash(runtime), inlineScriptHash(AUTHORED_SCRIPT)], []),
  };
}

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Main-process view of the window's artifact-host child views. */
function snapshot(app: ElectronApplication, windowId: number): Promise<HostSnapshot> {
  return app.evaluate(
    ({ BrowserWindow }, { windowId, shellPrefix }) => {
      const window = BrowserWindow.fromId(windowId);
      if (!window || window.isDestroyed()) return { windowAlive: false, zoom: 1, views: [] };
      const views = window.contentView.children
        .map((child) => (child as { webContents?: Electron.WebContents }).webContents && child)
        .filter((child): child is Electron.WebContentsView => Boolean(child))
        .filter(
          (child) =>
            !child.webContents.isDestroyed() && child.webContents.getURL().startsWith(shellPrefix),
        )
        .map((child) => {
          const contents = child.webContents;
          // Present at runtime; not in Electron's published typings.
          const preferences =
            (
              contents as unknown as {
                getLastWebPreferences?: () => Record<string, unknown>;
              }
            ).getLastWebPreferences?.() ?? {};
          return {
            id: contents.id,
            bounds: child.getBounds(),
            visible: child.getVisible(),
            pid: contents.getOSProcessId(),
            framePids: contents.mainFrame.framesInSubtree.map((frame) => frame.osProcessId),
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            preload: Boolean(preferences.preload),
            persistent: contents.session.isPersistent(),
          };
        });
      return {
        windowAlive: true,
        zoom: window.webContents.getZoomFactor(),
        views,
      };
    },
    { windowId, shellPrefix: SHELL_PREFIX },
  );
}

function hostEvents(page: Page): Promise<ArtifactHostEvent[]> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __artifactHostEvents?: ArtifactHostEvent[];
        }
      ).__artifactHostEvents ?? [],
  );
}

test.beforeAll(() => {
  // Bundle exactly as production and the dev launcher do.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("Run interactive opens a sandboxed host view that relays readiness, size and input, and Stop tears it down", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-artifact-host-"));
  let vite: ChildProcess | null = null;
  let launchedApp: ElectronApplication | null = null;
  let contentServer: LoopbackArtifactContentServer | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "artifact-host-electron",
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
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  try {
    contentServer = await LoopbackArtifactContentServer.start({
      frameAncestors: [DESKTOP_ARTIFACT_SHELL_ORIGIN, rendererUrl],
      applicationOrigins: [rendererUrl],
    });
    const status = contentServer.status();
    expect(status.available).toBe(true);
    // A different loopback host name from the application, as in production.
    expect(new URL(status.origin!).hostname).toBe("localhost");
    const document = preparedDocument();
    const live = contentServer.mint({
      ...IDENTITY,
      preparedSha256: sha256Hex(document.bytes),
      contentSecurityPolicy: document.csp,
      load: async () => document.bytes,
      authorize: async () => true,
    });

    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
      },
    });
    ownProcessGroup(vite);
    await waitForUrl(rendererUrl);
    const app = await electron.launch({
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
    launchedApp = app;
    dismissStartupDialogs(app);
    const window = await app.firstWindow();
    // index.html's title stays until Vite serves and runs renderer-entry; under
    // host load that startup takes longer than expect's 5 s default.
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    await expect(window.getByRole("button", { name: "Global settings" })).toBeVisible({
      timeout: 60_000,
    });
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    test.info().annotations.push({
      type: "electron",
      description: JSON.stringify(versions),
    });
    const windowId = await (await app.browserWindow(window)).evaluate((candidate) => candidate.id);
    const rendererPid = await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.webContents.getOSProcessId(),
      windowId,
    );
    expect((await snapshot(app, windowId)).views).toEqual([]);

    // The IPC boundary refuses a content URL on the application's own origin.
    const sameOrigin = await window.evaluate(
      async ({ hostId, rendererUrl, identity, nonce }) => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: { artifactHost: ArtifactHostApi };
          }
        ).orkestrator.artifactHost;
        return api.open({
          hostId,
          contentUrl: `${rendererUrl}/a/not-a-capability`,
          ...identity,
          generation: "gen_same_origin",
          readinessNonce: nonce,
          bounds: { x: 40, y: 80, width: 600, height: 320 },
          visible: true,
        });
      },
      { hostId: HOST_ID, rendererUrl, identity: IDENTITY, nonce: NONCE },
    );
    expect(sameOrigin).toEqual({
      ok: false,
      error: "Artifact content cannot share the application origin",
    });
    expect((await snapshot(app, windowId)).views).toEqual([]);

    // Run interactive: the same calls ArtifactLiveHost makes.
    const bounds: Bounds = { x: 40, y: 80, width: 600, height: 320 };
    const opened = await window.evaluate(
      async ({ hostId, contentUrl, generation, identity, nonce, bounds }) => {
        const state = globalThis as typeof globalThis & {
          orkestrator: { artifactHost: ArtifactHostApi };
          __artifactHostEvents?: ArtifactHostEvent[];
        };
        const api = state.orkestrator.artifactHost;
        state.__artifactHostEvents = [];
        api.onEvent((event) => state.__artifactHostEvents!.push(event));
        const result = await api.open({
          hostId,
          contentUrl,
          ...identity,
          generation,
          readinessNonce: nonce,
          bounds,
          visible: true,
        });
        // Queued by the host until the readiness handshake completes.
        await api.postTheme(hostId, {
          channel: "orkestrator-artifact",
          v: 1,
          type: "theme",
          ...identity,
          generation,
          appearance: "dark",
          reducedMotion: true,
          viewport: { width: bounds.width, height: bounds.height },
          tokens: { "--ork-bg": "#101010" },
        });
        return result;
      },
      {
        hostId: HOST_ID,
        contentUrl: live.url,
        generation: live.generation,
        identity: IDENTITY,
        nonce: NONCE,
        bounds,
      },
    );
    expect(opened).toEqual({ ok: true });

    await expect
      .poll(async () => (await hostEvents(window)).map((event) => event.type), {
        timeout: 15_000,
      })
      .toEqual(expect.arrayContaining(["ready", "size"]));
    const initialSize = (await hostEvents(window)).find((event) => event.type === "size");
    expect(initialSize?.type === "size" && initialSize.height).toBeGreaterThanOrEqual(160);

    const host = await snapshot(app, windowId);
    expect(host.windowAlive).toBe(true);
    expect(host.views).toHaveLength(1);
    const view = host.views[0]!;
    expect(view).toMatchObject({
      visible: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: false,
      persistent: false,
    });
    expect(view.bounds).toEqual({
      x: Math.round(bounds.x * host.zoom),
      y: Math.round(bounds.y * host.zoom),
      width: Math.round(bounds.width * host.zoom),
      height: Math.round(bounds.height * host.zoom),
    });
    // The shell and the artifact frame never share the application renderer.
    expect(view.framePids.length).toBeGreaterThanOrEqual(2);
    expect(view.framePids).not.toContain(rendererPid);
    test.info().annotations.push({
      type: "host-view",
      description: JSON.stringify({
        bounds: view.bounds,
        zoom: host.zoom,
        frames: view.framePids.length,
      }),
    });

    // Interact through the host: a real click on the host view's page, routed
    // by Chromium into the cross-origin artifact frame. Playwright reaches the
    // view's page over its own CDP attachment (test-only); the app exposes
    // nothing. `webContents.sendInputEvent` is not used: on a shared macOS
    // desktop it never reached the artifact frame.
    const shellPage = app.windows().find((candidate) => candidate.url().startsWith(SHELL_PREFIX));
    if (!shellPage) throw new Error("The artifact host page is not attached");
    await shellPage
      .frameLocator("#artifact")
      .getByRole("button", { name: "Count 0" })
      .click({ timeout: 10_000 });
    await expect(
      shellPage.frameLocator("#artifact").getByRole("button", { name: "Count 1" }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          (await hostEvents(window)).find((event) => event.type === "link-request") ?? null,
        { timeout: 10_000 },
      )
      .toMatchObject({
        hostId: HOST_ID,
        type: "link-request",
        hostname: "example.com",
        label: "count:1",
      });
    await expect
      .poll(
        async () =>
          Math.max(
            0,
            ...(await hostEvents(window)).map((event) =>
              event.type === "size" ? event.height : 0,
            ),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(460);

    // Repositioning and hiding keep the same live document.
    const moved: Bounds = { x: 20, y: 60, width: 500, height: 240 };
    await window.evaluate(
      async ({ hostId, moved }) => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: { artifactHost: ArtifactHostApi };
          }
        ).orkestrator.artifactHost;
        await api.setBounds(hostId, moved);
        await api.setVisible(hostId, false);
      },
      { hostId: HOST_ID, moved },
    );
    const hidden = await snapshot(app, windowId);
    expect(hidden.views).toHaveLength(1);
    expect(hidden.views[0]).toMatchObject({ id: view.id, visible: false });
    expect(hidden.views[0]!.bounds.width).toBe(Math.round(moved.width * hidden.zoom));
    await window.evaluate(async (hostId) => {
      const api = (
        globalThis as typeof globalThis & {
          orkestrator: { artifactHost: ArtifactHostApi };
        }
      ).orkestrator.artifactHost;
      await api.setVisible(hostId, true);
    }, HOST_ID);
    expect((await snapshot(app, windowId)).views[0]).toMatchObject({
      id: view.id,
      visible: true,
    });
    expect((await hostEvents(window)).some((event) => event.type === "closed")).toBe(false);

    // Stop.
    await window.evaluate(async (hostId) => {
      const api = (
        globalThis as typeof globalThis & {
          orkestrator: { artifactHost: ArtifactHostApi };
        }
      ).orkestrator.artifactHost;
      await api.close(hostId);
    }, HOST_ID);
    await expect
      .poll(async () => (await hostEvents(window)).filter((event) => event.type === "closed"))
      .toEqual([{ hostId: HOST_ID, type: "closed", reason: "requested" }]);
    expect((await snapshot(app, windowId)).views).toEqual([]);
    await expect.poll(() => shellPage.isClosed()).toBe(true);
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, id) => {
          const contents = webContents.fromId(id);
          return !contents || contents.isDestroyed();
        }, view.id),
      )
      .toBe(true);
    const hostPids = Array.from(new Set(view.framePids));
    await expect.poll(() => hostPids.filter(processAlive), { timeout: 10_000 }).toEqual([]);

    // The application window and its renderer survive.
    expect(processAlive(rendererPid)).toBe(true);
    expect((await snapshot(app, windowId)).windowAlive).toBe(true);
    await expect(window.getByRole("button", { name: "Global settings" })).toBeVisible();
    const greeting = await window.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          orkestrator: {
            invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
          };
        }
      ).orkestrator;
      return api.invoke<string>("greet", { name: "After artifact host" });
    });
    expect(greeting).toContain("Hello, After artifact host");
  } finally {
    await closeElectronWithin(launchedApp).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await contentServer?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
