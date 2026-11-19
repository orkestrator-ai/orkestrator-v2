import { acknowledgeDockerReachabilityWarning } from "../docker-reachability-warning";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { terminalVisibleText } from "./terminal-visible-text";

/**
 * One shell shown on a wide desktop and a narrow phone at once, against the
 * real backend (terminal size ownership, `terminal-size-ownership.ts`). Both
 * keep receiving its output, and the PTY has the size of whichever client the
 * user last interacted with: opening the phone view does not shrink the
 * desktop's terminal, tapping and typing on the phone does, and typing on the
 * desktop takes it back.
 */

type Status = { status: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

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
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

/**
 * Opens an environment from the sidebar, or from the phone's drawer. Host
 * notices over it are cleared by `continuePastHostNotices`.
 */
async function openEnvironment(page: Page, projectName: string, name: string) {
  const drawerTrigger = page.getByRole("button", { name: "Open projects and environments" });
  const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
  const entry = page.getByText(name, { exact: true }).first();
  await expect(expand.or(entry).or(drawerTrigger).first()).toBeVisible({ timeout: 30_000 });
  const drawer = page.getByRole("dialog", { name: "Projects and environments" });
  if ((await drawerTrigger.isVisible()) && !(await drawer.isVisible())) await drawerTrigger.click();
  await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(0, 0);
  await entry.click();
  const closeDrawer = page.getByRole("button", { name: "Close projects and environments" });
  if (await closeDrawer.first().isVisible()) await closeDrawer.first().click();
}

/**
 * Host notices that do not concern a local shell: a host whose user cannot
 * reach Docker, and a credential-free profile's Claude sign-in. Either would
 * sit over the sidebar on whichever client loaded first.
 */
async function continuePastHostNotices(page: Page) {
  await acknowledgeDockerReachabilityWarning(page);
  for (const label of [
    "Continue without Docker",
    "Continue without Claude",
    "Continue without GitHub CLI",
  ]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await page.addLocatorHandler(button, async () => button.click());
  }
}

test.beforeEach(async ({ page }) => continuePastHostNotices(page));

test("the client the user last interacted with sets a shared terminal's size, and both see its output", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  await page.setViewportSize(DESKTOP);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();

  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `size-owner-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const phoneContext = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
  });
  try {
    await fetchModulesOutsideChromium(phoneContext);
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
          tabs: [{ id: "tab-shell", type: "plain", displayTitle: "Shared shell" }],
        },
      },
    });

    const phone = await phoneContext.newPage();
    phone.setDefaultTimeout(20_000);
    await phone.goto(status.browserUrl!);
    await continuePastHostNotices(phone);
    await page.goto(status.browserUrl!);

    // Every size-setting command either page sends, by sender.
    const sent: Array<{ who: string; command: string; args: Record<string, unknown> }> = [];
    for (const [who, client] of [
      ["desktop", page],
      ["phone", phone],
    ] as const) {
      client.on("request", (request) => {
        if (!request.url().endsWith("/__orkestrator/invoke") || request.method() !== "POST") {
          return;
        }
        try {
          const { command, args } = request.postDataJSON() as {
            command?: string;
            args?: Record<string, unknown>;
          };
          if (command) sent.push({ who, command, args: args ?? {} });
        } catch {
          // Not a JSON command.
        }
      });
    }

    const desktopTerminal = page.locator(".xterm:visible");
    const phoneTerminal = phone.locator(".xterm:visible");
    await openEnvironment(page, fixture.name, environment.name);
    await expect(desktopTerminal).toHaveCount(1, { timeout: 60_000 });
    await desktopTerminal.click();
    await page.keyboard.type("echo DESKTOP-1; stty size");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => sent.find((entry) => entry.command === "local_terminal_write"), {
        timeout: 30_000,
      })
      .toBeTruthy();
    const sessionId = String(
      sent.find((entry) => entry.command === "local_terminal_write")!.args.sessionId,
    );
    const output = async () =>
      terminalVisibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    const sizes = async () =>
      [...(await output()).matchAll(/^(\d+) (\d+)\s*$/gm)].map(([, rows, cols]) => ({
        rows: Number(rows),
        cols: Number(cols),
      }));
    await expect.poll(async () => (await sizes()).length).toBe(1);
    const [desktopSize] = await sizes();
    expect(desktopSize!.cols).toBeGreaterThan(100);

    // The phone opens the same terminal. Fitting it to the narrow screen is
    // layout, so the desktop keeps its size.
    await openEnvironment(phone, fixture.name, environment.name);
    await expect(phoneTerminal).toHaveCount(1, { timeout: 60_000 });
    await expect(phoneTerminal.locator(".xterm-rows")).toContainText("DESKTOP-1", {
      timeout: 30_000,
    });
    await expect
      .poll(() => sent.some((entry) => entry.who === "phone" && /resize/.test(entry.command)), {
        timeout: 30_000,
      })
      .toBe(true);
    await page.keyboard.type("echo DESKTOP-2; stty size");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sizes()).length).toBe(2);
    expect((await sizes())[1]).toEqual(desktopSize);
    await expect(phoneTerminal.locator(".xterm-rows")).toContainText("DESKTOP-2");

    // Tapping and typing on the phone takes the size over.
    await phoneTerminal.click();
    await expect
      .poll(() =>
        sent.some((entry) => entry.who === "phone" && entry.command === "claim_terminal_size"),
      )
      .toBe(true);
    await phone.keyboard.type("echo PHONE-1; stty size");
    await phone.keyboard.press("Enter");
    await expect.poll(async () => (await sizes()).length).toBe(3);
    const phoneSize = (await sizes())[2]!;
    expect(phoneSize.cols).toBeLessThan(60);
    // The desktop still receives the shell's output.
    await expect(desktopTerminal.locator(".xterm-rows")).toContainText("PHONE-1");

    // Typing on the desktop takes it back.
    await desktopTerminal.click();
    await page.keyboard.type("echo DESKTOP-3; stty size");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await sizes()).length).toBe(4);
    expect((await sizes())[3]).toEqual(desktopSize);
    await expect(phoneTerminal.locator(".xterm-rows")).toContainText("DESKTOP-3");
  } finally {
    await phoneContext.close().catch(() => undefined);
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});
