/**
 * Real-stack web annotations in the actual Electron main process.
 *
 * Launches Electron with a disposable agent-test profile under a temporary
 * root (never the user's profile or backend data), serves the synthetic
 * annotation fixture from a real local-environment worktree, and drives the
 * native preview through the production preload API. Selection clicks are
 * delivered by `webContents.sendInputEvent`, so the page runtime sees trusted
 * input exactly as it does from a user; nothing calls page hooks to select.
 *
 * Covers: capture without an agent tab + renderer reload + backend
 * restart persistence; pending spool survival across renderer reload;
 * sensitive-field masking in evidence and pixels; adversarial page strings
 * inert in the compiled brief and forged provenance rejected; pins after
 * hot reload / reorder / duplicate / removal; hash and query route identity
 * with token stripping; no synthetic secret in profile storage or logs;
 * development source hints in a local worktree and, with
 * ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER=1, a container environment.
 *
 * Native window (rendered by the real renderer, not fixed bounds): the Notes
 * column shrinks the view to its host at app zoom 0.8, 1 and 1.25 (150% turns
 * the layout narrow); menus and dialogs hide the view; the narrow
 * Preview/Notes switch; keyboard-only create and send with focus handed to the
 * view and back to the editor. Capture pixels and the selection highlight
 * stay on the target at preview zoom 0.8, 1 and 1.5 and at DPR 1 and 2.
 */
import type { Page, TestInfo } from "@playwright/test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { focusedWebContentsUrls, trackWebContentsFocus } from "./webcontents-focus";
import { expect, test } from "./electron-fixtures";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { _electron as electron } from "playwright";
import type { ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrowserPreviewAnchorResult,
  BrowserPreviewPendingCapture,
  BrowserPreviewPendingCaptureDescriptor,
  BrowserPreviewSelectionStatus,
} from "@orkestrator/protocol/browser-preview";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  WEB_ANNOTATION_COMMANDS as C,
  webAnnotationPageKey,
  type WebAnnotationCaptureInput,
  type WebAnnotationRect,
  type WebAnnotationRequest,
  type WebAnnotationGetResult,
} from "@orkestrator/protocol/web-annotations";

import {
  resolveRuntimeProfile,
  type RuntimeProfile,
} from "../../apps/desktop/electron/runtime-profile";
import { prepareFixtureRepository } from "../../apps/desktop/scripts/dev/fixture";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { longText } from "../../test-fixtures/agent-project/annotation-app/page";
import {
  ADVERSARIAL_SENTINEL,
  FIXTURE_VIEWPORT,
  ROUTE_VARIANTS,
  SYNTHETIC_SECRET_VALUES,
  TEST_IDS,
  briefInertness,
  findSyntheticSecrets,
  resetFixture,
  startFixtureServer,
  type FixtureServer,
} from "./web-annotations-support";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import {
  recordElectronDiagnostics,
  recordProcessOutput,
  withElectronDiagnostics,
} from "./electron-diagnostics";
import { dismissStartupDialogs } from "./electron-startup-dialogs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");
const templateRoot = path.join(repositoryRoot, "test-fixtures", "agent-project");
const TAB_ID = "annotation-preview-tab";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Receipt = { annotationId: string; captureId?: string | null };

interface Stack {
  temporaryRoot: string;
  profile: RuntimeProfile;
  profilePath: string;
  rendererUrl: string;
  vite: ChildProcess;
  app: ElectronApplication;
  window: Page;
  environmentId: string;
  worktreePath: string;
  fixture: FixtureServer;
}

let stack: Stack | null = null;
const outputTails = new WeakMap<ElectronApplication, () => string>();

function s(): Stack {
  if (!stack) throw new Error("Annotation stack is not running");
  return stack;
}

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

/** `switches` are Chromium switches, e.g. `--force-device-scale-factor=2`. */
async function launchElectron(
  current: Pick<Stack, "profile" | "profilePath" | "rendererUrl">,
  switches: string[] = [],
) {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [
      ...ELECTRON_TEST_SWITCHES,
      ...switches,
      path.join(packageRoot, "dist", "electron", "main.js"),
    ],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${path.join(current.profile.dataDir, "probe-bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      ORKESTRATOR_ANNOTATION_CODEX_PROBE: path.join(current.profile.dataDir, "codex-launches"),
      ELECTRON_DEV: "1",
      VITE_DEV_SERVER_URL: current.rendererUrl,
      ORKESTRATOR_RUNTIME_PROFILE_FILE: current.profilePath,
      // Never contend for the fixed control-MCP port an installed app may own.
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    },
  });
  recordElectronDiagnostics(app);
  dismissStartupDialogs(app);
  // Keep a bounded tail of main-process output for startup diagnostics only.
  let tail = "";
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4_000);
  };
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  outputTails.set(app, () => tail);
  const window = await app.firstWindow({ timeout: 90_000 }).catch((error: Error) => {
    const survivors = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(
        (line) => line.includes("dist/electron/main.js") || line.includes("backend/src/main.ts"),
      )
      .map((line) => line.slice(0, 160))
      .join("\n");
    throw new Error(
      `${error.message}\nexitCode=${app.process().exitCode}\nprocesses:\n${survivors}\nElectron output tail:\n${tail}`,
    );
  });
  await expect(window).toHaveTitle(current.profile.electronTitle, { timeout: 60_000 });
  await waitForApi(window);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
  });
  // The launcher selection is empty (nothing to provision or download), and
  // main rewrites it on every start. Enable Codex in the profile's own config
  // so it can be offered as an annotation destination; no agent is started.
  await window.evaluate(async () => {
    const api = (globalThis as any).orkestrator;
    const config = await api.invoke("get_config");
    await api.invoke("update_global_config", {
      global: { ...config.global, enabledAgentPlatforms: ["codex"] },
    });
  });
  return { app, window };
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

/**
 * Every descendant of `root`. `node_modules/.bin/electron` is a Node wrapper
 * that spawns the real binary, so signalling the launched process alone can
 * orphan Electron (and through it the backend) when a quit hangs.
 */
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Close Electron and wait until its supervised children (backend) are gone. */
async function closeElectron(): Promise<void> {
  const app = s().app;
  const electronPid = app.process().pid;
  const children = electronPid ? descendantPids(electronPid) : [];
  const child = app.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  // A normal application quit (menu Quit / Cmd+Q path), then a bounded wait.
  // The evaluate reply can be lost when the process quits under it, so it is
  // bounded rather than awaited outright.
  await Promise.race([
    app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  const quitAt = Date.now();
  const graceful = await Promise.race([
    exited,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  test.info().annotations.push({
    type: "electron-quit-ms",
    description: graceful ? String(Date.now() - quitAt) : "timeout",
  });
  if (!graceful) {
    test.info().annotations.push({
      type: "electron-quit",
      description:
        `app.quit() did not exit within 30s; output tail: ${outputTails.get(app)?.() ?? ""}`.slice(
          0,
          2_000,
        ),
    });
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // The wrapper cannot forward SIGKILL: stop the real Electron tree by pid.
    for (const pid of children.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await closeElectronWithin(app, 10_000);
  await expect.poll(() => children.filter(alive).length, { timeout: 20_000 }).toBe(0);
}

async function waitForApi(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        window
          .evaluate(async () => {
            const api = (globalThis as any).orkestrator;
            if (!api?.invoke) return false;
            await api.invoke("greet", { name: "annotations" });
            return true;
          })
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const invoke: Invoke = (command, args = {}) =>
  s().window.evaluate(
    ({ command, args }) => (globalThis as any).orkestrator.invoke(command, args),
    { command, args },
  );

/** The production preload capture API (`window.orkestrator.browserPreview`). */
function preview<T>(method: string, ...args: unknown[]): Promise<T> {
  return s().window.evaluate(
    ({ method, args }) => {
      const api = (globalThis as any).orkestrator.browserPreview;
      const target = method in api ? api : api.capture;
      return target[method](...args);
    },
    { method, args },
  );
}

/** Evaluate in the preview's own web contents (main world), found from main. */
function inPreview<T>(script: string): Promise<T> {
  return s().app.evaluate(
    async ({ webContents }, { origin, script }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin));
      if (!contents) throw new Error("Fixture preview web contents not found");
      return contents.executeJavaScript(script, true);
    },
    { origin: s().fixture.url, script },
  ) as Promise<T>;
}

/**
 * As `inPreview`, but on the main frame directly: `webContents.executeJavaScript`
 * waits for a loading page to finish, and a late web font holds the load event.
 */
function inPreviewNow<T>(script: string): Promise<T> {
  return s().app.evaluate(
    async ({ webContents }, { origin, script }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin));
      if (!contents) throw new Error("Fixture preview web contents not found");
      return contents.mainFrame.executeJavaScript(script, true);
    },
    { origin: s().fixture.url, script },
  ) as Promise<T>;
}

/** Trusted pointer input, delivered by Chromium like a real click. */
async function trustedClick(x: number, y: number): Promise<void> {
  await s().app.evaluate(
    async ({ webContents }, { origin, x, y }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin));
      if (!contents) throw new Error("Fixture preview web contents not found");
      const point = { x: Math.round(x), y: Math.round(y) };
      contents.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 60));
      contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    },
    { origin: s().fixture.url, x, y },
  );
}

