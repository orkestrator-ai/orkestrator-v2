import { expect, test, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

/**
 * Terminal input recovery in a real browser against the real backend: a write
 * whose response is lost fences the terminal, nothing incidental (a resize, an
 * environment switch) re-arms it, and "Resume input" does so without restarting
 * the shell. See docs/2026-10-14/terminal-input-recovery-plan.md.
 */

type Status = { status: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const TERMINAL_WRITE = "local_terminal_write";

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function signIn(page: Page, status: Status): Promise<Invoke> {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  // Test setup goes through the request context, which page routes never see.
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

/** Terminal output as text: vim interleaves cursor and mode sequences with what it echoes. */
const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** The page's own backend commands, as sent over the network. */
function commandOf(request: Request): { command?: string; args?: Record<string, unknown> } {
  if (!request.url().endsWith("/__orkestrator/invoke") || request.method() !== "POST") return {};
  try {
    return request.postDataJSON() as { command?: string; args?: Record<string, unknown> };
  } catch {
    return {};
  }
}

test("a lost terminal write stays fenced until the user resumes, and the shell survives", async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();

  const created: Environment[] = [];
  for (const name of ["resume", "resume-other"]) {
    created.push(
      await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${name}-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      }),
    );
  }
  const [target, other] = created as [Environment, Environment];
  try {
    for (const environment of created) {
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
    const worktree = (await invoke<Environment>("get_environment", { environmentId: target.id }))
      .worktreePath!;
    expect(worktree).toBeTruthy();

    // Every terminal command the page actually sends.
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    page.on("request", (request) => {
      const { command, args } = commandOf(request);
      if (command) sent.push({ command, args: args ?? {} });
    });
    const writes = () => sent.filter((entry) => entry.command === TERMINAL_WRITE);

    // "lose": a write reaches the backend and then its response is lost, as if
    // the connection dropped. "down": writes never arrive at all.
    let fault: "none" | "lose" | "down" = "none";
    let lost = 0;
    await page.route("**/__orkestrator/invoke", async (route) => {
      const { command } = commandOf(route.request());
      // The credential-free fixture exercises terminals, not login.
      if (command === "check_claude_cli") return route.fulfill({ json: { result: false } });
      if (command !== TERMINAL_WRITE || fault === "none") return route.fallback();
      if (fault === "lose") {
        lost += 1;
        await route.fetch();
        fault = "down";
      }
      await route.abort("connectionreset");
    });

    await page.goto(status.browserUrl!);
    const openEnvironment = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Escape");
      await entry.click();
    };
    const focusTerminal = async () => {
      const terminal = page.locator(".xterm:visible").first();
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
    };
    await openEnvironment(target.name);
    await focusTerminal();

    await page.keyboard.type("echo PID=$$");
    await page.keyboard.press("Enter");
    await expect.poll(() => writes().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const sessionId = String(writes()[0]!.args.sessionId);
    const output = async () =>
      visibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    const shellPid = async () => {
      let pid: string | undefined;
      await expect
        .poll(async () => {
          pid = [...(await output()).matchAll(/PID=(\d+)/g)].at(-1)?.[1];
          return pid;
        })
        .toBeTruthy();
      return pid!;
    };
    const pidBefore = await shellPid();

    // vim is the case the fence exists for: what reached the shell is not
    // simply what the prompt would echo.
    await page.keyboard.type("vim -u NONE -N -n resume.txt");
    await page.keyboard.press("Enter");
    await expect.poll(output).toContain("resume.txt");
    await page.keyboard.type("ibefore-");
    await expect.poll(output).toContain("before-");

    // The next write reaches the backend, and then its response is lost.
    fault = "lose";
    await page.keyboard.type("X");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Terminal input failed" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(
      "Check the terminal before resuming: part of your last input may have reached the shell.",
    );
    await expect(toast.getByRole("button", { name: "Resume input" })).toBeVisible();
    await expect(toast.getByRole("button", { name: "Reconnect" })).toBeVisible();
    // The keystroke did land, which is exactly why the client may not guess.
    await expect.poll(output).toContain("before-X");

    // Restore the backend, then change the layout: the resize goes through but
    // does not re-arm input.
    fault = "none";
    expect(lost).toBe(1);
    const resizesBefore = sent.filter((entry) => entry.command === "local_terminal_resize").length;
    await page.setViewportSize({ width: 960, height: 640 });
    await expect
      .poll(() => sent.filter((entry) => entry.command === "local_terminal_resize").length)
      .toBeGreaterThan(resizesBefore);
    const writesWhileFenced = writes().length;
    await focusTerminal();
    await page.keyboard.type("Y");
    await expect(toast).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(writes().length).toBe(writesWhileFenced);
    expect(await output()).not.toContain("before-XY");

    // Resume is answered by the client: nothing new reaches the backend.
    const sentBeforeResume = sent.length;
    await toast.getByRole("button", { name: "Resume input" }).click();
    await expect(toast).toBeHidden();
    expect(sent.slice(sentBeforeResume).map((entry) => entry.command)).not.toContain(
      "local_terminal_input_resume",
    );
    await focusTerminal();
    await page.keyboard.type("Z");
    // The resize made vim redraw, so the echo is no longer one run of text;
    // the saved buffer below is the precise check.
    await expect.poll(() => writes().some((entry) => entry.args.data === "Z")).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.type(":wq");
    await page.keyboard.press("Enter");
    // vim's buffer is what the terminal echoed: the lost write, then the input
    // typed after resuming, and nothing that was fenced.
    await expect
      .poll(() => fs.readFile(path.join(worktree, "resume.txt"), "utf8").catch(() => null))
      .toBe("before-XZ\n");
    // vim reads ahead, so input typed before it exits would be swallowed.
    await expect.poll(async () => /[%$#]\s*$/.test(await output())).toBe(true);
    await page.keyboard.type("echo PID=$$");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await output()).match(/PID=\d+/g)?.length ?? 0).toBe(2);
    expect(await shellPid()).toBe(pidBefore);

    // An environment switch does not re-arm a fenced terminal either.
    fault = "lose";
    // One input event, so the lost write carries the whole command.
    await page.keyboard.insertText("echo lost");
    await expect(toast).toBeVisible();
    fault = "none";
    expect(lost).toBe(2);
    await openEnvironment(other.name);
    await expect(page.locator(".xterm:visible").first()).toBeVisible({ timeout: 60_000 });
    await openEnvironment(target.name);
    await focusTerminal();
    const writesAfterSwitch = writes().length;
    await page.keyboard.type("-fenced");
    await expect(toast).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(writes().length).toBe(writesAfterSwitch);
    await toast.getByRole("button", { name: "Resume input" }).click();
    await expect(toast).toBeHidden();
    await focusTerminal();
    await page.keyboard.type("-resumed");
    await page.keyboard.press("Enter");
    await expect.poll(output).toMatch(/lost-resumed\r?\n/);
    expect(await output()).not.toContain("-fenced");
    await page.keyboard.type("echo PID=$$");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await output()).match(/PID=\d+/g)?.length ?? 0).toBe(3);
    expect(await shellPid()).toBe(pidBefore);
  } finally {
    for (const environment of created) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});
