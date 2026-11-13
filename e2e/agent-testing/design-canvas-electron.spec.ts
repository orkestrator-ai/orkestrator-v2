/**
 * The design canvas in the real Electron app: the production main bundle,
 * preload and IPC invoke bridge, with a disposable agent-test profile under a
 * temporary root and a fixture repository (never the user's profile, backend
 * data or this checkout). No agent provider is started and no credential is
 * used: every canvas here is a blank canvas created from the UI.
 *
 * Covers, through the real window:
 * - Open: New design workspace -> Blank canvas (no agent) with a Mobile frame.
 * - Edit: a pointer drag of the frame title, read back from the backend.
 * - Keyboard: Arrow / Shift+Arrow nudges and Alt+Arrow resize (each burst one
 *   undo entry), Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, Delete of the
 *   selected frame (and undo of it), `+`/`-` zoom, Shift+1 fit all, `P`
 *   preview mode, `?` shortcut help and Escape deselect. Ctrl/Cmd+0 resets
 *   the canvas to 100% while the app-wide Ctrl/Cmd+= / Ctrl/Cmd+- keep
 *   changing the window's zoom factor and Ctrl/Cmd+0 leaves it alone (App's
 *   global zoom listener used to swallow it). Keys are delivered by
 *   Playwright through Chromium's input pipeline (CDP), not as OS key events,
 *   so native menu key-equivalent routing on macOS is not exercised.
 * - Export: the Export dialog writes `designs/<name>.orkdes` into the
 *   environment worktree; the file is checked byte for byte against the
 *   portable serialization of the exported revision and against the digest
 *   the backend recorded for the export.
 * - Download: Electron's own download path for the toolbar's blob download.
 *   The product installs no `will-download` handler, so Electron would show
 *   its native Save dialog; the spec adds a main-process `will-download`
 *   listener that sets the save path, which replaces only that OS dialog.
 *   The journey first asserts the window's session has no handler of its
 *   own: the Save dialog is Electron's, which is why 0036 (retired) dropped a manual
 *   check of it, and a product handler would need its own test.
 * - Open design (`design_import_host_file`): this picker is Orkestrator's own
 *   in-app host path picker (it lists the backend host's directories), not an
 *   OS file dialog, so nothing is stubbed. The spec drives the real picker to
 *   a fixture `.orkdes` file outside the repository and records any
 *   `dialog.showOpenDialog*` call in main to prove no OS dialog is involved.
 *
 * The journey itself lives in design-canvas-electron-journey.ts, shared with
 * design-canvas-packaged-electron.spec.ts, which runs it against the packaged
 * Linux or macOS app and its `file://` renderer. Here, like the other Electron specs,
 * the renderer is served by Vite. On a shared Linux host, set
 * `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1` to run Electron headless.
 *
 * Not covered: design agents (Claude/Codex) and the MCP tool cycle, which need
 * live providers (design-live.spec.ts).
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { ownProcessGroup, stopProcessGroup, waitForStopped, withCleanup } from "../process-cleanup";
import {
  ELECTRON_TEST_SWITCHES,
  HEADLESS_ELECTRON_SWITCHES,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { openDesignWindow, runDesignCanvasJourney } from "./design-canvas-electron-journey";
import { electronSpecEnvironment } from "./electron-spec-environment";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

test.beforeAll(() => {
  // Bundle exactly as production and the dev launcher do. A `tsc` emit leaves
  // workspace imports pointing at raw `.ts` sources Electron cannot run.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron", async () => {
  test.setTimeout(480_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-electron-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "design-canvas-electron",
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
  await withCleanup(async () => {
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
    // Opt-in for shared Linux hosts: keep the window off the signed-in desktop.
    const headless = headlessElectronRequested();
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
        path.join(packageRoot, "dist", "electron", "main.js"),
      ],
      cwd: repositoryRoot,
      env: electronSpecEnvironment(headless ? withoutDisplay(process.env) : process.env, {
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        // Never contend for the fixed control-MCP port an installed app may own.
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      }),
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    const window = await openDesignWindow(electronApp, profile, {
      title: "document",
      timeoutMs: 150_000,
    });
    await runDesignCanvasJourney({ electronApp, window, profile, temporaryRoot });
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
          if (vite) await stopProcessGroup(vite);
        },
        async () => {
          // Retain the profile if forced termination could not prove the tree stopped.
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped([...owned, ...(vite?.pid ? [-vite.pid] : [])], 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});
