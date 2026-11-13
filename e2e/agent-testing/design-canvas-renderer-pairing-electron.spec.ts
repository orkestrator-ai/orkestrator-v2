/**
 * 0036 task 6: the design canvas with an old renderer on a new backend, and a
 * new renderer on an old backend, through the desktop connection manager
 * (`connections.connect`), the pairing `version-compatibility.md` requires in
 * both directions. Each half runs design-canvas-electron-journey.ts in a
 * desktop window whose active connection is a headless backend of the other
 * version, so every design command the journey issues reaches that backend.
 *
 * - **This renderer, published backend.** The packaged-test build of this
 *   checkout (`mise run package:mac:unpacked:test` or
 *   `package:linux:unpacked:test`), connected to `orkestrator@2.22.3`
 *   installed from npm with `--ignore-scripts` into the run's root
 *   (`ORKESTRATOR_PAIRING_RELEASE` picks another release).
 * - **Published renderer, this backend.** A published desktop build, connected
 *   to `apps/backend/src/main.ts`. It runs only when
 *   `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE` names its executable, for example
 *   v2.22.3's macOS zip from the GitHub release, unpacked with `ditto -x -k`
 *   into a new empty directory under `output/agent-testing/`:
 *   `…/OrkestratorV2.app/Contents/MacOS/OrkestratorV2`. That build ships with
 *   the Node inspect fuse off, so it is driven over CDP
 *   (`--remote-debugging-port=0`) and the journey skips the steps that need
 *   main (window size, the download's save path, the window zoom factor).
 *   It predates hidden agent-test windows, so on macOS its window opens on
 *   the desktop for the length of the run.
 *
 * Both apps run on a disposable agent-test profile under a temporary root,
 * with HOME, the XDG roots and an allowlisted environment
 * (`packagedLaunchEnvironment`), as design-canvas-packaged-electron.spec.ts
 * does. Both backends are this run's own, on loopback, on ports other than the
 * production ones, with their own data directories and no agent toolchain, so
 * no provider turn can start. The gateway token is passed only to
 * `connections.connect`; tracing is off so it is not recorded.
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron, chromium, type Browser, type Page } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENT_TEST_HIDDEN_WINDOWS_ENV,
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { ownProcessGroup, stopProcessGroup, waitForStopped, withCleanup } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { dismissStartupDialogsOnPage } from "./electron-startup-dialogs";
import { openDesignWindow, runDesignCanvasJourney } from "./design-canvas-electron-journey";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
  packagedResourcesPath,
} from "./packaged-electron-app";
import {
  DEFAULT_PAIRING_RELEASE,
  PAIRING_OLD_APP_ENV,
  PAIRING_RELEASE_ENV,
  installPublishedBackend,
  pairingPorts,
  startPairingBackend,
  type PairingBackend,
} from "./design-renderer-pairing-support";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

// The journey's invoke and connect calls carry the gateway token as arguments.
test.use({ trace: "off" });

type Connections = {
  connect(input: { address: string; token: string; nickname?: string }): Promise<{
    activeConnectionId: string | null;
  }>;
};

async function pairingProfile(temporaryRoot: string, id: string) {
  // The renderer port is reserved for the profile's shape only: nothing serves it.
  const [rendererPort, gatewayPort] = (await pairingPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: id,
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
  const home = path.join(temporaryRoot, "home");
  await mkdir(home, { recursive: true });
  return { profile, profilePath, home };
}

/**
 * Make `backend` the window's active connection and prove the journey's
 * commands now reach it: `get_app_version` answers the backend's version, not
 * the app's own bundled backend's.
 */
