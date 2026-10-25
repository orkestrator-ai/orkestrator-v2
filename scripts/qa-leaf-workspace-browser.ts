/**
 * Real-stack QA: opening a leaf environment in a hosted browser.
 *
 * Starts two isolated backends from source with temporary data
 * directories, loopback listeners on ephemeral ports and private random
 * gateway tokens (never printed):
 *
 *   - Desk: the command node (--command-node), serving the web client;
 *   - Leaf: a standalone node Desk attaches.
 *
 * A headless Chromium session signs in to Desk and checks, asserting each
 * step, that clicking a Leaf environment shows Leaf's workspace in the
 * central region (a realm frame on a grant the tab keeps, never in a URL)
 * while the page itself stays on Desk and never reloads; that the realm
 * starts the environment as Leaf's own sidebar would; that clicking a Desk
 * environment brings the central region back without closing Leaf's realm;
 * and that Leaf's work, transcript and pending input survive all of it.
 *
 * Screenshots go to output/agent-testing/leaf-workspace-qa/<run>/ (gitignored).
 * Only processes this script started are stopped; nothing else is touched.
 *
 * Requires the built web client: `bun run --cwd apps/web build`.
 * Run: bun scripts/qa-leaf-workspace-browser.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const repo = path.resolve(import.meta.dir, "..");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(repo, "output", "agent-testing", "leaf-workspace-qa", runId);
const children: ChildProcess[] = [];
const log = (...args: unknown[]) => console.log("[leaf-workspace-qa]", ...args);

function fail(message: string): never {
  throw new Error(`QA assertion failed: ${message}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

type Node = {
  name: string;
  color: string;
  dir: string;
  token: string;
  port: number;
  commandNode: boolean;
  allowedOrigin?: string;
  child?: ChildProcess;
};

const origin = (node: Node) => `http://127.0.0.1:${node.port}`;

function start(node: Node): Promise<void> {
  const args = [
    "apps/backend/src/main.ts",
    "--data-dir",
    path.join(node.dir, "data"),
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--port",
    String(node.port),
    "--strict-gateway-port",
    "--runtime-flavor",
    "agent-test",
    "--renderer-root",
    path.join(repo, "apps", "web", "dist"),
    "--worktree-dir",
    path.join(node.dir, "worktrees"),
    ...(node.commandNode ? ["--command-node"] : []),
    ...(node.allowedOrigin ? ["--allowed-origins", node.allowedOrigin] : []),
  ];
  const child = spawn("bun", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ORKESTRATOR_GATEWAY_TOKEN: node.token,
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    },
  });
  node.child = child;
  children.push(child);
  child.stderr?.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${node.name} did not start`)), 90_000);
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n").slice(0, -1)) {
        if (line.includes('"orkestrator-backend-ready"')) {
          clearTimeout(timer);
          resolve();
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${node.name} exited early (${code})`));
    });
  });
}

async function stop(node: Node): Promise<void> {
  const child = node.child;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function invoke<T>(node: Node, command: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${origin(node)}/__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok) fail(`${node.name} ${command}: ${payload.error ?? response.status}`);
  return payload.result as T;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${code}`)),
    );
  });
}

type Seeded = { projectId: string; environmentId: string };

async function seed(node: Node, project: string, environment: string): Promise<Seeded> {
  const repoDir = path.join(node.dir, "repos", project);
  await mkdir(repoDir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], repoDir);
  await run(
    "git",
    ["-c", "user.email=qa@example.com", "-c", "user.name=QA"].concat([
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]),
    repoDir,
  );
  const originPath = path.join(node.dir, "repos", `${project}.git`);
  await run("git", ["init", "--bare", "-b", "main", originPath], node.dir);
  await run("git", ["remote", "add", "origin", originPath], repoDir);
  await run("git", ["push", "-u", "origin", "main"], repoDir);
  const created = await invoke<{ id: string }>(node, "add_project", {
    gitUrl: originPath,
    localPath: repoDir,
  });
  const env = await invoke<{ id: string }>(node, "create_environment", {
    projectId: created.id,
    name: environment,
    environmentType: "local",
  });
  const profile = await invoke<{ revision: number }>(node, "get_backend_profile");
  await invoke(node, "update_backend_profile", {
    expectedRevision: profile.revision,
    displayName: node.name,
    colorToken: node.color,
  });
  return { projectId: created.id, environmentId: env.id };
}

async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean) {
  const deadline = Date.now() + 60_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch {
      // Not yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`timed out waiting for ${label}; last: ${JSON.stringify(last)?.slice(-600)}`);
}

async function dismissStartupPrompts(page: Page): Promise<void> {
  for (const label of ["Continue Without GitHub CLI", "Continue anyway", "Dismiss"]) {
    try {
      await page.locator(`button:has-text("${label}")`).first().click({ timeout: 2_000 });
    } catch {
      // Not shown on this host.
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(repo, "apps/web/dist/index.html"))) {
    fail("missing apps/web/dist; run `bun run --cwd apps/web build` first");
  }
  await mkdir(out, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), "ork-leaf-workspace-qa-"));
  const desk: Node = {
    name: "Desk",
    color: "violet",
    dir: path.join(root, "desk"),
    token: randomBytes(24).toString("base64url"),
    port: await freePort(),
    commandNode: true,
  };
  const leaf: Node = {
    name: "Leaf",
    color: "blue",
    dir: path.join(root, "leaf"),
    token: randomBytes(24).toString("base64url"),
    port: await freePort(),
    commandNode: false,
  };
  leaf.allowedOrigin = origin(desk);
  try {
    await mkdir(desk.dir, { mode: 0o700 });
    await mkdir(leaf.dir, { mode: 0o700 });
    await Promise.all([start(desk), start(leaf)]);
    log("backends ready");
    const deskSeed = await seed(desk, "desk-app", "desk-env");
    const leafSeed = await seed(leaf, "leaf-app", "leaf-env");
    const leafEnvironment = leafSeed.environmentId;
    const leafId = (await invoke<{ nodeId: string }>(leaf, "get_node_status")).nodeId;
    const deskId = (await invoke<{ nodeId: string }>(desk, "get_node_status")).nodeId;
    await invoke(desk, "add_node", {
      routes: [{ id: "loopback", kind: "https", enabled: true, origin: origin(leaf) }],
      token: leaf.token,
    });
    await until(
      "Leaf's environments in Desk's portal",
      () => invoke<{ nodes: Array<{ environments: unknown[] }> }>(desk, "get_node_summaries"),
      (value) => value.nodes.some((node) => node.environments.length > 0),
    );
    log("Leaf attached to Desk");

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (error) => log("renderer error:", error.message.slice(0, 300)));

      const requests: string[] = [];
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.includes("/__orkestrator/")) requests.push(`${url.origin}${url.pathname}`);
      });
      await page.goto(`${origin(desk)}/`);
      await page.fill("#token", desk.token);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.keyboard.press("Enter"),
      ]);
      await page
        .waitForSelector('[data-testid="project-search-bar"]', { timeout: 30_000 })
        .catch(async (error) => {
          await page.screenshot({
            path: path.join(out, "startup-failure.png"),
            mask: [page.locator("#token")],
          });
          throw error;
        });
      await dismissStartupPrompts(page);

      const leafRow = `[data-testid="federated-environment-row"][data-machine="${leafId}"]`;
      await page.waitForSelector(leafRow, { timeout: 30_000 });
      await page.screenshot({ path: path.join(out, "01-desk-portal.png") });

      // A reload of the page would drop this marker.
      await page.evaluate(() => {
        (window as unknown as { __qaPage?: number }).__qaPage = 1;
      });
      const samePage = async (step: string) => {
        const marker = await page.evaluate(
          () => (window as unknown as { __qaPage?: number }).__qaPage ?? null,
        );
        if (marker !== 1) fail(`the page reloaded (${step})`);
        const target = await page.evaluate(() => window.orkestratorWorkspaceTarget ?? null);
        if (target) fail(`the page moved to ${JSON.stringify(target)} (${step})`);
      };
      const realmFrame = 'iframe[title^="Workspace on "]';

      // Opening Leaf's environment shows Leaf's workspace in the central region.
      requests.length = 0;
      await page
        .locator(leafRow)
        .getByRole("button", { name: /^leaf-env, on / })
        .click();
      const frameHandle = await page.waitForSelector(realmFrame, { timeout: 30_000 });
      await samePage("opening Leaf");
      const frameUrl = new URL((await frameHandle.getAttribute("src")) ?? "");
      if (frameUrl.origin !== origin(desk)) fail(`realm served from ${frameUrl.origin}`);
      if (frameUrl.searchParams.get("realm") !== "workspace") fail(`realm URL ${frameUrl}`);
      if (/okg_|token/i.test(frameUrl.toString())) fail("a grant reached the realm's URL");
      const frame = await frameHandle.contentFrame();
      if (!frame) fail("no realm frame");
      await frame.waitForSelector("[data-mobile-toolbar]", { timeout: 30_000 });
      const realmTarget = await frame.evaluate(() => window.orkestratorWorkspaceTarget ?? null);
      if (realmTarget?.nodeId !== leafId) fail(`realm target ${JSON.stringify(realmTarget)}`);
      log(`Leaf's workspace in the central region (${realmTarget.path})`);
      if ((await frame.locator('[data-testid="project-search-bar"]').count()) !== 0) {
        fail("the realm shows a sidebar of its own");
      }
      await page.waitForFunction(() => document.title.includes("leaf-app"), null, {
        timeout: 30_000,
      });
      log(`title: ${await page.title()}`);
      await page.waitForSelector(`${leafRow}[data-selected="true"]`, { timeout: 30_000 });
      await page.screenshot({ path: path.join(out, "02-leaf-in-central-region.png") });

      // The machines menu still names Desk as the command node.
      await page.click('[data-testid="machines-filter"]');
      const commandNodeName = await page
        .locator('[data-testid="command-node-name"]')
        .textContent({ timeout: 10_000 });
      if (commandNodeName?.trim() !== "Desk") fail(`command node shown as ${commandNodeName}`);
      await page.keyboard.press("Escape");
      log("machines menu names Desk as the command node");

      // Settings changed on Desk apply on Leaf.
      const deskConfig = await invoke<{ global: Record<string, unknown> }>(desk, "get_config");
      await invoke(desk, "update_global_config", {
        global: { ...deskConfig.global, terminalScrollback: 4321 },
      });
      await until(
        "Leaf to use Desk's settings",
        () => invoke<{ global: { terminalScrollback?: number } }>(leaf, "get_config"),
        (value) => value.global.terminalScrollback === 4321,
      );
      const leafStatus = await invoke<{ inheritedSettingsFrom?: { controllerId: string } }>(
        leaf,
        "get_node_status",
      );
      if (leafStatus.inheritedSettingsFrom?.controllerId !== deskId) {
        fail(`Leaf follows ${JSON.stringify(leafStatus.inheritedSettingsFrom)}`);
      }
      log("Leaf uses Desk's settings");

      // The realm's traffic goes to Leaf (directly or through Desk's relay).
      const leafTraffic = requests.filter(
        (url) => url.startsWith(origin(leaf)) || url.includes(`/__orkestrator/nodes/${leafId}/`),
      );
      if (leafTraffic.length === 0) fail("no request reached Leaf");
      log(`${leafTraffic.length} requests reached Leaf; ${requests.length} in total`);

      // A local environment starts on selection, as from Leaf's own sidebar.
      const started = await until(
        "Leaf's environment to start",
        () =>
          invoke<Array<{ id: string; status: string; worktreePath?: string }>>(
            leaf,
            "get_environment_snapshots",
            { projectId: leafSeed.projectId },
          ),
        (list) =>
          list.some(
            (entry) =>
              entry.id === leafEnvironment && entry.status === "running" && !!entry.worktreePath,
          ),
      );
      log(
        `Leaf environment: ${JSON.stringify(started.find((entry) => entry.id === leafEnvironment)?.status)}`,
      );
      await frame.waitForFunction(
        () => !document.body.textContent?.includes("Connecting to"),
        null,
        {
          timeout: 30_000,
        },
      );
      await page.screenshot({ path: path.join(out, "02c-leaf-workspace-loaded.png") });

      // Work and a pending input remain owned by Leaf while Desk's is shown.
      const terminal = await invoke<{ sessionId: string }>(leaf, "create_local_terminal_session", {
        environmentId: leafEnvironment,
        terminalKey: "leaf-background-check",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      });
      await invoke(leaf, "start_local_terminal_session", { sessionId: terminal.sessionId });
      const gate = path.join(leaf.dir, "finish-background");
      const quotedGate = "'" + gate.replaceAll("'", "'\\''") + "'";
      await invoke(leaf, "local_terminal_write", {
        sessionId: terminal.sessionId,
        data: `while [ ! -f ${quotedGate} ]; do sleep 0.1; done; printf 'leaf-background-finished\\n'; read -r qa_reply; printf 'leaf-input-%s\\n' "$qa_reply"\n`,
      });

      // Opening Desk's environment brings the central region back; Leaf's
      // realm stays open behind it. Desk's own rows are the window's
      // ordinary sidebar rows.
      await page
        .getByRole("button", { name: /desk-env/ })
        .first()
        .click();
      await page.waitForFunction(() => document.title.includes("desk-app"), null, {
        timeout: 30_000,
      });
      await samePage("back to Desk");
      if (!(await page.locator(realmFrame).isHidden())) fail("Leaf's realm still shown");
      if ((await page.locator(realmFrame).count()) !== 1) fail("Leaf's realm was closed");
      await page.screenshot({ path: path.join(out, "03-desk-in-central-region.png") });
      const deskStarted = await until(
        "Desk's environment to start",
        () =>
          invoke<Array<{ id: string; status: string; worktreePath?: string }>>(
            desk,
            "get_environment_snapshots",
            { projectId: deskSeed.projectId },
          ),
        (list) =>
          list.some(
            (entry) =>
              entry.id === deskSeed.environmentId &&
              entry.status === "running" &&
              !!entry.worktreePath,
          ),
      );
      log(
        `back on Desk; its environment: ${JSON.stringify(deskStarted.find((entry) => entry.id === deskSeed.environmentId)?.status)}`,
      );
      await writeFile(gate, "finish");
      // A shell may set the window title on the same line (OSC/CSI sequences).
      const plain = (line: string) =>
        line
          .replace(/\u001b\][^\u0007]*\u0007/g, "")
          .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
          .replace(/\u0007/g, "")
          .trim();
      const finishedLine = (output: string, text: string) =>
        output.split(/\r?\n/).some((line) => plain(line) === text);
      await until(
        "Leaf finishes in background and waits for input",
        () =>
          invoke<{ output: string }>(leaf, "get_terminal_output_snapshot", {
            sessionId: terminal.sessionId,
          }),
        (snapshot) => finishedLine(snapshot.output, "leaf-background-finished"),
      );

      // Back to Leaf: the same realm, no new grant, no reload.
      await page
        .locator(leafRow)
        .getByRole("button", { name: /^leaf-env, on / })
        .click();
      await page.waitForSelector(`${realmFrame}:visible`, { timeout: 30_000 });
      await samePage("returning to Leaf");
      if ((await page.locator(realmFrame).count()) !== 1) fail("a second realm was opened");
      // The realm's own client still reaches the rehydrated terminal.
      const rehydrated = await frame.evaluate(async (sessionId) => {
        return window.orkestrator!.invoke<{ output: string; mode: string }>(
          "get_terminal_state_snapshot",
          { sessionId },
        );
      }, terminal.sessionId);
      if (!rehydrated || !rehydrated.output.includes("leaf-background-finished"))
        fail("background transcript did not rehydrate");
      await frame.evaluate(async (sessionId) => {
        await window.orkestrator!.invoke("local_terminal_write", { sessionId, data: "resumed\n" });
      }, terminal.sessionId);
      await until(
        "the pending input is still actionable",
        () =>
          invoke<{ output: string }>(leaf, "get_terminal_output_snapshot", {
            sessionId: terminal.sessionId,
          }),
        (snapshot) => finishedLine(snapshot.output, "leaf-input-resumed"),
      );
      const leafNow = await invoke<{ status: string }>(leaf, "get_environment", {
        environmentId: leafEnvironment,
      });
      if (leafNow.status === "stopped") fail("Leaf work stopped while not shown");
      await invoke(leaf, "close_local_terminal_session", { sessionId: terminal.sessionId });
      log("background status, transcript and pending input survived switching away and back");

      // A reloaded page is Desk's, and never boots onto a leaf.
      await page.reload();
      await page.waitForSelector('[data-testid="project-search-bar"]', { timeout: 30_000 });
      await dismissStartupPrompts(page);
      if (await page.evaluate(() => Boolean(window.orkestratorWorkspaceTarget)))
        fail("the reloaded page booted onto a leaf");
      log("a reloaded page stays on Desk");
      log(`PASS — screenshots in ${path.relative(repo, out)}`);
    } finally {
      await browser.close();
    }
  } finally {
    await Promise.all([stop(desk), stop(leaf)]);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(async (error: unknown) => {
  console.error("[leaf-workspace-qa]", error instanceof Error ? error.message : error);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
