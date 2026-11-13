/**
 * The design canvas journey of design-canvas-electron.spec.ts, run against the
 * packaged app (Linux or macOS) instead of the dev bundle and Vite: the app's own
 * executable, `app.asar`, the bundled Bun backend and bridges, and the
 * renderer loaded from `file://<resources>/web/index.html`. That renderer is
 * what users run, and no dev-served spec ever loads it.
 *
 * Build the app first with `mise run package:linux:unpacked:test` (or
 * `mise run package:mac:unpacked:test` on macOS, an ad-hoc identity that is
 * never signed with a Developer ID or notarised), which writes
 * `release/packaged-test/linux-unpacked/` (`mac-arm64/OrkestratorV2.app`) and
 * installs nothing. That is
 * the shipped build with the Node inspect fuse back on, which Playwright's
 * `_electron.launch` needs; every other fuse is as shipped. Then run `mise run
 * test:agent:electron:packaged`, which tests that existing build without rebuilding. Set
 * `ORKESTRATOR_PACKAGED_APP_EXECUTABLE` to run another unpacked build with that fuse on.
 *
 * The app runs on a disposable agent-test profile under a temporary root, as
 * the dev spec's does: its `userData`, backend data, fixture repository and
 * worktrees all live there, and `HOME` and the XDG directories point there too,
 * and only an allowlist of host variables is passed on (packaged-electron-app.ts),
 * so nothing reads or writes the user's data directory, logins, keyring or
 * agent homes. The profile enables no agent platform and no provider starts.
 *
 * On Linux it runs on Chromium's headless Ozone platform with no `DISPLAY` or
 * `WAYLAND_DISPLAY` (as `dev:test --headless` does), so it never opens
 * a window on the signed-in desktop. Playwright drives the page over CDP,
 * which needs no display. macOS has no headless platform, so there every
 * window stays hidden with no Dock icon (`ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS`,
 * which keeps painting and timers running).
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENT_TEST_HIDDEN_WINDOWS_ENV,
  resolveRuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { waitForStopped, withCleanup } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { openDesignWindow, runDesignCanvasJourney } from "./design-canvas-electron-journey";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
  packagedResourcesPath,
} from "./packaged-electron-app";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("the packaged app's file:// renderer opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes", async () => {
  test.skip(
    process.platform !== "linux" &&
      process.platform !== "darwin" &&
      !process.env.ORKESTRATOR_PACKAGED_APP_EXECUTABLE,
    "Only the unpacked Linux and macOS builds have a default location; set ORKESTRATOR_PACKAGED_APP_EXECUTABLE elsewhere",
  );
  test.setTimeout(480_000);
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:${process.platform === "darwin" ? "mac" : "linux"}:unpacked:test\` first.`,
  ).toBe(true);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-packaged-"));
  let app: ElectronApplication | null = null;
  // The renderer port is reserved for the profile's shape only: nothing serves it.
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "design-canvas-packaged",
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
  await withCleanup(async () => {
    app = await electron.launch({
      executablePath,
      args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
      cwd: temporaryRoot,
      env: {
        ...packagedLaunchEnvironment(process.env, { home, profilePath }),
        // macOS cannot run headless: keep the window off the shared desktop.
        ...(process.platform === "darwin" ? { [AGENT_TEST_HIDDEN_WINDOWS_ENV]: "1" } : {}),
      },
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    const window = await openDesignWindow(electronApp, profile, {
      title: "native",
      timeoutMs: 60_000,
    });
    const pageErrors: string[] = [];
    window.on("pageerror", (error) => pageErrors.push(error.message));

    await test.step("the packaged app loads its renderer from file://", async () => {
      const runtime = await electronApp.evaluate(({ app: electronApp }) => ({
        isPackaged: electronApp.isPackaged,
        resourcesPath: process.resourcesPath,
        userData: electronApp.getPath("userData"),
      }));
      expect(runtime.isPackaged).toBe(true);
      expect(runtime.resourcesPath).toBe(packagedResourcesPath(executablePath));
      expect(window.url()).toBe(
        pathToFileURL(path.join(runtime.resourcesPath, "web", "index.html")).href,
      );
      // The disposable profile, never the user's data directory.
      expect(runtime.userData).toBe(profile.dataDir);
      expect(path.relative(temporaryRoot, runtime.userData).startsWith("..")).toBe(false);
      test.info().annotations.push({ type: "packaged-app", description: executablePath });
    });

    await runDesignCanvasJourney({ electronApp, window, profile, temporaryRoot });
    // Reported, not asserted: the dev spec does not hold the renderer to zero either.
    test.info().annotations.push({ type: "page-errors", description: String(pageErrors.length) });
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
          // Retain the profile if forced termination could not prove the tree stopped.
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped(owned, 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});
