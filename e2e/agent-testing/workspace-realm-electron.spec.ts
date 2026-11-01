import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * Another node's workspace in a desktop window's central region
 * (docs/architecture/command-nodes.md, "Opening an environment on another
 * node"), through the real main process, preload and IPC: the window stays on
 * its command node and never reloads; the leaf's workspace is a child view
 * bound to the leaf, placed over the central region, and hidden — not closed
 * — when one of the window's own environments is selected again.
 */

type RouteUpgradeFixture = { allowDirect: boolean; restore(): void; advance(): void };
type CaptureFixture = { pending: boolean; release(): void; restore(): void };
type CoordinatorGate = { release(): void };
type Project = { id: string; name: string };
type Environment = { id: string; name: string; status?: string; worktreePath?: string | null };

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

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

/** A standalone backend from source: the leaf the desktop's command node attaches. */
async function startLeaf(root: string) {
  const [port] = (await reserveLoopbackPorts(1)) as [number];
  const token = randomBytes(24).toString("base64url");
  const dir = path.join(root, "leaf");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const child = spawn(
    "bun",
    [
      "apps/backend/src/main.ts",
      "--data-dir",
      path.join(dir, "data"),
      "--host",
      "127.0.0.1",
      "--allow-non-tailscale-bind",
      "--port",
      String(port),
      "--strict-gateway-port",
      "--runtime-flavor",
      "agent-test",
      "--worktree-dir",
      path.join(dir, "worktrees"),
    ],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        ORKESTRATOR_GATEWAY_TOKEN: token,
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the leaf did not start")), 90_000);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes('"orkestrator-backend-ready"')) {
        clearTimeout(timer);
        child.stdout?.resume();
        resolve();
      }
      buffer = buffer.slice(-4096);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the leaf exited early (${code})`));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`${origin}/__orkestrator/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    const payload = (await response.json()) as { result?: T; error?: string };
    if (!response.ok) throw new Error(`leaf ${command}: ${payload.error ?? response.status}`);
    return payload.result as T;
  };
  // One project with one local environment, named so its rows are easy to find.
  const repo = path.join(dir, "repos", "leaf-app");
  const bare = path.join(dir, "repos", "leaf-app.git");
  await mkdir(repo, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], repo);
  run(
    "git",
    [
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    repo,
  );
  run("git", ["init", "-q", "--bare", "-b", "main", bare], dir);
  run("git", ["remote", "add", "origin", bare], repo);
  run("git", ["push", "-q", "-u", "origin", "main"], repo);
  const project = await invoke<Project>("add_project", { gitUrl: bare, localPath: repo });
  const environment = await invoke<Environment>("create_environment", {
    projectId: project.id,
    name: "leaf-env",
    environmentType: "local",
  });
  const profile = await invoke<{ revision: number }>("get_backend_profile");
  await invoke("update_backend_profile", {
    expectedRevision: profile.revision,
    displayName: "Leaf",
    colorToken: "blue",
  });
  const { nodeId } = await invoke<{ nodeId: string }>("get_node_status");
  return { child, origin, token, invoke, nodeId, project, environment };
}

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("a leaf's workspace opens in the window's central region without moving or reloading the window", async () => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-realm-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  let leafChild: ChildProcess | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-realm",
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
    const window = await electronApp.firstWindow();
    window.setDefaultTimeout(20_000);
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 60_000 });
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) =>
      window.evaluate(
        ({ command, args }) =>
          (
            globalThis as typeof globalThis & {
              orkestrator: {
                invoke<R>(command: string, args?: Record<string, unknown>): Promise<R>;
              };
            }
          ).orkestrator.invoke<T>(command, args),
        { command, args },
      );

    // The desktop's Local backend is the command node: one environment of its
    // own, and the leaf attached.
    const project = await invoke<Project>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const own = await invoke<Environment>("create_environment", {
      projectId: project.id,
      name: `desk-env-${Date.now()}`,
      environmentType: "local",
    });
    const directOrigin = leaf.origin;
    // Fail the initial advertised direct probe, then let the loopback
    // fallback answer. This models a transient failure during realm open.
    await electronApp.evaluate((_electron, directOrigin) => {
      const originalFetch = globalThis.fetch;
      const originalNow = Date.now;
      const probedGrants = new Set<string>();
      const fixture: RouteUpgradeFixture = {
        allowDirect: false,
        advance: () => {
          Date.now = () => originalNow() + 5 * 60_000;
        },
        restore: () => {
          globalThis.fetch = originalFetch;
          Date.now = originalNow;
        },
      };
      (
        globalThis as typeof globalThis & { routeUpgradeFixture?: RouteUpgradeFixture }
      ).routeUpgradeFixture = fixture;
      globalThis.fetch = ((input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (
          !fixture.allowDirect &&
          !probedGrants.has(authorization) &&
          authorization.startsWith("Bearer okg_") &&
          url.origin === directOrigin &&
          url.pathname === "/__orkestrator/hello"
        ) {
          probedGrants.add(authorization);
          return Promise.resolve(new Response("Probe unavailable", { status: 503 }));
        }
        return originalFetch(input, init);
      }) as typeof fetch;
    }, directOrigin);
    await invoke("add_node", {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: directOrigin }],
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
    await window.reload();
    const leafRow = window.locator(
      `[data-testid="federated-environment-row"][data-machine="${leaf.nodeId}"]`,
    );
    await expect(leafRow).toBeVisible({ timeout: 60_000 });
    await window.keyboard.press("Escape");

    // A reload of the window would drop this marker.
    await window.evaluate(() => {
      (globalThis as unknown as { __realmQa?: number }).__realmQa = 1;
    });
    const sameWindow = async () => {
      expect(
        await window.evaluate(() => (globalThis as unknown as { __realmQa?: number }).__realmQa),
      ).toBe(1);
      expect(
        await window.evaluate(
          () =>
            (globalThis as unknown as { orkestratorWorkspaceTarget?: unknown })
              .orkestratorWorkspaceTarget ?? null,
        ),
      ).toBeNull();
    };

    const leafProject = window.getByRole("button", { name: /^leaf-app\s*\d*$/ });
    await leafProject.click();

    // The main process opened one realm, bound to the leaf, over the central region.
    const realmState = () =>
      electronApp.evaluate(async ({ BrowserWindow, webContents }) => {
        const realm = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes("realm=workspace"));
        if (!realm) return null;
        const owner = BrowserWindow.getAllWindows()[0]!;
        const view = owner.contentView.children.find(
          (child) => (child as { webContents?: { id: number } }).webContents?.id === realm.id,
        ) as { getBounds(): Electron.Rectangle; getVisible(): boolean } | undefined;
        const realmInfo = (await realm.executeJavaScript(
          `({
            target: window.orkestratorWorkspaceTarget ?? null,
            toolbar: Boolean(document.querySelector("[data-mobile-toolbar]")),
            sidebar: Boolean(document.querySelector('[data-testid="project-search-bar"]')),
            homeSelected: Boolean(document.querySelector('[role="tab"][aria-controls="project-panel-home"][aria-selected="true"]')),
            coordinatorSelected: Boolean(document.querySelector('[role="tab"][aria-controls="project-panel-coordinator"][aria-selected="true"]')),
            coordinatorGate: Boolean(document.querySelector('[data-testid="leaf-mode-coordinator-gate"]')),
            coordinatorChecking: Boolean(document.querySelector('[data-testid="leaf-mode-coordinator-pending"], [data-testid="leaf-mode-coordinator-unavailable"]')),
            coordinatorPanel: Boolean(document.querySelector('#project-panel-coordinator')),
          })`,
        )) as {
          target: { nodeId: string; path: "relay" | "direct" } | null;
          toolbar: boolean;
          sidebar: boolean;
          homeSelected: boolean;
          coordinatorSelected: boolean;
          coordinatorGate: boolean;
          coordinatorChecking: boolean;
          coordinatorPanel: boolean;
        };
        return {
          count: webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL().includes("realm=workspace")).length,
          bounds: view?.getBounds() ?? null,
          visible: view?.getVisible() ?? false,
          zoom: owner.webContents.getZoomFactor(),
          ...realmInfo,
        };
      });
    await expect
      .poll(async () => (await realmState())?.toolbar ?? false, { timeout: 60_000 })
      .toBe(true);
    await expect.poll(async () => (await realmState())?.visible).toBe(true);
    const opened = (await realmState())!;
    expect(opened.count).toBe(1);
    expect(opened.target?.nodeId).toBe(leaf.nodeId);
    expect(opened.sidebar).toBe(false);
    expect(opened.visible).toBe(true);
    const region = await window
      .locator('[data-testid="remote-workspace-region"]')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      });
    expect(opened.bounds).toEqual({
      x: Math.round(region.x * opened.zoom),
      y: Math.round(region.y * opened.zoom),
      width: Math.round(region.width * opened.zoom),
      height: Math.round(region.height * opened.zoom),
    });
    await expect(window).toHaveTitle(/leaf-app/);
    await sameWindow();

    // Machine grouping opens Coordinator, including on a fresh realm.
    await expect.poll(async () => (await realmState())?.coordinatorSelected).toBe(true);
    // Explicit board navigation also selects Coordinator in the same realm.
    await leafProject.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Open Board", exact: true }).click();
    await expect.poll(async () => (await realmState())?.coordinatorSelected).toBe(true);
    // The command node has a different repository. Main now opens this leaf's
    // coordinator directly instead of gating it behind a command-node notice.
    await expect.poll(async () => (await realmState())?.coordinatorChecking).toBe(false);
    await expect.poll(async () => (await realmState())?.coordinatorPanel).toBe(true);
    await expect.poll(async () => (await realmState())?.coordinatorGate).toBe(false);
    // Reselecting the project restores the grouping's landing tab.
    const realmPageForTabs = electronApp
      .context()
      .pages()
      .find((page) => page.url().includes("realm=workspace"));
    expect(realmPageForTabs).toBeTruthy();
    await realmPageForTabs!.getByRole("tab", { name: "Home", exact: true }).click();
    await expect.poll(async () => (await realmState())?.homeSelected).toBe(true);
    await leafProject.click();
    await expect.poll(async () => (await realmState())?.coordinatorSelected).toBe(true);

    // Repository grouping opens Home in the same realm, on initial click and reselection.
    await window.getByRole("button", { name: /^Sort environments:/ }).click();
    await window.getByRole("menuitemradio", { name: "By repository", exact: true }).click();
    const repositoryProject = window.getByTitle("Open leaf-app on Leaf");
    await repositoryProject.click();
    await expect.poll(async () => (await realmState())?.homeSelected).toBe(true);
    await realmPageForTabs!.getByRole("tab", { name: "Coordinator", exact: true }).click();
    await expect.poll(async () => (await realmState())?.coordinatorSelected).toBe(true);
    await repositoryProject.click();
    await expect.poll(async () => (await realmState())?.homeSelected).toBe(true);
    await window.getByRole("button", { name: /^Sort environments:/ }).click();
    await window.getByRole("menuitemradio", { name: "By machine", exact: true }).click();
    await sameWindow();
    await leafRow.getByRole("button", { name: /^leaf-env, on / }).click();
    await expect(leafRow).toHaveAttribute("data-selected", "true");

    // The mounted connection panel starts with the relayed snapshot.
    expect((await realmState())?.target?.path).toBe("relay");
    const connectionPath = () =>
      electronApp.evaluate(async ({ webContents }) => {
        const realm = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes("realm=workspace"))!;
        return realm.executeJavaScript(
          `document.querySelector('[data-testid="connection-path"]')?.getAttribute('data-path') ?? null`,
        );
      });
    const agentTrigger = window.getByRole("button", {
      name: /^(Open|Close) agent information$/,
    });
    await agentTrigger.click();
    await expect.poll(connectionPath).toBe("relay");
    await agentTrigger.click();

    // Hold the leaf coordinator's reads until released, so the reloaded realm's
    // coordinator finishes loading only after a panel has opened over it.
    await electronApp.evaluate(() => {
      const held: Array<() => void> = [];
      let open = true;
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (open && /"(get|ensure)_project_coordinator"/.test(body))
          await new Promise<void>((resolve) => held.push(resolve));
        return inner(input, init);
      }) as typeof fetch;
      (globalThis as typeof globalThis & { coordinatorGate?: CoordinatorGate }).coordinatorGate = {
        release: () => {
          open = false;
          for (const resolve of held.splice(0)) resolve();
        },
      };
    });
    const releaseCoordinator = () =>
      electronApp.evaluate(() =>
        (
          globalThis as typeof globalThis & { coordinatorGate: CoordinatorGate }
        ).coordinatorGate.release(),
      );
    // No upgrade while idle. A real renderer command must travel through
    // getBackend/noteUse, upgrade the route, and reload only this realm.
    await electronApp.evaluate(() => {
      const fixture = (
        globalThis as typeof globalThis & { routeUpgradeFixture: RouteUpgradeFixture }
      ).routeUpgradeFixture;
      fixture.allowDirect = true;
      fixture.advance();
    });
    // Advancing the route invalidates its previous verification. The first
    // read can initiate the upgrade while failing against that stale route.
    await expect
      .poll(
        async () => {
          try {
            await electronApp.evaluate(async ({ webContents }) => {
              const realm = webContents
                .getAllWebContents()
                .find((contents) => contents.getURL().includes("realm=workspace"))!;
              await realm.executeJavaScript(`window.orkestrator.invoke("get_backend_profile")`);
            });
            return true;
          } catch (error) {
            if (String(error).includes("The connection is awaiting a verified route")) return false;
            throw error;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await realmState())?.target?.path, { timeout: 30_000 })
      .toBe("direct");
    const gateway = await electronApp.evaluate(async ({ webContents }) => {
      const realm = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes("realm=workspace"))!;
      return realm.executeJavaScript(`window.orkestratorGateway.resolveBaseUrl()`);
    });
    expect(gateway).toBe(directOrigin);
    await sameWindow();
    // The realm's open title-bar panel, and whether it holds DOM and native focus.
    const panelState = () =>
      electronApp.evaluate(async ({ webContents }) => {
        const realm = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes("realm=workspace"))!;
        const dom = (await realm.executeJavaScript(`(() => {
        const panel = document.querySelector('section[role="dialog"][aria-hidden="false"]');
        return { label: panel?.getAttribute('aria-label') ?? null, focused: Boolean(panel?.contains(document.activeElement)) };
      })()`)) as { label: string | null; focused: boolean };
        return { ...dom, nativeFocus: realm.isFocused() };
      });
    // A coordinator that finishes loading under an open panel (a slow link, a
    // loaded host) mounts its composer there. The composer must not take the
    // panel's focus: it did, and the panel focus checks below failed whenever
    // the reloaded realm's coordinator was still loading (todo 1170).
    const coordinatorComposer = () =>
      electronApp.evaluate(async ({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().includes("realm=workspace"))!
          .executeJavaScript(
            `Boolean(document.querySelector('[role="textbox"][aria-label^="Ask the coordinator"]'))`,
          ),
      );
    try {
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.focus(),
      );
      const trigger = window.getByRole("button", { name: "Open agent information", exact: true });
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await electronApp.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows()[0]!.webContents;
        host.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        host.sendInputEvent({ type: "char", keyCode: "\r" });
        host.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      });
      await expect.poll(panelState).toMatchObject({ label: "Agent information", focused: true });
      expect(await coordinatorComposer()).toBe(false);
    } finally {
      await releaseCoordinator();
    }
    await expect.poll(coordinatorComposer, { timeout: 30_000 }).toBe(true);
    expect(await panelState()).toMatchObject({ label: "Agent information", focused: true });
    await agentTrigger.click();
    await expect.poll(async () => (await panelState()).label).toBeNull();
    // Reopen on the reloaded document: mounted UI must consume the new snapshot.
    await agentTrigger.click();
    await expect.poll(connectionPath).toBe("direct");
    await agentTrigger.click();
    await electronApp.evaluate(() => {
      (
        globalThis as typeof globalThis & { routeUpgradeFixture: RouteUpgradeFixture }
      ).routeUpgradeFixture.restore();
    });

    // Native keyboard input requires the containing window to be focused.
    const windowFocused = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
      if (process.platform === "darwin") app.focus({ steal: true });
      const host = BrowserWindow.getAllWindows()[0]!;
      host.show();
      host.focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return host.isFocused();
    });
    if (!windowFocused)
      test.info().annotations.push({
        type: "native-focus",
        description:
          "The desktop session did not activate Electron. DOM keyboard handoffs are checked; native focus calls are covered by WorkspaceViews unit tests.",
      });
    {
      const realmPage = electronApp
        .windows()
        .find((page) => page.url().includes("realm=workspace"));
      if (!realmPage) throw new Error("The realm page was not attached");
      const previewUrl = `${rendererUrl}/favicon.ico?shortcuts-native-preview`;
      await realmPage.evaluate(async (url) => {
        const api = (
          window as unknown as {
            orkestrator: {
              browserPreview: {
                attach(input: unknown): Promise<unknown>;
              };
            };
          }
        ).orkestrator.browserPreview;
        await api.attach({
          tabId: "shortcuts-native-qa",
          url,
          bounds: { x: 10, y: 80, width: 160, height: 90 },
          visible: true,
        });
      }, previewUrl);
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .some((contents) => contents.getURL() === url && !contents.isLoading()),
            previewUrl,
          ),
        )
        .toBe(true);
      const previewPage = electronApp.windows().find((page) => page.url() === previewUrl);
      if (!previewPage) throw new Error("The native preview page was not attached");
      await previewPage.evaluate(() => {
        document.body.innerHTML = '<input aria-label="Preview editor">';
      });
      const editor = previewPage.getByRole("textbox", { name: "Preview editor" });
      const chord = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Slash`;
      try {
        for (const source of ["menu", "preview", "outside"] as const) {
          await editor.focus();
          await electronApp.evaluate(({ webContents }, url) => {
            const contents = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === url)!;
            contents.focus();
            // Exercise the native focus notification even on shared desktops
            // where the OS refuses to activate the test application's window.
            contents.emit("focus");
          }, previewUrl);
          if (source === "menu") {
            await electronApp.evaluate(({ BrowserWindow, Menu }) => {
              const host = BrowserWindow.getAllWindows()[0]!;
              const item = Menu.getApplicationMenu()!
                .items.find((item) => item.label === "View")!
                .submenu!.items.find((item) => item.label === "Keyboard Shortcuts…")!;
              item.click({ triggeredByAccelerator: false }, host, host.webContents);
            });
          } else
            await electronApp.evaluate(({ webContents }, url) => {
              const contents = webContents
                .getAllWebContents()
                .find((item) => item.getURL() === url)!;
              const modifiers: ("meta" | "control" | "shift")[] = [
                process.platform === "darwin" ? "meta" : "control",
                "shift",
              ];
              contents.sendInputEvent({ type: "keyDown", keyCode: "/", modifiers });
              contents.sendInputEvent({ type: "keyUp", keyCode: "/", modifiers });
            }, previewUrl);
          const dialog = realmPage.getByRole("dialog", { name: "Keyboard shortcuts" });
          await expect(dialog).toBeVisible();
          await expect(
            realmPage.getByRole("textbox", { name: "Search keyboard shortcuts" }),
          ).toBeFocused();
          await expect(window.getByTestId("keyboard-shortcuts-dialog")).toHaveCount(0);
          if (source === "menu") {
            // The built MenuItem adapts its event-first call to the template's
            // third event argument. An open dialog distinguishes toggle/open.
            await electronApp.evaluate(({ BrowserWindow, Menu }) => {
              const host = BrowserWindow.getAllWindows()[0]!;
              const item = Menu.getApplicationMenu()!
                .items.find((item) => item.label === "View")!
                .submenu!.items.find((item) => item.label === "Keyboard Shortcuts…")!;
              item.click(
                {
                  triggeredByAccelerator: true,
                  shiftKey: true,
                  metaKey: process.platform === "darwin",
                  ctrlKey: process.platform !== "darwin",
                },
                host,
                host.webContents,
              );
            });
            await expect(dialog).toHaveCount(0);
            await realmPage.keyboard.press(chord);
            await expect(dialog).toBeVisible();
          }
          // No product echo interval or fixed test delay: a separate press closes.
          if (source === "outside")
            await realmPage
              .locator('[data-slot="dialog-overlay"]')
              .click({ position: { x: 2, y: 2 } });
          else await realmPage.keyboard.press(source === "menu" ? "Escape" : chord);
          await expect(dialog).toHaveCount(0);
          if (windowFocused)
            await expect
              .poll(() =>
                electronApp.evaluate(
                  ({ webContents }, url) => webContents.getFocusedWebContents()?.getURL() === url,
                  previewUrl,
                ),
              )
              .toBe(true);
          await previewPage.keyboard.type(source);
          await expect(editor).toHaveValue(source);
          await editor.fill("");
        }
      } finally {
        await realmPage.evaluate(async () => {
          await (
            window as unknown as {
              orkestrator: { browserPreview: { destroy(id: string): Promise<void> } };
            }
          ).orkestrator.browserPreview.destroy("shortcuts-native-qa");
        });
      }
    }
    // ⌘K / Ctrl+K typed in the realm's composer opens the window's search,
    // which takes native keyboard focus from the realm.
    {
      const realmPage = electronApp
        .windows()
        .find((page) => page.url().includes("realm=workspace"));
      if (!realmPage) throw new Error("The realm page was not attached");
      await realmPage.evaluate(() => {
        const composer = document.createElement("textarea");
        composer.setAttribute("aria-label", "Realm QA composer");
        document.body.append(composer);
      });
      const composer = realmPage.getByRole("textbox", { name: "Realm QA composer" });
      const search = window.getByRole("dialog", { name: "Search projects and environments" });
      try {
        await composer.focus();
        await realmPage.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+K`);
        await expect(search).toBeVisible();
        await expect(realmPage.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
        if (windowFocused)
          await expect
            .poll(() =>
              electronApp.evaluate(
                ({ BrowserWindow, webContents }) =>
                  webContents.getFocusedWebContents()?.id ===
                  BrowserWindow.getAllWindows()[0]!.webContents.id,
              ),
            )
            .toBe(true);
        await window.keyboard.press("Escape");
        await expect(search).toHaveCount(0);
      } finally {
        await realmPage.evaluate(() =>
          document.querySelector('[aria-label="Realm QA composer"]')?.remove(),
        );
      }
    }
    // Keyboard focus crosses the native webContents boundary in both directions.
    for (const [triggerLabel, panelLabel] of [
      ["Open agent information", "Agent information"],
      ["Open environment process usage", "Environment process usage"],
    ]) {
      const trigger = window.getByRole("button", { name: triggerLabel, exact: true });
      await expect(trigger).not.toHaveAttribute("aria-controls");
      for (const dismiss of ["close", "Escape"]) {
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.focus(),
        );
        await trigger.focus();
        await expect(trigger).toBeFocused();
        await electronApp.evaluate(({ BrowserWindow }) => {
          const host = BrowserWindow.getAllWindows()[0]!.webContents;
          host.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          host.sendInputEvent({ type: "char", keyCode: "\r" });
          host.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        });
        await expect.poll(panelState).toMatchObject({ label: panelLabel, focused: true });
        if (windowFocused)
          await expect.poll(async () => (await panelState()).nativeFocus).toBe(true);
        // Clear the shell's retained DOM focus so return-focus cannot pass
        // merely because the original trigger stayed its active element.
        await window.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        // Send actual native keyboard input to the focused child document.
        await electronApp.evaluate(({ webContents }, dismiss) => {
          const realm = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().includes("realm=workspace"))!;
          const keyCode = dismiss === "Escape" ? "Escape" : "Enter";
          realm.sendInputEvent({ type: "keyDown", keyCode });
          if (keyCode === "Enter") realm.sendInputEvent({ type: "char", keyCode: "\r" });
          realm.sendInputEvent({ type: "keyUp", keyCode });
        }, dismiss);
        await expect.poll(async () => (await panelState()).label).toBeNull();
        await expect(trigger).toBeFocused();
        await expect.poll(async () => (await panelState()).nativeFocus).toBe(false);
      }
    }

    // A sidebar menu that stays clear of the central region leaves the
    // workspace live.
    await leafRow
      .getByRole("button", { name: /^leaf-env, on / })
      .click({ button: "right", position: { x: 20, y: 8 } });
    await expect(window.getByRole("menu")).toBeVisible();
    await window.waitForTimeout(300);
    expect((await realmState())?.visible).toBe(true);
    await expect(window.getByTestId("workspace-realm-still")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByRole("menu")).toHaveCount(0);

    // A dialog over the region: the workspace steps aside, leaving a still of
    // itself under the dialog, and comes back when the dialog closes.
    await window.evaluate(() =>
      globalThis.dispatchEvent(
        new CustomEvent("orkestrator:open-global-settings", { detail: "general" }),
      ),
    );
    await expect(window.getByRole("dialog")).toBeVisible();
    await expect(window.getByTestId("workspace-realm-still")).toHaveAttribute(
      "src",
      /^data:image\/jpeg;base64,/,
    );
    await expect.poll(async () => (await realmState())?.visible).toBe(false);
    await window.screenshot({
      path: test.info().outputPath("settings-over-leaf-workspace.png"),
    });
    await window.keyboard.press("Escape");
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => (await realmState())?.visible).toBe(true);
    await expect(window.getByTestId("workspace-realm-still")).toHaveCount(0);

    // A slow still capture must not intercept input intended for a shell dialog.
    await electronApp.evaluate(({ webContents }) => {
      const realm = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes("realm=workspace"))!;
      const capture = realm.capturePage.bind(realm);
      const fixture: CaptureFixture = {
        pending: false,
        release: () => undefined,
        restore: () => {
          realm.capturePage = capture;
        },
      };
      (
        globalThis as typeof globalThis & { realmCaptureFixture?: CaptureFixture }
      ).realmCaptureFixture = fixture;
      realm.capturePage = (...args) => {
        fixture.pending = true;
        const image = capture(...args);
        return new Promise((resolve, reject) => {
          fixture.release = () => {
            void image.then(resolve, reject);
          };
        });
      };
    });
    await window.evaluate((region) => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("data-state", "open");
      Object.assign(dialog.style, {
        position: "fixed",
        zIndex: "1000",
        background: "white",
        padding: "20px",
        left: `${region.x + region.width / 2}px`,
        top: `${region.y + region.height / 2}px`,
      });
      const button = document.createElement("button");
      button.textContent = "Dismiss during capture";
      button.onclick = () => dialog.remove();
      dialog.appendChild(button);
      document.body.appendChild(dialog);
    }, region);
    await expect
      .poll(() =>
        electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { realmCaptureFixture?: CaptureFixture })
              .realmCaptureFixture?.pending,
        ),
      )
      .toBe(true);
    await expect.poll(async () => (await realmState())?.visible).toBe(false);
    await window.getByRole("button", { name: "Dismiss during capture", exact: true }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await electronApp.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { realmCaptureFixture?: CaptureFixture };
      runtime.realmCaptureFixture!.restore();
      runtime.realmCaptureFixture!.release();
      delete runtime.realmCaptureFixture;
    });
    await expect.poll(async () => (await realmState())?.visible).toBe(true);
    await expect(window.getByTestId("workspace-realm-still")).toHaveCount(0);

    // Selecting it started the leaf's local environment, as the leaf's own sidebar would.
    await expect
      .poll(
        async () =>
          (
            await leaf.invoke<Environment>("get_environment", {
              environmentId: leaf.environment.id,
            })
          ).status,
        { timeout: 60_000 },
      )
      .toBe("running");

    // The window's own environment brings the central region back; the realm stays open.
    const expand = window.getByRole("button", { name: `Expand project ${project.name}` });
    const ownRow = window.getByText(own.name, { exact: true }).first();
    await expect(expand.or(ownRow)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await ownRow.click();
    await expect.poll(async () => (await realmState())?.visible, { timeout: 20_000 }).toBe(false);
    expect((await realmState())?.count).toBe(1);
    await expect(leafRow).not.toHaveAttribute("data-selected", "true");
    await sameWindow();

    // And back again: the same realm, shown, with no reload anywhere.
    await leafRow.getByRole("button", { name: /^leaf-env, on / }).click();
    await expect.poll(async () => (await realmState())?.visible, { timeout: 20_000 }).toBe(true);
    expect((await realmState())?.count).toBe(1);
    await sameWindow();

    await invoke("stop_environment", { environmentId: own.id }).catch(() => undefined);
    await leaf
      .invoke("stop_environment", { environmentId: leaf.environment.id })
      .catch(() => undefined);
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
