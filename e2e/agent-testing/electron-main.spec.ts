import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

function backendChildPid(electronPid: number): number | null {
  const processes = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (processes.status !== 0) return null;
  for (const line of processes.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== electronPid) continue;
    if (match[3].includes("apps/backend/src/main.ts")) return Number(match[1]);
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string): Promise<void> {
  await expect
    .poll(
      async () =>
        fetch(url)
          .then((response) => response.ok)
          .catch(() => false),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
}

test("real Electron main process shares one backend across independent windows", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-smoke-"));
  let vite: ChildProcess | null = null;
  let launchedApp: ElectronApplication | null = null;
  const build = spawnSync("bunx", ["tsc", "-p", "tsconfig.electron.json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-smoke",
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
    await waitForUrl(rendererUrl);
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: [path.join(repositoryRoot, "apps", "desktop", "dist", "electron", "main.js")],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
      },
    });
    launchedApp = app;
    const window = await app.firstWindow();
    await expect(window).toHaveTitle(profile.electronTitle);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null),
      )
      .toBe(`${profile.electronTitle} — Local`);
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    expect(userData).toBe(profile.dataDir);
    const greeting = await window.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          orkestrator: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
        }
      ).orkestrator;
      return api.invoke<string>("greet", { name: "Electron smoke" });
    });
    expect(greeting).toContain("Hello, Electron smoke");
    await window
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              clipboard: { writeText(value: string): Promise<void>; readText(): Promise<string> };
            };
          }
        ).orkestrator;
        await api.clipboard.writeText("orkestrator-electron-smoke");
        return api.clipboard.readText();
      })
      .then((value) => expect(value).toBe("orkestrator-electron-smoke"));
    const electronPid = await app.evaluate(() => process.pid);
    expect(electronPid).toBeTruthy();
    const backendPid = await expect
      .poll(() => backendChildPid(electronPid!), { timeout: 10_000 })
      .not.toBeNull()
      .then(() => backendChildPid(electronPid!));
    expect(backendPid).not.toBeNull();

    const actionBarControl = window.getByRole("button", { name: "Global settings" });
    await expect(actionBarControl).toBeVisible();
    await window.bringToFront();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null),
      )
      .toBe(`${profile.electronTitle} — Local`);
    const invokeNewWindowAccelerator = () =>
      app.evaluate(({ BrowserWindow, Menu }) => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const fileMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
        const newWindow = fileMenu?.submenu?.items.find((item) => item.label === "New Window");
        if (!focusedWindow || !newWindow?.click) {
          throw new Error("New Window menu item is unavailable");
        }
        newWindow.click(undefined, focusedWindow, focusedWindow.webContents);
      });
    const dispatchRendererCommandN = () =>
      window.evaluate(() => {
        const event = new KeyboardEvent("keydown", {
          key: "n",
          code: "KeyN",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    const rendererTabCount = await window.locator('[aria-label^="Close "]').count();

    // Electron owns Command+N, but the DOM may observe the same keypress
    // before or after the native accelerator depending on the host. Exercise
    // the ActionBar listener on both sides of the real menu callback: neither
    // ordering may add a renderer tab or a duplicate BrowserWindow.
    expect(await dispatchRendererCommandN()).toBe(false);
    await invokeNewWindowAccelerator();
    expect(await dispatchRendererCommandN()).toBe(false);
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(2);
    await expect
      .poll(() => window.locator('[aria-label^="Close "]').count())
      .toBe(rendererTabCount);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect
      .poll(
        () => app.windows().filter((candidate) => candidate.url().startsWith(rendererUrl)).length,
        { timeout: 10_000 },
      )
      .toBe(2);
    const secondWindow = app
      .windows()
      .find((candidate) => candidate !== window && candidate.url().startsWith(rendererUrl));
    if (!secondWindow) throw new Error("New Window accelerator did not open a renderer window");
    await expect(secondWindow).toHaveTitle(profile.electronTitle);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((candidate) => candidate.getTitle()),
        ),
      )
      .toEqual([`${profile.electronTitle} — Local`, `${profile.electronTitle} — Local`]);

    const readWindowMenu = () =>
      app.evaluate(({ Menu }) => {
        const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Window");
        const radios = (windowMenu?.submenu?.items ?? []).filter((item) => item.type === "radio");
        return {
          present: Boolean(windowMenu),
          labels: radios.map((item) => item.label),
          selected: radios.filter((item) => item.checked).map((item) => item.label),
        };
      });
    const windowMenu = await readWindowMenu();
    expect(windowMenu.present).toBe(true);
    // Two windows share one connection title, so the entries must be distinct.
    expect(windowMenu.labels).toEqual([
      `${profile.electronTitle} — Local (1)`,
      `${profile.electronTitle} — Local (2)`,
    ]);
    expect(windowMenu.selected).toHaveLength(1);

    // Selecting the other entry must move focus to that window.
    const targetLabel = windowMenu.labels.find((label) => !windowMenu.selected.includes(label));
    if (!targetLabel) throw new Error("Window menu has no inactive entry to switch to");
    await app.evaluate(({ BrowserWindow, Menu }, label) => {
      const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "Window");
      const target = windowMenu?.submenu?.items.find(
        (item) => item.type === "radio" && item.label === label,
      );
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (!target?.click || !focusedWindow) {
        throw new Error("Window menu switch target is unavailable");
      }
      target.click(undefined, focusedWindow, focusedWindow.webContents);
    }, targetLabel);
    await expect.poll(async () => (await readWindowMenu()).selected).toEqual([targetLabel]);

    await secondWindow
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
              isolatedViewState?: boolean;
            };
          }
        ).orkestrator;
        return {
          isolatedViewState: api.isolatedViewState,
          greeting: await api.invoke<string>("greet", { name: "Second window" }),
        };
      })
      .then((value) => {
        expect(value.isolatedViewState).toBe(true);
        expect(value.greeting).toContain("Hello, Second window");
      });
    expect(backendChildPid(electronPid!)).toBe(backendPid);

    await window.close();
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(1);
    expect(backendChildPid(electronPid!)).toBe(backendPid);
    await secondWindow
      .evaluate(async () => {
        const api = (
          globalThis as typeof globalThis & {
            orkestrator: {
              invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
            };
          }
        ).orkestrator;
        return api.invoke<string>("greet", { name: "Remaining window" });
      })
      .then((value) => expect(value).toContain("Hello, Remaining window"));

    await app.close();
    launchedApp = null;
    await expect.poll(() => processExists(backendPid!), { timeout: 10_000 }).toBe(false);
  } finally {
    await launchedApp?.close().catch(() => undefined);
    if (vite?.pid) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {}
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
