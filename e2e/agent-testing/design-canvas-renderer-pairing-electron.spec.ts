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
 *   (`ORKESTRATOR_PAIRING_RELEASE` picks another release; what the agent
 *   journey expects of it follows `pairingBackendDesignCapabilities`).
 * - **Published renderer, this backend.** A published desktop build, connected
 *   to `apps/backend/src/main.ts`. It runs only when
 *   `ORKESTRATOR_PAIRING_OLD_APP_EXECUTABLE` names its executable (absolute,
 *   or relative to the repository root), for example
 *   v2.22.3's macOS zip from the GitHub release, unpacked with `ditto -x -k`
 *   into a new empty directory under `output/agent-testing/`:
 *   `…/OrkestratorV2.app/Contents/MacOS/OrkestratorV2`. That build ships with
 *   the Node inspect fuse off, so it is driven over CDP
 *   (`--remote-debugging-port=0`) and the journey skips the steps that need
 *   main (window size, the download's save path, the window zoom factor).
 *   It predates hidden agent-test windows, so on macOS its window opens on
 *   the desktop for the length of the run; on Linux it gets the same headless
 *   switches as the packaged app (`packagedLaunchSwitches`).
 *
 * After the canvas journey each half runs Ask agent and Resume
 * (design-agent-pairing-journey.ts, to-do 8011 (retired)) on a real Claude Code whose
 * every model call goes to a loopback Anthropic endpoint in this process
 * (`fake-anthropic-model.ts`), with a fixture key: no login, nothing billed.
 * v2.22.3 predates Resume in both halves, so neither pair can press it: this
 * renderer on the old backend must show the closed link as ended (the old
 * backend refuses `design_session_link_states`, the `unsupported` fallback),
 * and the old renderer shows it as ended from its own layout. The second half
 * then connects this checkout's packaged renderer to the same new backend and
 * resumes the conversation the old renderer made: the upgrade path, and the
 * only place in the pairing where Resume runs.
 *
 * Both apps run on a disposable agent-test profile under a temporary root,
 * with HOME, the XDG roots and an allowlisted environment
 * (`packagedLaunchEnvironment`), as design-canvas-packaged-electron.spec.ts
 * does. Both backends are this run's own, on loopback, on ports other than the
 * production ones, with their own data directories. Their toolchain holds
 * only this checkout's pinned Claude Code (downloaded once into
 * `output/agent-testing/design-pairing-toolchain`, never the real data
 * directory) and a stub `pi`, and their Claude configuration directory is the
 * run's own, so the only provider turns are against the loopback model. The
 * gateway token is passed only to `connections.connect`; tracing is off so it
 * is not recorded.
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
  packagedAppStop,
  packagedResourcesPath,
  stopPackagedAppThenRemoveProfile,
  stopPackagedAppsThenRemoveProfile,
} from "./packaged-electron-app";
import {
  DEFAULT_PAIRING_RELEASE,
  PAIRING_OLD_APP_ENV,
  PAIRING_RELEASE_ENV,
  installPairingClaude,
  installPublishedBackend,
  pairingBackendDesignCapabilities,
  pairingOldAppExecutable,
  pairingPorts,
  startPairingBackend,
  type PairingBackend,
} from "./design-renderer-pairing-support";
import {
  removeAskAgentEnvironment,
  resumeLinkedConversation,
  runAskAgentJourney,
} from "./design-agent-pairing-journey";
import { startFakeAnthropicModel, type FakeAnthropicModel } from "./fake-anthropic-model";

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
 * the app's own bundled backend's. That proof needs the two versions to
 * differ, so a pairing of a version with itself fails here rather than
 * passing against the bundled backend. A same-version connection names
 * `knownEnvironmentId` instead, an environment only `backend` has: the proof
 * is then that `get_environment` finds it.
 */
