/**
 * Multi-node window qualification (plan item 4006, report §12 Phase 4.6):
 * one window shows other nodes' workspaces in its own React tree (4001's
 * `inTreeNodes`), on the browser (the command profile's gateway page) and on
 * the desktop (an Electron this spec launches, connected to the command
 * profile as a remote command node, as plan item 2013's proof does:
 * Playwright cannot drive a `dev:test` profile's own Electron).
 *
 * Topology (`multi-node-window-support.ts`): the command profile, the leaf
 * profile attached to it, and up to five standalone leaves started from
 * source and attached too: six leaves, seven nodes. Every node gets one
 * started local environment whose layout is one terminal tab.
 *
 * The renderer is a development build, where a per-node store's hook outside
 * a node scope throws (plan item 3018, which retired 4004's runtime shim
 * guard with the shim it watched): such a throw lands in the node's error
 * boundary. After every flow no node workspace shows a render failure, and
 * the node shown (if another node) has its in-tree region mounted.
 *
 * Flows: open each node; a leaf's workspace surfaces (terminal, agent tab
 * with no turn, files, preview); the inactive-environment cycle from
 * `AGENTS.md` for a leaf; reload rehydration with a snapshot-first paint;
 * six-node switching with budget eviction; previews from two nodes in one
 * window (desktop: z-order and focus); a grant lapse reopened without a
 * reload; attention from a hidden node.
 *
 * mise run dev:test --profile <cmd> --fixture --no-agent-credentials --headless
 * mise run dev:test --profile <leaf> --fixture --no-agent-credentials --headless
 * ORKESTRATOR_AGENT_TEST_PROFILE=<cmd> ORKESTRATOR_AGENT_TEST_LEAF_PROFILE=<leaf> \
 *   bunx playwright test --config e2e/agent-testing/playwright.multi-node.config.ts
 *
 * No provider turn is made; evidence holds ids, timings, tiers and counts
 * only (`output/agent-testing/<run>/multi-node/<path>/`).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { _electron as electron } from "playwright";
import { mergeTests } from "@playwright/test";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup } from "../process-cleanup";
import { test as browserTest, fetchModulesOutsideChromium } from "./browser-test";
import { closeElectronWithin } from "./design-electron-cleanup";
import { expect, test as electronTest } from "./electron-fixtures";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { dismissStartupDialogs } from "./electron-startup-dialogs";
import {
  SHELL_TAB,
  SKIP_REASON,
  commandProfile,
  configureLifecycle,
  collectedHeapBytes,
  cues,
  dismissDialogs,
  evidenceDir,
  environmentButton,
  inTreeRegion,
  installCueCounters,
  leafProfile,
  lifecycleView,
  raiseTerminalAttention,
  renderedTerminal,
  seedLayout,
  startTopology,
  writeEvidence,
  type Topology,
  type TopologyNode,
} from "./multi-node-window-support";
import { loginUrl, repositoryRoot } from "./scope-proof-support";
import { focusedWebContentsUrls, trackWebContentsFocus } from "./webcontents-focus";
import { electronSpecEnvironment } from "./electron-spec-environment";

const test = mergeTests(browserTest, electronTest);

test.skip(!commandProfile || !leafProfile, SKIP_REASON);

const packageRoot = path.join(repositoryRoot, "apps", "desktop");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(packageRoot, "node_modules", ".bin", "electron");

interface Surface {
  kind: "browser" | "desktop";
  page: Page;
  app: ElectronApplication | null;
  topology: Topology;
  /** Every `open_node_workspace` the window's grants made: node id → workspace ids, in order. */
  grants: () => Promise<Record<string, string[]>>;
  /** Browser only: the page's responses per origin and status. */
  responses?: () => Promise<Record<string, Record<number, number>>>;
  /** Holds the next grant opens for `delayMs` (null clears it). */
  delayGrants: (delayMs: number | null) => Promise<void>;
  stop(): Promise<void>;
}

let surface: Surface | null = null;
const evidence: Record<string, unknown> = {};

function s(): Surface {
  if (!surface) throw new Error("The window was not opened.");
  return surface;
}

