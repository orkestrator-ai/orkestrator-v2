import type { Page } from "@playwright/test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

/**
 * The desktop half of terminal input recovery
 * (docs/architecture/event-snapshot-recovery.md): the
 * same recovery flow as terminal-input-resume.spec.ts, through the real
 * Electron main process, IPC and BackendHttpClient. A wrapper around the main
 * process's fetch loses one write's response after the backend applied it.
 */

type Project = { id: string; name: string };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Fault = "none" | "lose" | "down";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const TERMINAL_WRITE = "local_terminal_write";

const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

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

/** Records every backend command the main process sends and injects faults. */
async function installFetchFault(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, terminalWrite) => {
    const state = globalThis as typeof globalThis & {
      __resumeFault?: string;
      __resumeSent?: Array<{ command: string; args: Record<string, unknown> }>;
      __resumeLost?: number;
    };
    if (state.__resumeSent) return;
    state.__resumeFault = "none";
    state.__resumeSent = [];
    state.__resumeLost = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      let body: { command?: string; args?: Record<string, unknown> } = {};
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      } catch {}
      if (!body.command) return original(input, init);
      state.__resumeSent!.push({ command: body.command, args: body.args ?? {} });
      // The isolated profile exercises terminals, not login.
      if (body.command === "check_claude_cli") return Response.json({ result: false });
      if (body.command !== terminalWrite || state.__resumeFault === "none") {
        return original(input, init);
      }
      if (state.__resumeFault === "lose") {
        state.__resumeLost! += 1;
        await original(input, init);
        state.__resumeFault = "down";
      }
      throw new TypeError("fetch failed");
    }) as typeof fetch;
  }, TERMINAL_WRITE);
}

