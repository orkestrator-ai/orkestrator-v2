/**
 * Native key presses of the app-level shortcuts on the packaged Linux app
 * under X11, on the surfaces the 2026-10-31 packaged run could not set up:
 * the composer, a browser preview, an interactive artifact view and a design
 * frame. The sidebar, terminal, Monaco and menu-bar rows were recorded then
 * and are not repeated. Results and how to run it:
 * docs/architecture/keyboard-shortcuts.md, "Packaged native qualification".
 *
 * Every key below is an XTEST event from `xdotool`, so it goes through X11,
 * Chromium's native input and main's `before-input-event` exactly as a user's
 * press does. Playwright only sets the stage (focus, layout) and reads the
 * result. Opt-in: set `ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1` on a disposable X
 * display (Xvfb) with `xdotool`, never the signed-in desktop, because the
 * keys go to whichever window has X focus. Without it the test skips.
 *
 * Build first with `mise run package:linux:unpacked:test`. The app runs on a
 * disposable agent-test profile under a temporary root, with `HOME` and the
 * XDG directories there and only allowlisted host variables
 * (packaged-electron-app.ts), so nothing reads or writes the user's data
 * directory, logins or keyring. No agent platform is enabled and no provider
 * starts: the composer is an unassigned agent tab's, which needs no session.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ArtifactHostApi, ArtifactHostEvent } from "@orkestrator/protocol/artifact-host-ipc";
import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import { LoopbackArtifactContentServer } from "../../apps/backend/src/core/transcript-artifacts/content-server";
import { sha256Hex } from "../../apps/backend/src/core/transcript-artifacts/dependency-manifest";
import {
  buildInteractiveCsp,
  DESKTOP_ARTIFACT_SHELL_ORIGIN,
  inlineScriptHash,
} from "../../apps/backend/src/core/transcript-artifacts/interactive-csp";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile } from "../../apps/desktop/scripts/dev/profile-io";
import { waitForStopped, withCleanup } from "../process-cleanup";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { openDesignWindow } from "./design-canvas-electron-journey";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { nativeMenuAlt, nativeMenuFocus, nativeMenuWindows } from "./native-menu-input";
import { packagedAppExecutable, packagedLaunchEnvironment } from "./packaged-electron-app";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");

const PREVIEW_PATH = "/native-shortcut-preview";
const PREVIEW_TITLE = "Native shortcut preview";
const SHELL_PREFIX = `${DESKTOP_ARTIFACT_SHELL_ORIGIN}/`;
const ARTIFACT = { artifactId: "art_native_shortcuts", revision: 1 };
const ARTIFACT_NONCE = "nonce_native_shortcuts";
const ARTIFACT_HOST_ID = "native-shortcuts-host";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** One row of the qualification matrix, as recorded in to-do 0325. */
type Row = { surface: string; check: string; result: "pass"; resumed: string };

/** XTEST input to whichever window has X focus; the test keeps that ours. */
function xdotool(...args: string[]): string {
  return execFileSync("xdotool", args, { encoding: "utf8", timeout: 10_000 }).trim();
}

function press(...chords: string[]): void {
  xdotool("key", "--clearmodifiers", "--delay", "60", ...chords);
}

function typeText(text: string): void {
  xdotool("type", "--clearmodifiers", "--delay", "60", text);
}

/** The page every preview row types into; it records the keys it receives. */
const PREVIEW_HTML = [
  "<!doctype html>",
  `<html lang="en"><head><meta charset="utf-8"><title>${PREVIEW_TITLE}</title></head>`,
  "<body>",
  '<label>Field <input id="field" autocomplete="off"></label>',
  "<script>",
  "window.__keys = [];",
  "addEventListener('keydown', (event) => {",
  "  if (event.ctrlKey && event.key !== 'Control') window.__keys.push('ctrl+' + event.key.toLowerCase());",
  "}, true);",
  "</script>",
  "</body></html>",
].join("");

function artifactDocument(): { bytes: Uint8Array; csp: string } {
  const runtime = artifactFrameRuntimeScript({ ...ARTIFACT, nonce: ARTIFACT_NONCE });
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"></head><body>',
    '<label>Artifact field <input id="field" autocomplete="off"></label>',
    `<script>${runtime}</script>`,
    "</body></html>",
  ].join("");
  return {
    bytes: new TextEncoder().encode(html),
    csp: buildInteractiveCsp([inlineScriptHash(runtime)], []),
  };
}