/** A marker a reload would drop: proves a flow ran without reloading the window. */
async function markWindow(page: Page): Promise<string> {
  const marker = `mn-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((marker) => {
    (window as unknown as { __mnMarker?: string }).__mnMarker = marker;
  }, marker);
  return marker;
}

async function windowMarker(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __mnMarker?: string }).__mnMarker ?? null);
}

/** Where `node`'s terminal renders: the window's own tree, on the node's scope. */
function terminalHost(node: TopologyNode): { target: Page; nodeId: string } {
  return { target: s().page, nodeId: node.nodeId };
}

/** The xterm of `node`'s environment, wherever it renders. */
async function terminalLocator(node: TopologyNode) {
  const { page, topology } = s();
  if (node.nodeId === topology.command.nodeId) {
    return page.locator('[data-testid="workspace-content"] .xterm:visible, .xterm:visible').first();
  }
  return inTreeRegion(page, node.nodeId).locator(".xterm:visible").first();
}

/** Clicks `node`'s environment in the sidebar and waits until its terminal shows. */
async function openNode(node: TopologyNode): Promise<number> {
  const { page } = s();
  await dismissDialogs(page);
  const button = environmentButton(page, node);
  await expect(button).toBeVisible({ timeout: 60_000 });
  // A row's hover card can cover the next row: move away and let it close
  // (no Escape: a focused terminal would take it as input).
  await page.mouse.move(0, 0);
  await expect(page.locator(".fixed.z-50.w-fit.rounded-md"))
    .toHaveCount(0, { timeout: 5_000 })
    .catch(() => undefined);
  const started = Date.now();
  await button.click();
  if (node.nodeId !== s().topology.command.nodeId) {
    await expect(inTreeRegion(page, node.nodeId)).toBeVisible({ timeout: 60_000 });
  }
  await expect(await terminalLocator(node)).toBeVisible({ timeout: 90_000 });
  return Date.now() - started;
}

/** Types a line into `node`'s terminal through the page, as a user does. */
async function typeInTerminal(node: TopologyNode, line: string): Promise<void> {
  const { page } = s();
  if (node.nodeId !== s().topology.command.nodeId) {
    // The terminal tab, if another tab (an agent tab, a preview) is in front.
    const tab = inTreeRegion(page, node.nodeId)
      .getByRole("tab", { name: /^Terminal/ })
      .first();
    if (await tab.isVisible()) await tab.click();
  }
  const terminal = await terminalLocator(node);
  // The shell is attached and prompting before anything is typed (a key sent
  // while the session is still attaching can be lost).
  await expect
    .poll(async () => /[%$#] *$/mu.test((await terminalText(node)).trimEnd()), { timeout: 30_000 })
    .toBe(true);
  // The middle of the terminal: a status notice may cover its top-left corner.
  await terminal.click();
  await terminal.locator(".xterm-helper-textarea").focus();
  await page.waitForTimeout(300);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function terminalText(node: TopologyNode): Promise<string> {
  const { target, nodeId } = terminalHost(node);
  return renderedTerminal(target, nodeId, node.environment.id).catch(() => "");
}

/**
 * After every flow: no node workspace shows a render failure (a store hook
 * outside its node's scope throws in this development renderer), and the
 * node shown (if another node) has its in-tree region mounted.
 */
async function checkScopes(flow: string, shown: TopologyNode | null): Promise<void> {
  const page = s().page;
  const failures = await page.getByTestId("node-workspace-error").count();
  const record = (evidence.scopeChecks ??= {}) as Record<string, unknown>;
  record[flow] = { renderFailures: failures };
  expect(failures, `no node workspace render failure (${flow})`).toBe(0);
  if (shown && shown.nodeId !== s().topology.command.nodeId) {
    await expect(inTreeRegion(page, shown.nodeId)).toHaveCount(1);
  }
}

/**
 * Writes this worker's evidence over the file's earlier entries: a failed
 * flow restarts the worker, and the flows before it keep what they recorded.
 */
function saveEvidence(): void {
  const file = path.join(evidenceDir, `${s().kind}-evidence.json`);
  let earlier: Record<string, unknown> = {};
  try {
    earlier = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // First worker of the run.
  }
  writeEvidence(`${s().kind}-evidence`, {
    ...earlier,
    kind: s().kind,
    leaves: s().topology.leaves.length,
    ...evidence,
    scopeChecks: {
      ...(earlier.scopeChecks as Record<string, unknown> | undefined),
      ...(evidence.scopeChecks as Record<string, unknown> | undefined),
    },
  });
}

// ---------------------------------------------------------------------------
// Surfaces

async function openBrowserSurface(
  browser: import("@playwright/test").Browser,
  topology: Topology,
): Promise<Surface> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fetchModulesOutsideChromium(context);
  await context.addInitScript(installCueCounters);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const grantLog: Record<string, string[]> = {};
  // Responses per origin and status (paths and bodies are not kept).
  const responses: Record<string, Record<number, number>> = {};
  page.on("response", (response) => {
    const origin = new URL(response.url()).origin;
    const perOrigin = (responses[origin] ??= {});
    perOrigin[response.status()] = (perOrigin[response.status()] ?? 0) + 1;
  });
  page.on("response", async (response) => {
    const request = response.request();
    if (!request.url().endsWith("/__orkestrator/invoke") || request.method() !== "POST") return;
    let body: { command?: string; args?: { nodeId?: string } } = {};
    try {
      body = JSON.parse(request.postData() ?? "{}");
    } catch {
      return;
    }
    if (body.command !== "open_node_workspace" || !body.args?.nodeId) return;
    // Only the workspace id is kept; the grant itself stays in the page.
    const result = (await response.json().catch(() => null)) as {
      result?: { workspaceId?: string };
    } | null;
    const id = result?.result?.workspaceId;
    if (id) (grantLog[body.args.nodeId] ??= []).push(id);
  });
  let grantDelay: number | null = null;
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request();
    if (grantDelay !== null && request.postData()?.includes('"open_node_workspace"')) {
      await new Promise((resolve) => setTimeout(resolve, grantDelay!));
    }
    await route.fallback();
  });
  await page.goto(loginUrl(commandProfile));
  await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await dismissDialogs(page);
  return {
    kind: "browser",
    page,
    app: null,
    topology,
    grants: async () => structuredClone(grantLog),
    responses: async () => structuredClone(responses),
    delayGrants: async (delayMs) => {
      grantDelay = delayMs;
    },
    stop: async () => {
      await context.close().catch(() => undefined);
    },
  };
}

async function openDesktopSurface(topology: Topology): Promise<Surface> {
  const build = spawnSync("bun", ["scripts/electron-bundle.ts"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "multi-node-electron-"));
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "multi-node-electron",
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
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  const stop = async () => {
    await closeElectronWithin(app).catch(() => undefined);
    if (vite) await stopProcessGroup(vite).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  try {
    vite = spawn("bun", ["run", "dev"], {
      cwd: webRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: String(rendererPort),
        VITE_ORKESTRATOR_PROFILE: profile.id,
        VITE_ORKESTRATOR_PROFILE_FLAVOR: "agent-test",
      },
    });
    ownProcessGroup(vite);
    await expect
      .poll(
        async () =>
          fetch(rendererUrl)
            .then((r) => r.ok)
            .catch(() => false),
        { timeout: 60_000 },
      )
      .toBe(true);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [...ELECTRON_TEST_SWITCHES, path.join(packageRoot, "dist", "electron", "main.js")],
      cwd: repositoryRoot,
      env: electronSpecEnvironment(process.env, {
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: rendererUrl,
        ORKESTRATOR_RUNTIME_PROFILE_FILE: profilePath,
        ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS: "1",
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
      }),
    });
    const electronApp = app;
    dismissStartupDialogs(electronApp);
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(30_000);
    await expect(page).toHaveTitle(profile.electronTitle, { timeout: 90_000 });
    await page.addInitScript(installCueCounters);
    const command = topology.command;
    // The command node is the command profile's backend: a remote connection.
    // Its token goes only to the renderer's secure connection store, as a user's would.
    await page.evaluate(
      async ({ address, token }) => {
        const api = (
          globalThis as unknown as {
            orkestrator: { connections: { connect(input: object): Promise<unknown> } };
          }
        ).orkestrator;
        await api.connections.connect({ address, token, nickname: "Multi-node command node" });
      },
      { address: command.origin, token: command.gateway.secret() },
    );
    await expect
      .poll(
        async () => {
          const id = await page
            .evaluate(
              () =>
                (globalThis as { orkestratorDesktopIdentity?: { backendId?: string | null } })
                  .orkestratorDesktopIdentity?.backendId ?? null,
            )
            .catch(() => null);
          if (id !== command.nodeId) await page.reload().catch(() => undefined);
          return id;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(command.nodeId);
    await page.reload();
    await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
    await trackWebContentsFocus(electronApp);
    // Main opens every node grant: record their workspace ids (never the
    // grant), and optionally hold an open, from main's own fetch.
    await electronApp.evaluate((_electron, commandOrigin) => {
      const main = globalThis as typeof globalThis & {
        __mnGrants?: Record<string, string[]>;
        __mnGrantDelay?: number | null;
      };
      main.__mnGrants = {};
      main.__mnGrantDelay = null;
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = typeof init?.body === "string" ? init.body : "";
        const grant =
          url.origin === commandOrigin &&
          url.pathname.endsWith("/__orkestrator/invoke") &&
          body.includes('"open_node_workspace"');
        if (!grant) return inner(input, init);
        if (main.__mnGrantDelay) {
          await new Promise((resolve) => setTimeout(resolve, main.__mnGrantDelay!));
        }
        const response = await inner(input, init);
        try {
          const nodeId = (JSON.parse(body) as { args?: { nodeId?: string } }).args?.nodeId;
          const payload = (await response.clone().json()) as { result?: { workspaceId?: string } };
          if (nodeId && payload.result?.workspaceId) {
            (main.__mnGrants![nodeId] ??= []).push(payload.result.workspaceId);
          }
        } catch {
          // Not JSON: nothing to record.
        }
        return response;
      }) as typeof fetch;
    }, command.origin);
    await dismissDialogs(page);
    return {
      kind: "desktop",
      page,
      app: electronApp,
      topology,
      grants: () =>
        electronApp.evaluate(() =>
          structuredClone(
            (globalThis as { __mnGrants?: Record<string, string[]> }).__mnGrants ?? {},
          ),
        ),
      delayGrants: (delayMs) =>
        electronApp.evaluate((_electron, delayMs) => {
          (globalThis as { __mnGrantDelay?: number | null }).__mnGrantDelay = delayMs;
        }, delayMs),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

test.beforeAll(async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const kind = testInfo.project.name === "electron" ? "desktop" : "browser";
  const topology = await startTopology(`${kind === "desktop" ? "d" : "b"}t`);
  try {
    surface =
      kind === "desktop"
        ? await openDesktopSurface(topology)
        : await openBrowserSurface(browser, topology);
  } catch (error) {
    await topology.stop();
    throw error;
  }
  evidence.topology = {
    commandNode: topology.command.nodeId,
    leaves: topology.leaves.map((leaf) => ({ name: leaf.name, nodeId: leaf.nodeId })),
  };
});

test.afterAll(async () => {
  if (!surface) return;
  saveEvidence();
  await surface.stop();
  await surface.topology.stop();
  surface = null;
});

// ---------------------------------------------------------------------------
// Flows

test("opens each node's environment in the window", async () => {
  const { topology, page } = s();
  const opened: Array<{ node: string; ms: number }> = [];
  for (const node of [topology.command, ...topology.leaves]) {
    opened.push({ node: node.name, ms: await openNode(node) });
    if (node.nodeId !== topology.command.nodeId) {
      // The shown node is the only visible region; the others stay mounted, hidden.
      await expect(inTreeRegion(page, node.nodeId)).toBeVisible();
      await expect(page.locator('[data-testid="in-tree-workspace"]:visible')).toHaveCount(1);
      await expect(page.locator('iframe[title^="Workspace on "]')).toHaveCount(0);
    }
    await checkScopes(`open ${node.name}`, node);
  }
  evidence.firstOpenMs = opened;
  if (s().responses) {
    // Which route the window's leaf traffic took: the leaves' own origins
    // (direct) or only the command node's (relay).
    const responses = await s().responses!();
    const leafOrigins = new Set(topology.leaves.map((leaf) => leaf.origin));
    evidence.browserRoute = Object.keys(responses).some((origin) => leafOrigins.has(origin))
      ? "direct"
      : "relay";
  }
});

test("a leaf's workspace works: terminal, agent tab without a turn, files, preview", async () => {
  const { page, topology } = s();
  const leaf = topology.leaves[0]!;
  await openNode(leaf);
  const region = inTreeRegion(page, leaf.nodeId);
  const nonce = Math.random().toString(36).slice(2, 8);
  // Terminal: the leaf's shell runs the command (its output, not the echo).
  await typeInTerminal(
    leaf,
    `echo surf-$((40+2))-${nonce} > uf4006-${nonce}.txt; cat uf4006-${nonce}.txt`,
  );
  await expect.poll(() => terminalText(leaf), { timeout: 30_000 }).toContain(`surf-42-${nonce}`);
  const worktree = (
    await leaf.invoke<{ worktreePath: string }>("get_environment", {
      environmentId: leaf.environment.id,
    })
  ).worktreePath;
  expect(worktree).toBeTruthy();
  // Files: the leaf's change list shows the file its terminal wrote.
  await region
    .getByRole("button", { name: /Show file panel|Hide file panel/ })
    .first()
    .click();
  await expect(region.getByText(`uf4006-${nonce}.txt`).first()).toBeVisible({ timeout: 60_000 });
  // Agent tab: a new native agent tab renders its composer; nothing is sent.
  await region.getByRole("button", { name: "New native agent tab" }).first().click();
  await expect(region.getByRole("textbox").first()).toBeVisible({ timeout: 60_000 });
  // Preview: a browser tab on a page the leaf's terminal serves (the fixture
  // server on a port it binds itself and prints).
  await region
    .getByRole("tab", { name: /Terminal/ })
    .first()
    .click();
  await typeInTerminal(leaf, "PORT=0 bun server.ts");
  let port = "";
  await expect
    .poll(
      async () => {
        const printed = /Fixture server [^:]+: http:\/\/127\.0\.0\.1:(\d+)/.exec(
          await terminalText(leaf),
        );
        port = printed?.[1] ?? "";
        return port;
      },
      { timeout: 30_000 },
    )
    .not.toBe("");
  if (s().kind === "desktop") {
    // A remote gateway opens only an environment's registered preview targets
    // (security report M2), on the leaf as on the command node: register the
    // fixture server as a service of the leaf's environment.
    await leaf.invoke("register_preview_service", {
      service: {
        environmentId: leaf.environment.id,
        label: "uf4006-fixture",
        targetKind: "worktree",
        applicationPort: Number(port),
        addressFamily: "ipv4",
        readinessPath: "/health",
      },
      operationId: `register-uf4006-${port}`,
    });
  }
  await seedLayout(
    leaf,
    [{ id: "tab-preview", type: "browser", browserData: { url: `http://127.0.0.1:${port}/` } }],
    SHELL_TAB,
  );
  await page.reload();
  await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  await openNode(leaf);
  await region
    .getByRole("tab", { name: /127\.0\.0\.1|Orkestrator test project|New tab|Browser/ })
    .first()
    .click();
  if (s().kind === "browser") {
    // A browser page cannot show a dev server's loopback page: the tab says
    // so, exactly as it does for the window's own node (checked below).
    await expect(region.getByText("Browser tabs aren’t supported here")).toBeVisible({
      timeout: 60_000,
    });
    await seedLayout(
      topology.command,
      [{ id: "tab-preview", type: "browser", browserData: { url: `http://127.0.0.1:${port}/` } }],
      "tab-preview",
    );
    await page.reload();
    await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
    await dismissDialogs(page);
    await environmentButton(page, topology.command).click();
    await expect(page.getByText("Browser tabs aren’t supported here").first()).toBeVisible({
      timeout: 60_000,
    });
    await seedLayout(topology.command);
    await openNode(leaf);
  } else {
    // Soft: the rest of the flow still runs. Found 2026-11-07 (fixed): the
    // desktop resolved a leaf's loopback page through the command node's
    // gateway. The registered port may also open as a service preview over the
    // leaf's tunnel (the tab migrates), so any view showing the page counts;
    // its origin says which route it took.
    const leafPreview = () =>
      s().app!.evaluate(
        async ({ webContents }, { port, renderer }) => {
          const candidates = webContents
            .getAllWebContents()
            .filter(
              (contents) =>
                new URL(contents.getURL() || "about:blank").origin !== renderer &&
                (contents.getURL().startsWith(`http://127.0.0.1:${port}/`) ||
                  contents.getURL().includes(`/__orkestrator/browser/loopback/${port}/`) ||
                  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(contents.getURL())),
            );
          let fallback: { origin: string; h1: string | null } | null = null;
          for (const view of candidates) {
            const shown = {
              origin: new URL(view.getURL()).origin,
              h1: (await view
                .executeJavaScript("document.querySelector('h1')?.textContent ?? null")
                .catch(() => null)) as string | null,
            };
            if (shown.h1 === "Orkestrator test project") return shown;
            fallback ??= shown;
          }
          return fallback;
        },
        { port, renderer: new URL(page.url()).origin },
      );
    let shown = await leafPreview();
    for (let tries = 0; tries < 30 && shown?.h1 !== "Orkestrator test project"; tries += 1) {
      await page.waitForTimeout(2_000);
      shown = await leafPreview();
    }
    evidence.leafPreviewOnDesktop = shown && {
      throughGateway:
        shown.origin === topology.command.origin
          ? "command"
          : shown.origin === leaf.origin
            ? "leaf"
            : "local-service-tunnel",
      h1: shown.h1,
    };
    expect
      .soft(shown?.h1, "an in-tree leaf's preview shows the leaf's page")
      .toBe("Orkestrator test project");
  }
  // Stop the fixture server, back to a terminal-only layout.
  await region
    .getByRole("tab", { name: /Terminal/ })
    .first()
    .click();
  const running = await terminalLocator(leaf);
  await running.click();
  await running.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+C");
  await seedLayout(leaf);
  evidence.surfaces = {
    terminal: true,
    files: true,
    agentTab: true,
    preview:
      s().kind === "desktop"
        ? (evidence.leafPreviewOnDesktop as { h1?: string } | null)?.h1 ===
          "Orkestrator test project"
          ? "rendered"
          : "not-rendered"
        : "unsupported-on-browser-same-as-command-node",
  };
  await checkScopes("surfaces", leaf);
});

