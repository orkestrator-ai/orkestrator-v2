import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { _electron as electron } from "playwright";

import { BackendProcess } from "../../apps/desktop/electron/backend-process";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { startOutageLink, type OutageLink } from "./client-outage-support";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The desktop half of client freshness
 * (docs/todo/transcripts-and-observation/0051-client-reconnect-and-freshness.md):
 * a window whose active connection is a remote backend has no gateway stream of
 * its own in the renderer, so its outage signal is Electron's connection list.
 * The remote is a real second backend behind a test-owned link, restarted for
 * real and then cut off silently.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const BANNER_DELAY_MS = 4_000;
/** Two silent keepalives and the slack (60 s), the banner's delay, and a margin. */
const SILENT_LINK_BANNER_BUDGET_MS = 75_000;
const RECONNECT_BUDGET_MS = 45_000;

type Connections = {
  connect(input: {
    address: string;
    token: string;
    nickname: string;
  }): Promise<{ activeConnectionId: string }>;
  list(): Promise<{ connections: Array<{ id: string; transport?: string }> }>;
};

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

const coordinatorDisconnected = (window: Page): Promise<boolean> =>
  window.evaluate(async () => {
    const modulePath = "/src/lib/read-coordinator.ts";
    const { getReadCoordinator } = await import(/* @vite-ignore */ modulePath);
    return getReadCoordinator().getDiagnostics().disconnected as boolean;
  });

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a remote connection shows the banner, pauses reads and recovers, on a restart and on a silent link", async () => {
  test.setTimeout(420_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-outage-"));
  const [rendererPort, gatewayPort, remotePort] = (await reserveLoopbackPorts(3)) as [
    number,
    number,
    number,
  ];
  const roots = (name: string) => ({
    developmentRoot: path.join(temporaryRoot, name),
    productionDataDir: path.join(temporaryRoot, "production"),
    homeDir: temporaryRoot,
  });
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-outage",
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: roots("local"),
  });
  const remoteProfile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-outage-remote",
    flavor: "agent-test",
    gatewayPort: remotePort,
    roots: roots("remote"),
  });
  const profilePath = await initializeProfile(profile);
  await initializeProfile(remoteProfile);
  await prepareFixtureRepository(
    profile,
    path.join(repositoryRoot, "test-fixtures", "agent-project"),
  );
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  let link: OutageLink | null = null;
  let remote = new BackendProcess();
  const startRemote = async () => {
    const backend = new BackendProcess();
    const controlPort = process.env.ORKESTRATOR_CONTROL_MCP_PORT;
    process.env.ORKESTRATOR_CONTROL_MCP_PORT = "0";
    try {
      await backend.start({
        isDev: true,
        appRoot: repositoryRoot,
        resourceRoot: repositoryRoot,
        dataDir: remoteProfile.dataDir,
        gatewayHost: "127.0.0.1",
        gatewayPort: remotePort,
        allowNonTailscaleBind: true,
        runtimeFlavor: "agent-test",
        runtimeProfileId: remoteProfile.id,
        worktreeDir: remoteProfile.worktreeDir,
        strictGatewayPort: true,
        strictDockerOwner: true,
        onEvent: () => undefined,
      });
    } finally {
      if (controlPort === undefined) delete process.env.ORKESTRATOR_CONTROL_MCP_PORT;
      else process.env.ORKESTRATOR_CONTROL_MCP_PORT = controlPort;
    }
    return backend;
  };
  try {
    remote = await startRemote();
    const info = remote.getInfo();
    if (!info) throw new Error("The remote backend reported no gateway");
    const token = (JSON.parse(await readFile(info.authFile, "utf8")) as { token: string }).token;
    link = await startOutageLink({
      owner: "electron-remote",
      gatewayUrl: `http://127.0.0.1:${remotePort}`,
      rendererUrl,
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
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      },
    });
    dismissStartupDialogs(app);
    const window = await app.firstWindow();
    window.setDefaultTimeout(20_000);
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });

    // The token stays in this test and the renderer's secure connection store.
    const connectionId = await window.evaluate(
      async ({ address, token }) =>
        (
          await (
            globalThis as unknown as { orkestrator: { connections: Connections } }
          ).orkestrator.connections.connect({ address, token, nickname: "Remote" })
        ).activeConnectionId,
      { address: link.url, token },
    );
    const transport = () =>
      window.evaluate(
        async (id) =>
          (
            await (
              globalThis as unknown as { orkestrator: { connections: Connections } }
            ).orkestrator.connections.list()
          ).connections.find((connection) => connection.id === id)?.transport,
        connectionId,
      );
    await expect.poll(transport, { timeout: 30_000 }).toBe("connected");
    const banner = window.getByTestId("connection-status-banner");
    await expect(banner).toHaveCount(0);
    await expect.poll(() => coordinatorDisconnected(window)).toBe(false);

    // A real backend restart.
    const stoppedAt = Date.now();
    await remote.stop();
    await expect.poll(transport, { timeout: 15_000 }).toBe("reconnecting");
    const reconnectingAfterMs = Date.now() - stoppedAt;
    await window.waitForTimeout(Math.max(0, stoppedAt + BANNER_DELAY_MS - 1_000 - Date.now()));
    await expect(banner).toHaveCount(0);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const bannerAfterMs = Date.now() - stoppedAt;
    await expect.poll(() => coordinatorDisconnected(window)).toBe(true);

    const startingAt = Date.now();
    remote = await startRemote();
    const listeningAt = Date.now();
    await expect.poll(transport, { timeout: RECONNECT_BUDGET_MS }).toBe("connected");
    const reconnectedAt = Date.now();
    await expect(banner).toHaveCount(0);
    await expect.poll(() => coordinatorDisconnected(window)).toBe(false);

    // A link that drops with no answer: nothing errors, so only silence tells.
    const cutAt = Date.now();
    link.setMode("blackhole");
    await expect(banner).toBeVisible({ timeout: SILENT_LINK_BANNER_BUDGET_MS });
    const silentBannerAfterMs = Date.now() - cutAt;
    expect(await transport()).toBe("reconnecting");
    await expect.poll(() => coordinatorDisconnected(window)).toBe(true);
    const restoredAt = Date.now();
    link.setMode("up");
    await expect.poll(transport, { timeout: RECONNECT_BUDGET_MS }).toBe("connected");
    await expect(banner).toHaveCount(0);
    await expect.poll(() => coordinatorDisconnected(window)).toBe(false);

    const evidence = {
      reconnectingAfterMs,
      bannerAfterMs,
      backendStartTookMs: listeningAt - startingAt,
      reconnectedAfterListeningMs: reconnectedAt - listeningAt,
      silentBannerAfterMs,
      silentRecoveredAfterRestoreMs: Date.now() - restoredAt,
    };
    test.info().annotations.push({
      type: "electron-remote",
      description: JSON.stringify(evidence),
    });
    console.log(`[connection-outage] electron-remote ${JSON.stringify(evidence)}`);
    expect(bannerAfterMs).toBeGreaterThanOrEqual(BANNER_DELAY_MS - 1_000);
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    await remote.stop().catch(() => undefined);
    await link?.close().catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