test.beforeAll(() => {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("Electron keeps a lost terminal write fenced until Resume, without restarting the PTY", async () => {
  test.setTimeout(300_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-electron-resume-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "electron-resume",
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
    await installFetchFault(electronApp);
    const window = await electronApp.firstWindow();
    window.setDefaultTimeout(20_000);
    // index.html's title stays until Vite serves and runs renderer-entry; under
    // host load that startup takes longer than expect's 5 s default.
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
    const setFault = (fault: Fault) =>
      electronApp.evaluate((_electron, value) => {
        (globalThis as typeof globalThis & { __resumeFault?: string }).__resumeFault = value;
      }, fault);
    const mainProcessState = () =>
      electronApp.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __resumeSent?: Array<{ command: string; args: Record<string, unknown> }>;
          __resumeLost?: number;
        };
        return { sent: state.__resumeSent ?? [], lost: state.__resumeLost ?? 0 };
      });
    const writes = async () =>
      (await mainProcessState()).sent.filter((entry) => entry.command === TERMINAL_WRITE);

    const project = await invoke<Project>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const created: Environment[] = [];
    for (const name of ["resume", "resume-other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: project.id,
        name: `${name}-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      created.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-shell",
          root: {
            kind: "leaf",
            id: "pane-shell",
            activeTabId: "tab-shell",
            tabs: [{ id: "tab-shell", type: "plain" }],
          },
        },
      });
    }
    const [target, other] = created as [Environment, Environment];
    const worktree = (await invoke<Environment>("get_environment", { environmentId: target.id }))
      .worktreePath!;
    expect(worktree).toBeTruthy();

    await window.reload();
    const openEnvironment = async (page: Page, name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${project.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Escape");
      await entry.click();
    };
    const focusTerminal = async () => {
      const terminal = window.locator(".xterm:visible").first();
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
    };
    await openEnvironment(window, target.name);
    await focusTerminal();

    await window.keyboard.type("echo PID=$$");
    await window.keyboard.press("Enter");
    await expect.poll(async () => (await writes()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const sessionId = String((await writes())[0]!.args.sessionId);
    const output = async () =>
      visibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    const shellPid = async (count: number) => {
      await expect.poll(async () => (await output()).match(/PID=\d+/g)?.length ?? 0).toBe(count);
      return [...(await output()).matchAll(/PID=(\d+)/g)].at(-1)![1]!;
    };
    const pidBefore = await shellPid(1);

    await window.keyboard.type("vim -u NONE -N -n resume.txt");
    await window.keyboard.press("Enter");
    await expect.poll(output).toContain("resume.txt");
    await window.keyboard.type("ibefore-");
    await expect.poll(output).toContain("before-");

    await setFault("lose");
    await window.keyboard.type("X");
    const toast = window
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Terminal input failed" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(
      "Check the terminal before resuming: part of your last input may have reached the shell.",
    );
    await expect(toast.getByRole("button", { name: "Resume input" })).toBeVisible();
    await expect(toast.getByRole("button", { name: "Reconnect" })).toBeVisible();
    await expect.poll(output).toContain("before-X");

    // Restore the backend, then resize the native window.
    await setFault("none");
    expect((await mainProcessState()).lost).toBe(1);
    const resizes = async () =>
      (await mainProcessState()).sent.filter((entry) => entry.command === "local_terminal_resize")
        .length;
    const resizesBefore = await resizes();
    await electronApp.evaluate(({ BrowserWindow }) => {
      const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
      const [width, height] = focused.getSize();
      focused.setSize(width! - 240, height! - 80);
    });
    await expect.poll(resizes).toBeGreaterThan(resizesBefore);
    const writesWhileFenced = (await writes()).length;
    await focusTerminal();
    await window.keyboard.type("Y");
    await expect(toast).toBeVisible();
    await window.waitForTimeout(1_000);
    expect((await writes()).length).toBe(writesWhileFenced);

    const sentBeforeResume = (await mainProcessState()).sent.length;
    await toast.getByRole("button", { name: "Resume input" }).click();
    await expect(toast).toBeHidden();
    // Answered in the main process by the sequencer; no HTTP request.
    expect(
      (await mainProcessState()).sent.slice(sentBeforeResume).map((entry) => entry.command),
    ).not.toContain("local_terminal_input_resume");
    await focusTerminal();
    await window.keyboard.type("Z");
    await expect
      .poll(async () => (await writes()).some((entry) => entry.args.data === "Z"))
      .toBe(true);
    await window.keyboard.press("Escape");
    await window.keyboard.type(":wq");
    await window.keyboard.press("Enter");
    await expect
      .poll(() => readFile(path.join(worktree, "resume.txt"), "utf8").catch(() => null))
      .toBe("before-XZ\n");
    // vim reads ahead, so input typed before it exits would be swallowed.
    await expect.poll(async () => /[%$#]\s*$/.test(await output())).toBe(true);
    // Resume kept the PTY: the same shell process answers.
    await window.keyboard.type("echo PID=$$");
    await window.keyboard.press("Enter");
    expect(await shellPid(2)).toBe(pidBefore);

    // Switching environments does not re-arm a fenced terminal either.
    await setFault("lose");
    await window.keyboard.insertText("echo lost");
    await expect(toast).toBeVisible();
    await setFault("none");
    expect((await mainProcessState()).lost).toBe(2);
    await openEnvironment(window, other.name);
    await expect(window.locator(".xterm:visible").first()).toBeVisible({ timeout: 60_000 });
    await openEnvironment(window, target.name);
    await focusTerminal();
    const writesAfterSwitch = (await writes()).length;
    await window.keyboard.type("-fenced");
    await expect(toast).toBeVisible();
    await window.waitForTimeout(1_000);
    expect((await writes()).length).toBe(writesAfterSwitch);
    await toast.getByRole("button", { name: "Resume input" }).click();
    await expect(toast).toBeHidden();
    await focusTerminal();
    await window.keyboard.type("-resumed");
    await window.keyboard.press("Enter");
    await expect.poll(output).toMatch(/lost-resumed\r?\n/);
    expect(await output()).not.toContain("-fenced");
    await window.keyboard.type("echo PID=$$");
    await window.keyboard.press("Enter");
    expect(await shellPid(3)).toBe(pidBefore);

    for (const environment of created) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  } finally {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