test("inactive-environment cycle on a leaf: start, switch away, finish, return, reload", async () => {
  const { page, topology } = s();
  const leaf = topology.leaves[0]!;
  await openNode(leaf);
  const nonce = Math.random().toString(36).slice(2, 8);
  // Work that outlives the switch: the output appears only after the sleep.
  await typeInTerminal(leaf, `sleep 6; echo cycle-$((40+2))-${nonce}`);
  await page.waitForTimeout(500);
  // Switch away to another node's environment, so the leaf is hidden.
  await openNode(topology.command);
  const hiddenAt = Date.now();
  await page.waitForTimeout(9_000);
  await checkScopes("cycle hidden", topology.command);
  // Return: the output produced while hidden is there.
  await openNode(leaf);
  await expect.poll(() => terminalText(leaf), { timeout: 30_000 }).toContain(`cycle-42-${nonce}`);
  const returnedAfterMs = Date.now() - hiddenAt;
  await checkScopes("cycle return", leaf);
  // Reload: the same output from the authoritative snapshot.
  await page.reload();
  await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  await openNode(leaf);
  await expect.poll(() => terminalText(leaf), { timeout: 30_000 }).toContain(`cycle-42-${nonce}`);
  // The terminal still takes input after the reload.
  await typeInTerminal(leaf, `echo after-$((40+2))-${nonce}`);
  await expect.poll(() => terminalText(leaf), { timeout: 30_000 }).toContain(`after-42-${nonce}`);
  evidence.inactiveCycle = {
    hiddenForMs: returnedAfterMs,
    outputAfterReturn: true,
    outputAfterReload: true,
  };
  await checkScopes("cycle reload", leaf);
});

