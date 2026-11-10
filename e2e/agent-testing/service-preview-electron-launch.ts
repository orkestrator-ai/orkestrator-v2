/**
 * Launch and quit the real Electron app for the service-preview Electron specs
 * (`service-preview-electron.spec.ts`, `service-preview-seeded-electron.spec.ts`).
 *
 * Each spec owns a disposable agent-test profile under a temporary root; this
 * module only starts Electron against it with the desktop tunnel enabled and
 * stops it again, waiting for the supervised backend to exit.
 */
import type { Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  AGENT_TEST_PREVIEW_RETENTION_ENV,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { closeElectronWithin } from "./design-electron-cleanup";
import { recordElectronDiagnostics, recordTestNote } from "./electron-diagnostics";
import { expect, test } from "./electron-fixtures";
import {
  ELECTRON_TEST_SWITCHES,
  HEADLESS_ELECTRON_SWITCHES,
  headlessElectronRequested,
  withoutDisplay,
} from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import {
  NETWORK_CHANGED,
  collectStartupConsole,
  pageStartupWindow,
  waitForRendererStart,
} from "./electron-startup-recovery";
import { electronSpecEnvironment } from "./electron-spec-environment";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const packageRoot = path.join(repositoryRoot, "apps", "desktop");
export const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

const outputTails = new WeakMap<ElectronApplication, () => string>();
const previewOutput = new WeakMap<ElectronApplication, () => string[]>();

/** A bounded tail of main-process output, for startup diagnostics only. */
export function electronOutputTail(app: ElectronApplication): string {
  return outputTails.get(app)?.() ?? "";
}

/**
 * Main's recent preview transport warnings (static text, e.g. a failed
 * release) and uncaught exceptions, which stop main before it releases
 * anything (flake 0622).
 */
export function electronPreviewOutput(app: ElectronApplication): string[] {
  return previewOutput.get(app)?.() ?? [];
}

export async function waitForUrl(url: string): Promise<void> {
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

export async function waitForApi(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window
          .evaluate(async () => {
            const api = (globalThis as any).orkestrator;
            if (!api?.invoke) return false;
            await api.invoke("greet", { name: "service-previews" });
            return true;
          })
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** Bundle the main process exactly as production and the dev launcher do. */
export function bundleElectron(): void {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
}

export async function launchElectron(current: {
  profile: RuntimeProfile;
  profilePath: string;
  rendererUrl: string;
}): Promise<{ app: ElectronApplication; window: Page; windowId: number }> {
  const headless = headlessElectronRequested();
  const app = await electron.launch({
    executablePath: electronExecutable,
    // The shared switches include turning off background throttling (flake 0620).
    args: [
      ...ELECTRON_TEST_SWITCHES,
      ...(headless ? HEADLESS_ELECTRON_SWITCHES : []),
      path.join(packageRoot, "dist", "electron", "main.js"),
    ],
    cwd: repositoryRoot,
    env: electronSpecEnvironment(headless ? withoutDisplay(process.env) : process.env, {
      ELECTRON_DEV: "1",
      VITE_DEV_SERVER_URL: current.rendererUrl,
      ORKESTRATOR_RUNTIME_PROFILE_FILE: current.profilePath,
      // Pinned so a saved setting on the profile cannot turn the tunnel off.
      ORKESTRATOR_PREVIEW_TRANSPORT: "1",
      // Never contend for the fixed control-MCP port an installed app may own.
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
      // No startup container-to-host probe: on a host whose firewall drops
      // Docker traffic its result dialog opens when the probe ends and takes
      // keyboard focus mid-test (flake 0620), and each run's probe network
      // would outlive this disposable profile.
      ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
      // Partition retention passes every 2 s instead of after a minute
      // (agent-test runtimes only), so the retention test sees one run.
      [AGENT_TEST_PREVIEW_RETENTION_ENV]: "2000",
    }),
  });
  recordElectronDiagnostics(app);
  const startupConsole = collectStartupConsole(app.context());
  dismissStartupDialogs(app);
  let tail = "";
  let previewLines: string[] = [];
  const keep = () => {
    let partial = "";
    return (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-4_000);
      const lines = (partial + text).split("\n");
      partial = lines.pop()!.slice(-1_000);
      const matched = lines.filter(
        (line) => line.includes("[preview]") || line.includes("uncaught-exception"),
      );
      if (matched.length > 0) previewLines = [...previewLines, ...matched].slice(-20);
    };
  };
  app.process().stdout?.on("data", keep());
  app.process().stderr?.on("data", keep());
  outputTails.set(app, () => tail);
  previewOutput.set(app, () => previewLines.map((line) => line.slice(0, 300)));
  const window = await app.firstWindow({ timeout: 90_000 }).catch((error: Error) => {
    startupConsole.dispose();
    throw new Error(`${error.message}\nElectron output tail:\n${tail}`);
  });
  // Reloads only after Chromium aborted the renderer's Vite modules with
  // ERR_NETWORK_CHANGED (flake 2340); any other startup failure still fails.
  try {
    const reloads = await waitForRendererStart(
      pageStartupWindow(window, startupConsole),
      current.profile.electronTitle,
      { timeoutMs: 90_000 },
    );
    if (reloads > 0) {
      const note = `renderer start reloaded ${reloads}x after ${NETWORK_CHANGED}`;
      recordTestNote(note);
      // Also in the run's results.json, so a passing run shows it recovered.
      console.log(`[startup-recovery] ${note}`);
    }
  } finally {
    startupConsole.dispose();
  }
  await waitForApi(window);
  const windowId = await (
    await app.browserWindow(window)
  ).evaluate((host) => {
    host.setSize(1440, 960);
    return host.id;
  });
  return { app, window, windowId };
}

function childPids(parent: number): number[] {
  const processes = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (processes.status !== 0) return [];
  return processes.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => ppid === parent && Number.isInteger(pid))
    .map(([pid]) => pid!);
}

/** Every descendant of `root`: the `.bin/electron` wrapper spawns the real binary. */
function descendantPids(root: number): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < 512) {
    for (const pid of childPids(queue.shift()!)) {
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Quit Electron normally and wait until its supervised children (backend) are gone. */
export async function closeElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const children = child.pid ? descendantPids(child.pid) : [];
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  await Promise.race([
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  const graceful = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!graceful) {
    test.info().annotations.push({
      type: "electron-quit",
      description:
        `app.quit() did not exit within 30s; output tail: ${electronOutputTail(app)}`.slice(
          0,
          2_000,
        ),
    });
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    for (const pid of children.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await closeElectronWithin(app, 10_000);
  await expect.poll(() => children.filter(alive).length, { timeout: 20_000 }).toBe(0);
}