async function rectOf(
  selector: string,
  index = 0,
  run: typeof inPreview = inPreview,
): Promise<WebAnnotationRect | null> {
  return run(
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
}

/**
 * Scroll an element into the middle of the viewport and return its rect once
 * layout has settled: two consecutive reads agree and the element is inside
 * the viewport. Late layout (embedded frames, custom elements) can otherwise
 * move it between measuring and the trusted input that targets it.
 */
async function settledRect(
  selector: string,
  index = 0,
  block: "center" | "start" = "center",
): Promise<WebAnnotationRect> {
  await inPreview(
    `document.querySelectorAll(${JSON.stringify(selector)})[${index}].scrollIntoView({ block: ${JSON.stringify(block)}, behavior: "instant" }); true`,
  );
  let previous: WebAnnotationRect | null = null;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = await inPreview<{ rect: WebAnnotationRect | null; innerHeight: number }>(
      `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; const r = el && el.getBoundingClientRect(); return { rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null, innerHeight: window.innerHeight }; })()`,
    );
    const current = probe.rect;
    const same = current !== null && JSON.stringify(current) === JSON.stringify(previous);
    const visible =
      current !== null &&
      current.y >= -2 &&
      current.y + Math.min(current.height, 40) <= probe.innerHeight + 2;
    if (same && visible) return current;
    if (Date.now() > deadline) {
      throw new Error(
        `${selector} did not settle in the viewport: ${JSON.stringify(probe)} previous=${JSON.stringify(previous)}`,
      );
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function attachPreview(route: string): Promise<void> {
  await preview("attach", {
    tabId: TAB_ID,
    url: `${s().fixture.url}${route}`,
    bounds: { x: 0, y: 0, ...FIXTURE_VIEWPORT },
    visible: true,
  });
  await waitForFixturePage(route);
}

async function navigate(route: string): Promise<void> {
  await preview("navigate", TAB_ID, `${s().fixture.url}${route}`);
  await waitForFixturePage(route);
}

/**
 * The fixture's page script ran, without waiting for the load event: a late
 * web font holds `document.readyState` short of `complete` until it settles.
 */
async function waitForFixtureScript(pathname: string): Promise<void> {
  await expect
    .poll(
      () =>
        inPreviewNow<boolean>(
          `Boolean(window.__annotationFixture) && location.pathname === ${JSON.stringify(pathname)}`,
        ).catch(() => false),
      { timeout: 20_000, intervals: [50] },
    )
    .toBe(true);
}

/**
 * Reload in the page and wait only for the new document's script. The
 * preview's own `reload` resolves after the load event, which a late font holds.
 */
async function reloadFixtureScript(pathname: string): Promise<void> {
  await inPreview("window.__previousDocument = true; setTimeout(() => location.reload(), 0); true");
  await expect
    .poll(() => inPreviewNow<boolean>("window.__previousDocument !== true").catch(() => false), {
      timeout: 20_000,
      intervals: [50],
    })
    .toBe(true);
  await waitForFixtureScript(pathname);
}

async function waitForFixturePage(route: string): Promise<void> {
  const expected = new URL(route, s().fixture.url);
  await expect
    .poll(
      () =>
        inPreview<boolean>(
          `document.readyState === "complete" && Boolean(window.__annotationFixture) && location.pathname + location.search === ${JSON.stringify(expected.pathname + expected.search)}`,
        ).catch(() => false),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** `zoom` is the preview's page zoom: input events take DIPs, rects are CSS px. */
async function captureElement(selector: string, index = 0, zoom = 1, tabId = TAB_ID) {
  const rect = await settledRect(selector, index);
  const started = await preview<BrowserPreviewSelectionStatus>("startCapture", {
    tabId,
    mode: "element",
    environmentId: s().environmentId,
  });
  expect(started.status).toBe("selecting");
  const selectedAt = Date.now();
  await trustedClick((rect.x + rect.width / 2) * zoom, (rect.y + rect.height / 2) * zoom);
  const status = await awaitCaptureEnd(tabId);
  if (status.status !== "captured") throw new Error(`Capture failed: ${JSON.stringify(status)}`);
  clientTimings.selectionToSpool.push(Date.now() - selectedAt);
  return { descriptor: status.pending, rect: rect };
}

/** Client-side latency, recorded per capture for the baseline test. */
const clientTimings = { selectionToSpool: [] as number[], spoolToSaved: [] as number[] };

/** Poll capture status tightly (25 ms) so the end is timed, not the poll interval. */
async function awaitCaptureEnd(tabId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await preview<BrowserPreviewSelectionStatus>("getCaptureStatus", tabId);
    if (status.status === "captured" || status.status === "error") return status;
    if (Date.now() > deadline) throw new Error(`Capture did not end: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readPending(captureId: string): Promise<BrowserPreviewPendingCapture> {
  const record = await preview<BrowserPreviewPendingCapture | null>(
    "readPendingCapture",
    captureId,
  );
  expect(record).not.toBeNull();
  return record!;
}

/** The renderer's acknowledged transfer: receipt check, asset stage, create, ack. */
async function saveCapture(captureId: string, body: string): Promise<Receipt> {
  const environmentId = s().environmentId;
  const startedAt = Date.now();
  const record = await readPending(captureId);
  const operationId = `create-${captureId}`;
  const existing = await invoke<{ receipt: Receipt | null }>(C.receipt, {
    environmentId,
    operationId,
  });
  let receipt = existing.receipt;
  if (!receipt) {
    const assetIds: string[] = [];
    if (record.imageDataUrl) {
      const staged = await invoke<{ asset: { id: string } }>(C.assetStage, {
        environmentId,
        operationId: `asset-${captureId}`,
        mediaType: "image/png",
        data: record.imageDataUrl.slice(record.imageDataUrl.indexOf(",") + 1),
      });
      assetIds.push(staged.asset.id);
    }
    receipt = await invoke<Receipt>(C.create, {
      environmentId,
      operationId,
      capture: { ...record.capture, assetIds },
      body,
    });
    clientTimings.spoolToSaved.push(Date.now() - startedAt);
  }
  await preview("acknowledgePendingCapture", {
    captureId,
    annotationId: receipt.annotationId,
    backendCaptureId: receipt.captureId ?? "",
  });
  return receipt;
}

async function listAnnotations(filter: Record<string, unknown> = {}) {
  return invoke<{ items: Array<{ id: string; page: { route: string }; latestIntent: string }> }>(
    C.list,
    { environmentId: s().environmentId, filter: { state: "all", ...filter }, limit: 50 },
  );
}

async function getAnnotation(annotationId: string) {
  return invoke<{
    annotation: { id: string; currentCaptureId: string; contentRevision: number; page: unknown };
  }>(C.get, { environmentId: s().environmentId, annotationId });
}

async function captureRecord(captureId: string) {
  return (
    await invoke<{ capture: WebAnnotationCaptureInput & { id: string } }>(C.capture, {
      environmentId: s().environmentId,
      captureId,
    })
  ).capture;
}

/** Fraction of pixels in the inner part of `rect` equal to the most common pixel. */
async function uniformity(dataUrl: string, rect: WebAnnotationRect, scale: number) {
  return s().app.evaluate(
    ({ nativeImage }, { dataUrl, rect, scale }) => {
      const image = nativeImage.createFromDataURL(dataUrl);
      const inset = 0.2;
      const crop = {
        x: Math.round((rect.x + rect.width * inset) * scale),
        y: Math.round((rect.y + rect.height * inset) * scale),
        width: Math.max(1, Math.round(rect.width * (1 - 2 * inset) * scale)),
        height: Math.max(1, Math.round(rect.height * (1 - 2 * inset) * scale)),
      };
      const bitmap = image.crop(crop).toBitmap();
      const counts = new Map<number, number>();
      for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
        const pixel = bitmap.readUInt32LE(offset);
        counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
      }
      const total = bitmap.length / 4;
      return total > 0 ? Math.max(...counts.values()) / total : 0;
    },
    { dataUrl, rect, scale },
  );
}

function record(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const testInfo = test.info();
  testInfo.setTimeout(300_000);
  // Bundle exactly as production and the dev launcher do. A `tsc` emit leaves
  // workspace imports pointing at raw `.ts` sources Electron cannot run.
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-annotations-"));
  const [rendererPort, gatewayPort, fixturePort] = (await reserveLoopbackPorts(3)) as [
    number,
    number,
    number,
  ];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "annotation-smoke",
    flavor: "agent-test",
    credentialSources: ["claude"],
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  // Refuse and record any accidental provider launch, including after cleanup
  // and across relaunches of this persisted profile. No real Codex can run.
  const probeBin = path.join(profile.dataDir, "probe-bin");
  await mkdir(probeBin, { recursive: true });
  await writeFile(path.join(profile.dataDir, "codex-launches"), "");
  await writeFile(
    path.join(probeBin, "codex"),
    `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.158.0'; exit 0 ;;
  app-server|exec) printf 'provider-launch\n' >> "$ORKESTRATOR_ANNOTATION_CODEX_PROBE" ;;
esac
exit 91
`,
    { mode: 0o700 },
  );
  // Enable only the isolated onboarding read and seed its empty marker. This
  // fixture copies no host credentials and runs no Claude turns.
  const isolatedHome = path.join(profile.dataDir, "agent-credentials", "home");
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(isolatedHome, ".claude.json"), "{}", { mode: 0o600 });
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn("bun", ["run", "dev"], {
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
  const partial = { temporaryRoot, profile, profilePath, rendererUrl, vite } as Stack;
  stack = partial;
  await waitForUrl(rendererUrl);
  const { app, window } = await withElectronDiagnostics(() => launchElectron(partial));
  partial.app = app;
  partial.window = window;

  const projectPath = await prepareFixtureRepository(profile, templateRoot);
  // Compile the documentation's emitter before creating environments, so both
  // local and container workspaces contain the source the real capture names.
  const emitted = spawnSync(
    "bun",
    [path.join(packageRoot, "tests/source-hint-emitter-fixture.ts"), projectPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(emitted.status, `${emitted.stdout}\n${emitted.stderr}`).toBe(0);
  for (const args of [
    ["add", "annotation-app", "orkestrator-source-babel-plugin.mjs"],
    [
      "-c",
      "user.name=Annotation Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Compile documented source hints for native capture",
    ],
    ["push", "origin", "HEAD"],
  ]) {
    const result = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }
  const project = await invoke<{ id: string }>("add_project", {
    gitUrl: path.join(profile.fixtureDir, "origin.git"),
    localPath: projectPath,
  });
  const environment = await invoke<{ id: string }>("create_environment", {
    projectId: project.id,
    name: "annotation-fixture",
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  await invoke("start_environment", { environmentId: environment.id });
  const hydrated = await invoke<{ worktreePath: string | null }>("get_environment", {
    environmentId: environment.id,
  });
  expect(hydrated.worktreePath).toBeTruthy();
  partial.environmentId = environment.id;
  partial.worktreePath = hydrated.worktreePath!;
  // Served from the environment worktree: a source edit there is what renders.
  partial.fixture = await startFixtureServer(partial.worktreePath, fixturePort);
  await attachPreview(ROUTE_VARIANTS.settings);
});

test.afterAll(async () => {
  const testInfo = test.info();
  testInfo.setTimeout(90_000);
  const current = stack;
  if (!current) return;
  let running = false;
  try {
    const child = current.app?.process();
    running = Boolean(child) && child.exitCode === null && child.signalCode === null;
  } catch {
    // Playwright throws once the application has been closed.
  }
  if (running) await closeElectron().catch(() => undefined);
  const launches = await readFile(
    path.join(current.profile.dataDir, "codex-launches"),
    "utf8",
  ).catch(() => "probe-unreadable");
  stack = null;
  await current.fixture?.stop().catch(() => undefined);
  if (current.vite) await stopProcessGroup(current.vite).catch(() => undefined);
  await rm(current.temporaryRoot, { recursive: true, force: true });
  expect(launches, "no Codex session/prompt launch through cleanup or relaunch").toBe("");
});

test.beforeEach(async () => {
  if (stack?.fixture) await resetFixture(stack.fixture);
});

test("Home native preview hides beneath board panels and returns without losing its tab", async () => {
  const environment = await invoke<{ projectId: string }>("get_environment", {
    environmentId: s().environmentId,
  });
  const home = await invoke<{ id: string }>("ensure_project_home_environment", {
    projectId: environment.projectId,
  });
  const tabId = "home-visibility-preview";
  await invoke("save_pane_layout", {
    environmentId: home.id,
    expectedRevision: 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "home-preview-pane",
      root: {
        kind: "leaf",
        id: "home-preview-pane",
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            type: "browser",
            browserData: { url: `${s().fixture.url}${ROUTE_VARIANTS.settings}` },
          },
        ],
      },
    },
  });
  await preview("destroy", TAB_ID);
  try {
    const projects = await invoke<Array<{ id: string; name: string }>>("get_projects");
    const project = projects.find((candidate) => candidate.id === environment.projectId)!;
    const projectRow = s()
      .window.getByRole("button", { name: new RegExp(`^${project.name}`) })
      .first();
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    await projectRow.click();
    await s().window.getByRole("tab", { name: "Home", exact: true }).click();
    await expect(s().window.getByRole("textbox", { name: "Browser address" })).toBeVisible();
    // A startup dialog can reopen after the renderer reload below, and it
    // correctly hides the view. Its handler (`dismissStartupDialogs`) runs
    // only before a locator action or assertion, never during this
    // main-process poll, so give it one on every read (flake 0272).
    const visiblePreview = async () => {
      await expect(s().window.getByRole("dialog"))
        .toHaveCount(0, { timeout: 1_000 })
        .catch(() => undefined);
      return s().app.evaluate(({ BrowserWindow }, origin) => {
        const host = BrowserWindow.getAllWindows()[0];
        return (
          host?.contentView.children.some((view) => {
            const child = view as unknown as {
              getVisible(): boolean;
              webContents?: { getURL(): string };
            };
            return child.webContents?.getURL().startsWith(origin) && child.getVisible();
          }) ?? false
        );
      }, s().fixture.url);
    };
    await expect.poll(visiblePreview, { timeout: 30_000 }).toBe(true);
    for (const board of ["Kanban", "Coordinator"]) {
      await s().window.getByRole("tab", { name: board, exact: true }).click();
      await expect.poll(visiblePreview).toBe(false);
      await s().window.getByRole("tab", { name: "Home", exact: true }).click();
      await expect.poll(visiblePreview).toBe(true);
    }
    await s().window.reload();
    await waitForApi(s().window);
    await s().window.evaluate(
      async ({ projectId, homeId }) => {
        const modulePath = "/src/stores/uiStore.ts";
        const { useUIStore } = await import(modulePath);
        useUIStore.getState().selectProjectAndEnvironment(projectId, homeId);
        useUIStore.getState().setProjectBoardTab("home");
      },
      { projectId: environment.projectId, homeId: home.id },
    );
    await expect.poll(visiblePreview, { timeout: 30_000 }).toBe(true);
    await s().window.getByRole("tab", { name: "Kanban", exact: true }).click();
    await expect.poll(visiblePreview).toBe(false);
  } finally {
    await s().window.evaluate(async () => {
      const modulePath = "/src/stores/uiStore.ts";
      const { useUIStore } = await import(modulePath);
      useUIStore.getState().selectProject(null);
    });
    await preview("destroy", tabId).catch(() => undefined);
    await invoke("delete_environment", { environmentId: home.id });
    await attachPreview(ROUTE_VARIANTS.settings);
  }
});

test("a capture saved without any agent tab survives renderer reload and backend restart", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  const destinations = await invoke<{ options: unknown[] }>(C.destinations, {
    environmentId: s().environmentId,
  });
  expect(destinations.options).toEqual([]);

  await navigate(ROUTE_VARIANTS.settings);
  const { descriptor } = await captureElement(`[data-testid="${TEST_IDS.saveSettings}"]`);
  // captureElement scrolls the selected button into view. Measure fields at
  // that scroll offset, rather than comparing pixels to pre-scroll rectangles.
  const passwordRect = await rectOf(`[data-testid="${TEST_IDS.passwordField}"]`);
  const displayNameRect = await rectOf("#display-name");
  expect(descriptor.stale).toBe(false);
  expect(descriptor.environmentId).toBe(s().environmentId);

  const pending = await readPending(descriptor.captureId);
  const serialized = JSON.stringify(pending.capture);
  for (const secret of SYNTHETIC_SECRET_VALUES) expect(serialized.includes(secret)).toBe(false);
  expect(pending.capture.target.kind).toBe("element");
  expect(pending.capture.page.service).toEqual({ kind: "port", port: s().fixture.port });
  expect(pending.capture.page.route).toBe(ROUTE_VARIANTS.settings);

  // Sensitive fields are masked in the image, not only in the text evidence.
  expect(pending.capture.redaction.sensitiveRegionsMasked).toBeGreaterThanOrEqual(1);
  if (pending.imageDataUrl) {
    const geometry = pending.capture.geometry!;
    const scale = geometry.image?.scale ?? 1;
    const masked = await uniformity(pending.imageDataUrl, passwordRect!, scale);
    const unmasked = await uniformity(pending.imageDataUrl, displayNameRect!, scale);
    await testInfo.attach("masked-capture.png", {
      body: Buffer.from(pending.imageDataUrl.split(",")[1]!, "base64"),
      contentType: "image/png",
    });
    record(testInfo, "mask-geometry", JSON.stringify({ geometry, passwordRect, displayNameRect }));
    record(
      testInfo,
      "mask-uniformity",
      `password=${masked.toFixed(3)} displayName=${unmasked.toFixed(3)}`,
    );
    expect(masked).toBeGreaterThan(0.98);
    expect(unmasked).toBeLessThan(masked);
  } else {
    expect(pending.capture.redaction.imageExcluded).toBe(true);
    record(testInfo, "mask-uniformity", "image excluded by main (masking unavailable)");
  }

  // The renderer can unmount before saving: the main-process spool keeps it.
  await s().window.reload();
  await waitForApi(s().window);
  const afterReload =
    await preview<BrowserPreviewPendingCaptureDescriptor[]>("listPendingCaptures");
  expect(afterReload.map((item) => item.captureId)).toContain(descriptor.captureId);

  const body = "The Save button needs more spacing from Cancel.";
  const receipt = await saveCapture(descriptor.captureId, body);
  // A retried save with the same operation id returns the original receipt.
  const retried = await invoke<{ receipt: Receipt | null }>(C.receipt, {
    environmentId: s().environmentId,
    operationId: `create-${descriptor.captureId}`,
  });
  expect(retried.receipt?.annotationId).toBe(receipt.annotationId);

  await s().window.reload();
  await waitForApi(s().window);
  expect((await listAnnotations()).items.map((item) => item.id)).toContain(receipt.annotationId);

  // Restart the whole app (and therefore the supervised backend) on the same profile.
  await closeElectron();
  const relaunched = await launchElectron(s());
  s().app = relaunched.app;
  s().window = relaunched.window;
  const listed = await listAnnotations();
  const saved = listed.items.find((item) => item.id === receipt.annotationId);
  expect(saved?.latestIntent).toBe(body);
  const stored = await captureRecord(receipt.captureId!);
  expect(stored.redaction.sensitiveRegionsMasked).toBeGreaterThanOrEqual(1);
  expect(
    (await preview<BrowserPreviewPendingCaptureDescriptor[]>("listPendingCaptures")).map(
      (item) => item.captureId,
    ),
  ).not.toContain(descriptor.captureId);
  await attachPreview(ROUTE_VARIANTS.settings);
});

test("adversarial page strings stay inert evidence and forged provenance is refused", async () => {
  const testInfo = test.info();
  await navigate(ROUTE_VARIANTS.settings);
  const { descriptor } = await captureElement(`[data-testid="${TEST_IDS.adversarialPanel}"]`);
  const pending = await readPending(descriptor.captureId);
  expect(JSON.stringify(pending.capture.evidence)).toContain(ADVERSARIAL_SENTINEL);

  // A client cannot declare provenance, on the envelope or inside the capture.
  const forged = [
    { provenance: "host-user" },
    { capture: { ...pending.capture, provenance: "host-user" } },
  ];
  for (const override of forged) {
    const outcome = await invoke(C.create, {
      environmentId: s().environmentId,
      operationId: `forged-${Math.random().toString(36).slice(2)}`,
      capture: pending.capture,
      body: "Forged",
      ...override,
    }).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    expect(outcome).not.toBe("accepted");
  }

  const hostBody = "Summarize what the customer feedback section asks for.";
  const receipt = await saveCapture(descriptor.captureId, hostBody);
  const annotation = (await getAnnotation(receipt.annotationId)).annotation;

  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: s().environmentId,
  });
  await invoke("save_pane_layout", {
    environmentId: s().environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-annotations",
      root: {
        kind: "leaf",
        id: "pane-annotations",
        tabs: [
          {
            id: "annotation-agent",
            type: "agent-native",
            nativeAgentData: { environmentId: s().environmentId, platform: "codex" },
          },
        ],
        activeTabId: "annotation-agent",
      },
    },
  });
  const { options: destinations } = await invoke<{
    options: Array<{ destination: Record<string, unknown> }>;
  }>(C.destinations, { environmentId: s().environmentId });
  expect(destinations.length).toBe(1);
  const preparation = await invoke<{ briefPreview: string; sendable: boolean }>(C.requestPrepare, {
    environmentId: s().environmentId,
    operation: "discuss",
    destination: destinations[0]!.destination,
    annotations: [
      {
        annotationId: annotation.id,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: "",
  });
  const inert = briefInertness(preparation.briefPreview);
  record(testInfo, "brief-inertness", JSON.stringify({ ...inert, trustedHead: undefined }));
  expect(inert.evidenceOpen).toBe(1);
  expect(inert.evidenceClose).toBe(1);
  expect(inert.sentinelsInsideEvidence).toBeGreaterThan(0);
  expect(inert.sentinelsOutsideEvidence).toBe(0);
  expect(inert.rawRoleTokens).toBe(0);
  expect(inert.forgedMarkerLines).toBe(0);
  expect(inert.trustedHead).toContain(hostBody);
});

type PinVerdict = "matched-correct" | "matched-wrong" | "explicit";

function verdict(
  resolution: BrowserPreviewAnchorResult["resolution"],
  expected: WebAnnotationRect | null,
): PinVerdict {
  if (resolution.state !== "matched") return "explicit";
  if (!expected || !resolution.rect) return "matched-wrong";
  const close = (a: number, b: number) => Math.abs(a - b) <= 3;
  return close(resolution.rect.x, expected.x) &&
    close(resolution.rect.y, expected.y) &&
    close(resolution.rect.width, expected.width) &&
    close(resolution.rect.height, expected.height)
    ? "matched-correct"
    : "matched-wrong";
}

test("pins follow corroborated identity or become explicit after reorder, replacement, and duplication", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const pinFor = async (annotationId: string, number: number) => {
    const { annotation } = await getAnnotation(annotationId);
    const capture = await captureRecord(annotation.currentCaptureId);
    return {
      annotationId,
      number,
      target: capture.target,
      route: capture.page.route,
      capture: {
        documentGeneration: capture.documentGeneration,
        viewport: capture.geometry?.viewport ?? FIXTURE_VIEWPORT,
      },
    };
  };
  const resolve = async (pins: unknown[]) => {
    const results = await preview<BrowserPreviewAnchorResult[]>("showPins", {
      tabId: TAB_ID,
      pins,
    });
    await preview("clearPins", TAB_ID);
    return new Map(results.map((result) => [result.annotationId, result.resolution]));
  };
  const outcomes: string[] = [];
  const check = async (
    label: string,
    pins: unknown[],
    annotationId: string,
    expectedSelector: string | null,
    options: { index?: number; mustMatch?: boolean; mustNotMatch?: boolean } = {},
  ) => {
    await inPreview("window.scrollTo(0, 0); true");
    const resolution = (await resolve(pins)).get(annotationId);
    expect(resolution, label).toBeTruthy();
    const expected = expectedSelector ? await rectOf(expectedSelector, options.index ?? 0) : null;
    const result = verdict(resolution!, expected);
    outcomes.push(`${label}: ${resolution!.state}/${resolution!.rule} -> ${result}`);
    expect(result, label).not.toBe("matched-wrong");
    if (options.mustMatch) expect(result, label).toBe("matched-correct");
    if (options.mustNotMatch) expect(resolution!.state, label).not.toBe("matched");
  };

  // Pricing: a card with a stable test id.
  await navigate(ROUTE_VARIANTS.pricing);
  const teamSelector = `[data-testid="${TEST_IDS.teamCta}"]`;
  const team = await captureElement(teamSelector);
  const teamReceipt = await saveCapture(team.descriptor.captureId, "Team CTA label");
  const teamPins = [await pinFor(teamReceipt.annotationId, 1)];
  await check("team baseline", teamPins, teamReceipt.annotationId, teamSelector, {
    mustMatch: true,
  });
  await inPreview("window.__annotationFixture.reorderCards()");
  await check("team after card reorder", teamPins, teamReceipt.annotationId, teamSelector);
  await inPreview("window.__annotationFixture.hotReload()");
  await check("team after hot reload", teamPins, teamReceipt.annotationId, teamSelector);
  await inPreview("window.__annotationFixture.duplicateTeamCard()");
  await check("team with duplicate card", teamPins, teamReceipt.annotationId, teamSelector);
  await inPreview("window.__annotationFixture.removeTeamCard()");
  await check("team removed", teamPins, teamReceipt.annotationId, null, { mustNotMatch: true });

  // Settings: identical "Enable" buttons that only their row label tells apart.
  await navigate(ROUTE_VARIANTS.settings);
  const auditRow = `[data-testid="${TEST_IDS.featureList}"] li:nth-child(2) button`;
  const audit = await captureElement(auditRow);
  const auditReceipt = await saveCapture(audit.descriptor.captureId, "Audit log toggle");
  const auditPins = [await pinFor(auditReceipt.annotationId, 2)];
  await check("audit baseline", auditPins, auditReceipt.annotationId, auditRow, {
    mustMatch: true,
  });
  await inPreview("window.__annotationFixture.reorderFeatures()");
  // After reversing five rows the Audit log row is 4th; the 2nd row is now "Usage alerts".
  await check(
    "audit after row reorder",
    auditPins,
    auditReceipt.annotationId,
    `[data-testid="${TEST_IDS.featureList}"] li:nth-child(4) button`,
  );
  await inPreview("window.__annotationFixture.replaceSaveButton()");
  record(testInfo, "pin-outcomes", outcomes.join("; "));
});

test("hash and query variants keep distinct identities and token parameters are stripped", async () => {
  const testInfo = test.info();
  const teamSelector = `[data-testid="${TEST_IDS.teamCta}"]`;
  await navigate(ROUTE_VARIANTS.pricingTeamAnnual);
  const annual = await captureElement(teamSelector);
  const annualRecord = await readPending(annual.descriptor.captureId);
  expect(annualRecord.capture.page.route).toBe(ROUTE_VARIANTS.pricingTeamAnnual);
  const annualReceipt = await saveCapture(annual.descriptor.captureId, "Annual Team CTA");

  await navigate(ROUTE_VARIANTS.pricingStarterMonthly);
  const starter = await captureElement(`[data-testid="plan-cta-starter"]`);
  const starterRecord = await readPending(starter.descriptor.captureId);
  expect(starterRecord.capture.page.route).toBe(ROUTE_VARIANTS.pricingStarterMonthly);
  const starterReceipt = await saveCapture(starter.descriptor.captureId, "Starter CTA");

  const annualKey = webAnnotationPageKey(annualRecord.capture.page);
  const starterKey = webAnnotationPageKey(starterRecord.capture.page);
  expect(annualKey).not.toBe(starterKey);
  const filtered = (await listAnnotations({ pageKey: annualKey })).items.map((item) => item.id);
  expect(filtered).toContain(annualReceipt.annotationId);
  expect(filtered).not.toContain(starterReceipt.annotationId);

  // The annual note's pin must not claim a match on the starter route.
  const { annotation } = await getAnnotation(annualReceipt.annotationId);
  const capture = await captureRecord(annotation.currentCaptureId);
  const results = await preview<BrowserPreviewAnchorResult[]>("showPins", {
    tabId: TAB_ID,
    pins: [
      {
        annotationId: annotation.id,
        number: 1,
        target: capture.target,
        route: capture.page.route,
        capture: { documentGeneration: capture.documentGeneration, viewport: FIXTURE_VIEWPORT },
      },
    ],
  });
  await preview("clearPins", TAB_ID);
  record(
    testInfo,
    "cross-route-pin",
    `${results[0]?.resolution.state}/${results[0]?.resolution.rule}`,
  );
  expect(results[0]?.resolution.state).not.toBe("matched");

  await navigate(ROUTE_VARIANTS.tokenBearingSettings);
  const token = await captureElement(`[data-testid="${TEST_IDS.saveSettings}"]`);
  const tokenRecord = await readPending(token.descriptor.captureId);
  expect(tokenRecord.capture.page.route).toBe("/settings?tab=profile");
  expect(tokenRecord.capture.page.requiresNavigation).toBe(true);
  expect(tokenRecord.capture.redaction.urlParametersRemoved).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(tokenRecord)).not.toContain(
    ROUTE_VARIANTS.tokenBearingSettings.split("token=")[1]!,
  );
  await saveCapture(token.descriptor.captureId, "Save on the profile tab");

  await navigate(ROUTE_VARIANTS.hashSettingsBilling);
  const hash = await captureElement("[data-hash-view]");
  const hashRecord = await readPending(hash.descriptor.captureId);
  expect(hashRecord.capture.page.route).toBe(ROUTE_VARIANTS.hashSettingsBilling);
  await preview("discardPendingCapture", hash.descriptor.captureId);
});

/** Raw trusted input for drags and keys; `mouseMove` carries the pressed button. */
async function trustedInput(events: Array<Record<string, unknown>>): Promise<void> {
  await s().app.evaluate(
    async ({ webContents }, { origin, events }) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin));
      if (!contents) throw new Error("Fixture preview web contents not found");
      for (const event of events) {
        contents.sendInputEvent(event as unknown as Electron.KeyboardInputEvent);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    },
    { origin: s().fixture.url, events },
  );
}

async function awaitCaptured(): Promise<BrowserPreviewPendingCaptureDescriptor> {
  let status = { status: "inactive" } as BrowserPreviewSelectionStatus;
  await expect
    .poll(
      async () => {
        status = await preview<BrowserPreviewSelectionStatus>("getCaptureStatus", TAB_ID);
        return status.status;
      },
      { timeout: 20_000 },
    )
    .toMatch(/^(captured|error)$/);
  if (status.status !== "captured") throw new Error(`Capture failed: ${JSON.stringify(status)}`);
  return status.pending;
}

function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  const at = (point: { x: number; y: number }) => ({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return [
    { type: "mouseMove", ...at(from) },
    { type: "mouseDown", ...at(from), button: "left", clickCount: 1 },
    { type: "mouseMove", ...at(middle), modifiers: ["leftButtonDown"] },
    { type: "mouseMove", ...at(to), modifiers: ["leftButtonDown"] },
    { type: "mouseUp", ...at(to), button: "left", clickCount: 1 },
  ];
}

test("text, region, and page modes capture end to end; embedded roots resolve to their host", async () => {
  const testInfo = test.info();
  await navigate(ROUTE_VARIANTS.pricing);
  const start = (mode: string) =>
    preview<BrowserPreviewSelectionStatus>("startCapture", {
      tabId: TAB_ID,
      mode,
      environmentId: s().environmentId,
    });

  // The selected text's immediate parent has no box of its own.
  await inPreview(
    `(() => { const paragraph = document.querySelector('[data-testid="long-text"]'); const span = document.createElement("span"); span.style.display = "contents"; span.append(...paragraph.childNodes); paragraph.append(span); return true; })()`,
  );
  // Text: a native drag selection inside the long paragraph. It is taller
  // than the viewport, so align its top and drag along a line in the middle
  // of the viewport, clear of the capture hint and the edges.
  expect((await start("text")).status).toBe("selecting");
  const paragraph = await settledRect('[data-testid="long-text"]', 0, "start");
  const lineY = paragraph.y + Math.min(300, paragraph.height / 2);
  await trustedInput(
    drag(
      { x: paragraph.x + 4, y: lineY },
      { x: paragraph.x + Math.min(400, paragraph.width - 8), y: lineY },
    ),
  );
  const text = await readPending((await awaitCaptured()).captureId);
  expect(text.capture.target.kind).toBe("text-range");
  if (text.capture.target.kind === "text-range") {
    const quote = text.capture.target.quote.exact.trim();
    record(testInfo, "text-quote-chars", String(quote.length));
    expect(quote.length).toBeGreaterThan(10);
    // Exactly the page's own long text: nothing from neighbouring regions.
    expect(longText().includes(quote)).toBe(true);
  }
  const textNote = await saveCapture(text.descriptor.captureId, "Tighten this clause.");
  const textPin = await pinQuery(textNote.annotationId);
  await preview("showPins", { tabId: TAB_ID, pins: [textPin] });
  expect(
    await inPreview<string>(
      `document.querySelector("[data-orkestrator-pins] [role='img']").style.display`,
    ),
  ).toBe("block");
  // A range in a non-rendered subtree must still disappear.
  await inPreview(
    `document.querySelector('[data-testid="long-text"]').style.display = "none"; window.dispatchEvent(new Event("resize")); true`,
  );
  await expect
    .poll(() =>
      inPreview<string>(
        `document.querySelector("[data-orkestrator-pins] [role='img']").style.display`,
      ),
    )
    .toBe("none");
  await preview("clearPins", TAB_ID);
  await inPreview(`document.querySelector('[data-testid="long-text"]').style.display = ""; true`);

  // Region over the canvas chart; confirmed with Enter.
  expect((await start("region")).status).toBe("selecting");
  const canvas = await settledRect('[data-testid="usage-chart"]');
  await trustedInput([
    ...drag(
      { x: canvas.x, y: canvas.y },
      { x: canvas.x + canvas.width, y: canvas.y + canvas.height },
    ),
    { type: "keyDown", keyCode: "Enter" },
    { type: "keyUp", keyCode: "Enter" },
  ]);
  const region = await readPending((await awaitCaptured()).captureId);
  expect(region.capture.target.kind).toBe("region");
  if (region.capture.target.kind === "region") {
    expect(Math.abs(region.capture.target.rect.width - canvas.width)).toBeLessThanOrEqual(3);
    expect(Math.abs(region.capture.target.rect.height - canvas.height)).toBeLessThanOrEqual(3);
  }
  expect(region.imageDataUrl ?? region.capture.redaction.imageExcluded).toBeTruthy();
  await saveCapture(region.descriptor.captureId, "Label the chart axes.");

  // Page mode completes without any selection gesture.
  const page = await start("page");
  if (page.status !== "captured") await awaitCaptured();
  const pageStatus = await preview<BrowserPreviewSelectionStatus>("getCaptureStatus", TAB_ID);
  expect(pageStatus.status).toBe("captured");
  if (pageStatus.status === "captured") {
    const whole = await readPending(pageStatus.pending.captureId);
    expect(whole.capture.target.kind).toBe("page");
    await preview("discardPendingCapture", pageStatus.pending.captureId);
  }

  // Element clicks on an iframe and a shadow-root button select their host
  // element in the top document (inner roots are documented as unsupported).
  const hosts: string[] = [];
  for (const selector of ['[data-testid="billing-iframe"]', '[data-testid="shadow-card"]']) {
    const { descriptor } = await captureElement(selector);
    const pending = await readPending(descriptor.captureId);
    expect(pending.capture.target.kind).toBe("element");
    if (pending.capture.target.kind === "element") {
      const tag = pending.capture.target.anchor.semantic.tagName.toLowerCase();
      hosts.push(`${selector} -> ${tag} (${pending.capture.target.anchor.scope.kind})`);
      expect(["iframe", "fixture-shadow-card"]).toContain(tag);
    }
    await preview("discardPendingCapture", descriptor.captureId);
  }
  record(testInfo, "embedded-hosts", hosts.join("; "));
});

// ---------------------------------------------------------------------------
// The real Notes column beside the native view, keyboard flow, zoom and DPR.

const UI_TAB_ID = "annotation-ui-preview";
const MARKER_ID = "annotation-alignment-marker";

/** A rect in window DIPs (or image pixels, where named). */
type DipRect = WebAnnotationRect;

/** The fixture's native view as main holds it: bounds in window DIPs. */
function nativePreviewView(): Promise<{ bounds: DipRect; visible: boolean } | null> {
  return s().app.evaluate(({ BrowserWindow }, origin) => {
    const host = BrowserWindow.getAllWindows()[0];
    for (const view of host?.contentView.children ?? []) {
      const child = view as unknown as {
        getBounds(): DipRect;
        getVisible(): boolean;
        webContents?: { getURL(): string };
      };
      if (child.webContents?.getURL().startsWith(origin)) {
        return { bounds: child.getBounds(), visible: child.getVisible() };
      }
    }
    return null;
  }, s().fixture.url);
}

/** Renderer rects scaled to window DIPs by the host's native zoom factor. */
async function rendererLayout(selectors: Record<string, string>) {
  const zoom = await s().app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
  );
  const css = await s().window.evaluate((selectors) => {
    const out: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      out[name] =
        rect && rect.width > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
    }
    return out;
  }, selectors);
  const dip: Record<string, DipRect | null> = {};
  for (const [name, rect] of Object.entries(css)) {
    dip[name] = rect
      ? { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom }
      : null;
  }
  return { zoom, dip };
}

const PREVIEW_HOST = `[data-native-browser-preview="${UI_TAB_ID}"]`;
const NOTES_PANEL = `[data-annotation-panel="${UI_TAB_ID}"]`;

/** The native view sits on the renderer's preview host, within whole-DIP rounding. */
async function expectViewOnHost(testInfo: TestInfo, label: string): Promise<DipRect> {
  let last: unknown = null;
  await expect
    .poll(
      async () => {
        const [view, layout] = await Promise.all([
          nativePreviewView(),
          rendererLayout({ host: PREVIEW_HOST }),
        ]);
        const host = layout.dip.host;
        last = { view, host, zoom: layout.zoom };
        if (!view?.visible || !host) return false;
        return (
          Math.abs(view.bounds.x - host.x) <= 1.5 &&
          Math.abs(view.bounds.y - host.y) <= 1.5 &&
          Math.abs(view.bounds.width - host.width) <= 1.5 &&
          Math.abs(view.bounds.height - host.height) <= 1.5
        );
      },
      { timeout: 20_000, message: `${label}: native view off its host` },
    )
    .toBe(true)
    .catch((error: Error) => {
      throw new Error(`${error.message}\n${JSON.stringify(last)}`);
    });
  record(testInfo, `bounds-${label}`, JSON.stringify(last));
  return (last as { view: { bounds: DipRect } }).view.bounds;
}

/**
 * Whether two rects share at least one DIP in both axes. Main rounds the
 * view's bounds to whole DIPs, so against a fractional neighbour (app zoom
 * 0.8) it can reach up to a DIP into it; that is not covering it.
 */
function overlaps(a: DipRect, b: DipRect): boolean {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x >= 1 && y >= 1;
}

async function uiStore(action: string, ...args: unknown[]): Promise<void> {
  await s().window.evaluate(
    async ({ action, args }) => {
      const modulePath = "/src/stores/uiStore.ts";
      const { useUIStore } = await import(modulePath);
      (useUIStore.getState() as Record<string, (...values: unknown[]) => void>)[action]!(...args);
    },
    { action, args },
  );
}

async function setHostWindowSize(width: number, height: number): Promise<void> {
  await s().app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
    { width, height },
  );
}

/**
 * Show the annotation environment with one browser tab rendered by the real
 * renderer (BrowserTab, AnnotatedPreviewArea, AnnotationPanel). The fixed-bounds
 * preview the other tests drive is destroyed first, so exactly one native view
 * shows the fixture; `restoreDirectPreview` puts it back.
 */
async function showRendererPreview(
  extraTabs: Array<Record<string, unknown>> = [],
  containerId: string | null = null,
) {
  const environment = await invoke<{ projectId: string }>("get_environment", {
    environmentId: s().environmentId,
  });
  await preview("destroy", TAB_ID);
  const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: s().environmentId,
  });
  await invoke("save_pane_layout", {
    environmentId: s().environmentId,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId,
      activePaneId: "annotation-ui-pane",
      root: {
        kind: "leaf",
        id: "annotation-ui-pane",
        activeTabId: UI_TAB_ID,
        tabs: [
          {
            id: UI_TAB_ID,
            type: "browser",
            browserData: { url: `${s().fixture.url}${ROUTE_VARIANTS.settings}` },
          },
          ...extraTabs,
        ],
      },
    },
  });
  await uiStore("selectProjectAndEnvironment", environment.projectId, s().environmentId);
  await expect(s().window.locator(PREVIEW_HOST)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await nativePreviewView())?.visible ?? false).toBe(true);
  await waitForFixturePage(ROUTE_VARIANTS.settings);
}

async function restoreDirectPreview(): Promise<void> {
  await uiStore("setZoomLevel", 100).catch(() => undefined);
  await setHostWindowSize(1440, 960);
  await uiStore("selectProject", null).catch(() => undefined);
  await preview("destroy", UI_TAB_ID).catch(() => undefined);
  await attachPreview(ROUTE_VARIANTS.settings);
}

/** Keyboard activation of a renderer control: focus it, then Enter. No pointer. */
async function pressControl(locator: ReturnType<Page["locator"]>, key = "Enter"): Promise<void> {
  // A locator can set the DOM activeElement while the native preview still
  // owns keyboard focus. Return it to the host before activating its control.
  await s().app.evaluate(({ app, BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0]!;
    if (process.platform === "darwin") app.focus({ steal: true });
    host.focus();
    host.webContents.focus();
  });
  await locator.focus();
  await expect(locator).toBeFocused();
  await s().window.keyboard.press(key);
}

/**
 * A trusted capture of the fixture's emitted hints in the current environment,
 * saved through the real renderer, then read back from storage and the thread.
 */
async function captureAndReviewSourceHints(containerId: string | null = null): Promise<void> {
  await showRendererPreview([], containerId);
  try {
    const capabilities = await invoke<{ operations: { sourceHints?: boolean } }>(C.capabilities, {
      environmentId: s().environmentId,
    });
    expect(capabilities.operations.sourceHints).toBe(true);
    const before = new Set((await listAnnotations()).items.map((item) => item.id));
    await pressControl(s().window.getByRole("button", { name: /^Annotations, / }));
    await pressControl(s().window.getByRole("button", { name: "Add note", exact: true }));
    await expect(s().window.getByRole("button", { name: "Cancel selection" })).toBeVisible();
    const rect = await settledRect(`[data-testid="${TEST_IDS.saveSettings}"]`);
    await trustedClick(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const status = await awaitCaptureEnd(UI_TAB_ID);
    if (status.status !== "captured") throw new Error(`Capture failed: ${JSON.stringify(status)}`);
    const descriptor = status.pending;
    const candidates = [
      {
        producer: "annotation-fixture",
        path: "annotation-app/GeneratedSave.tsx",
        line: 2,
        component: "SettingsSave",
        verified: false,
      },
      {
        producer: "annotation-fixture",
        path: "annotation-app/MissingSettings.tsx",
        line: 4,
        component: "Settings",
        verified: false,
      },
    ];
    const pending = await readPending(descriptor.captureId);
    expect(pending.capture.evidence?.sourceHints).toEqual(candidates);
    // Save through the real renderer: commitPendingCapture consults its capability cache,
    // stages the native image, invokes the backend command, and acknowledges the spool.
    const body = "Source hint live path: align Save.";
    const editor = s().window.locator(`${NOTES_PANEL} textarea`).first();
    await expect(editor).toBeVisible();
    await editor.fill(body);
    await pressControl(s().window.getByRole("button", { name: "Save note", exact: true }));
    await expect
      .poll(async () =>
        (await listAnnotations()).items.find(
          (item) => !before.has(item.id) && item.latestIntent === body,
        ),
      )
      .toBeTruthy();
    const created = (await listAnnotations()).items.find(
      (item) => !before.has(item.id) && item.latestIntent === body,
    )!;
    const { annotation } = await getAnnotation(created.id);
    const stored = await captureRecord(annotation.currentCaptureId);
    expect(stored.evidence?.sourceHints).toEqual([
      { ...candidates[0]!, verified: true },
      candidates[1]!,
    ]);
    // The reviewer sees what the agent is given, and what the backend's check found.
    await expect(s().window.locator(`${NOTES_PANEL} [data-source-candidates] li`)).toHaveText([
      "annotation-app/GeneratedSave.tsx:2 · SettingsSave · path found in workspace at capture",
      "annotation-app/MissingSettings.tsx:4 · Settings · path not confirmed",
    ]);
    await expect.poll(() => preview("readPendingCapture", descriptor.captureId)).toBeNull();
    // Disk-backed evidence remains available after the renderer loses its cache.
    await s().window.reload();
    await waitForApi(s().window);
    expect((await captureRecord(annotation.currentCaptureId)).evidence?.sourceHints).toEqual(
      stored.evidence?.sourceHints,
    );
  } finally {
    await restoreDirectPreview();
  }
}

test("development source hints survive native spool and renderer capability gating into verified stored evidence", async () => {
  await captureAndReviewSourceHints();
});

test("a desktop capture in a container environment has its source hints checked inside the container", async () => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_ELECTRON_CONTAINER !== "1",
    "Needs Docker and this worktree's image (mise run docker:build:dev)",
  );
  test.info().setTimeout(6 * 60_000);
  const localEnvironmentId = s().environmentId;
  const { projectId } = await invoke<{ projectId: string }>("get_environment", {
    environmentId: localEnvironmentId,
  });
  const environment = await invoke<{ id: string }>("create_environment", {
    projectId,
    name: "annotation-fixture-container",
    networkAccessMode: "restricted",
    environmentType: "containerized",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const { containerId } = await invoke<{ containerId?: string | null }>("get_environment", {
      environmentId: environment.id,
    });
    expect(containerId).toBeTruthy();
    s().environmentId = environment.id;
    await captureAndReviewSourceHints(containerId!);
  } finally {
    s().environmentId = localEnvironmentId;
    await invoke("delete_environment", { environmentId: environment.id });
  }
});

test("the real Notes column shrinks the native view, overlays hide it, and the narrow switch swaps surfaces", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  await showRendererPreview();
  try {
    const notesButton = s().window.getByRole("button", { name: /^Annotations, / });
    await expect(notesButton).toHaveAttribute("aria-expanded", "false");
    const closed = await expectViewOnHost(testInfo, "notes-closed");

    // Opening Notes gives the column real width; the native view shrinks to
    // the host and never reaches under the column, its resize handle or a
    // focus ring inside it.
    await pressControl(notesButton);
    await expect(s().window.locator(NOTES_PANEL)).toBeVisible();
    for (const zoom of [100, 80, 125]) {
      await uiStore("setZoomLevel", zoom);
      await expect
        .poll(() => rendererLayout({}).then((layout) => layout.zoom))
        .toBeCloseTo(zoom / 100, 2);
      const bounds = await expectViewOnHost(testInfo, `notes-open-zoom-${zoom}`);
      const { dip } = await rendererLayout({
        notes: NOTES_PANEL,
        handle: '[aria-label="Resize annotations panel"]',
      });
      expect(dip.notes).not.toBeNull();
      expect(overlaps(bounds, dip.notes!)).toBe(false);
      expect(overlaps(bounds, dip.handle!)).toBe(false);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(dip.handle!.x + 1);
      if (zoom === 100) expect(bounds.width).toBeLessThan(closed.width - 200);
    }
    // At 150% the 1440-DIP window is 960 CSS px wide, so the column becomes
    // the narrow Preview/Notes switch; Preview still lands on its host.
    await uiStore("setZoomLevel", 150);
    const zoomedSurfaces = s().window.getByRole("tablist", { name: "Preview or notes" });
    await expect(zoomedSurfaces).toBeVisible({ timeout: 20_000 });
    await pressControl(zoomedSurfaces.getByRole("tab", { name: "Preview" }));
    await expectViewOnHost(testInfo, "notes-open-zoom-150-narrow");
    await uiStore("setZoomLevel", 100);
    await expect(zoomedSurfaces).toHaveCount(0, { timeout: 20_000 });
    await expectViewOnHost(testInfo, "notes-open-zoom-reset");

    const addNote = s().window.getByRole("button", { name: "Add note" });
    await addNote.focus();
    const ring = await s().window.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      const rect = element?.getBoundingClientRect();
      // Two-pixel ring plus offset, generously.
      return rect
        ? { x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 }
        : null;
    });
    const view = (await nativePreviewView())!;
    expect(ring).not.toBeNull();
    expect(overlaps(view.bounds, ring!)).toBe(false);

    // A menu and a dialog over the window hide the native view (it is a
    // separate surface and would otherwise paint over them), then it returns.
    const servers = s().window.getByRole("button", { name: /^Connected server: / });
    await pressControl(servers);
    await expect(s().window.getByRole("menu")).toBeVisible();
    await expect.poll(async () => (await nativePreviewView())?.visible).toBe(false);
    await s().window.keyboard.press("Escape");
    await expect(s().window.getByRole("menu")).toHaveCount(0);
    await expect.poll(async () => (await nativePreviewView())?.visible).toBe(true);
    await pressControl(servers);
    await pressControl(s().window.getByRole("menuitem", { name: "New connection" }));
    const dialog = s().window.getByRole("dialog", { name: "New connection" });
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await nativePreviewView())?.visible).toBe(false);
    await s().window.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expectViewOnHost(testInfo, "after-dialog");

    // Under 720 px the column becomes a Preview/Notes switch.
    await setHostWindowSize(900, 900);
    const surfaces = s().window.getByRole("tablist", { name: "Preview or notes" });
    await expect(surfaces).toBeVisible({ timeout: 20_000 });
    await pressControl(surfaces.getByRole("tab", { name: "Notes" }));
    await expect(surfaces.getByRole("tab", { name: "Notes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(s().window.locator(NOTES_PANEL)).toBeVisible();
    await expect.poll(async () => (await nativePreviewView())?.visible).toBe(false);
    await pressControl(surfaces.getByRole("tab", { name: "Preview" }));
    const narrow = await expectViewOnHost(testInfo, "narrow-preview");
    const { dip } = await rendererLayout({ notes: NOTES_PANEL });
    expect(dip.notes).toBeNull();
    expect(narrow.width).toBeGreaterThan(300);
    await setHostWindowSize(1440, 960);
    await expect(surfaces).toHaveCount(0, { timeout: 20_000 });
    await expectViewOnHost(testInfo, "wide-again");
    await pressControl(s().window.getByRole("button", { name: "Close annotations" }));
    await expect(notesButton).toHaveAttribute("aria-expanded", "false");
    await expect(notesButton).toBeFocused();
    const reclosed = await expectViewOnHost(testInfo, "notes-reclosed");
    expect(Math.abs(reclosed.width - closed.width)).toBeLessThanOrEqual(1.5);
  } finally {
    await restoreDirectPreview();
  }
});

/** Reach controls through Chromium's tab order, without locator.focus(). */
async function tabTo(locator: ReturnType<Page["locator"]>, backwards = false): Promise<void> {
  await expect(locator).toBeVisible();
  const key = backwards ? "Shift+Tab" : "Tab";
  for (let step = 0; step < 100; step++) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await s().window.keyboard.press(key);
  }
  await expect(locator, `unreachable through ${key}`).toBeFocused();
}

async function tabActivate(locator: ReturnType<Page["locator"]>, key = "Enter") {
  await tabTo(locator);
  await expect(locator).toBeFocused();
  await s().window.keyboard.press(key);
}

async function expectNoCodexLaunch(): Promise<void> {
  expect(await readFile(path.join(s().profile.dataDir, "codex-launches"), "utf8")).toBe("");
}

test("keyboard alone creates a note and sends it, with focus handed to the native view and back", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const agentTabId = "annotation-ui-codex";
  await showRendererPreview([
    {
      id: agentTabId,
      type: "agent-native",
      nativeAgentData: { environmentId: s().environmentId, platform: "codex" },
    },
  ]);
  let draftKey: string | null = null;
  let annotationId: string | null = null;
  let sent = false;
  let requestId: string | null = null;
  try {
    // Hold the destination's queue with an unsent chat draft (as the gateway
    // suite does), so the send is durable and observable but never executed.
    const { options } = await invoke<{
      options: Array<{ destination: { tabId: string; logicalSessionKey: string } }>;
    }>(C.destinations, { environmentId: s().environmentId });
    const option = options.find((candidate) => candidate.destination.tabId === agentTabId);
    expect(option, "codex tab offered as a destination").toBeTruthy();
    draftKey = `codex:${s().environmentId}:${encodeURIComponent(option!.destination.logicalSessionKey)}`;
    await invoke("save_compose_draft", {
      draftKey,
      ownerType: "environment",
      ownerId: s().environmentId,
      value: { text: "Held by the annotation suite", mentions: [], attachments: [] },
    });
    const before = new Set((await listAnnotations()).items.map((item) => item.id));

    // Bring the app forward so native focus is observable. Another app, or a
    // locked session, may keep the key window; then OS focus is not asserted,
    // but the in-app handoff still is: the view Chromium focuses (main
    // focusing the preview, then the host) and the renderer's editor focus.
    await trackWebContentsFocus(s().app);
    const focusedViews = async () =>
      (await focusedWebContentsUrls(s().app)).map((url) =>
        url.startsWith(s().fixture.url) ? "preview" : url === s().window.url() ? "host" : url,
      );
    const windowFocused = await s().app.evaluate(async ({ app, BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows()[0]!;
      if (process.platform === "darwin") app.focus({ steal: true });
      host.focus();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return host.isFocused();
    });
    record(testInfo, "window-focused", String(windowFocused));

    await tabActivate(s().window.getByRole("button", { name: /^Annotations, / }));
    // Start in the native page, then reach its target with real Tab events.
    // The inspector seeds its candidate from that focused element on start.
    await s().app.evaluate(({ webContents }, origin) => {
      webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getURL().startsWith(origin))
        ?.focus();
    }, s().fixture.url);
    for (let step = 0; step < 100; step++) {
      const onTarget = await inPreview<boolean>(
        `document.activeElement?.getAttribute('data-testid') === ${JSON.stringify(TEST_IDS.saveSettings)}`,
      );
      if (onTarget) break;
      await trustedInput([
        { type: "keyDown", keyCode: "Tab" },
        { type: "keyUp", keyCode: "Tab" },
      ]);
    }
    expect(await inPreview(`document.activeElement?.getAttribute('data-testid')`)).toBe(
      TEST_IDS.saveSettings,
    );
    await s().app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.focus(),
    );
    await expect.poll(focusedViews).toEqual(["host"]);
    const addNote = s().window.getByRole("button", { name: "Add note" });
    await tabTo(addNote);
    // Reverse and return to establish both directions of the local tab order.
    await s().window.keyboard.press("Shift+Tab");
    await expect(addNote).not.toBeFocused();
    await s().window.keyboard.press("Tab");
    await expect(addNote).toBeFocused();
    await tabActivate(s().window.getByRole("button", { name: "Add note" }));
    await expect(s().window.getByRole("button", { name: "Cancel selection" })).toBeVisible();
    const previewFocus = () =>
      s().app.evaluate(({ webContents }, origin) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin));
        return contents?.isFocused() ?? false;
      }, s().fixture.url);
    await expect.poll(focusedViews).toEqual(["preview"]);
    if (windowFocused) await expect.poll(previewFocus).toBe(true);
    record(testInfo, "preview-focused-while-selecting", String(await previewFocus()));
    await trustedInput([
      { type: "keyDown", keyCode: "Enter" },
      { type: "char", keyCode: "\r" },
      { type: "keyUp", keyCode: "Enter" },
    ]);

    // Main hands focus back: the renderer focuses the note editor.
    const editor = s().window.locator(`${NOTES_PANEL} textarea`).first();
    await expect(editor).toBeFocused({ timeout: 20_000 });
    await expect.poll(focusedViews).toEqual(["host"]);
    const body = "Keyboard-only note: align the Save button with Cancel.";
    await s().window.keyboard.type(body);
    await tabActivate(s().window.getByRole("button", { name: "Save note", exact: true }));
    await expect
      .poll(async () => (await listAnnotations()).items.find((item) => !before.has(item.id)))
      .toBeTruthy();
    const created = (await listAnnotations()).items.find((item) => !before.has(item.id))!;
    annotationId = created.id;
    expect(created.latestIntent).toBe(body);
    const saved = await invoke<WebAnnotationGetResult>(C.get, {
      environmentId: s().environmentId,
      annotationId: created.id,
    });
    expect(saved.capture?.target.kind).toBe("element");
    if (saved.capture?.target.kind !== "element") throw new Error("Missing keyboard capture");
    expect(saved.capture.target.anchor.stableId).toEqual({
      kind: "test-id",
      value: TEST_IDS.saveSettings,
    });

    // Send by keyboard: Discuss…, the session, Discuss with <agent>, then Send.
    const thread = s().window.locator(NOTES_PANEL);
    const discuss = thread.getByRole("button", { name: "Discuss…" });
    await expect(discuss).toBeVisible({ timeout: 20_000 });
    await tabActivate(discuss);
    const composer = thread.getByRole("region", { name: "Ask an agent" });
    await expect(composer).toBeVisible();
    // Choose the codex session (Space on its radio), then the operation, which
    // prepares the brief; Send appears with its preview.
    const session = composer
      .getByRole("radiogroup", { name: "Agent session" })
      .getByRole("radio")
      .first();
    await expect(session).toBeVisible({ timeout: 20_000 });
    await tabActivate(session, "Space");
    await expect(session).toHaveAttribute("aria-checked", "true");
    const prepare = composer.getByRole("button", { name: /^Discuss with / });
    await expect(prepare).toBeEnabled({ timeout: 20_000 });
    await tabActivate(prepare);
    const send = composer.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled({ timeout: 20_000 });
    sent = true;
    await tabActivate(send);
    await expect
      .poll(async () => {
        const got = await invoke<{ requests: WebAnnotationRequest[] }>(C.get, {
          environmentId: s().environmentId,
          annotationId: created.id,
        });
        requestId = got.requests[0]?.id ?? null;
        return got.requests.map((request) => `${request.operation}:${request.state}`);
      })
      .toEqual(["discuss:queued"]);
  } finally {
    try {
      if (draftKey) {
        // Discover receipts again even if an assertion failed immediately after
        // Send. Never release the hold on an unreadable/ambiguous request.
        const { requests } = await invoke<{ requests: WebAnnotationRequest[] }>(C.requestList, {
          environmentId: s().environmentId,
          ...(annotationId ? { annotationId } : {}),
        });
        if (sent)
          expect(requests.length, "Send receipt before releasing draft hold").toBeGreaterThan(0);
        if (requestId) expect(requests.some((request) => request.id === requestId)).toBe(true);
        for (const request of requests) {
          if (request.state !== "cancelled") {
            const cancelled = await invoke<{ request: WebAnnotationRequest; outcome: string }>(
              C.requestCancel,
              {
                environmentId: s().environmentId,
                requestId: request.id,
                expectedRevision: request.revision,
              },
            );
            expect(cancelled.outcome).toBe("cancelled");
          }
          const got = await invoke<{ request: WebAnnotationRequest }>(C.requestGet, {
            environmentId: s().environmentId,
            requestId: request.id,
          });
          expect(got.request.state).toBe("cancelled");
          const queue = await invoke<{
            messages: Array<{ id: string }>;
            inFlight?: unknown;
          } | null>("get_prompt_queue", { queueKey: request.queueKey });
          expect(queue?.messages.some((message) => message.id === request.id) ?? false).toBe(false);
          expect(queue?.inFlight ?? null).toBeNull();
        }
        await expectNoCodexLaunch();
        await invoke("delete_compose_draft", { draftKey });
      }
    } finally {
      // A failed cancellation leaves its draft in place until profile disposal.
      await restoreDirectPreview();
    }
  }
});

/** The pin query `showPins`/`showOnPage` take, built from the saved capture. */
async function pinQuery(annotationId: string, number = 1) {
  const { annotation } = await getAnnotation(annotationId);
  const capture = await captureRecord(annotation.currentCaptureId);
  return {
    annotationId,
    number,
    target: capture.target,
    route: capture.page.route,
    capture: {
      documentGeneration: capture.documentGeneration,
      viewport: capture.geometry?.viewport ?? FIXTURE_VIEWPORT,
    },
  };
}

async function pinOnce(pin: Awaited<ReturnType<typeof pinQuery>>) {
  const [result] = await preview<BrowserPreviewAnchorResult[]>("showPins", {
    tabId: TAB_ID,
    pins: [pin],
  });
  await preview("clearPins", TAB_ID);
  return result!.resolution;
}

function inViewport(rect: WebAnnotationRect | null): boolean {
  return (
    rect !== null &&
    rect.y >= 0 &&
    rect.y + Math.min(rect.height, 40) <= FIXTURE_VIEWPORT.height &&
    rect.width > 0
  );
}

test("pins and Show on page stay on the target or become explicit offscreen, in a closed modal, and across a late-font shift", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(180_000);
  const outcomes: string[] = [];
  const note = (line: string) => outcomes.push(line);
  try {
    // Offscreen: a footer 2,400 px below the fold.
    await navigate(ROUTE_VARIANTS.dialogs);
    const footer = `[data-testid="${TEST_IDS.offscreenFooter}"]`;
    const footerNote = await saveCapture(
      (await captureElement(footer)).descriptor.captureId,
      "Footer copy",
    );
    const footerPin = await pinQuery(footerNote.annotationId);
    await inPreview("window.scrollTo(0, 0); true");
    expect(inViewport(await rectOf(footer)), "footer starts offscreen").toBe(false);
    const offscreen = await pinOnce(footerPin);
    const offscreenVerdict = verdict(offscreen, await rectOf(footer));
    note(`offscreen pin: ${offscreen.state}/${offscreen.rule} -> ${offscreenVerdict}`);
    expect(offscreenVerdict).toBe("matched-correct");
    const shown = await preview<{ outcome: string; navigated: boolean; resolution: any }>(
      "showOnPage",
      { tabId: TAB_ID, pin: footerPin, pins: [], timeoutMs: 10_000 },
    );
    note(`offscreen show on page: ${shown.outcome} navigated=${shown.navigated}`);
    expect(shown).toMatchObject({ outcome: "shown", navigated: false });
    // Its resolution is the pre-scroll rect; after the scroll a fresh pin
    // must land on the footer, now in view.
    expect(shown.resolution.state).toBe("matched");
    await expect.poll(async () => inViewport(await rectOf(footer))).toBe(true);
    expect(verdict(await pinOnce(footerPin), await rectOf(footer))).toBe("matched-correct");

    // Modal: a button inside a <dialog> opened with showModal().
    await inPreview("window.scrollTo(0, 0); true");
    const opener = await settledRect(`[data-testid="${TEST_IDS.openDialog}"]`);
    await trustedClick(opener.x + opener.width / 2, opener.y + opener.height / 2);
    await expect
      .poll(() =>
        inPreview<boolean>(`document.querySelector('[data-testid="${TEST_IDS.dialog}"]').open`),
      )
      .toBe(true);
    const confirm = `[data-testid="${TEST_IDS.dialogConfirm}"]`;
    const modalNote = await saveCapture(
      (await captureElement(confirm)).descriptor.captureId,
      "Dialog save label",
    );
    const modalPin = await pinQuery(modalNote.annotationId);
    const open = await pinOnce(modalPin);
    note(`modal open pin: ${open.state}/${open.rule} -> ${verdict(open, await rectOf(confirm))}`);
    expect(verdict(open, await rectOf(confirm))).toBe("matched-correct");
    await inPreview(`document.querySelector('[data-testid="${TEST_IDS.dialog}"]').close(); true`);
    // Closed: the element still matches by identity but renders no box, so no
    // pin is drawn (not one at the page's corner) and Show on page says hidden.
    const [closedResult] = await preview<BrowserPreviewAnchorResult[]>("showPins", {
      tabId: TAB_ID,
      pins: [modalPin],
    });
    const closed = closedResult!.resolution;
    const badge = await inPreview<string>(
      `(() => { const badge = document.querySelector("[data-orkestrator-pins] [role='img']"); return badge ? badge.style.display : "absent"; })()`,
    );
    await preview("clearPins", TAB_ID);
    note(`modal closed pin: ${closed.state}/${closed.rule} badge=${badge}`);
    expect(closed).toMatchObject({ state: "matched", rect: null });
    expect(badge).toBe("none");
    const closedShow = await preview<{ outcome: string; resolution: any }>("showOnPage", {
      tabId: TAB_ID,
      pin: modalPin,
      pins: [],
      timeoutMs: 5_000,
    });
    note(`modal closed show on page: ${closedShow.outcome}/${closedShow.resolution.state}`);
    expect(closedShow.outcome).toBe("hidden");
    record(
      testInfo,
      "modal-closed",
      `${closed.state}, badge ${badge}; show on page ${closedShow.outcome}`,
    );

    // Late font. While a font holds the load event, main resolves pins only
    // after load, so they land on the target after its shift.
    const target = `[data-testid="${TEST_IDS.fontShiftTarget}"]`;
    const settled = () =>
      inPreviewNow<boolean>(`document.body.classList.contains("fonts-settled")`);
    const targetNow = () => rectOf(target, 0, inPreviewNow);
    const blocking = `${ROUTE_VARIANTS.lateFont}?delay=2500`;
    await navigate(blocking);
    await expect.poll(settled, { timeout: 15_000 }).toBe(true);
    const blockingNote = await saveCapture(
      (await captureElement(target)).descriptor.captureId,
      "Release notes button",
    );
    const blockingPin = await pinQuery(blockingNote.annotationId);
    await reloadFixtureScript(ROUTE_VARIANTS.lateFont);
    expect(await settled(), "font still loading").toBe(false);
    const unshifted = await targetNow();
    const afterLoad = await pinOnce(blockingPin);
    const shifted = await targetNow();
    expect(await settled(), "the pin resolved after the font settled").toBe(true);
    expect(shifted!.y - unshifted!.y, "the font shift moved the target down").toBeGreaterThan(30);
    note(
      `font holding load: pin ${afterLoad.state}/${afterLoad.rule} -> ${verdict(afterLoad, shifted)} after a ${Math.round(shifted!.y - unshifted!.y)} px shift`,
    );
    expect(verdict(afterLoad, shifted)).toBe("matched-correct");

    // A font a script loads after the load event: a pin drawn before the
    // shift follows it through main's live re-resolution.
    const lazy = `${ROUTE_VARIANTS.lateFont}?delay=2500&lazy=1`;
    await navigate(lazy);
    await expect.poll(settled, { timeout: 15_000 }).toBe(true);
    const lazyNote = await saveCapture(
      (await captureElement(target)).descriptor.captureId,
      "Release notes button (lazy font)",
    );
    const lazyPin = await pinQuery(lazyNote.annotationId);
    await reloadFixtureScript(ROUTE_VARIANTS.lateFont);
    const [drawn] = await preview<BrowserPreviewAnchorResult[]>("showPins", {
      tabId: TAB_ID,
      pins: [lazyPin],
    });
    const before = await targetNow();
    expect(await settled(), "pin drawn before the font settled").toBe(false);
    expect(verdict(drawn!.resolution, before)).toBe("matched-correct");
    await expect.poll(settled, { timeout: 15_000 }).toBe(true);
    const after = await targetNow();
    expect(after!.y - before!.y, "the font shift moved the target down").toBeGreaterThan(30);
    // The drawn outline (what the user sees) follows the target.
    const outline = () =>
      inPreviewNow<WebAnnotationRect | null>(
        `(() => { const badge = document.querySelector("[data-orkestrator-pins] [role='img']"); const box = badge && badge.previousElementSibling; if (!box || box.style.display === "none") return null; return { x: parseFloat(box.style.left), y: parseFloat(box.style.top), width: parseFloat(box.style.width), height: parseFloat(box.style.height) }; })()`,
      );
    await expect
      .poll(async () => verdict({ ...drawn!.resolution, rect: await outline() }, after), {
        timeout: 10_000,
      })
      .toBe("matched-correct");
    await preview("clearPins", TAB_ID);
    note(
      `lazy font: pin drawn before the shift, live pin matched-correct after a ${Math.round(after!.y - before!.y)} px shift`,
    );
  } finally {
    record(testInfo, "pin-outcomes", outcomes.join("; "));
    console.log(`[annotation-pins] ${outcomes.join("; ")}`);
  }
});

/** Hold a codex destination with a compose draft and send one held request. */
async function heldRequest(annotationId: string) {
  const agentTabId = "annotation-result-codex";
  const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: s().environmentId,
  });
  await invoke("save_pane_layout", {
    environmentId: s().environmentId,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "annotation-result-pane",
      root: {
        kind: "leaf",
        id: "annotation-result-pane",
        activeTabId: agentTabId,
        tabs: [
          {
            id: agentTabId,
            type: "agent-native",
            nativeAgentData: { environmentId: s().environmentId, platform: "codex" },
          },
        ],
      },
    },
  });
  const { options } = await invoke<{
    options: Array<{ destination: { tabId: string; logicalSessionKey: string } }>;
  }>(C.destinations, { environmentId: s().environmentId });
  const option = options.find((candidate) => candidate.destination.tabId === agentTabId);
  expect(option, "codex tab offered as a destination").toBeTruthy();
  const draftKey = `codex:${s().environmentId}:${encodeURIComponent(option!.destination.logicalSessionKey)}`;
  await invoke("save_compose_draft", {
    draftKey,
    ownerType: "environment",
    ownerId: s().environmentId,
    value: { text: "Held by the annotation suite", mentions: [], attachments: [] },
  });
  const { annotation } = await getAnnotation(annotationId);
  const preparation = await invoke<{ preparationId: string; bodyHash: string }>(C.requestPrepare, {
    environmentId: s().environmentId,
    operation: "implement",
    destination: option!.destination,
    annotations: [
      {
        annotationId,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: "",
  });
  const { request } = await invoke<{ request: WebAnnotationRequest }>(C.requestSend, {
    environmentId: s().environmentId,
    preparationId: preparation.preparationId,
    requestId: `req-result-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    bodyHash: preparation.bodyHash,
  });
  const cleanup = async () => {
    const latest = (
      await invoke<{ request: WebAnnotationRequest }>(C.requestGet, {
        environmentId: s().environmentId,
        requestId: request.id,
      })
    ).request;
    if (latest.state !== "cancelled") {
      const cancelled = await invoke<{ outcome: string }>(C.requestCancel, {
        environmentId: s().environmentId,
        requestId: request.id,
        expectedRevision: latest.revision,
      });
      expect(cancelled.outcome).toBe("cancelled");
    }
    await expectNoCodexLaunch();
    await invoke("delete_compose_draft", { draftKey });
  };
  return { request, cleanup };
}

/** A result (after) capture of `selector`, committed the way the renderer commits it. */
async function captureResult(
  selector: string,
  requestId: string,
  annotationId: string,
  point?: () => Promise<{ x: number; y: number }>,
) {
  const rect = point ? null : await settledRect(selector);
  const started = await preview<BrowserPreviewSelectionStatus>("startCapture", {
    tabId: TAB_ID,
    mode: "element",
    environmentId: s().environmentId,
    annotationId,
    purpose: "result",
    result: { requestId },
  });
  expect(started.status).toBe("selecting");
  const at = point
    ? await point()
    : { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 };
  await trustedClick(at.x, at.y);
  const status = await awaitCaptureEnd(TAB_ID);
  if (status.status !== "captured")
    throw new Error(`Result capture failed: ${JSON.stringify(status)}`);
  const pending = await readPending(status.pending.captureId);
  const assetIds: string[] = [];
  if (pending.imageDataUrl) {
    const staged = await invoke<{ asset: { id: string } }>(C.assetStage, {
      environmentId: s().environmentId,
      operationId: `asset-${status.pending.captureId}`,
      mediaType: "image/png",
      data: pending.imageDataUrl.slice(pending.imageDataUrl.indexOf(",") + 1),
    });
    assetIds.push(staged.asset.id);
  }
  const meta = pending.result;
  const committed = await invoke<{ captureId: string }>(C.resultCapture, {
    environmentId: s().environmentId,
    operationId: `result-${status.pending.captureId}`,
    requestId,
    annotationId,
    ...(meta
      ? {
          zoomFactor: meta.zoomFactor,
          deviceScaleFactor: meta.deviceScaleFactor,
          scroll: meta.scroll,
          stability: meta.stability,
          masks: meta.masks.map((mask) => ({ source: mask.source, rect: mask.rect })),
        }
      : {}),
    capture: { ...pending.capture, assetIds },
  });
  await preview("acknowledgePendingCapture", {
    captureId: status.pending.captureId,
    annotationId,
    backendCaptureId: committed.captureId,
  });
  const stored = (await captureRecord(committed.captureId)) as unknown as {
    comparison?: { differences: string[]; targetMatch: string; stability?: string };
  };
  return {
    stability: meta?.stability ?? null,
    differences: [...(stored.comparison?.differences ?? [])].sort(),
    targetMatch: stored.comparison?.targetMatch ?? null,
  };
}

test("result captures label stability and comparison differences, and Show on page reports an expired sign-in redirect", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(240_000);
  const outcomes: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const compare = async (
    label: string,
    selector: string,
    request: { request: WebAnnotationRequest },
    annotationId: string,
    expected: { stability: "stable" | "unstable"; differences: string[] },
    point?: () => Promise<{ x: number; y: number }>,
  ) => {
    const result = await captureResult(selector, request.request.id, annotationId, point);
    outcomes.push(
      `${label}: ${result.stability} [${result.differences.join(",")}] ${result.targetMatch}`,
    );
    expect(result.stability, label).toBe(expected.stability);
    expect(result.differences, label).toEqual([...expected.differences].sort());
    return result;
  };
  try {
    // A settled page and the same target: nothing to label.
    await navigate(ROUTE_VARIANTS.motion);
    const staticCopy = `[data-testid="${TEST_IDS.staticCopy}"]`;
    const banner = `[data-testid="${TEST_IDS.animatedBanner}"]`;
    const copyNote = await saveCapture(
      (await captureElement(staticCopy)).descriptor.captureId,
      "Static copy",
    );
    const copyRequest = await heldRequest(copyNote.annotationId);
    cleanups.push(copyRequest.cleanup);
    await compare("same route, settled", staticCopy, copyRequest, copyNote.annotationId, {
      stability: "stable",
      differences: [],
    });
    // A CSS animation elsewhere on the page does not unsettle this target;
    // the animated banner itself never settles.
    // It slides 160 px; the strip from 160 px to its width is always under it.
    const underBanner = () =>
      inPreview<{ x: number; y: number }>(
        `(() => { const el = document.querySelector(${JSON.stringify(banner)}); const row = el.parentElement.getBoundingClientRect(); const box = el.getBoundingClientRect(); return { x: row.x + (160 + el.offsetWidth) / 2, y: box.y + box.height / 2 }; })()`,
      );
    await compare(
      "animated target",
      banner,
      copyRequest,
      copyNote.annotationId,
      { stability: "unstable", differences: ["target", "unstable"] },
      underBanner,
    );
    // Another route, then another viewport.
    await navigate(ROUTE_VARIANTS.settings);
    await compare(
      "different route",
      `[data-testid="${TEST_IDS.saveSettings}"]`,
      copyRequest,
      copyNote.annotationId,
      { stability: "stable", differences: ["route", "target"] },
    );
    await navigate(ROUTE_VARIANTS.motion);
    await preview("setBounds", TAB_ID, { x: 0, y: 0, width: 1000, height: 700 });
    try {
      await compare("different viewport", staticCopy, copyRequest, copyNote.annotationId, {
        stability: "stable",
        differences: ["viewport"],
      });
    } finally {
      await preview("setBounds", TAB_ID, { x: 0, y: 0, ...FIXTURE_VIEWPORT });
    }

    // A web font (loaded by script after the load event) still loading for
    // the whole stability window.
    const fontRoute = `${ROUTE_VARIANTS.lateFont}?delay=6000&lazy=1`;
    const fontTarget = `[data-testid="${TEST_IDS.fontShiftTarget}"]`;
    await navigate(fontRoute);
    await expect
      .poll(() => inPreview<boolean>(`document.body.classList.contains("fonts-settled")`), {
        timeout: 15_000,
      })
      .toBe(true);
    const fontNote = await saveCapture(
      (await captureElement(fontTarget)).descriptor.captureId,
      "Release notes button",
    );
    const fontRequest = await heldRequest(fontNote.annotationId);
    cleanups.push(fontRequest.cleanup);
    await reloadFixtureScript(ROUTE_VARIANTS.lateFont);
    await expect
      .poll(() => inPreviewNow<string>("document.fonts.status"), {
        timeout: 10_000,
        intervals: [50],
      })
      .toBe("loading");
    await compare("font loading", fontTarget, fontRequest, fontNote.annotationId, {
      stability: "unstable",
      differences: ["unstable"],
    });
    await expect
      .poll(() => inPreviewNow<boolean>(`document.body.classList.contains("fonts-settled")`), {
        timeout: 15_000,
      })
      .toBe(true);
    await compare("font settled", fontTarget, fontRequest, fontNote.annotationId, {
      stability: "stable",
      differences: [],
    });

    // Expired sign-in: the page's route now redirects to /sign-in.
    await navigate(ROUTE_VARIANTS.account);
    const plan = `[data-testid="${TEST_IDS.accountPlan}"]`;
    const accountNote = await saveCapture(
      (await captureElement(plan)).descriptor.captureId,
      "Account plan copy",
    );
    const accountRequest = await heldRequest(accountNote.annotationId);
    cleanups.push(accountRequest.cleanup);
    const accountPin = await pinQuery(accountNote.annotationId);
    await fetch(`${s().fixture.url}/__fixture/state`, {
      method: "POST",
      body: JSON.stringify({ sessionExpired: true }),
    });
    await navigate(ROUTE_VARIANTS.settings);
    const redirected = await preview<{ outcome: string; navigated: boolean }>("showOnPage", {
      tabId: TAB_ID,
      pin: accountPin,
      pins: [],
      timeoutMs: 10_000,
    });
    outcomes.push(
      `expired sign-in show on page: ${redirected.outcome} navigated=${redirected.navigated}`,
    );
    expect(redirected).toMatchObject({ outcome: "navigation-required", navigated: true });
    await expect
      .poll(() => inPreview<string>("location.pathname"), { timeout: 10_000 })
      .toBe(ROUTE_VARIANTS.signIn);
    await compare(
      "expired sign-in",
      `[data-testid="${TEST_IDS.signInSubmit}"]`,
      accountRequest,
      accountNote.annotationId,
      { stability: "stable", differences: ["route", "target"] },
    );
  } finally {
    record(testInfo, "result-comparisons", outcomes.join("; "));
    console.log(`[annotation-comparisons] ${outcomes.join("; ")}`);
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test("baselines: client selection-to-saved timing and backend command latency", async () => {
  const testInfo = test.info();
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  };
  const p90 = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!
      : null;
  };
  const client = Object.fromEntries(
    Object.entries(clientTimings).map(([key, values]) => [
      key,
      {
        count: values.length,
        medianMs: median(values),
        p90Ms: p90(values),
        maxMs: Math.max(...values),
      },
    ]),
  );
  const metrics = await invoke<{
    durations: Record<string, { count: number; totalMs: number; maxMs: number }>;
  }>(C.metrics, {});
  const backend = Object.fromEntries(
    Object.entries(metrics.durations)
      .filter(([key]) => /^(command_ms|request_|capture)/.test(key))
      .map(([key, value]) => [
        key,
        {
          count: value.count,
          meanMs: Math.round(value.totalMs / Math.max(1, value.count)),
          maxMs: Math.round(value.maxMs),
        },
      ]),
  );
  const line = JSON.stringify({ client, backend });
  record(testInfo, "baselines", line.slice(0, 8_000));
  console.log(`[annotation-baseline] ${line}`);
  expect(clientTimings.selectionToSpool.length).toBeGreaterThan(0);
  expect(clientTimings.spoolToSaved.length).toBeGreaterThan(0);
});

/** The selection highlight's border colour (`browser-preview-annotation-script.ts`). */
const HIGHLIGHT_RGB: [number, number, number] = [38, 132, 255];
/** The marker under the highlight's 10% tint. */
const TINTED_MARKER_RGB: [number, number, number] = [233, 13, 255];

/**
 * Bounding box, in image pixels, of pixels within `tolerance` of `rgb` inside
 * `within` (image pixels). Accepts BGRA and RGBA bitmaps.
 */
async function colorBox(
  dataUrl: string,
  rgb: [number, number, number],
  within: DipRect,
  tolerance = 40,
) {
  return s().app.evaluate(
    ({ nativeImage }, { dataUrl, rgb, within, tolerance }) => {
      const image = nativeImage.createFromDataURL(dataUrl);
      const { width, height } = image.getSize();
      const bitmap = image.toBitmap();
      const near = (a: number, b: number, c: number) =>
        Math.abs(a - rgb[0]) <= tolerance &&
        Math.abs(b - rgb[1]) <= tolerance &&
        Math.abs(c - rgb[2]) <= tolerance;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      const x0 = Math.max(0, Math.floor(within.x));
      const y0 = Math.max(0, Math.floor(within.y));
      const x1 = Math.min(width, Math.ceil(within.x + within.width));
      const y1 = Math.min(height, Math.ceil(within.y + within.height));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * width + x) * 4;
          const p0 = bitmap[offset]!;
          const p1 = bitmap[offset + 1]!;
          const p2 = bitmap[offset + 2]!;
          if (near(p0, p1, p2) || near(p2, p1, p0)) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return maxX < 0
        ? null
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    },
    { dataUrl, rgb, within, tolerance },
  );
}

function scaled(rect: DipRect, scale: number, inset = 0): DipRect {
  return {
    x: (rect.x + inset) * scale,
    y: (rect.y + inset) * scale,
    width: (rect.width - 2 * inset) * scale,
    height: (rect.height - 2 * inset) * scale,
  };
}

function expectBoxNear(
  label: string,
  box: DipRect | null,
  expected: DipRect,
  tolerance: number,
): void {
  expect(box, `${label}: no pixels`).not.toBeNull();
  const detail = `${label}: ${JSON.stringify({ box, expected })}`;
  expect(Math.abs(box!.x - expected.x), detail).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(box!.y - expected.y), detail).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(box!.width - expected.width), detail).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(box!.height - expected.height), detail).toBeLessThanOrEqual(tolerance);
}