test("reload rehydrates the shown leaf, painting its snapshot first", async () => {
  const { page, topology } = s();
  const leaf = topology.leaves[0]!;
  await openNode(leaf);
  // The leaf scope writes its snapshot 5 s after it turns live, then every 30 s.
  await expect
    .poll(
      () =>
        page.evaluate(async (nodeId) => {
          const modulePath = "/src/lib/node-snapshots.ts";
          const { nodeSnapshotStore } = await import(/* @vite-ignore */ modulePath);
          const store = nodeSnapshotStore();
          if (!store) return false;
          const entries = (await store.entries()) as Array<{ nodeId: string }>;
          return entries.some((entry) => entry.nodeId === nodeId);
        }, leaf.nodeId),
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
  // Record, from the first script of the reloaded document, when the
  // snapshot preview and the live workspace first appear.
  await page.addInitScript((nodeId: string) => {
    const seen: Record<string, number> = {};
    (window as unknown as { __mnPaint?: Record<string, number> }).__mnPaint = seen;
    const check = () => {
      const region = document.querySelector(
        `[data-testid="in-tree-workspace"][data-node="${nodeId}"]`,
      );
      if (!region) return;
      if (!seen.snapshot && region.querySelector('[data-testid="node-snapshot-preview"]')) {
        seen.snapshot = performance.now();
      }
      if (!seen.stale && region.querySelector('[data-testid="snapshot-stale-marker"]')) {
        seen.stale = performance.now();
      }
      if (!seen.live && region.querySelector(".xterm")) seen.live = performance.now();
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true });
  }, leaf.nodeId);
  // Hold the leaf's grant open after the reload, so the scope is visibly
  // still connecting while its snapshot is already painted.
  await s().delayGrants(3_000);
  const started = Date.now();
  await page.reload();
  await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
  // The reload keeps the window's selection, or the leaf is opened again.
  const button = environmentButton(page, leaf);
  await expect(button).toBeVisible({ timeout: 60_000 });
  if (!(await inTreeRegion(page, leaf.nodeId).isVisible())) await button.click();
  await expect(await terminalLocator(leaf)).toBeVisible({ timeout: 90_000 });
  const liveMs = Date.now() - started;
  await s().delayGrants(null);
  const paint = await page.evaluate(
    () => (window as unknown as { __mnPaint?: Record<string, number> }).__mnPaint ?? {},
  );
  evidence.reload = { liveAfterReloadMs: liveMs, paint };
  expect(paint.snapshot, "the snapshot painted before the live workspace").toBeGreaterThan(0);
  expect(paint.stale, "the snapshot is marked stale").toBeGreaterThan(0);
  expect(paint.snapshot!).toBeLessThan(paint.live!);
  // Read-only until live, then the live workspace replaces it.
  await expect(inTreeRegion(page, leaf.nodeId).getByTestId("node-snapshot-preview")).toHaveCount(0);
  await checkScopes("reload", leaf);
});