async function connectWindow(
  window: Page,
  backend: PairingBackend,
  knownEnvironmentId?: string,
): Promise<void> {
  const invokeVersion = (): Promise<string> =>
    window.evaluate(() => (globalThis as any).orkestrator.invoke("get_app_version", {}));
  const localVersion = await invokeVersion();
  if (knownEnvironmentId) {
    await connectAndProve(window, backend, async () =>
      window
        .evaluate(
          (environmentId) =>
            (globalThis as any).orkestrator
              .invoke("get_environment", { environmentId })
              .then((environment: { id?: string } | null) => environment?.id === environmentId),
          knownEnvironmentId,
        )
        .catch(() => false),
    );
    test.info().annotations.push({
      type: "pairing",
      description: JSON.stringify({
        renderer: localVersion,
        backend: backend.version,
        proof: "environment",
      }),
    });
    return;
  }
  expect(
    localVersion,
    "the paired backend must report another version than the app's bundled one",
  ).not.toBe(backend.version);
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

/** Connect to `backend` and reload until `proved` holds (see {@link connectWindow}). */
async function connectAndProve(
  window: Page,
  backend: PairingBackend,
  proved: () => Promise<boolean>,
): Promise<void> {
  const active = await window.evaluate(
    ({ address, token }) =>
      (
        globalThis as unknown as { orkestrator: { connections: Connections } }
      ).orkestrator.connections.connect({ address, token, nickname: "Pairing" }),
    { address: backend.origin, token: backend.token },
  );
  expect(active.activeConnectionId).toBeTruthy();
  await expect
    .poll(
      async () => {
        const ok = await proved();
        if (!ok) await window.reload().catch(() => undefined);
        return ok;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(true);
}

/**
 * The loopback model and the Claude Code the pairing backends run (to-do
 * 8011 (retired)). The model stops with the test's other cleanups.
 */
async function pairingAgent(): Promise<{
  model: FakeAnthropicModel;
  agent: { claudeExecutable: string; modelOrigin: string };
}> {
  const claudeExecutable = await installPairingClaude();
  const model = await startFakeAnthropicModel();
  return { model, agent: { claudeExecutable, modelOrigin: model.origin } };
}

/**
 * The backends' Claude Code has no login, only the loopback model's fixture
 * key in its settings, so both renderers open "Claude Code Is Not Logged In".
 * The notice is non-blocking, and sessions still run on that key; it is
 * dismissed for this run only, as the other fake-model specs do.
 */
function dismissClaudeLoginNotice(window: Page): void {
  window
    .addLocatorHandler(
      window.getByRole("button", { name: "Continue Without Claude", exact: true }),
      async (button) => {
        await button.click({ timeout: 5_000 }).catch(() => undefined);
      },
    )
    .catch(() => undefined);
}

/** Launch this checkout's packaged app on a fresh profile and open its first window. */
async function launchPackagedApp(temporaryRoot: string, profileId: string) {
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:${process.platform === "darwin" ? "mac" : "linux"}:unpacked:test\` first.`,
  ).toBe(true);
  const { profile, profilePath, home } = await pairingProfile(temporaryRoot, profileId);
  const app = await electron.launch({
    executablePath,
    args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
    cwd: temporaryRoot,
    env: {
      ...packagedLaunchEnvironment(process.env, { home, profilePath }),
      ...(process.platform === "darwin" ? { [AGENT_TEST_HIDDEN_WINDOWS_ENV]: "1" } : {}),
    },
  });
  recordElectronDiagnostics(app);
  return { app, profile };
}

test("this checkout's packaged renderer edits, exports and asks an agent on a published backend", async () => {
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
  let model: FakeAnthropicModel | null = null;
  await withCleanup(async () => {
    const packageRoot = await installPublishedBackend(release, path.join(temporaryRoot, "npm"));
    const paired = await pairingAgent();
    model = paired.model;
    backend = await startPairingBackend(
      { kind: "published", packageRoot },
      path.join(temporaryRoot, "backend"),
      paired.agent,
    );
    expect(backend.version).toBe(release);
    const launched = await launchPackagedApp(temporaryRoot, "design-pairing-new");
    app = launched.app;
    const { profile } = launched;
    const window = await openDesignWindow(app, profile, { title: "native", timeoutMs: 60_000 });
    dismissClaudeLoginNotice(window);
    await connectWindow(window, backend);
    const electronApp = app;
    await journeyWithEvidence(window, () =>
      runDesignCanvasJourney({ electronApp, window, profile, temporaryRoot }),
    );
    // v2.22.3 has neither; a later selected release may have both, and then
    // this renderer must offer Resume and resume the conversation.
    const capabilities = pairingBackendDesignCapabilities(release);
    test.info().annotations.push({
      type: "pairing-backend-capabilities",
      description: JSON.stringify(capabilities),
    });
    await journeyWithEvidence(window, async () => {
      const asked = await runAskAgentJourney({
        window,
        profile,
        model: paired.model,
        backendHasLinkStates: capabilities.linkStates,
        resumeOffered: capabilities.linkStates && capabilities.resume,
      });
      if (capabilities.linkStates && capabilities.resume)
        await resumeLinkedConversation({ window, model: paired.model, asked });
      await removeAskAgentEnvironment(window, asked.environmentId);
    });
  }, [
    // The root holds the backend's data directory and worktrees as well as
    // the app's profile: it is removed only once both are proven stopped.
    () =>
      stopPackagedAppThenRemoveProfile(app, {
        snapshot: (launched) => electronProcessTree(launched),
        close: (launched, owned) => closeElectron(launched, owned),
        release: async () => {
          await (backend as PairingBackend | null)?.stop();
        },
        waitForStopped: (owned) => waitForStopped(owned, 0),
        removeProfile: () => rm(temporaryRoot, { recursive: true, force: true }),
      }),
    async () => {
      await (model as FakeAnthropicModel | null)?.stop();
    },
  ]);
});

/**
 * Run the journey, attaching a screenshot, the page's accessibility tree and
 * the text of any open dialog when it fails: Playwright takes no failure screenshot of an Electron window.
 * Neither shows the gateway token.
 */
async function journeyWithEvidence<T>(window: Page, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const screenshot = await window.screenshot().catch(() => null);
    if (screenshot)
      await test.info().attach("failure", { body: screenshot, contentType: "image/png" });
    const tree = await window
      .locator("body")
      .ariaSnapshot()
      .catch(() => null);
    if (tree) await test.info().attach("failure-aria", { body: tree, contentType: "text/plain" });
    // An open modal hides the rest of the window from the tree above.
    const dialogs = await window
      .evaluate(() =>
        Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]'))
          .filter((element) => element.getAttribute("aria-hidden") !== "true")
          .map((element) => (element as HTMLElement).innerText)
          .join("\n----\n"),
      )
      .catch(() => null);
    if (dialogs)
      await test.info().attach("failure-dialogs", { body: dialogs, contentType: "text/plain" });
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

test("a published desktop renderer edits, exports and asks an agent on this checkout's backend", async () => {
  const executable = pairingOldAppExecutable(repositoryRoot, process.env);
  test.skip(!executable, `Set ${PAIRING_OLD_APP_ENV} to a published desktop build's executable`);
  test.setTimeout(600_000);
  expect(existsSync(executable!), `No app at ${executable}`).toBe(true);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-pairing-"));
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  let backend: PairingBackend | null = null;
  let model: FakeAnthropicModel | null = null;
  let resumer: ElectronApplication | null = null;
  const stopPublishedApp = (launched: ChildProcess) =>
    withCleanup(async () => {
      await (browser as Browser | null)?.close();
    }, [() => stopProcessGroup(launched, 15_000)]);
  await withCleanup(async () => {
    const paired = await pairingAgent();
    model = paired.model;
    backend = await startPairingBackend(
      { kind: "current" },
      path.join(temporaryRoot, "backend"),
      paired.agent,
    );
    const { profile, profilePath, home } = await pairingProfile(
      temporaryRoot,
      "design-pairing-old",
    );
    let stderr = "";
    const launched = ownProcessGroup(
      spawn(
        executable!,
        [
          ...ELECTRON_TEST_SWITCHES,
          // Linux: the environment has no display, so the app runs headless.
          ...packagedLaunchSwitches(process.platform),
          "--remote-debugging-port=0",
        ],
        {
          detached: true,
          cwd: temporaryRoot,
          stdio: ["ignore", "ignore", "pipe"],
          env: packagedLaunchEnvironment(process.env, { home, profilePath }),
        },
      ),
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
    dismissClaudeLoginNotice(window);
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
    const asked = await journeyWithEvidence(window, () =>
      runAskAgentJourney({
        window,
        profile,
        model: paired.model,
        backendHasLinkStates: true,
        resumeOffered: false,
        olderRenderer: true,
      }),
    );
    // The upgrade path: the published app closes, and this checkout's
    // renderer, on the same backend, resumes what the old one linked.
    await stopPublishedApp(launched);
    const next = await launchPackagedApp(temporaryRoot, "design-pairing-resume");
    resumer = next.app;
    const current = await openDesignWindow(next.app, next.profile, {
      title: "native",
      timeoutMs: 60_000,
    });
    dismissClaudeLoginNotice(current);
    await connectWindow(current, backend, asked.environmentId);
    await journeyWithEvidence(current, async () => {
      await resumeLinkedConversation({ window: current, model: paired.model, asked });
      await removeAskAgentEnvironment(current, asked.environmentId);
    });
  }, [
    // Both apps share the root, so it goes only once this checkout's app,
    // the published app's whole process group and the backend are all
    // proven stopped: a resumer that cannot be proven stopped keeps it.
    () =>
      stopPackagedAppsThenRemoveProfile(
        [
          packagedAppStop(resumer as ElectronApplication | null, {
            snapshot: (launched) => electronProcessTree(launched),
            close: (launched, owned) => closeElectron(launched, owned),
            waitForStopped: (owned) => waitForStopped(owned, 0),
          }),
          packagedAppStop(child as ChildProcess | null, {
            snapshot: (launched) => (launched.pid ? [-launched.pid, launched.pid] : []),
            close: (launched) => stopPublishedApp(launched),
            waitForStopped: (owned) => waitForStopped(owned, 0),
          }),
        ],
        {
          release: async () => {
            await (backend as PairingBackend | null)?.stop();
          },
          removeProfile: () => rm(temporaryRoot, { recursive: true, force: true }),
        },
      ),
    async () => {
      await (model as FakeAnthropicModel | null)?.stop();
    },
  ]);
});