async function setPreviewZoom(factor: number): Promise<void> {
  await s().app.evaluate(
    ({ webContents }, { origin, factor }) => {
      webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(origin))
        ?.setZoomFactor(factor);
    },
    { origin: s().fixture.url, factor },
  );
}

async function relaunch(switches: string[]): Promise<void> {
  await closeElectron();
  const relaunched = await launchElectron(s(), switches);
  s().app = relaunched.app;
  s().window = relaunched.window;
  await attachPreview(ROUTE_VARIANTS.settings);
}

test("capture pixels stay on the target at preview zoom 0.8, 1 and 1.5 and at DPR 1 and 2", async () => {
  const testInfo = test.info();
  testInfo.setTimeout(420_000);
  const natural = await s().app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  record(testInfo, "natural-scale-factor", String(natural));
  // Exercise both forced branches on every host, including forced DPR 1 on
  // non-Retina machines. Natural capture remains a separate baseline.
  const runs = [
    { dpr: natural, switches: [] as string[] },
    ...[1, 2].map((dpr) => ({ dpr, switches: [`--force-device-scale-factor=${dpr}`] })),
  ];
  let forced = false;
  try {
    for (const run of runs) {
      if (run.switches.length > 0 || forced) {
        await relaunch(run.switches);
        forced = run.switches.length > 0;
      }
      const scaleFactor = await s().app.evaluate(
        ({ screen }) => screen.getPrimaryDisplay().scaleFactor,
      );
      expect(scaleFactor).toBe(run.dpr);
      for (const layout of ["direct", "notes"] as const) {
        const tabId = layout === "direct" ? TAB_ID : UI_TAB_ID;
        if (layout === "direct") {
          // 800 DIPs keeps DPR 2 below the 2000-pixel reduction bound.
          await preview("attach", {
            tabId,
            url: `${s().fixture.url}${ROUTE_VARIANTS.settings}`,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            visible: true,
          });
          await waitForFixturePage(ROUTE_VARIANTS.settings);
        } else {
          await setHostWindowSize(1280, 900);
          await showRendererPreview();
          const notes = s().window.getByRole("button", { name: /^Annotations, / });
          if ((await notes.getAttribute("aria-expanded")) === "false") await pressControl(notes);
          const bounds = await expectViewOnHost(testInfo, `capture-notes-dpr-${run.dpr}`);
          expect(bounds.x).toBeGreaterThan(0);
          expect(bounds.y).toBeGreaterThan(0);
          expect(bounds.width).toBeLessThanOrEqual(1000);
        }
        for (const zoom of [0.8, 1, 1.5]) {
          await setPreviewZoom(zoom);
          await inPreview(
            `(() => { document.getElementById(${JSON.stringify(MARKER_ID)})?.remove(); const marker = document.createElement("div"); marker.id = ${JSON.stringify(MARKER_ID)}; Object.assign(marker.style, { position: "fixed", left: "200px", top: "140px", width: "160px", height: "90px", background: "rgb(255, 0, 255)", zIndex: "2147480000" }); document.body.append(marker); return true; })()`,
          );
          const { descriptor, rect } = await captureElement(`#${MARKER_ID}`, 0, zoom, tabId);
          const pending = await readPending(descriptor.captureId);
          const label = `${run.switches.length ? "forced" : "natural"}-${layout}-dpr-${run.dpr}-zoom-${zoom}`;
          try {
            expect(pending.capture.target.kind).toBe("element");
            const geometry = pending.capture.geometry!;
            expect(geometry.zoomFactor).toBeCloseTo(zoom, 2);
            expect(geometry.devicePixelRatio).toBeCloseTo(run.dpr * zoom, 1);
            expect(pending.imageDataUrl, `${label}: image`).toBeTruthy();
            const scale = geometry.image!.scale;
            expect(geometry.image!.reduced, `${label}: full native scale`).toBe(false);
            expect(scale).toBeCloseTo(run.dpr * zoom, 1);
            if (pending.capture.target.kind !== "element") throw new Error(label);
            const target = pending.capture.target.rect;
            record(
              testInfo,
              label,
              JSON.stringify({
                geometry,
                target,
                rect,
                tag: pending.capture.target.anchor.semantic.tagName,
              }),
            );
            // The recorded target matches the page's own layout.
            expect(Math.abs(target.x - rect.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(target.y - rect.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(target.width - rect.width)).toBeLessThanOrEqual(1);
            // The highlight's border box is the target, and the marker shows
            // inside its 2 CSS px border, both within a device pixel or two.
            const tolerance = Math.max(2, Math.ceil(scale) + 1);
            const expected = scaled(target, scale);
            const search = {
              x: expected.x - 12,
              y: expected.y - 12,
              width: expected.width + 24,
              height: expected.height + 24,
            };
            const highlight = await colorBox(pending.imageDataUrl!, HIGHLIGHT_RGB, search);
            const marker = await colorBox(pending.imageDataUrl!, TINTED_MARKER_RGB, search);
            record(testInfo, `${label}-pixels`, JSON.stringify({ highlight, marker, expected }));
            expectBoxNear(`${label} highlight`, highlight, expected, tolerance);
            expectBoxNear(`${label} marker`, marker, scaled(target, scale, 2), tolerance);
            if (zoom === 1) {
              await testInfo.attach(`${label}.png`, {
                body: Buffer.from(pending.imageDataUrl!.split(",")[1]!, "base64"),
                contentType: "image/png",
              });
            }
          } finally {
            await preview("discardPendingCapture", descriptor.captureId);
          }
        }
        await setPreviewZoom(1);
        await inPreview(`document.getElementById(${JSON.stringify(MARKER_ID)})?.remove(); true`);
        if (layout === "notes") await restoreDirectPreview();
      }
      await expectNoCodexLaunch();
    }
  } finally {
    if (forced) await relaunch([]);
    else await setPreviewZoom(1).catch(() => undefined);
  }
});

test("profile storage and logs contain no synthetic secret", async () => {
  // Stop the app first so every buffered log and spool write is on disk.
  await closeElectron();
  await expectNoCodexLaunch();
  const scan = await findSyntheticSecrets([s().profile.dataDir, s().profile.logDir]);
  expect(scan.scannedFiles).toBeGreaterThan(0);
  expect(scan.hits).toEqual([]);
});