test("packaged Linux on X11: Ctrl+Shift+/ and Ctrl+K from the composer, a browser preview, an interactive artifact and a design frame", async () => {
  test.skip(
    process.platform !== "linux" || process.env.ORKESTRATOR_NATIVE_SHORTCUT_INPUT !== "1",
    "Native input is opt-in: set ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1 on a disposable X display",
  );
  // An opted-in run that cannot do what it asked fails instead of skipping.
  expect(
    process.env.DISPLAY,
    "ORKESTRATOR_NATIVE_SHORTCUT_INPUT=1 needs an X DISPLAY",
  ).toBeTruthy();
  test.setTimeout(600_000);
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:linux:unpacked:test\` first.`,
  ).toBe(true);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-native-shortcuts-"));
  let app: ElectronApplication | null = null;
  let previewServer: Server | null = null;
  let contentServer: LoopbackArtifactContentServer | null = null;
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "native-shortcuts-packaged",
    flavor: "agent-test",
    // No ports: nothing serves the renderer of a packaged build (it loads from
    // file:), and port 0 lets the backend bind its own gateway port.
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  const home = path.join(temporaryRoot, "home");
  await mkdir(home, { recursive: true });
  const rows: Row[] = [];
  const record = (surface: string, check: string, resumed: string) =>
    rows.push({ surface, check, result: "pass", resumed });

  await withCleanup(async () => {
    previewServer = createServer((request, response) => {
      if (request.url !== PREVIEW_PATH) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PREVIEW_HTML);
    });
    await new Promise<void>((resolve) => previewServer!.listen(0, "127.0.0.1", resolve));
    const previewUrl = `http://127.0.0.1:${(previewServer.address() as AddressInfo).port}${PREVIEW_PATH}`;

    app = await electron.launch({
      executablePath,
      args: [
        ...ELECTRON_TEST_SWITCHES,
        // A real X11 window on the disposable display, never headless Ozone.
        "--ozone-platform=x11",
        "--password-store=basic",
      ],
      cwd: temporaryRoot,
      env: {
        ...packagedLaunchEnvironment(process.env, { home, profilePath }),
        DISPLAY: process.env.DISPLAY!,
        GDK_BACKEND: "x11",
        XDG_SESSION_TYPE: "x11",
      },
    });
    recordElectronDiagnostics(app);
    const electronApp = app;
    const window = await openDesignWindow(electronApp, profile, {
      title: "native",
      timeoutMs: 90_000,
    });
    const runtime = await electronApp.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      userData: electronApp.getPath("userData"),
      pid: process.pid,
      electron: process.versions.electron,
      version: electronApp.getVersion(),
    }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.userData).toBe(profile.dataDir);
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
    });

    const invoke: Invoke = (command, args = {}) =>
      window.evaluate(
        ({ command, args }) => (globalThis as any).orkestrator.invoke(command, args),
        { command, args },
      );
    const projectPath = await prepareFixtureRepository(profile, templateRoot);
    const project = await invoke<{ id: string; name: string }>("add_project", {
      gitUrl: path.join(profile.fixtureDir, "origin.git"),
      localPath: projectPath,
    });
    const environment = await invoke<{ id: string; name: string }>("create_environment", {
      projectId: project.id,
      name: "native-shortcuts",
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: environment.id });
    const composerTabId = "native-shortcuts-composer";
    const previewTabId = "native-shortcuts-preview";
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: environment.id,
    });
    await invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "native-shortcuts-pane",
        root: {
          kind: "leaf",
          id: "native-shortcuts-pane",
          activeTabId: composerTabId,
          tabs: [
            {
              id: composerTabId,
              type: "agent-native",
              nativeAgentData: { environmentId: environment.id },
            },
            { id: previewTabId, type: "browser", browserData: { url: previewUrl } },
          ],
        },
      },
    });

    const main = nativeMenuWindows(runtime.pid).find((candidate) =>
      candidate.title.startsWith(profile.electronTitle),
    );
    expect(main, "the packaged window on the X display").toBeDefined();
    // Xvfb has no window manager: give the window X focus as one would.
    nativeMenuFocus(main!);
    await expect.poll(() => xdotool("getwindowfocus")).toBe(main!.id);
    /** What a click on the window's own document does to native focus. */
    const focusShell = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.focus();
      });
    const shellFocused = () =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.isFocused(),
      );

    await window.reload();
    const expand = window.getByRole("button", { name: `Expand project ${project.name}` });
    const entry = window.getByText(environment.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await window.mouse.move(0, 0);
    // The window and its own document have native focus before the
    // environment (and its background preview tab) opens, as after a click.
    await focusShell();
    await expect.poll(shellFocused).toBe(true);
    await entry.click();

    /** Where focus is, for a failure message: X focus, each WebContents, the shell's element. */
    const describeFocus = async () =>
      JSON.stringify({
        xFocus: xdotool("getwindowfocus"),
        window: main!.id,
        contents: await electronApp.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((candidate) => !candidate.isDestroyed())
            .map((candidate) => ({
              url: candidate.getURL().slice(0, 80),
              focused: candidate.isFocused(),
            })),
        ),
        views: await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => ({
            url:
              (child as { webContents?: Electron.WebContents }).webContents
                ?.getURL()
                .slice(0, 80) ?? null,
            visible: child.getVisible(),
            bounds: child.getBounds(),
          })),
        ),
        shell: await window.evaluate(() => ({
          hasFocus: document.hasFocus(),
          active: document.activeElement
            ? `${document.activeElement.tagName} ${document.activeElement.getAttribute("aria-label") ?? ""}`
            : null,
        })),
      });
    const expectFocused = async (focused: () => Promise<boolean>, what: string) => {
      try {
        await expect.poll(focused, { message: what }).toBe(true);
      } catch (error) {
        throw new Error(`${(error as Error).message}\nFocus: ${await describeFocus()}`);
      }
    };

    /** A pane tab by its layout id (`createPaneTabElementId`), whatever its label. */
    const paneTab = (tabId: string) =>
      window.locator(`[role="tab"][id$=":native-shortcuts-pane:${tabId}"]`);
    const dialog = window.getByRole("dialog", { name: "Keyboard shortcuts" });
    const dialogSearch = window.getByRole("textbox", { name: "Search keyboard shortcuts" });
    const projectSearch = window.getByRole("combobox", {
      name: "Search projects and environments",
    });

    /**
     * The chord opens from `surface`, a separate press closes, and typing
     * resumes there; then the same with Escape closing it.
     */
    const chordToggles = async (
      surface: string,
      focus: () => Promise<void>,
      focused: () => Promise<boolean>,
      typed: () => Promise<string>,
    ) => {
      for (const close of ["chord", "Escape"] as const) {
        await focus();
        await expectFocused(focused, `${surface} focused`);
        const before = await typed();
        press("ctrl+shift+slash");
        await expect(dialog).toBeVisible();
        await expect(dialogSearch).toBeFocused();
        press(close === "chord" ? "ctrl+shift+slash" : "Escape");
        await expect(dialog).toHaveCount(0);
        await expectFocused(focused, `${surface} focused again`);
        const marker = close === "chord" ? "zq" : "zw";
        expect(before).not.toContain(marker);
        typeText(marker);
        // Where the caret sits depends on how the test focused the surface
        // (a DOM focus() puts it at the start of a contenteditable), so only
        // that every typed key arrived is asserted.
        await expect.poll(typed).toContain(marker);
        expect((await typed()).length).toBe(before.length + marker.length);
        record(
          surface,
          close === "chord"
            ? "Ctrl+Shift+/ opens with search focused; a separate press closes"
            : "Ctrl+Shift+/ opens; Escape closes",
          `\`${marker}\` typed into the ${surface.toLowerCase()}`,
        );
      }
    };

    /** Ctrl+K from `surface` opens the window's search, which takes typing. */
    const ctrlKOpensSearch = async (
      surface: string,
      focus: () => Promise<void>,
      focused: () => Promise<boolean>,
    ) => {
      await focus();
      await expectFocused(focused, `${surface} focused`);
      press("ctrl+k");
      await expect(projectSearch).toBeFocused();
      typeText("rea");
      await expect(projectSearch).toHaveValue("rea");
      press("ctrl+a", "BackSpace", "Escape");
      record(
        surface,
        "Ctrl+K opens the window's search, which takes typing",
        "`rea` in the search",
      );
    };

    /** Runs `script` in the browser preview's page, once it exists. */
    const inPreview = <T>(script: string) =>
      electronApp.evaluate(
        async ({ webContents }, { script, path }) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => !candidate.isDestroyed() && candidate.getURL().includes(path));
          if (!contents) return null;
          return (await contents.executeJavaScript(script)) as unknown;
        },
        { script, path: PREVIEW_PATH },
      ) as Promise<T | null>;
    const previewFocused = () =>
      electronApp.evaluate(
        ({ webContents }, path) =>
          webContents
            .getAllWebContents()
            .some(
              (candidate) =>
                !candidate.isDestroyed() &&
                candidate.getURL().includes(path) &&
                candidate.isFocused(),
            ),
        PREVIEW_PATH,
      );
    await test.step("composer (unassigned agent tab)", async () => {
      const composer = window
        .getByTestId("unassigned-native-compose-bar")
        .getByRole("textbox")
        .first();
      await expect(composer).toBeVisible({ timeout: 30_000 });
      // The browser tab behind it loads its page in a hidden view. Electron
      // focuses a view as it loads; the hidden one must not keep that focus,
      // or typing into the composer reaches an invisible page instead.
      await expect
        .poll(() => inPreview<string>("document.title"), { timeout: 30_000 })
        .toBe(PREVIEW_TITLE);
      await expect.poll(previewFocused).toBe(false);
      await expect.poll(shellFocused).toBe(true);
      await composer.focus();
      typeText("hx");
      await expect.poll(async () => ((await composer.textContent()) ?? "").trim()).toBe("hx");
      record(
        "Composer",
        "A background browser tab's hidden preview loads without taking keyboard focus",
        "`hx` typed into the composer",
      );
      press("ctrl+a", "BackSpace");
      await expect.poll(async () => ((await composer.textContent()) ?? "").trim()).toBe("");
      const focus = async () => {
        await focusShell();
        await composer.focus();
      };
      const focused = async () =>
        (await shellFocused()) &&
        (await window.evaluate(() =>
          Boolean(
            document.hasFocus() &&
            document.activeElement?.closest('[data-testid="unassigned-native-compose-bar"]'),
          ),
        ));
      const typed = async () => ((await composer.textContent()) ?? "").trim();
      await chordToggles("Composer", focus, focused, typed);
      await ctrlKOpensSearch("Composer", focus, focused);
    });

    await test.step("browser preview", async () => {
      await paneTab(previewTabId).click();
      await expect
        .poll(() => inPreview<string>("document.title"), { timeout: 30_000 })
        .toBe(PREVIEW_TITLE);
      const focus = async () => {
        await electronApp.evaluate(({ webContents }, path) => {
          webContents
            .getAllWebContents()
            .find((candidate) => !candidate.isDestroyed() && candidate.getURL().includes(path))
            ?.focus();
        }, PREVIEW_PATH);
        await inPreview("document.getElementById('field').focus()");
      };
      const focused = async () =>
        (await previewFocused()) &&
        (await inPreview<boolean>(
          "document.hasFocus() && document.activeElement?.id === 'field'",
        )) === true;
      const typed = async () =>
        (await inPreview<string>("document.getElementById('field').value")) ?? "";
      await chordToggles("Browser preview", focus, focused, typed);

      // An outside pointer click dismisses it, and typing resumes in the preview.
      await focus();
      await expectFocused(focused, "preview focused");
      const beforeClick = await typed();
      press("ctrl+shift+slash");
      await expect(dialog).toBeVisible();
      // Bottom right of the main area: outside the centred dialog, on the
      // renderer (the preview view is hidden while the dialog is open).
      xdotool("mousemove", "--window", main!.id, "1300", "880", "click", "1");
      await expect(dialog).toHaveCount(0);
      await expectFocused(focused, "preview focused after outside click");
      typeText("zc");
      await expect.poll(typed).toBe(`${beforeClick}zc`);
      record(
        "Browser preview",
        "Ctrl+Shift+/ opens; an outside pointer click closes",
        "`zc` typed into the preview's field",
      );

      // View › Keyboard Shortcuts… from the keyboard while the preview has
      // focus opens the window's dialog; choosing it again keeps the dialog
      // open and puts focus back on its search.
      const chooseFromMenu = async () => {
        nativeMenuAlt(main!);
        await expect
          .poll(async () => (await previewFocused()) || (await shellFocused()))
          .toBe(false);
        press("Right", "Right", "Down", "End", "Return");
      };
      await focus();
      await expectFocused(focused, "preview focused");
      const beforeMenu = await typed();
      await chooseFromMenu();
      await expect(dialog).toBeVisible();
      await expect(dialogSearch).toBeFocused();
      await dialogSearch.evaluate((element) => (element as HTMLElement).blur());
      await expect(dialogSearch).not.toBeFocused();
      await chooseFromMenu();
      await expect(dialog).toBeVisible();
      await expect(dialogSearch).toBeFocused();
      press("Escape");
      await expect(dialog).toHaveCount(0);
      await expectFocused(focused, "preview focused after menu dialog");
      typeText("zm");
      await expect.poll(typed).toBe(`${beforeMenu}zm`);
      record(
        "Browser preview",
        "View › Keyboard Shortcuts… (Alt, Right, Right, Down, End, Enter) opens; choosing it again keeps the dialog and refocuses search; Escape closes",
        "`zm` typed into the preview's field",
      );

      // Ctrl+K stays with the previewed page.
      await focus();
      await expectFocused(focused, "preview focused");
      await inPreview("window.__keys = []");
      press("ctrl+k");
      await expect.poll(() => inPreview<string[]>("window.__keys")).toEqual(["ctrl+k"]);
      await expect(projectSearch).toHaveCount(0);
      expect(await focused()).toBe(true);
      record(
        "Browser preview",
        "Ctrl+K stays with the page (no search)",
        "Focus stayed in the field",
      );

      // Back to the composer tab, so the preview view is hidden for the artifact.
      await paneTab(composerTabId).click();
      await expect.poll(previewFocused).toBe(false);
    });

    await test.step("interactive artifact view", async () => {
      contentServer = await LoopbackArtifactContentServer.start({
        frameAncestors: [DESKTOP_ARTIFACT_SHELL_ORIGIN],
      });
      const document = artifactDocument();
      const live = contentServer.mint({
        ...ARTIFACT,
        preparedSha256: sha256Hex(document.bytes),
        contentSecurityPolicy: document.csp,
        load: async () => document.bytes,
        authorize: async () => true,
      });
      const opened = await window.evaluate(
        async ({ hostId, contentUrl, generation, identity, nonce }) => {
          const state = globalThis as typeof globalThis & {
            orkestrator: { artifactHost: ArtifactHostApi };
            __artifactHostEvents?: ArtifactHostEvent[];
          };
          state.__artifactHostEvents = [];
          state.orkestrator.artifactHost.onEvent((event) =>
            state.__artifactHostEvents!.push(event),
          );
          return state.orkestrator.artifactHost.open({
            hostId,
            contentUrl,
            ...identity,
            generation,
            readinessNonce: nonce,
            bounds: { x: 420, y: 160, width: 600, height: 320 },
            visible: true,
          });
        },
        {
          hostId: ARTIFACT_HOST_ID,
          contentUrl: live.url,
          generation: live.generation,
          identity: ARTIFACT,
          nonce: ARTIFACT_NONCE,
        },
      );
      expect(opened).toEqual({ ok: true });
      await expect
        .poll(
          () =>
            window.evaluate(() =>
              (
                (globalThis as { __artifactHostEvents?: ArtifactHostEvent[] })
                  .__artifactHostEvents ?? []
              ).map((event) => event.type),
            ),
          { timeout: 15_000 },
        )
        .toContain("ready");
      const shellPage = (): Page | undefined =>
        electronApp.windows().find((page) => page.url().startsWith(SHELL_PREFIX));
      await expect.poll(() => Boolean(shellPage())).toBe(true);
      const field = shellPage()!.frameLocator("#artifact").locator("#field");
      const viewFocused = () =>
        electronApp.evaluate(
          ({ webContents }, prefix) =>
            webContents
              .getAllWebContents()
              .some(
                (candidate) =>
                  !candidate.isDestroyed() &&
                  candidate.getURL().startsWith(prefix) &&
                  candidate.isFocused(),
              ),
          SHELL_PREFIX,
        );
      const focus = async () => {
        await electronApp.evaluate(({ webContents }, prefix) => {
          webContents
            .getAllWebContents()
            .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(prefix))
            ?.focus();
        }, SHELL_PREFIX);
        await field.focus();
      };
      const focused = async () =>
        (await viewFocused()) &&
        (await field.evaluate(
          (element) =>
            element.ownerDocument.hasFocus() && element.ownerDocument.activeElement === element,
        ));
      const typed = () => field.inputValue();
      await chordToggles("Interactive artifact", focus, focused, typed);
      await ctrlKOpensSearch("Interactive artifact", focus, focused);
      await window.evaluate(
        (hostId) =>
          (
            globalThis as typeof globalThis & { orkestrator: { artifactHost: ArtifactHostApi } }
          ).orkestrator.artifactHost.close(hostId),
        ARTIFACT_HOST_ID,
      );
    });

    await test.step("design frame", async () => {
      await window.getByRole("button", { name: "New design workspace" }).click();
      const designDialog = window.getByRole("dialog", { name: "Design workspace" });
      await expect(designDialog).toBeVisible();
      await designDialog.getByRole("textbox", { name: "Name", exact: true }).fill("Shortcuts");
      await designDialog.getByRole("combobox", { name: "Design agent", exact: true }).click();
      await window.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
      await designDialog.getByRole("combobox", { name: "Initial frame", exact: true }).click();
      await window.getByRole("option", { name: "Mobile 390×844", exact: true }).click();
      const create = designDialog.getByRole("button", { name: "Create blank canvas", exact: true });
      // Design readiness is checked when the dialog opens.
      await expect(create)
        .toBeEnabled({ timeout: 60_000 })
        .catch(async (error: Error) => {
          const blocker = await designDialog.locator("#design-create-blocker").textContent();
          throw new Error(`${error.message}\nBlocked: ${blocker ?? "(no message)"}`);
        });
      await create.click();
      await expect(designDialog).toHaveCount(0, { timeout: 30_000 });
      const frame = window.frameLocator('iframe[title="Mobile"]');
      await expect(frame.locator("main")).toBeAttached({ timeout: 30_000 });
      // A text field in the frame, as a design's own input would be.
      await frame.locator("main").evaluate((main) => {
        const input = main.ownerDocument.createElement("input");
        input.id = "field";
        input.setAttribute("aria-label", "Frame field");
        main.append(input);
      });
      const field = frame.locator("#field");
      const focus = async () => {
        await focusShell();
        await field.focus();
      };
      const focused = async () =>
        (await shellFocused()) &&
        (await field.evaluate(
          (element) =>
            element.ownerDocument.hasFocus() && element.ownerDocument.activeElement === element,
        ));
      const typed = () => field.inputValue();
      await chordToggles("Design frame", focus, focused, typed);
      await ctrlKOpensSearch("Design frame", focus, focused);
    });

    const evidence = {
      packaged: { version: runtime.version, electron: runtime.electron },
      display: process.env.DISPLAY,
      keymap: execFileSync("setxkbmap", ["-query"], { encoding: "utf8", timeout: 10_000 }).trim(),
      rows,
    };
    await test.info().attach("native-shortcut-rows", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    await test.info().attach("packaged-window", {
      body: execFileSync("import", ["-window", main!.id, "png:-"], { timeout: 10_000 }),
      contentType: "image/png",
    });
  }, [
    async () => {
      let owned: number[] | undefined = app ? undefined : [];
      await withCleanup(async () => {
        if (app) {
          owned = electronProcessTree(app);
          await closeElectron(app, owned);
        }
      }, [
        async () => {
          await contentServer?.close().catch(() => undefined);
          await new Promise<void>((resolve) =>
            previewServer ? previewServer.close(() => resolve()) : resolve(),
          );
          // Retain the profile if forced termination could not prove the tree stopped.
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped(owned, 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});
