import { expect, test, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

/**
 * A shell in a split environment on a phone, against the real backend. The
 * mobile pane switcher shows one pane at a time and keeps the others laid out
 * underneath, and an inactive environment is not on screen at all. Work in the
 * shell keeps running through both, its PTY keeps the size of the pane, and on
 * return the terminal shows what happened from the backend's snapshot.
 */

type Status = { status: string; browserUrl?: string; testProject?: string };
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; status?: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const PHONE = { width: 390, height: 844 };
const LOOP_SECONDS = 20;
/** What the loop prints when it finishes; its command line spells it differently. */
const LOOP_DONE = "LOOP-DONE-42";

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

/** Terminal output as text, without the escape sequences a shell interleaves. */
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

test("a shell in a hidden phone pane keeps working and its size while away, and shows the result on return", async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  await page.setViewportSize(PHONE);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();

  const created: Environment[] = [];
  for (const name of ["panes", "panes-other"]) {
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
    }
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: target.id,
    });
    await invoke("save_pane_layout", {
      environmentId: target.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane-work",
        root: {
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          sizes: [50, 50],
          depth: 1,
          children: [
            {
              kind: "leaf",
              id: "pane-work",
              activeTabId: "tab-work",
              tabs: [{ id: "tab-work", type: "plain", displayTitle: "Work shell" }],
            },
            {
              kind: "leaf",
              id: "pane-side",
              activeTabId: "tab-side",
              tabs: [{ id: "tab-side", type: "plain", displayTitle: "Side shell" }],
            },
          ],
        },
      },
    });

    // Every terminal command the page sends, so the work shell's session and
    // every size the page gave its PTY are known.
    const sent: Array<{ command: string; args: Record<string, unknown> }> = [];
    page.on("request", (request) => {
      const { command, args } = commandOf(request);
      if (command) sent.push({ command, args: args ?? {} });
    });
    await page.route("**/__orkestrator/invoke", async (route) => {
      // The credential-free fixture exercises terminals, not login.
      if (commandOf(route.request()).command === "check_claude_cli") {
        return route.fulfill({ json: { result: false } });
      }
      return route.fallback();
    });

    await page.goto(status.browserUrl!);
    const drawer = page.getByRole("dialog", { name: "Projects and environments" });
    const openEnvironment = async (name: string) => {
      // A phone-sized load opens the drawer by itself.
      const drawerTrigger = page.getByRole("button", { name: "Open projects and environments" });
      await expect(drawer.or(drawerTrigger)).toBeVisible({ timeout: 30_000 });
      if (!(await drawer.isVisible())) await drawerTrigger.click();
      await expect(drawer).toBeVisible();
      const expand = drawer.getByRole("button", { name: `Expand project ${fixture.name}` });
      const entry = drawer.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
      if (await expand.isVisible()) await expand.click();
      await entry.click();
      // Selecting another environment closes the drawer; the current one does not.
      await expect(async () => {
        if (await drawer.isVisible()) await page.keyboard.press("Escape");
        await expect(drawer).toHaveCount(0, { timeout: 1_000 });
      }).toPass();
    };
    const switcherTabs = page.getByRole("tablist", { name: "Split panes" }).getByRole("tab");
    const showPane = async (index: number) => {
      await switcherTabs.nth(index).click();
      await expect(switcherTabs.nth(index)).toHaveAttribute("aria-selected", "true");
    };
    const visibleTerminal = page.locator(".xterm:visible");
    const focusTerminal = async () => {
      await expect(visibleTerminal).toHaveCount(1, { timeout: 60_000 });
      await visibleTerminal.click();
    };

    // The phone shows the work pane, its neighbour stacked underneath.
    await openEnvironment(target.name);
    await expect(switcherTabs).toHaveCount(2, { timeout: 60_000 });
    await showPane(0);
    await focusTerminal();
    await page.keyboard.type("echo PID=$$; stty size");
    await page.keyboard.press("Enter");
    const writes = () => sent.filter((entry) => entry.command === "local_terminal_write");
    await expect.poll(() => writes().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const sessionId = String(writes()[0]!.args.sessionId);
    const output = async () =>
      visibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    const sizes = async () =>
      [...(await output()).matchAll(/^(\d+) (\d+)\s*$/gm)].map(([, rows, cols]) => ({
        rows: Number(rows),
        cols: Number(cols),
      }));
    const workResizes = () =>
      sent
        .filter(
          (entry) =>
            entry.command === "local_terminal_resize" && entry.args.sessionId === sessionId,
        )
        .map(({ args }) => ({ rows: Number(args.rows), cols: Number(args.cols) }));
    await expect.poll(async () => (await sizes()).length).toBe(1);
    const [onScreen] = await sizes();

    // Fitted to the phone-width pane, not to a pane without a layout box.
    expect(onScreen!.cols).toBeGreaterThan(30);
    expect(onScreen!.rows).toBeGreaterThan(10);
    const pid = (await output()).match(/PID=(\d+)/)?.[1];
    expect(pid).toBeTruthy();

    // Work that outlasts the pane and the environment being on screen. Its
    // last step reports the PTY's size from while it was away.
    await page.keyboard.type(
      `for i in $(seq 1 ${LOOP_SECONDS}); do echo TICK=$i; sleep 1; done; stty size; echo LOOP-DONE-$((6*7))`,
    );
    await page.keyboard.press("Enter");
    await expect.poll(output).toContain("TICK=1");

    // Hidden behind the other pane, the shell keeps running.
    const resizesBeforeHiding = workResizes().length;
    await showPane(1);
    await expect(visibleTerminal).toHaveCount(1, { timeout: 60_000 });
    const ticksWhenHidden = Number([...(await output()).matchAll(/TICK=(\d+)/g)].at(-1)![1]);
    await expect
      .poll(async () => Number([...(await output()).matchAll(/TICK=(\d+)/g)].at(-1)?.[1] ?? 0), {
        timeout: 30_000,
      })
      .toBeGreaterThan(ticksWhenHidden);

    // And with its environment inactive it runs to the end.
    await openEnvironment(other.name);
    await expect(visibleTerminal).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(output, { timeout: (LOOP_SECONDS + 30) * 1_000 }).toContain(LOOP_DONE);

    // Neither the hidden pane nor the inactive environment resized the PTY:
    // without a layout box a fit would have shrunk it to a few columns.
    expect(workResizes().slice(resizesBeforeHiding)).toEqual([]);
    const [, whileAway] = await sizes();
    expect(whileAway).toEqual(onScreen);

    // Back: the status, the finished output and a working prompt.
    const expectReturned = async () => {
      await expect(switcherTabs).toHaveCount(2, { timeout: 60_000 });
      await showPane(0);
      await expect(visibleTerminal).toHaveCount(1, { timeout: 60_000 });
      await expect(visibleTerminal.locator(".xterm-rows")).toContainText(LOOP_DONE, {
        timeout: 30_000,
      });
      expect(
        (await invoke<Environment>("get_environment", { environmentId: target.id })).status,
      ).toBe("running");
    };
    await openEnvironment(target.name);
    await expectReturned();
    await focusTerminal();
    await page.keyboard.type("echo BACK=$$; stty size");
    await page.keyboard.press("Enter");
    await expect.poll(output).toContain(`BACK=${pid}`);
    await expect.poll(async () => (await sizes()).length).toBe(3);
    // Shown again, the PTY has the size of the terminal on screen. Fitting may
    // settle a cell smaller than at first, once scrollback adds a scrollbar.
    const returned = (await sizes())[2]!;
    expect(returned).toEqual(workResizes().at(-1));
    expect(returned.cols).toBeGreaterThan(30);
    expect(
      await visibleTerminal.evaluate(
        (terminal) => terminal.querySelectorAll(".xterm-rows > div").length,
      ),
    ).toBe(returned.rows);

    // A reload rehydrates the same result from the backend's snapshot.
    await page.reload();
    await openEnvironment(target.name);
    await expectReturned();
    await expect(visibleTerminal.locator(".xterm-rows")).toContainText(`BACK=${pid}`);
  } finally {
    for (const environment of created) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});