async function connectWindow(window: Page, backend: PairingBackend): Promise<void> {
  const invokeVersion = (): Promise<string> =>
    window.evaluate(() => (globalThis as any).orkestrator.invoke("get_app_version", {}));
  const localVersion = await invokeVersion();
  const active = await window.evaluate(
    ({ address, token }) =>
      (
        globalThis as unknown as { orkestrator: { connections: Connections } }
      ).orkestrator.connections.connect({ address, token, nickname: "Pairing" }),
    { address: backend.origin, token: backend.token },
  );
  expect(active.activeConnectionId).toBeTruthy();
  // The window reloads onto the new connection (preload exposes its gateway
  // at load), and commands from the page that was connected before fail
  // authentication until it does (as in multi-node-window.spec.ts).
  await expect
    .poll(
      async () => {
        const version = await invokeVersion().catch(() => null);
        if (version !== backend.version) await window.reload().catch(() => undefined);
        return version;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(backend.version);
  test.info().annotations.push({
    type: "pairing",
    description: JSON.stringify({ renderer: localVersion, backend: backend.version }),
  });
}

test("this checkout's packaged renderer edits and exports a canvas on a published backend", async () => {
  test.skip(
    process.platform !== "linux" &&
      process.platform !== "darwin" &&
      !process.env.ORKESTRATOR_PACKAGED_APP_EXECUTABLE,
    "Only the unpacked Linux and macOS builds have a default location",
  );
  test.setTimeout(600_000);
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:${process.platform === "darwin" ? "mac" : "linux"}:unpacked:test\` first.`,
  ).toBe(true);
  const release = process.env[PAIRING_RELEASE_ENV]?.trim() || DEFAULT_PAIRING_RELEASE;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-pairing-"));
  let app: ElectronApplication | null = null;
  let backend: PairingBackend | null = null;
  await withCleanup(async () => {
    const packageRoot = await installPublishedBackend(release, path.join(temporaryRoot, "npm"));
    backend = await startPairingBackend(
      { kind: "published", packageRoot },
      path.join(temporaryRoot, "backend"),
    );
    expect(backend.version).toBe(release);
    const { profile, profilePath, home } = await pairingProfile(
      temporaryRoot,
      "design-pairing-new",
    );
    app = await electron.launch({
      executablePath,
      args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
      cwd: temporaryRoot,
      env: {
        ...packagedLaunchEnvironment(process.env, { home, profilePath }),
        ...(process.platform === "darwin" ? { [AGENT_TEST_HIDDEN_WINDOWS_ENV]: "1" } : {}),
      },
    });
    recordElectronDiagnostics(app);
    const window = await openDesignWindow(app, profile, { title: "native", timeoutMs: 60_000 });
    await connectWindow(window, backend);
    const electronApp = app;
    await journeyWithEvidence(window, () =>
      runDesignCanvasJourney({ electronApp, window, profile, temporaryRoot }),
    );
  }, [
    async () => {
      let owned: number[] | undefined = app ? undefined : [];
      await withCleanup(async () => {
        if (app) {
          owned = electronProcessTree(app);
          await closeElectron(app, owned);
        }
      }, [
        async () => {
          await (backend as PairingBackend | null)?.stop();
        },
        async () => {
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped(owned, 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});

/**
 * Run the journey, attaching a screenshot and the page's accessibility tree
 * when it fails: Playwright takes no failure screenshot of an Electron window.
 * Neither shows the gateway token.
 */
async function journeyWithEvidence(window: Page, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const screenshot = await window.screenshot().catch(() => null);
    if (screenshot)
      await test.info().attach("failure", { body: screenshot, contentType: "image/png" });
    const tree = await window
      .locator("body")
      .ariaSnapshot()
      .catch(() => null);
    if (tree) await test.info().attach("failure-aria", { body: tree, contentType: "text/plain" });
    throw error;
  }
}

/** The published app's renderer page over CDP, once its preload answers. */
async function publishedRendererPage(
  browser: Browser,
  executable: string,
  profile: RuntimeProfile,
): Promise<Page> {
  const entry = pathToFileURL(
    path.join(packagedResourcesPath(executable, process.platform), "web", "index.html"),
  ).href;
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  await expect.poll(() => pages().map((page) => page.url()), { timeout: 90_000 }).toContain(entry);
  const page = pages().find((candidate) => candidate.url() === entry)!;
  dismissStartupDialogsOnPage(page);
  await expect
    .poll(
      () =>
        page
          .evaluate(async () => {
            const api = (globalThis as any).orkestrator;
            if (!api?.invoke) return false;
            await api.invoke("greet", { name: "design" });
            return true;
          })
          .catch(() => false),
      { timeout: 90_000 },
    )
    .toBe(true);
  test.info().annotations.push({ type: "published-app-profile", description: profile.id });
  return page;
}

test("a published desktop renderer edits and exports a canvas on this checkout's backend", async () => {
  const executable = process.env[PAIRING_OLD_APP_ENV]?.trim();
  test.skip(!executable, `Set ${PAIRING_OLD_APP_ENV} to a published desktop build's executable`);
  test.setTimeout(600_000);
  expect(existsSync(executable!), `No app at ${executable}`).toBe(true);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-pairing-"));
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let backend: PairingBackend | null = null;
  let stopped = false;
  await withCleanup(async () => {
    backend = await startPairingBackend({ kind: "current" }, path.join(temporaryRoot, "backend"));
    const { profile, profilePath, home } = await pairingProfile(
      temporaryRoot,
      "design-pairing-old",
    );
    let stderr = "";
    const launched = ownProcessGroup(
      spawn(executable!, [...ELECTRON_TEST_SWITCHES, "--remote-debugging-port=0"], {
        detached: true,
        cwd: temporaryRoot,
        stdio: ["ignore", "ignore", "pipe"],
        env: packagedLaunchEnvironment(process.env, { home, profilePath }),
      }),
    );
    child = launched;
    launched.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-256 * 1024);
    });
    const devtools = /DevTools listening on (ws:\/\/[^\s]+)/;
    await expect
      .poll(
        () => {
          expect(launched.exitCode).toBeNull();
          return devtools.exec(stderr)?.[1];
        },
        { timeout: 90_000 },
      )
      .toBeTruthy();
    browser = await chromium.connectOverCDP(devtools.exec(stderr)![1]!);
    const window = await publishedRendererPage(browser, executable!, profile);
    await window.setViewportSize({ width: 1440, height: 900 });
    await connectWindow(window, backend);
    await journeyWithEvidence(window, () =>
      runDesignCanvasJourney({
        electronApp: null,
        window,
        profile,
        temporaryRoot,
        olderRenderer: true,
      }),
    );
  }, [
    async () => {
      await (browser as Browser | null)?.close();
    },
    async () => {
      if (child) await stopProcessGroup(child, 15_000);
      stopped = true;
    },
    async () => {
      await (backend as PairingBackend | null)?.stop();
    },
    async () => {
      if (stopped) await rm(temporaryRoot, { recursive: true, force: true });
    },
  ]);
});