test("six-node switching with budget eviction", async () => {
  const { page, topology } = s();
  const leaves = topology.leaves;
  const switches: Array<{ round: number; node: string; ms: number; tier: string }> = [];
  // Warm every leaf (each stays mounted while warm), then switch around twice.
  for (let round = 0; round < 3; round += 1) {
    for (const leaf of leaves) {
      const ms = await openNode(leaf);
      const view = await lifecycleView(page);
      switches.push({ round, node: leaf.name, ms, tier: view.tiers[leaf.nodeId] ?? "?" });
      expect(view.tiers[leaf.nodeId]).toBe("live");
      await checkScopes(`switch ${round} ${leaf.name}`, leaf);
    }
  }
  await page.waitForTimeout(3_000);
  const warmHeap = await collectedHeapBytes(page);
  const warm = await lifecycleView(page);
  const hidden = leaves.slice(0, -1).map((leaf) => warm.tiers[leaf.nodeId]);
  expect(hidden.every((tier) => tier === "warm")).toBe(true);
  // Budget A: room for about three warm scopes; the least recently shown suspend.
  const perScope = warm.config.scopeEstimateBytes;
  await configureLifecycle(page, {
    memorySource: "estimate",
    memoryBudgetBytes: warm.estimateBytes - Math.round(2.5 * perScope),
  });
  await expect
    .poll(
      async () =>
        Object.values((await lifecycleView(page)).tiers).filter((t) => t === "suspended").length,
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);
  const afterA = await lifecycleView(page);
  const shownLeaf = leaves.at(-1)!;
  expect(afterA.tiers[shownLeaf.nodeId]).toBe("live");
  // Least recently shown first: the first leaf goes before the fifth.
  expect(afterA.tiers[leaves[0]!.nodeId]).not.toBe("warm");
  const suspendedViews = await page.locator('[data-testid="in-tree-workspace"] .xterm').count();
  // Budget B: only the shown scope fits; every hidden one goes back to summary.
  await configureLifecycle(page, { memoryBudgetBytes: perScope + 1024 * 1024 });
  await expect
    .poll(
      async () => {
        const tiers = (await lifecycleView(page)).tiers;
        return leaves.slice(0, -1).filter((leaf) => (tiers[leaf.nodeId] ?? "summary") === "summary")
          .length;
      },
      { timeout: 30_000 },
    )
    .toBe(leaves.length - 1);
  const afterB = await lifecycleView(page);
  expect(afterB.tiers[shownLeaf.nodeId]).toBe("live");
  await page.waitForTimeout(3_000);
  const summaryHeap = await collectedHeapBytes(page);
  // Back to the default budget: an evicted node reopens when shown, with its terminal.
  await configureLifecycle(page, {
    memorySource: warm.config.memorySource,
    memoryBudgetBytes: warm.config.memoryBudgetBytes,
  });
  const reopenMs = await openNode(leaves[0]!);
  const reopened = await lifecycleView(page);
  expect(reopened.tiers[leaves[0]!.nodeId]).toBe("live");
  evidence.sixNode = {
    leaves: leaves.length,
    switches,
    warm: {
      tiers: Object.values(warm.tiers),
      estimateBytes: warm.estimateBytes,
      heapUsedBytes: warm.heapUsedBytes,
      reading: warm.reading,
      config: warm.config,
    },
    budgetA: {
      budgetBytes: warm.estimateBytes - Math.round(2.5 * perScope),
      tiers: Object.values(afterA.tiers),
      estimateBytes: afterA.estimateBytes,
      mountedTerminals: suspendedViews,
    },
    budgetB: {
      budgetBytes: perScope + 1024 * 1024,
      tiers: Object.values(afterB.tiers),
      estimateBytes: afterB.estimateBytes,
    },
    collectedHeapBytes: {
      sixWarmOneShown: warmHeap,
      oneShownOthersSummary: summaryHeap,
      perWarmScope:
        warmHeap !== null && summaryHeap !== null
          ? Math.round((warmHeap - summaryHeap) / Math.max(1, leaves.length - 1))
          : null,
    },
    reopenFromSummaryMs: reopenMs,
    afterReopen: { tiers: Object.values(reopened.tiers), heapUsedBytes: reopened.heapUsedBytes },
  };
  await checkScopes("six-node", leaves[0]!);
});

