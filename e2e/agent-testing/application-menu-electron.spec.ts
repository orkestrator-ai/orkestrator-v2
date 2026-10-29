import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {} from "../fixtures/application-menu-electron";
import { closeElectronWithin } from "./design-electron-cleanup";
import { nativeMenuKeys, nativeMenuScreenshot, nativeMenuWindows } from "./native-menu-input";

test("built application menu resolves native roles and dispatches callbacks", async () => {
  test.skip(process.platform === "darwin", "Windows/Linux menu qualification");
  const directory = await mkdtemp(path.join(os.tmpdir(), "orkestrator-menu-"));
  let app: ElectronApplication | undefined;
  try {
    const fixture = path.join(directory, "main.cjs");
    execFileSync(
      "bun",
      [
        "build",
        "e2e/fixtures/application-menu-electron.ts",
        "--target=node",
        "--format=cjs",
        "--external=electron",
        `--outfile=${fixture}`,
      ],
      { timeout: 30_000 },
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
      ),
    );
    if (process.platform === "linux") {
      delete env.WAYLAND_DISPLAY;
      env.GDK_BACKEND = "x11";
      env.XDG_SESSION_TYPE = "x11";
    }
    app = await electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [
        "--no-sandbox",
        ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
        "--lang=en-US",
        `--user-data-dir=${path.join(directory, "profile")}`,
        fixture,
      ],
      env,
    });
    const page = await app.firstWindow();
    await expect(page).toHaveTitle("Orkestrator menu qualification");
    const snapshot = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()!;
      return menu.items.map((item) => ({
        label: item.label,
        items: item.submenu!.items.map((child) => ({
          label: child.label,
          role: child.role,
          accelerator: child.accelerator ?? null,
          registerAccelerator: child.registerAccelerator,
        })),
      }));
    });
    expect(snapshot.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    const items = snapshot.flatMap((item) => item.items);
    expect(items.find((item) => item.role === "quit")).toMatchObject({
      label: process.platform === "win32" ? "Exit" : "Quit",
      accelerator: process.platform === "win32" ? null : "CommandOrControl+Q",
    });
    expect(items.find((item) => item.role === "redo")).toMatchObject({
      label: "Redo",
      accelerator: process.platform === "win32" ? "Control+Y" : "Shift+CommandOrControl+Z",
    });
    expect(items.find((item) => item.role === "minimize")).toMatchObject({
      label: "Minimize",
      accelerator: "CommandOrControl+M",
    });
    expect(items.find((item) => item.role === "about")?.label).toMatch(/^About/);
    expect(items.find((item) => item.label === "Close Tab")?.accelerator).toBeNull();
    expect(
      items.some((item) => ["hide", "hideothers", "unhide", "zoom"].includes(item.role ?? "")),
    ).toBe(false);
    expect(items.find((item) => item.label === "Keyboard Shortcuts…")).toMatchObject({
      accelerator: "CmdOrCtrl+Shift+K",
      registerAccelerator: false,
    });
    expect(items.find((item) => item.label === "Settings…")).toMatchObject({
      accelerator: "CmdOrCtrl+,",
      registerAccelerator: false,
    });

    await app.evaluate(({ Menu, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const items = Menu.getApplicationMenu()!.items.flatMap((item) => item.submenu!.items);
      for (const label of [
        "New Window",
        "Close Tab",
        "Settings…",
        "Zoom In",
        "Zoom Out",
        "Actual Size",
        "Check for Updates…",
        "Menu fixture",
      ]) {
        items
          .find((item) => item.label === label)!
          .click({} as Electron.KeyboardEvent, window, window.webContents);
      }
      const shortcuts = items.find((item) => item.label === "Keyboard Shortcuts…")!;
      shortcuts.click(
        { triggeredByAccelerator: false } as Electron.KeyboardEvent,
        window,
        window.webContents,
      );
      shortcuts.click(
        { triggeredByAccelerator: true, ctrlKey: true, shiftKey: true } as Electron.KeyboardEvent,
        window,
        window.webContents,
      );
    });
    expect(await app.evaluate(() => globalThis.applicationMenuEvents)).toEqual([
      "new-window",
      "close-tab",
      "settings",
      "zoom:in",
      "zoom:out",
      "zoom:reset",
      "updates",
      expect.stringMatching(/^window:\d+$/),
      "shortcuts:open",
      "shortcuts:toggle",
    ]);
    await test.info().attach("native-menu-defaults", {
      body: JSON.stringify(snapshot, null, 2),
      contentType: "application/json",
    });

    // Native input is opt-in: CI uses a disposable desktop and Linux uses Xvfb.
    // Missing native dependencies fail an opted-in run instead of silently skipping.
    if (process.env.ORKESTRATOR_NATIVE_MENU_INPUT !== "1") {
      test.info().annotations.push({
        type: "native-input",
        description: "Not requested; set ORKESTRATOR_NATIVE_MENU_INPUT=1 on an isolated desktop",
      });
      return;
    }
    const pid = await app.evaluate(() => process.pid);
    const electronVersion = await app.evaluate(() => process.versions.electron);
    const main = nativeMenuWindows(pid).find(
      (window) => window.title === "Orkestrator menu qualification",
    );
    expect(main).toBeDefined();
    const events = () => app!.evaluate(() => globalThis.applicationMenuEvents);
    await app.evaluate(() => {
      globalThis.applicationMenuEvents = [];
    });

    // Alt selects File, two Right keys select View, End chooses Shortcuts.
    nativeMenuKeys(
      main!,
      ["Alt_L", "Right", "Right", "Down", "End", "Return"],
      "{F10}{RIGHT}{RIGHT}{DOWN}{END}{ENTER}",
    );
    await expect.poll(events).toEqual(["shortcuts:open"]);
    nativeMenuKeys(
      main!,
      ["Alt_L", "Right", "Right", "Down", "End", "Return"],
      "{F10}{RIGHT}{RIGHT}{DOWN}{END}{ENTER}",
    );
    await expect.poll(events).toEqual(["shortcuts:open", "shortcuts:open"]);
    nativeMenuKeys(main!, ["ctrl+n"], "^n");
    await expect.poll(events).toEqual(["shortcuts:open", "shortcuts:open", "new-window"]);
    // Display-only shortcut must not independently dispatch from Electron's menu.
    nativeMenuKeys(main!, ["ctrl+shift+k", "ctrl+n"], "^+k^n");
    await expect
      .poll(events)
      .toEqual(["shortcuts:open", "shortcuts:open", "new-window", "new-window"]);

    // Invoke the built About role, leaving the real platform implementation
    // and its default metadata intact. Observe and dismiss its native window.
    const beforeAbout = new Set(nativeMenuWindows(pid).map((window) => window.id));
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const about = Menu.getApplicationMenu()!
        .items.find((item) => item.label === "Help")!
        .submenu!.items.find((item) => item.role === "about")!;
      about.click({} as Electron.KeyboardEvent, window, window.webContents);
    });
    const aboutWindows = () =>
      nativeMenuWindows(pid).filter(
        (window) => !beforeAbout.has(window.id) && window.title.length > 0,
      );
    await expect.poll(() => aboutWindows().length).toBe(1);
    const about = aboutWindows()[0]!;
    if (process.platform === "linux") expect(about.title).toMatch(/About/i);
    await test.info().attach("native-about-window", {
      body: JSON.stringify({
        platform: process.platform,
        about,
        electron: electronVersion,
      }),
      contentType: "application/json",
    });
    await test.info().attach("native-about", {
      body: nativeMenuScreenshot(about),
      contentType: "image/png",
    });
    nativeMenuKeys(about, ["Escape"], "{ESC}");
    await expect
      .poll(() => nativeMenuWindows(pid).some((window) => window.id === about.id))
      .toBe(false);
    nativeMenuKeys(main!, ["a"], "a");
    await expect(page.getByRole("textbox")).toHaveValue("a");
  } finally {
    await closeElectronWithin(app);
    await rm(directory, { recursive: true, force: true });
  }
});
