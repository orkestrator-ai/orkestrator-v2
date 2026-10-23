/**
 * The design canvas in the real Electron app: the production main bundle,
 * preload and IPC invoke bridge, with a disposable agent-test profile under a
 * temporary root and a fixture repository (never the user's profile, backend
 * data or this checkout). No agent provider is started and no credential is
 * used: every canvas here is a blank canvas created from the UI.
 *
 * Covers, through the real window:
 * - Open: New design workspace -> Blank canvas (no agent) with a Mobile frame.
 * - Edit: a pointer drag of the frame title, read back from the backend.
 * - Keyboard: Arrow / Shift+Arrow nudges and Alt+Arrow resize (each burst one
 *   undo entry), Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo, Delete of the
 *   selected frame (and undo of it), `+`/`-` zoom, Shift+1 fit all, `P`
 *   preview mode, `?` shortcut help and Escape deselect. Ctrl/Cmd+0 resets
 *   the canvas to 100% while the app-wide Ctrl/Cmd+= / Ctrl/Cmd+- keep
 *   changing the window's zoom factor and Ctrl/Cmd+0 leaves it alone (App's
 *   global zoom listener used to swallow it). Keys are delivered by
 *   Playwright through Chromium's input pipeline (CDP), not as OS key events,
 *   so native menu key-equivalent routing on macOS is not exercised.
 * - Export: the Export dialog writes `designs/<name>.orkdes` into the
 *   environment worktree; the file is checked byte for byte against the
 *   portable serialization of the exported revision and against the digest
 *   the backend recorded for the export.
 * - Download: Electron's own download path for the toolbar's blob download.
 *   The product installs no `will-download` handler, so Electron would show
 *   its native Save dialog; the spec adds a main-process `will-download`
 *   listener that sets the save path, which replaces only that OS dialog.
 * - Open design (`design_import_host_file`): this picker is Orkestrator's own
 *   in-app host path picker (it lists the backend host's directories), not an
 *   OS file dialog, so nothing is stubbed. The spec drives the real picker to
 *   a fixture `.orkdes` file outside the repository and records any
 *   `dialog.showOpenDialog*` call in main to prove no OS dialog is involved.
 *
 * Not covered: design agents (Claude/Codex) and the MCP tool cycle, which need
 * live providers (design-live.spec.ts), and the packaged `file://` renderer;
 * like the other Electron specs, the renderer is served by Vite.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type { DesignSnapshotEnvelope } from "@orkestrator/protocol/design-operations";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { stopProcessGroup, waitForStopped, withCleanup } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");

const DESIGN_NAME = "Electron design";
const HOST_DESIGN_NAME = "Host fixture design";
const HOST_FRAME_NAME = "Host screen";
const HOST_MARKER = "Opened from the host";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type CommandResult<T> = { ok: true; value: T } | { ok: false; failure: { message: string } };
type DownloadRecord = {
  filename: string;
  scheme: string;
  savePath: string;
  state: string;
  received: number;
};

async function waitForUrl(url: string): Promise<void> {
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

/** The bytes `portableBytes` (backend `design/records.ts`) writes for a revision. */
function portableBytes(canvas: DesignCanvas): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        format: canvas.format,
        version: canvas.version,
        id: canvas.id,
        environmentId: canvas.environmentId,
        name: canvas.name,
        revision: canvas.revision,
        frames: canvas.frames.map((frame) => ({
          id: frame.id,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          html: frame.html,
          revision: frame.revision,
        })),
      },
      null,
      2,
    ),
  );
}

function zoomPercent(page: Page): Promise<number> {
  return page
    .getByRole("button", { name: /^Zoom \d+%\. Reset to 100%$/ })
    .first()
    .getAttribute("aria-label")
    .then((label) => Number(label?.match(/^Zoom (\d+)%/)?.[1] ?? Number.NaN));
}

test.beforeAll(() => {
  // Bundle exactly as production and the dev launcher do. A `tsc` emit leaves
  // workspace imports pointing at raw `.ts` sources Electron cannot run.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
});