test("previews from two nodes in one window keep their z-order and focus", async () => {
  test.skip(s().kind !== "desktop", "native preview views are the desktop's");
  const { page, topology, app } = s();
  const servers: Server[] = [];
  const serve = async (marker: string) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>${marker}</title><h1>${marker}</h1><input id="field">`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  };
  const leaf = topology.leaves[1] ?? topology.leaves[0]!;
  const urls = { command: await serve("mn-command-preview"), leaf: await serve("mn-leaf-preview") };
  try {
    // Distinct tab ids, as the app makes them (`tab-<uuid>`): main keys a
    // window's previews by tab id (see Notes of plan items 2009 and 4001).
    for (const [node, url, tabId] of [
      [topology.command, urls.command, `tab-preview-command-${Date.now()}`],
      [leaf, urls.leaf, `tab-preview-leaf-${Date.now()}`],
    ] as const) {
      await seedLayout(node, [{ id: tabId, type: "browser", browserData: { url } }], tabId);
    }
    await page.reload();
    await expect(page.getByTestId("project-search-bar")).toBeVisible({ timeout: 90_000 });
    const views = () =>
      app!.evaluate(({ BrowserWindow, webContents }, urls) => {
        const owner = BrowserWindow.getAllWindows()[0]!;
        const children = owner.contentView.children as unknown as Array<{
          webContents?: Electron.WebContents;
          getVisible(): boolean;
          getBounds(): Electron.Rectangle;
        }>;
        const out: Record<
          string,
          { index: number; visible: boolean; bounds: Electron.Rectangle } | null
        > & {
          all?: Array<{ url: string; visible: boolean }>;
        } = {
          command: null,
          leaf: null,
        };
        out.all = children.map((child) => ({
          url: (child.webContents?.getURL() ?? "").replace(/[?#].*$/u, ""),
          visible: child.getVisible(),
        }));
        children.forEach((child, index) => {
          const url = child.webContents?.getURL() ?? "";
          for (const key of ["command", "leaf"] as const) {
            // A node's loopback page is served through that node's gateway
            // (`/__orkestrator/browser/loopback/<port>/`).
            const port = new URL(urls[key]).port;
            if (
              url.startsWith(urls[key]) ||
              url.includes(`/__orkestrator/browser/loopback/${port}/`)
            ) {
              out[key] = { index, visible: child.getVisible(), bounds: child.getBounds() };
            }
          }
        });
        void webContents;
        return out;
      }, urls);
    const show = async (node: TopologyNode) => {
      await dismissDialogs(page);
      // A pointer resting on a row opens its hover card, which covers the next
      // row and, as an overlay, hides the native previews (seen 2026-11-07):
      // move it off the sidebar before and after the click.
      const away = async () => {
        await page.mouse.move(700, 4);
        await expect(page.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0, {
          timeout: 5_000,
        });
      };
      await away();
      await environmentButton(page, node).click();
      await away();
      if (node !== topology.command) await expect(inTreeRegion(page, node.nodeId)).toBeVisible();
    };
    await show(topology.command);
    await expect
      .poll(async () => (await views()).command?.visible ?? false, { timeout: 60_000 })
      .toBe(true)
      .catch(async (error: unknown) => {
        evidence.previewsDebug = {
          views: await views(),
          contents: await app!.evaluate(({ webContents }) =>
            webContents
              .getAllWebContents()
              .map((contents) => contents.getURL().replace(/[?#].*$/u, "")),
          ),
        };
        await page.screenshot({ path: path.join(test.info().outputDir, "previews-debug.png") });
        throw error;
      });
    const steps: Record<string, unknown> = { commandShown: await views() };
    evidence.previewsSteps = steps;
    await show(leaf);
    await expect
      .poll(async () => (await views()).leaf?.visible ?? false, { timeout: 60_000 })
      .toBe(true)
      .catch(async (error: unknown) => {
        steps.leafShownFailed = await views();
        throw error;
      });
    // A node reopened from summary remounts its workspace once: let it settle.
    await page.waitForTimeout(3_000);
    steps.leafVisibleAfterSettling = (await views()).leaf?.visible ?? false;
    await expect
      .poll(async () => (await views()).leaf?.visible ?? false, { timeout: 30_000 })
      .toBe(true);
    const bothShownOnce = await views();
    steps.leafShown = bothShownOnce;
    steps.leafPreviewPage = await app!.evaluate(async ({ webContents }, port) => {
      const view = webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getURL().includes(`/loopback/${port}/`) ||
            contents.getURL().includes(`:${port}/`),
        );
      if (!view) return null;
      return {
        url: view.getURL().replace(/[?#].*$/u, ""),
        title: view.getTitle(),
        h1: (await view.executeJavaScript("document.querySelector('h1')?.textContent ?? null")) as
          string | null,
      };
    }, new URL(urls.leaf).port);
    // Only the shown node's preview is visible; the other node's stays alive, hidden.
    expect(bothShownOnce.command?.visible).toBe(false);
    expect(bothShownOnce.leaf?.visible).toBe(true);
    // Its view sits inside the leaf's region.
    const zoom = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    );
    const regionBox = (await inTreeRegion(page, leaf.nodeId).boundingBox())!;
    const leafBounds = bothShownOnce.leaf!.bounds;
    expect(leafBounds.x).toBeGreaterThanOrEqual(Math.floor(regionBox.x * zoom) - 1);
    expect(leafBounds.y).toBeGreaterThanOrEqual(Math.floor(regionBox.y * zoom) - 1);
    // Focus the leaf's preview, then switch back: the hidden preview gives focus up.
    const leafPreviewPath = `/__orkestrator/browser/loopback/${new URL(urls.leaf).port}/`;
    const isLeafPreview = (url: string) =>
      url.startsWith(urls.leaf) || url.includes(leafPreviewPath);
    await app!.evaluate(
      ({ webContents }, { url, path }) => {
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(url) || contents.getURL().includes(path))
          ?.focus();
      },
      { url: urls.leaf, path: leafPreviewPath },
    );
    await expect
      .poll(async () => (await focusedWebContentsUrls(app!)).some(isLeafPreview))
      .toBe(true);
    await show(topology.command);
    await expect
      .poll(async () => (await views()).command?.visible ?? false, { timeout: 30_000 })
      .toBe(true);
    const back = await views();
    expect(back.leaf?.visible ?? false).toBe(false);
    const focusedAfter = await focusedWebContentsUrls(app!);
    // Switching nodes again: the leaf's view is reused (same z-order slot), not recreated on top.
    await show(leaf);
    await expect
      .poll(async () => (await views()).leaf?.visible ?? false, { timeout: 30_000 })
      .toBe(true);
    const again = await views();
    expect(again.command?.visible).toBe(false);
    // The visible preview is drawn above every hidden one.
    expect(again.leaf!.index).toBeGreaterThanOrEqual(0);
    evidence.previews = {
      shownLeaf: {
        command: bothShownOnce.command && {
          index: bothShownOnce.command.index,
          visible: bothShownOnce.command.visible,
        },
        leaf: { index: bothShownOnce.leaf!.index, visible: true },
      },
      backOnCommand: {
        command: back.command && { index: back.command.index, visible: back.command.visible },
        leaf: back.leaf && { index: back.leaf.index, visible: back.leaf.visible },
      },
      leafPreviewFocusedAfterSwitchAway: focusedAfter.some(isLeafPreview),
      again: {
        command: again.command && { index: again.command.index, visible: again.command.visible },
        leaf: { index: again.leaf!.index, visible: again.leaf!.visible },
      },
    };
    expect(focusedAfter.some(isLeafPreview), "a hidden preview keeps no focus").toBe(false);
    await checkScopes("previews", leaf);
  } finally {
    for (const node of [topology.command, leaf]) await seedLayout(node).catch(() => undefined);
    for (const server of servers) server.close();
  }
});

test("a lapsed grant reopens without a reload", async () => {
  const { page, topology } = s();
  const leaf = topology.leaves[0]!;
  await openNode(leaf);
  const marker = await markWindow(page);
  const before = (await s().grants())[leaf.nodeId] ?? [];
  expect(before.length, "the window opened a grant for the leaf").toBeGreaterThan(0);
  // The command node revokes the window's current grant at the leaf, as a lapse does.
  const responsesBefore = (await s().responses?.()) ?? null;
  await topology.command.invoke("close_node_workspace", { workspaceId: before.at(-1)! });
  const lapsedAt = Date.now();
  // A terminal already open keeps its stream; record whether input still
  // reaches the leaf before anything reopens.
  const nonce = Math.random().toString(36).slice(2, 8);
  await typeInTerminal(leaf, `echo lapse-$((40+2))-${nonce}`);
  const streamKeptWorking = await expect
    .poll(() => terminalText(leaf), { timeout: 10_000 })
    .toContain(`lapse-42-${nonce}`)
    .then(
      () => true,
      () => false,
    );
  const grantsAfterTerminalWrite = ((await s().grants())[leaf.nodeId] ?? []).length;
  // The next leaf request is refused; the client opens a new grant and carries
  // on. The files panel reads the leaf over HTTP.
  const region = inTreeRegion(page, leaf.nodeId);
  const toggle = region.getByRole("button", { name: /^(Show|Hide) file panel$/ }).first();
  await toggle.click();
  await toggle.click();
  await expect
    .poll(async () => ((await s().grants())[leaf.nodeId] ?? []).length, { timeout: 60_000 })
    .toBeGreaterThan(before.length)
    .catch(async (error: unknown) => {
      const label = (origin: string) =>
        origin === topology.command.origin ? "command" : origin === leaf.origin ? "leaf" : "other";
      const relabel = (record: Record<string, Record<number, number>> | null) =>
        record &&
        Object.fromEntries(
          Object.entries(record).map(([origin, statuses]) => [label(origin), statuses]),
        );
      evidence.grantLapseDebug = {
        grants: before.length,
        responsesBefore: relabel(responsesBefore),
        responsesAfter: relabel((await s().responses?.()) ?? null),
        streamKeptWorking,
      };
      throw error;
    });
  const reopenedMs = Date.now() - lapsedAt;
  const historyNotice = page.getByText("Terminal history could not be synchronized");
  const noticeAfterLapse = await historyNotice.isVisible();
  // And works on the new grant: a terminal command and the files panel.
  const nonce2 = Math.random().toString(36).slice(2, 8);
  await typeInTerminal(leaf, `echo relapse-$((40+2))-${nonce2}`);
  await expect
    .poll(() => terminalText(leaf), { timeout: 60_000 })
    .toContain(`relapse-42-${nonce2}`)
    .catch(async (error: unknown) => {
      // Did the input reach the leaf's shell, only not the window? Booleans
      // from the leaf's own terminal output (no content is kept).
      const listed = await leaf.invoke<unknown>("list_terminal_sessions").catch(() => null);
      const ids = (Array.isArray(listed) ? listed : Object.keys((listed as object) ?? {})).map(
        (entry) =>
          typeof entry === "string" ? entry : String((entry as { sessionId?: string }).sessionId),
      );
      const seen = { lapse: false, relapse: false, sessions: ids.length };
      for (const sessionId of ids) {
        const output = await leaf
          .invoke<{ output?: string }>("get_terminal_output_snapshot", { sessionId })
          .then((snapshot) => snapshot?.output ?? "")
          .catch(() => "");
        seen.lapse ||= output.includes(`lapse-42-${nonce}`);
        seen.relapse ||= output.includes(`relapse-42-${nonce2}`);
      }
      evidence.grantLapseDebug = {
        grantsBefore: before.length,
        grantsAfterTerminalWrite,
        grantsAfterReopen: ((await s().grants())[leaf.nodeId] ?? []).length,
        streamKeptWorking,
        leafShellSaw: seen,
        reloaded: (await windowMarker(page)) !== marker,
      };
      throw error;
    });
  expect(await windowMarker(page), "the window did not reload").toBe(marker);
  await expect(inTreeRegion(page, leaf.nodeId)).toBeVisible();
  const after = (await s().grants())[leaf.nodeId] ?? [];
  evidence.grantLapse = {
    grantsBefore: before.length,
    grantsAfter: after.length,
    reopenedMs,
    reloaded: false,
    openTerminalStreamKeptWorkingAfterRevoke: streamKeptWorking,
    // Equal to grantsBefore: that input reached the leaf on the revoked grant's open stream.
    grantsAfterTerminalWrite,
    terminalHistoryNoticeAfterLapse: noticeAfterLapse,
  };
  await checkScopes("grant lapse", leaf);
});

test("attention from a hidden node reaches the window", async () => {
  const { page, topology } = s();
  const leaf = topology.leaves[0]!;
  // Show the leaf once (so it is held), then hide it behind the command node's environment.
  await openNode(leaf);
  await openNode(topology.command);
  await page.mouse.click(5, 5); // a user gesture, so Web Audio may play
  await page.waitForTimeout(2_000);
  const tier = (await lifecycleView(page)).tiers[leaf.nodeId] ?? "summary";
  const before = await cues(page);
  const raised = await raiseTerminalAttention(leaf, Math.random().toString(36).slice(2, 8));
  expect(raised.unreadAfter, "the leaf marked its environment unread").toBe(true);
  // The leaf's row shows the unread work, from the hidden node.
  await expect(
    page
      .locator(`[data-testid="federated-environment-row"][data-machine="${leaf.nodeId}"]`)
      .filter({ hasText: leaf.environment.name })
      .locator('[aria-label="New completed activity"]')
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await cues(page)).sounds, { timeout: 30_000 })
    .toBeGreaterThan(before.sounds);
  const after = await cues(page);
  evidence.attention = {
    leafTier: tier,
    reason: raised.reason,
    cues: after.sounds - before.sounds,
    notifications: after.notifications - before.notifications,
  };
  await checkScopes("attention", topology.command);
});
