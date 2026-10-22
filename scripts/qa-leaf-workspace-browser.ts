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
 * step, that clicking a Leaf environment moves the tab itself to Leaf, as if
 * it had connected to Leaf directly (no panel, frame or second app), that the
 * sidebar then lists Desk from its self summary, and that clicking a Desk
 * environment moves the tab back.
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
  fail(`timed out waiting for ${label}`);
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

      // Opening Leaf's environment moves the tab itself to Leaf.
      requests.length = 0;
      await Promise.all([
        page.waitForNavigation({ timeout: 30_000, waitUntil: "domcontentloaded" }),
        page.click(`${leafRow} button >> nth=0`),
      ]);
      await page.waitForSelector('[data-testid="project-search-bar"]', { timeout: 30_000 });
      await dismissStartupPrompts(page);
      const target = await page.evaluate(() => window.orkestratorWorkspaceTarget ?? null);
      if (target?.nodeId !== leafId) fail(`workspace target ${JSON.stringify(target)}`);
      log(`tab moved to Leaf (${target.path})`);
      if ((await page.locator("iframe").count()) !== 0) fail("a frame was opened");
      await page.waitForFunction(() => document.title.includes("leaf-app"), null, {
        timeout: 30_000,
      });
      log(`title: ${await page.title()}`);
      const deskRow = `[data-testid="federated-environment-row"][data-machine="${deskId}"]`;
      await page.waitForSelector(deskRow, { timeout: 30_000 });
      if ((await page.locator(leafRow).count()) !== 0) {
        fail("Leaf is still listed as another machine");
      }
      await page.screenshot({ path: path.join(out, "02-tab-on-leaf.png") });

      // Workspace traffic goes to Leaf (directly or through Desk's relay);
      // only the portal stays on Desk.
      const leafTraffic = requests.filter(
        (url) => url.startsWith(origin(leaf)) || url.includes(`/__orkestrator/nodes/${leafId}/`),
      );
      if (leafTraffic.length === 0) fail("no request reached Leaf");
      log(`${leafTraffic.length} requests reached Leaf; ${requests.length} in total`);

      // The clicked environment is visible and selected in Leaf's own tree,
      // and a local environment starts on selection as it does on Desk.
      await page.waitForFunction(
        () => document.querySelector("aside, nav, body")?.textContent?.includes("leaf-env"),
        null,
        { timeout: 30_000 },
      );
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

      // Work and a pending input remain owned by Leaf while the tab is on Desk.
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

      // Opening Desk's environment moves the tab back.
      await Promise.all([
        page.waitForNavigation({ timeout: 30_000, waitUntil: "domcontentloaded" }),
        page.click(`${deskRow} button >> nth=0`),
      ]);
      await page.waitForSelector('[data-testid="project-search-bar"]', { timeout: 30_000 });
      const back = await page.evaluate(() => window.orkestratorWorkspaceTarget ?? null);
      if (back) fail(`still on ${JSON.stringify(back)}`);
      await page.waitForFunction(() => document.title.includes("desk-app"), null, {
        timeout: 30_000,
      });
      await page.waitForSelector(leafRow, { timeout: 30_000 });
      await page.screenshot({ path: path.join(out, "03-tab-back-on-desk.png") });
      // The same start-on-selection happened for Desk's environment, so both
      // nodes treat a click the same way.
      const deskStarted = await until(
        "Desk's environment to start",
        () =>
          invoke<Array<{ id: string; status: string; worktreePath?: string; setupError?: string }>>(
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
      await dismissStartupPrompts(page);
      await writeFile(gate, "finish");
      const finishedLine = (output: string, text: string) =>
        output.split(/\r?\n/).some((line) => line.trim() === text);
      await until(
        "Leaf finishes in background and waits for input",
        () =>
          invoke<{ output: string }>(leaf, "get_terminal_output_snapshot", {
            sessionId: terminal.sessionId,
          }),
        (snapshot) => finishedLine(snapshot.output, "leaf-background-finished"),
      );
      await invoke(leaf, "set_environment_unread", {
        environmentId: leafEnvironment,
        unread: true,
      });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click(`${leafRow} button >> nth=0`),
      ]).catch(async (error) => {
        await page.screenshot({ path: path.join(out, "return-leaf-failure.png") });
        log("return notices:", await page.locator("[data-sonner-toast]").allTextContents());
        throw error;
      });
      await page.waitForSelector('[data-testid="project-search-bar"]');
      await dismissStartupPrompts(page);
      await page.reload();
      await page.waitForSelector('[data-testid="project-search-bar"]');
      await dismissStartupPrompts(page);
      const rehydrated = await page.evaluate(async (sessionId) => {
        return window.orkestrator!.invoke<{ output: string; mode: string }>(
          "get_terminal_state_snapshot",
          { sessionId },
        );
      }, terminal.sessionId);
      if (!rehydrated || !rehydrated.output.includes("leaf-background-finished"))
        fail("background transcript did not rehydrate");
      // Pending terminal input is still actionable after returning and reloading.
      await page.evaluate(async (sessionId) => {
        await window.orkestrator!.invoke("local_terminal_write", { sessionId, data: "resumed\n" });
      }, terminal.sessionId);
      await until(
        "rehydrated input control works",
        () =>
          invoke<{ output: string }>(leaf, "get_terminal_output_snapshot", {
            sessionId: terminal.sessionId,
          }),
        (snapshot) => finishedLine(snapshot.output, "leaf-input-resumed"),
      );
      const returnedEnvironment = await page.evaluate(
        async (environmentId) =>
          window.orkestrator!.invoke<{ status: string }>("get_environment", { environmentId }),
        leafEnvironment,
      );
      if (returnedEnvironment.status === "stopped") fail("Leaf work stopped while inactive");
      await invoke(leaf, "close_local_terminal_session", { sessionId: terminal.sessionId });
      log("background status, transcript and pending input survived switch and reload");

      // Removing the only registered leaf must leave Desk's return path usable.
      await invoke(desk, "forget_node", { nodeId: leafId });
      await page.waitForSelector(deskRow, { timeout: 30_000 });
      await page.reload();
      await page.waitForSelector(deskRow, { timeout: 30_000 });
      await dismissStartupPrompts(page);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click(`${deskRow} button >> nth=0`),
      ]);
      await page.waitForSelector('[data-testid="project-search-bar"]');
      if (await page.evaluate(() => Boolean(window.orkestratorWorkspaceTarget)))
        fail("return after final leaf removal failed");
      log("final leaf removal kept a working command-node return route");
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
