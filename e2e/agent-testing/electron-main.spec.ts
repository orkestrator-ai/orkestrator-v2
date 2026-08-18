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

test("real Electron main process uses the profile identity and preload IPC", async () => {
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
