import { expect, test, type Page, type Request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * What the sidebar's animated width does to the things in the central column,
 * against the real backend: a shell with a real PTY and a Monaco editor side
 * by side. The panels animate every frame while each consumer is laid out at
 * most twice, and its left edge stays against the moving sidebar throughout.
 */

type Status = { status: string; browserUrl?: string; testProject?: string };
type Project = { id: string; localPath: string | null; name: string };
type Environment = { id: string; name: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type Motion = {
  frames: Array<{ sidebar: number; terminalGap: number; editorGap: number; files: number | null }>;
  terminalWidths: number[];
  editorWidths: number[];
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const previews = path.join(repositoryRoot, "output", "visual-previews");
/** The first layout when the pin takes effect and the last when it is released. */
const MAX_LAYOUTS_PER_CHANGE = 2;
/** The menu's non-compact view, named for whether the profile has other machines. */
const FULL_VIEW = /^(Full list|By project)$/;

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
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args } },
    );
    expect(invokeResponse.ok(), `${name}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function commandOf(request: Request): { command?: string; args?: Record<string, unknown> } {
  if (!request.url().endsWith("/__orkestrator/invoke") || request.method() !== "POST") return {};
  try {
    return request.postDataJSON() as { command?: string; args?: Record<string, unknown> };
  } catch {
    return {};
  }
}

/** Records every frame's geometry and every layout of the two consumers until stopped. */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (element) => element.getClientRects().length > 0,
      )!;
    const sidebar = document.querySelector<HTMLElement>("[data-panel]")!;
    const terminal = visible(".xterm");
    const editor = visible(".monaco-editor");
    // The panes of a split are panels too; only the shell's own are its siblings.
    const files =
      sidebar.parentElement!.querySelectorAll<HTMLElement>(":scope > [data-panel]")[2] ?? null;
    const motion: Motion = { frames: [], terminalWidths: [], editorWidths: [] };
    const observe = (element: HTMLElement, into: number[]) => {
      let first = true;
      const observer = new ResizeObserver(() => {
        if (first) first = false;
        else into.push(element.getBoundingClientRect().width);
      });
      observer.observe(element);
      return observer;
    };
    const observers = [
      observe(terminal, motion.terminalWidths),
      observe(editor, motion.editorWidths),
    ];
    let frame = requestAnimationFrame(function record() {
      const edge = sidebar.getBoundingClientRect().right;
      motion.frames.push({
        sidebar: sidebar.getBoundingClientRect().width,
        terminalGap: terminal.getBoundingClientRect().left - edge,
        editorGap: editor.getBoundingClientRect().left - edge,
        files: files?.getBoundingClientRect().width ?? null,
      });
      frame = requestAnimationFrame(record);
    });
    (window as unknown as { stopRecording: () => Motion }).stopRecording = () => {
      cancelAnimationFrame(frame);
      for (const observer of observers) observer.disconnect();
      return motion;
    };
  });
}

const settled = (page: Page) =>
  expect(page.locator("[data-sidebar-width-animating]")).toHaveCount(0);

test("the sidebar's animated width lays out a real terminal and editor at most twice", async ({
  page,
}) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await signIn(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  expect(fixture).toBeTruthy();
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `sidebar-width-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
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
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          sizes: [50, 50],
          depth: 1,
          children: [
            {
              kind: "leaf",
              id: "pane-shell",
              activeTabId: "tab-shell",
              tabs: [{ id: "tab-shell", type: "plain", displayTitle: "Shell" }],
            },
            {
              kind: "leaf",
              id: "pane-editor",
              activeTabId: "tab-editor",
              tabs: [{ id: "tab-editor", type: "file", fileData: { filePath: "server.ts" } }],
            },
          ],
        },
      },
    });

    const resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
    page.on("request", (request) => {
      const { command, args } = commandOf(request);
      if (command === "local_terminal_resize") {
        resizes.push({
          sessionId: String(args?.sessionId),
          cols: Number(args?.cols),
          rows: Number(args?.rows),
        });
      }
    });
    await page.route("**/__orkestrator/invoke", async (route) =>
      // The credential-free fixture exercises terminals, not login.
      commandOf(route.request()).command === "check_claude_cli"
        ? route.fulfill({ json: { result: false } })
        : route.fallback(),
    );

    // None of the optional-tool notices matter to a local fixture, and each blocks the sidebar.
    for (const name of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      await page.addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
        button.click(),
      );
    }
    await loadAppWithDevRetry(page, test.info(), () => page.goto(status.browserUrl!));
    const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
    const entry = page.getByText(environment.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await entry.click();

    const terminal = page.locator(".xterm:visible");
    await expect(terminal).toHaveCount(1, { timeout: 60_000 });
    const editor = page.locator(".monaco-editor:visible").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await terminal.click();

    // A terminal's first fit after loading measures with stale cell metrics and
    // corrects itself on the next, whatever resized it. Keep that out of the count.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);

    const sidebar = page.locator("[data-panel]").first();
    const sidebarWidth = async () => Math.round((await sidebar.boundingBox())!.width);
    const fullWidth = await sidebarWidth();
    expect(fullWidth).toBeGreaterThanOrEqual(280);

    /** One change of width: the recording around it, and the PTY resizes it caused. */
    const measure = async (change: () => Promise<void>, expectedWidth: number) => {
      // A fit from before this change may still be on its way to the backend.
      await expect(async () => {
        const seen = resizes.length;
        await page.waitForTimeout(500);
        expect(resizes.length).toBe(seen);
      }).toPass({ timeout: 15_000 });
      const before = resizes.length;
      await startRecording(page);
      await change();
      await expect.poll(sidebarWidth).toBe(expectedWidth);
      await settled(page);
      await page.waitForTimeout(300);
      const motion = await page.evaluate(() =>
        (window as unknown as { stopRecording: () => Motion }).stopRecording(),
      );
      return { motion, ptyResizes: resizes.slice(before) };
    };
    const assertCheap = ({ motion, ptyResizes }: Awaited<ReturnType<typeof measure>>) => {
      const steps = new Set(motion.frames.map((frame) => Math.round(frame.sidebar)));
      // The panel really moved through intermediate widths.
      expect(steps.size).toBeGreaterThan(3);
      expect(motion.terminalWidths.length).toBeLessThanOrEqual(MAX_LAYOUTS_PER_CHANGE);
      expect(motion.editorWidths.length).toBeLessThanOrEqual(MAX_LAYOUTS_PER_CHANGE);
      expect(ptyResizes.length).toBeLessThanOrEqual(MAX_LAYOUTS_PER_CHANGE);
      // No layout jump: the first pane stays against the moving edge, and the
      // second moves relative to it only when the column is laid out.
      const terminalGaps = motion.frames.map((frame) => frame.terminalGap);
      expect(Math.max(...terminalGaps) - Math.min(...terminalGaps)).toBeLessThanOrEqual(2);
      const editorGaps = new Set(motion.frames.map((frame) => Math.round(frame.editorGap)));
      expect(editorGaps.size).toBeLessThanOrEqual(MAX_LAYOUTS_PER_CHANGE + 1);
      // The files panel beside the central column keeps its width.
      const files = motion.frames.flatMap((frame) => (frame.files === null ? [] : [frame.files]));
      if (files.length > 0) expect(Math.max(...files) - Math.min(...files)).toBeLessThan(2);
      // A motion in one direction, not a detour through another width.
      const widths = motion.frames.map((frame) => frame.sidebar);
      const rising = widths[widths.length - 1]! > widths[0]!;
      for (let index = 1; index < widths.length; index += 1) {
        const step = widths[index]! - widths[index - 1]!;
        expect(rising ? step : -step).toBeGreaterThanOrEqual(-1);
      }
    };
    const chooseView = async (view: string | RegExp) => {
      await page
        .getByRole("button", { name: /^(Sort environments|Sidebar view):/ })
        .first()
        .click();
      await page.getByRole("menuitemradio", { name: view }).first().click();
    };
    const screenshot = (name: string) =>
      page.screenshot({ path: path.join(previews, `sidebar-consumers-${name}.png`) });

    await screenshot("full");
    const toCompact = await measure(() => chooseView("Compact"), 56);
    assertCheap(toCompact);
    await screenshot("compact");
    // Leaving compact returns the width and the terminal fills the rest.
    const toFull = await measure(() => chooseView(FULL_VIEW), fullWidth);
    assertCheap(toFull);

    // The left-panel toggle runs through the same motion.
    const hide = await measure(
      () => page.getByRole("button", { name: "Hide left panel" }).click(),
      0,
    );
    assertCheap(hide);
    const show = await measure(
      () => page.getByRole("button", { name: "Show left panel" }).click(),
      fullWidth,
    );
    assertCheap(show);

    // With the files panel open, the width comes out of the central column only.
    await page.getByRole("button", { name: "Show file panel" }).click();
    await expect(page.getByRole("button", { name: "Hide file panel" })).toBeVisible();
    await page.waitForTimeout(500);
    // A new panel lays the group out afresh from its default sizes.
    const widthBesideFiles = await sidebarWidth();
    const beside = await measure(() => chooseView("Compact"), 56);
    assertCheap(beside);
    const panels = sidebar.locator("xpath=../*[@data-panel]");
    await expect(panels).toHaveCount(3);
    const filesAfter = (await panels.nth(2).boundingBox())!.width;
    await screenshot("compact-files-panel");
    const back = await measure(() => chooseView(FULL_VIEW), widthBesideFiles);
    assertCheap(back);
    expect(Math.abs((await panels.nth(2).boundingBox())!.width - filesAfter)).toBeLessThan(2);
    await page.getByRole("button", { name: "Hide file panel" }).click();

    // The PTY ended at the size the terminal shows.
    await page.waitForTimeout(500);
    const finalSize = await page.evaluate(() => {
      const element = Array.from(document.querySelectorAll<HTMLElement>(".xterm-rows")).find(
        (rows) => rows.getClientRects().length > 0,
      )!;
      return { rows: element.children.length };
    });
    expect(resizes.at(-1)?.rows).toBe(finalSize.rows);

    test.info().annotations.push({
      type: "measurements",
      description: JSON.stringify(
        Object.fromEntries(
          Object.entries({ toCompact, toFull, hide, show, beside, back }).map(([name, result]) => [
            name,
            {
              frames: result.motion.frames.length,
              widths: new Set(result.motion.frames.map((frame) => Math.round(frame.sidebar))).size,
              terminal: result.motion.terminalWidths,
              editor: result.motion.editorWidths,
              pty: result.ptyResizes,
            },
          ]),
        ),
      ),
    });
  } finally {
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});