test("design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron", async () => {
  test.setTimeout(480_000);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-design-electron-"));
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "design-canvas-electron",
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
  const downloadDir = path.join(temporaryRoot, "downloads");
  const hostDir = path.join(temporaryRoot, "host-designs");
  await mkdir(downloadDir, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  await withCleanup(async () => {
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
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [...ELECTRON_TEST_SWITCHES, path.join(packageRoot, "dist", "electron", "main.js")],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        // Never contend for the fixed control-MCP port an installed app may own.
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      },
    });
    const electronApp = app;
    dismissStartupDialogs(electronApp);
    const window = await electronApp.firstWindow({ timeout: 90_000 });
    // index.html's title stays until Vite serves and runs renderer-entry; a
    // cold Vite dependency pass on a loaded host can take well over a minute.
    await expect(window).toHaveTitle(profile.electronTitle, { timeout: 150_000 });
    await expect
      .poll(
        () =>
          window
            .evaluate(async () => {
              const api = (globalThis as any).orkestrator;
              if (!api?.invoke) return false;
              await api.invoke("greet", { name: "design" });
              return true;
            })
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
    });
    const versions = await electronApp.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    test.info().annotations.push({ type: "electron", description: JSON.stringify(versions) });

    // Main-process instrumentation: record (and refuse) any OS open dialog,
    // and give Electron's download a save path instead of its Save dialog.
    await electronApp.evaluate(({ BrowserWindow, dialog }, downloadDir) => {
      const state = globalThis as typeof globalThis & {
        __designDialogCalls?: string[];
        __designDownloads?: DownloadRecord[];
      };
      state.__designDialogCalls = [];
      state.__designDownloads = [];
      const record = (name: string) => () => {
        state.__designDialogCalls!.push(name);
        return name.endsWith("Sync") ? undefined : { canceled: true, filePaths: [] };
      };
      (dialog as any).showOpenDialog = record("showOpenDialog");
      (dialog as any).showOpenDialogSync = record("showOpenDialogSync");
      const session = BrowserWindow.getAllWindows()[0]!.webContents.session;
      session.on("will-download", (_event, item) => {
        const entry: DownloadRecord = {
          filename: item.getFilename(),
          scheme: new URL(item.getURL()).protocol,
          savePath: `${downloadDir}/${item.getFilename()}`,
          state: "progressing",
          received: 0,
        };
        item.setSavePath(entry.savePath);
        state.__designDownloads!.push(entry);
        item.once("done", (_doneEvent, doneState) => {
          entry.state = doneState;
          entry.received = item.getReceivedBytes();
        });
      });
    }, downloadDir);
    const dialogCalls = () =>
      electronApp.evaluate(
        () => (globalThis as { __designDialogCalls?: string[] }).__designDialogCalls ?? [],
      );
    const downloads = () =>
      electronApp.evaluate(
        () => (globalThis as { __designDownloads?: DownloadRecord[] }).__designDownloads ?? [],
      );

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
      name: "design-electron",
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: environment.id });
    const { worktreePath } = await invoke<{ worktreePath: string | null }>("get_environment", {
      environmentId: environment.id,
    });
    expect(worktreePath).toBeTruthy();
    const action = <T>(name: string, input: Record<string, unknown>) =>
      invoke<T>("design_action", { environmentId: environment.id, action: name, input });
    const snapshot = async (canvasId: string) => {
      const result = await invoke<CommandResult<DesignSnapshotEnvelope>>("design_snapshot", {
        environmentId: environment.id,
        canvasId,
      });
      if (!result.ok) throw new Error(result.failure.message);
      expect(result.value.kind).toBe("snapshot");
      return result.value;
    };
    const libraryIds = async (search: string) =>
      (
        await invoke<{ value: { entries: Array<{ id: string; name: string }> } }>(
          "design_library",
          { environmentId: environment.id, query: { search } },
        )
      ).value.entries;

    await window.reload();
    const expand = window.getByRole("button", { name: `Expand project ${project.name}` });
    const entry = window.getByText(environment.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await window.mouse.move(0, 0);
    await entry.click();

    let canvasId = "";
    let frameId = "";
    const title = window.getByRole("button", { name: "Move frame Mobile", exact: true });
    const frame = async () => {
      const canvas = await action<DesignCanvas>("get_canvas", { canvasId });
      return canvas.frames.find((candidate) => candidate.id === frameId) ?? null;
    };
    const geometry = async () => {
      const current = await frame();
      return (
        current && { x: current.x, y: current.y, width: current.width, height: current.height }
      );
    };

    await test.step("open a blank canvas from New design workspace", async () => {
      await window.getByRole("button", { name: "New design workspace" }).click();
      const dialog = window.getByRole("dialog", { name: "Design workspace" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(DESIGN_NAME);
      await dialog.getByRole("combobox", { name: "Design agent", exact: true }).click();
      await window.getByRole("option", { name: "Blank canvas (no agent)", exact: true }).click();
      await dialog.getByRole("combobox", { name: "Initial frame", exact: true }).click();
      await window.getByRole("option", { name: "Mobile 390×844", exact: true }).click();
      await dialog.getByRole("button", { name: "Create blank canvas", exact: true }).click();
      // Creating the canvas and its first frame commits twice before the tab opens.
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      await expect(
        window.getByRole("button", { name: `Design name: ${DESIGN_NAME}. Rename` }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(title).toBeVisible();
      // The Mobile preset's starting document is a single empty <main>.
      await expect(window.frameLocator('iframe[title="Mobile"]').locator("main")).toBeAttached({
        timeout: 30_000,
      });
      const entries = await libraryIds(DESIGN_NAME);
      expect(entries).toHaveLength(1);
      canvasId = entries[0]!.id;
      const canvas = await action<DesignCanvas>("get_canvas", { canvasId });
      expect(canvas.frames).toHaveLength(1);
      frameId = canvas.frames[0]!.id;
      expect(canvas.frames[0]).toMatchObject({
        name: "Mobile",
        x: 0,
        y: 0,
        width: 390,
        height: 844,
      });
    });

    await test.step("edit: drag the frame and read the committed geometry back", async () => {
      const before = (await geometry())!;
      const zoom = (await zoomPercent(window)) / 100;
      const box = (await title.boundingBox())!;
      const start = { x: box.x + Math.min(20, box.width / 2), y: box.y + box.height / 2 };
      await window.mouse.move(start.x, start.y);
      await window.mouse.down();
      await window.mouse.move(start.x + 60, start.y + 40, { steps: 5 });
      await window.mouse.move(start.x + 120, start.y + 80, { steps: 5 });
      await window.mouse.up();
      await expect.poll(async () => (await geometry())!.x, { timeout: 15_000 }).not.toBe(before.x);
      const after = (await geometry())!;
      expect(Math.abs(after.x - (before.x + Math.round(120 / zoom)))).toBeLessThanOrEqual(2);
      expect(Math.abs(after.y - (before.y + Math.round(80 / zoom)))).toBeLessThanOrEqual(2);
      expect({ width: after.width, height: after.height }).toEqual({
        width: before.width,
        height: before.height,
      });
      // The title shows the committed geometry once the edit settles.
      await expect(title).not.toContainText("saving");
    });

    await test.step("keyboard shortcuts", async () => {
      // Clicking the title selects the frame and focuses it (inside the canvas).
      await title.click();
      await expect(title).toHaveAttribute("aria-pressed", "true");
      const start = (await geometry())!;

      // One burst of nudges is one gesture.
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("Shift+ArrowDown");
      await expect
        .poll(geometry, { timeout: 15_000 })
        .toEqual({ ...start, x: start.x + 3, y: start.y + 10 });
      // Let the keyboard gesture end (800 ms idle) before the next one.
      await window.waitForTimeout(1_200);
      await window.keyboard.press("Alt+ArrowRight");
      await window.keyboard.press("Shift+Alt+ArrowDown");
      await expect.poll(geometry, { timeout: 15_000 }).toEqual({
        x: start.x + 3,
        y: start.y + 10,
        width: start.width + 1,
        height: start.height + 10,
      });
      await expect(title).not.toContainText("saving");
      await window.waitForTimeout(1_200);

      // Undo the resize gesture, then the nudge gesture; redo reapplies the nudge.
      await window.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(geometry, { timeout: 15_000 })
        .toEqual({ ...start, x: start.x + 3, y: start.y + 10 });
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(geometry, { timeout: 15_000 }).toEqual(start);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect
        .poll(geometry, { timeout: 15_000 })
        .toEqual({ ...start, x: start.x + 3, y: start.y + 10 });

      // Delete removes the selected frame; undo brings it back.
      await title.click();
      await expect(title).toHaveAttribute("aria-pressed", "true");
      await window.keyboard.press("Delete");
      await expect.poll(frame, { timeout: 15_000 }).toBeNull();
      await expect(title).toHaveCount(0);
      // The deleted title took focus with it; undo needs no canvas focus (the
      // pane owns the shortcut), focus a toolbar control so the key has a target.
      await window.getByRole("button", { name: "Undo design change" }).focus();
      await window.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(geometry, { timeout: 15_000 })
        .toEqual({ ...start, x: start.x + 3, y: start.y + 10 });
      await expect(title).toBeVisible();

      // Canvas zoom keys.
      const appZoom = () =>
        electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
        );
      const appZoomBefore = await appZoom();
      await title.click();
      const zoom0 = await zoomPercent(window);
      await window.keyboard.press("+");
      await expect
        .poll(async () => Math.abs((await zoomPercent(window)) - zoom0 * 1.2))
        .toBeLessThanOrEqual(1);
      await window.keyboard.press("-");
      await window.keyboard.press("-");
      await expect.poll(() => zoomPercent(window)).toBeLessThan(zoom0);
      // Shift+1 lands on the same zoom as the Fit all button (capped at 100%).
      await window.keyboard.press("Shift+Digit1");
      await expect.poll(() => zoomPercent(window)).toBeLessThanOrEqual(100);
      const fitByKey = await zoomPercent(window);
      await window.keyboard.press("+");
      await expect.poll(() => zoomPercent(window)).toBeGreaterThan(fitByKey);
      await window.getByRole("button", { name: "Fit all frames" }).click();
      await expect.poll(() => zoomPercent(window)).toBe(fitByKey);
      // Ctrl/⌘+= stays the app's zoom (the window's zoom factor); Ctrl/⌘+0
      // in the owning canvas resets the canvas, not the app.
      const canvasSize = () =>
        window
          .locator('[aria-label="Design canvas"]')
          .first()
          .evaluate((node) => {
            const { width, height } = node.getBoundingClientRect();
            return { width: Math.round(width), height: Math.round(height) };
          });
      const sizeBefore = await canvasSize();
      await title.focus();
      // Key names only, reported if the reset below fails (diagnostics).
      await window.evaluate(() => {
        const state = globalThis as typeof globalThis & { __designKeys?: unknown[] };
        state.__designKeys = [];
        addEventListener("keydown", (event: KeyboardEvent) =>
          state.__designKeys!.push([
            event.key,
            event.metaKey,
            event.ctrlKey,
            event.defaultPrevented,
          ]),
        );
      });
      await window.keyboard.press("ControlOrMeta+=");
      await expect.poll(appZoom).toBeGreaterThan(appZoomBefore);
      const appZoomed = await appZoom();
      // Press once the canvas has re-measured at the new window zoom.
      await expect.poll(canvasSize).not.toEqual(sizeBefore);
      await window.keyboard.press("ControlOrMeta+0");
      await expect
        .poll(() => zoomPercent(window))
        .toBe(100)
        .catch(async (error: Error) => {
          const keys = await window.evaluate(
            () => (globalThis as { __designKeys?: unknown[] }).__designKeys,
          );
          throw new Error(
            `${error.message}\nwindow keydown (bubble): ${JSON.stringify(keys)}; app zoom ${await appZoom()}`,
          );
        });
      expect(await appZoom()).toBe(appZoomed);
      await window.keyboard.press("ControlOrMeta+-");
      await expect.poll(appZoom).toBe(appZoomBefore);
      // The canvas re-measures after the window zoom settles.
      await expect.poll(canvasSize).toEqual(sizeBefore);
      // At 100% the tall frame's title sits under the toolbar; fit it back in
      // view. Fit is idempotent, so repeat it until the viewport has re-measured.
      await expect(async () => {
        await window.keyboard.press("Shift+Digit1");
        expect(await zoomPercent(window)).toBe(fitByKey);
      }).toPass({ timeout: 10_000 });

      // P toggles preview mode; ? opens the shortcut help.
      await title.focus();
      await window.keyboard.press("p");
      await expect(window.getByRole("button", { name: "Exit preview mode" })).toBeVisible();
      await window.keyboard.press("p");
      await expect(window.getByRole("button", { name: "Preview mode", exact: true })).toBeVisible();
      await title.focus();
      await window.keyboard.press("Shift+Slash");
      const help = window.getByRole("dialog", { name: "Design keyboard shortcuts" });
      await expect(help).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(help).toHaveCount(0);

      // Escape clears the frame selection.
      await title.click();
      await expect(title).toHaveAttribute("aria-pressed", "true");
      await window.keyboard.press("Escape");
      await expect(title).toHaveAttribute("aria-pressed", "false");
    });

    await test.step("export to the repository and verify the file on disk", async () => {
      const committed = (await snapshot(canvasId)).canvas;
      await window.getByRole("button", { name: "Export design to repository" }).click();
      const dialog = window.getByRole("dialog", { name: "Export design to repository" });
      await expect(dialog.getByLabel("Folder")).toHaveValue("designs");
      const fileName = await dialog.getByLabel("File name").inputValue();
      expect(fileName).toMatch(/\.orkdes$/);
      const relativePath = `designs/${fileName}`;
      await expect(dialog.getByText(`New file: ${relativePath} will be created.`)).toBeVisible();
      await dialog
        .getByRole("button", { name: `Export revision ${committed.revision}`, exact: true })
        .click();
      await expect(
        dialog.getByText(`Exported revision ${committed.revision} to ${relativePath}`),
      ).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(dialog).toHaveCount(0);

      const bytes = await readFile(path.join(worktreePath!, relativePath));
      const after = await snapshot(canvasId);
      expect(after.canvas.revision).toBe(committed.revision);
      expect(bytes.equals(portableBytes(committed))).toBe(true);
      expect(after.workspace.export).toMatchObject({
        relativePath,
        lastExportedRevision: committed.revision,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      });
      await expect(
        window.getByText(`Exported revision ${committed.revision} to ${relativePath}`).first(),
      ).toBeVisible();
    });

    await test.step("download through Electron's download manager", async () => {
      const committed = (await snapshot(canvasId)).canvas;
      await window.getByRole("button", { name: "Download orkdes" }).click();
      const expectedName = `${DESIGN_NAME.replace(/[^a-zA-Z0-9_-]/g, "-")}.orkdes`;
      await expect
        .poll(async () => (await downloads()).map((item) => item.state), { timeout: 15_000 })
        .toEqual(["completed"]);
      const [download] = await downloads();
      expect(download).toMatchObject({ filename: expectedName, scheme: "blob:" });
      const content = await readFile(download!.savePath, "utf8");
      expect(download!.received).toBe(Buffer.byteLength(content));
      expect(JSON.parse(content)).toEqual(committed);
      expect(await dialogCalls()).toEqual([]);
    });

    await test.step("open a host .orkdes through the in-app host picker", async () => {
      const hostFile = path.join(hostDir, "host-fixture.orkdes");
      const fixtureId = randomUUID();
      await writeFile(
        hostFile,
        JSON.stringify({
          format: "orkdes",
          version: 1,
          id: fixtureId,
          environmentId: "another-machine",
          name: HOST_DESIGN_NAME,
          revision: 3,
          frames: [
            {
              id: randomUUID(),
              name: HOST_FRAME_NAME,
              x: 0,
              y: 0,
              width: 480,
              height: 320,
              html: `<h1>${HOST_MARKER}</h1>`,
              revision: 1,
            },
          ],
        }),
      );
      await window.getByRole("button", { name: "New design workspace" }).click();
      const workspace = window.getByRole("dialog", { name: "Design workspace" });
      await workspace.getByRole("tab", { name: "Open design", exact: true }).click();
      await workspace.getByRole("button", { name: "Choose .orkdes file…" }).click();
      const picker = window.getByRole("dialog", { name: "Open design (.orkdes)", exact: true });
      await expect(picker).toBeVisible();
      await picker.getByLabel("Path", { exact: true }).fill(hostFile);
      await picker.getByLabel("Path", { exact: true }).press("Enter");
      const select = picker.getByRole("button", { name: "Select file", exact: true });
      await expect(select).toBeEnabled();
      await select.click();
      await expect(picker).toHaveCount(0);
      await expect(workspace).toHaveCount(0, { timeout: 30_000 });
      await expect(
        window.frameLocator(`iframe[title="${HOST_FRAME_NAME}"]`).getByRole("heading"),
      ).toHaveText(HOST_MARKER, { timeout: 30_000 });

      const imported = await libraryIds(HOST_DESIGN_NAME);
      expect(imported).toHaveLength(1);
      expect(imported[0]!.id).not.toBe(fixtureId);
      const canvas = await action<DesignCanvas>("get_canvas", { canvasId: imported[0]!.id });
      expect(canvas).toMatchObject({ name: HOST_DESIGN_NAME, environmentId: environment.id });
      expect(canvas.frames.map((candidate) => [candidate.name, candidate.html])).toEqual([
        [HOST_FRAME_NAME, `<h1>${HOST_MARKER}</h1>`],
      ]);
      // The renderer never asked main for an OS file dialog.
      expect(await dialogCalls()).toEqual([]);
    });

    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
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
          if (vite) await stopProcessGroup(vite);
        },
        async () => {
          // Retain the profile if forced termination could not prove the tree stopped.
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped([...owned, ...(vite?.pid ? [-vite.pid] : [])], 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});
