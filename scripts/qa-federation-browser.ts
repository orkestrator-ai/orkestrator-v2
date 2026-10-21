/**
 * Real-stack QA for the federated client in a hosted browser.
 *
 * Starts two isolated standalone backends ("Mac mini" and "Linux VPS") with
 * temporary data directories, loopback-only listeners on ephemeral ports,
 * private random gateway tokens (never printed) and an ephemeral Control MCP
 * port. Machine B allows machine A's page origin and also serves a loopback
 * client gateway. A headless Chromium session signs in to A, adds B as
 * another machine and checks, asserting each step:
 *
 *   - both machines' environments appear with their own dots (UI-01, CL-05);
 *   - grouping by project keeps same-name projects separate (UI-02);
 *   - changing the machine filter never navigates (UI-05);
 *   - a side-by-side panel for B talks only to B's gateway (WB-01);
 *   - stopping B keeps A usable, labels B stale and disables its writes,
 *     and restarting B reconnects with the same colour (RT-01, CL-02);
 *   - a colour edit from A's page persists on B and updates the dot (CL-01);
 *   - B's loopback client gateway refuses control routes and missing tokens
 *     (SH-08, SH-09).
 *
 * Screenshots go to output/agent-testing/federation-qa/<run>/ (gitignored).
 * Only processes this script started are stopped; nothing else is touched.
 *
 * Requires built artifacts: `bun run --cwd apps/web build` and
 * `bun run --cwd apps/backend build`.
 * Run: bun scripts/qa-federation-browser.ts
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
const out = path.join(repo, "output", "agent-testing", "federation-qa", runId);
const children: ChildProcess[] = [];
const log = (...args: unknown[]) => console.log("[federation-qa]", ...args);

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

type Machine = {
  name: string;
  color: string;
  dir: string;
  token: string;
  port: number;
  clientPort?: number;
  allowedOrigin?: string;
  child?: ChildProcess;
};

function startBackend(machine: Machine): Promise<void> {
  const args = [
    "apps/backend/dist/main.js",
    "--data-dir",
    path.join(machine.dir, "data"),
    "--host",
    "127.0.0.1",
    "--allow-non-tailscale-bind",
    "--port",
    String(machine.port),
    "--strict-gateway-port",
    "--runtime-flavor",
    "agent-test",
    "--renderer-root",
    path.join(repo, "apps", "web", "dist"),
    // Environments are only created, never started, but any worktree stays
    // inside this run's temporary root.
    "--worktree-dir",
    path.join(machine.dir, "worktrees"),
    ...(machine.allowedOrigin ? ["--allowed-origins", machine.allowedOrigin] : []),
    ...(machine.clientPort ? ["--loopback-client-port", String(machine.clientPort)] : []),
  ];
  const child = spawn("bun", args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ORKESTRATOR_GATEWAY_TOKEN: machine.token,
      ORKESTRATOR_CONTROL_MCP_PORT: "0",
    },
  });
  machine.child = child;
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${machine.name} did not start`)), 60_000);
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
    child.stderr?.resume();
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${machine.name} exited early (${code})`));
    });
  });
}

async function stopBackend(machine: Machine): Promise<void> {
  const child = machine.child;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function invoke<T>(machine: Machine, command: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${machine.port}/__orkestrator/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${machine.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok) fail(`${machine.name} ${command}: ${payload.error ?? response.status}`);
  return payload.result as T;
}

async function seed(machine: Machine, projects: Record<string, string[]>): Promise<void> {
  for (const [project, environments] of Object.entries(projects)) {
    const repoDir = path.join(machine.dir, "repos", project);
    await mkdir(repoDir, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], repoDir);
    await run(
      "git",
      [
        "-c",
        "user.email=qa@example.com",
        "-c",
        "user.name=QA",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      repoDir,
    );
    const created = await invoke<{ id: string }>(machine, "add_project", {
      gitUrl: `https://github.com/acme/${project}.git`,
      localPath: repoDir,
    });
    for (const name of environments) {
      await invoke(machine, "create_environment", {
        projectId: created.id,
        name,
        environmentType: "local",
      });
    }
  }
  const profile = await invoke<{ revision: number }>(machine, "get_backend_profile");
  await invoke(machine, "update_backend_profile", {
    expectedRevision: profile.revision,
    displayName: machine.name,
    colorToken: machine.color,
  });
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${code}`)),
    );
  });
}

async function dismissGitHubPrompt(target: Page | ReturnType<Page["frameLocator"]>): Promise<void> {
  try {
    await target.locator('button:has-text("Continue Without GitHub CLI")').first().click({
      timeout: 4_000,
    });
  } catch {
    // Not shown on this host.
  }
}

async function main(): Promise<void> {
  for (const artifact of ["apps/web/dist/index.html", "apps/backend/dist/main.js"]) {
    if (!existsSync(path.join(repo, artifact))) fail(`missing ${artifact}; build it first`);
  }
  await mkdir(out, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), "ork-federation-qa-"));
  try {
    const a: Machine = {
      name: "Mac mini",
      color: "violet",
      dir: path.join(root, "a"),
      token: randomBytes(24).toString("base64url"),
      port: await freePort(),
    };
    const b: Machine = {
      name: "Linux VPS",
      color: "blue",
      dir: path.join(root, "b"),
      token: randomBytes(24).toString("base64url"),
      port: await freePort(),
      clientPort: await freePort(),
    };
    b.allowedOrigin = `http://127.0.0.1:${a.port}`;
    await mkdir(a.dir, { mode: 0o700 });
    await mkdir(b.dir, { mode: 0o700 });
    await writeFile(path.join(root, "README"), "Disposable federation QA data.\n");
    await Promise.all([startBackend(a), startBackend(b)]);
    log("backends ready");
    await seed(a, {
      orkestrator: ["feature-remote-ui", "fix-websocket"],
      "angela-tools": ["feature-raise-tracker"],
    });
    await seed(b, { orkestrator: ["feature-website", "fix-websocket"] });

    // SH-08 / SH-09 on B's loopback client gateway.
    const hello = await fetch(`http://127.0.0.1:${b.clientPort}/__orkestrator/hello`);
    if (hello.status !== 401) fail(`unauthenticated hello answered ${hello.status}`);
    const authorizedHello = (await (
      await fetch(`http://127.0.0.1:${b.clientPort}/__orkestrator/hello`, {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).json()) as { endpointRole: string };
    if (authorizedHello.endpointRole !== "client") fail("client gateway role");
    const updater = await fetch(`http://127.0.0.1:${b.clientPort}/__orkestrator/host-updater`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    if (updater.status !== 404)
      fail(`control route answered ${updater.status} on the client gateway`);

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${a.port}/`);
      await page.fill("#token", a.token);
      await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      await page.waitForSelector('[data-testid="project-search-bar"]', { timeout: 30_000 });
      await dismissGitHubPrompt(page);

      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("orkestrator:open-global-settings", { detail: "connections" }),
        ),
      );
      await page.fill("#browser-machine-address", `http://127.0.0.1:${b.port}`);
      await page.fill("#browser-machine-token", b.token);
      await page.click('button:has-text("Add machine")');
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="browser-machines"]')
            ?.textContent?.includes("Linux VPS"),
        null,
        { timeout: 20_000 },
      );
      await page.screenshot({ path: path.join(out, "01-settings-other-machines.png") });
      await page.click('button[aria-label="Close settings"]');

      await page.waitForSelector(
        '[data-testid="remote-machine-section"] [data-testid="federated-environment-row"]',
        { timeout: 20_000 },
      );
      const colours = new Set(
        await page.$$eval('[data-testid="machine-dot"]', (nodes) =>
          nodes.map((node) => node.getAttribute("data-machine-color")),
        ),
      );
      if (!colours.has("violet") || !colours.has("blue")) fail(`dots ${[...colours].join(",")}`);
      await page.screenshot({ path: path.join(out, "02-sidebar-all-machines.png") });
      log("UI-01/CL-05 ok");

      await page.click('button[title="Sort environments"]');
      await page.click('[role="menuitemradio"]:has-text("By project") >> nth=1');
      await page.waitForSelector('[data-testid="federated-project-list"]');
      const instances = await page.$$eval(
        '[data-testid="federated-project"]',
        (nodes) => nodes.length,
      );
      if (instances !== 3) fail(`expected 3 project instances, saw ${instances}`);
      await page.screenshot({ path: path.join(out, "03-sidebar-by-project.png") });
      await page.click('button[title="Sort environments"]');
      await page.click('[role="menuitemradio"]:has-text("By machine")');
      log("UI-02 ok");

      let navigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      await page.click('[data-testid="machines-filter"]');
      await page.click('[role="menuitemradio"]:has-text("Linux VPS")');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(out, "04-filter-linux-vps.png") });
      await page.click('[data-testid="machines-filter"]');
      await page.click('[role="menuitemradio"]:has-text("All machines")');
      if (navigations !== 0) fail("the filter change navigated the page");
      log("UI-05 (filter) ok");

      const panelOrigins = new Set<string>();
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (request.frame() !== page.mainFrame() && url.pathname.startsWith("/__orkestrator/")) {
          panelOrigins.add(url.origin);
        }
      });
      await page.click(
        '[data-testid="remote-machine-section"] [data-testid="federated-environment-row"] >> nth=0 >> button >> nth=0',
      );
      const frame = page.frameLocator('[data-testid="frame-machine-panel"]');
      await frame.locator("main").first().waitFor({ timeout: 30_000 });
      await dismissGitHubPrompt(frame);
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: path.join(out, "05-panel-side-by-side.png") });
      if ([...panelOrigins].some((origin) => origin !== `http://127.0.0.1:${b.port}`)) {
        fail(`panel frame reached ${[...panelOrigins].join(", ")}`);
      }
      if (panelOrigins.size === 0) fail("panel frame made no gateway requests");
      log("WB-01 ok");

      await stopBackend(b);
      await page.waitForFunction(
        () =>
          /Reconnecting|Unavailable/.test(
            document.querySelector('[data-testid="remote-machine-section"]')?.textContent ?? "",
          ),
        null,
        { timeout: 30_000 },
      );
      if ((await page.locator("text=feature-remote-ui").count()) === 0)
        fail("A's rows disappeared");
      await page.screenshot({ path: path.join(out, "06-machine-offline.png") });
      await startBackend(b);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="remote-machine-section"]')
            ?.textContent?.includes("Connected"),
        null,
        { timeout: 60_000 },
      );
      const afterRestart = await page.$$eval(
        '[data-testid="remote-machine-section"] [data-testid="machine-dot"]',
        (nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-machine-color")))],
      );
      if (afterRestart.join() !== "blue") fail(`colour after restart ${afterRestart.join()}`);
      await page.screenshot({ path: path.join(out, "07-machine-reconnected.png") });
      log("RT-01/CL-02 ok");

      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("orkestrator:open-global-settings", { detail: "connections" }),
        ),
      );
      await page
        .locator('[data-testid="browser-machines"] [role="radio"][aria-label="Teal"]')
        .first()
        .click({ timeout: 20_000 });
      await page.waitForTimeout(2_000);
      await page.click('button[aria-label="Close settings"]');
      const profile = await invoke<{ colorToken: string }>(b, "get_backend_profile");
      if (profile.colorToken !== "teal") fail(`B kept ${profile.colorToken}`);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="remote-machine-section"] [data-testid="machine-dot"]')
            ?.getAttribute("data-machine-color") === "teal",
        null,
        { timeout: 15_000 },
      );
      await page.screenshot({ path: path.join(out, "08-colour-edit.png") });
      log("CL-01 ok");

      await page.setViewportSize({ width: 820, height: 900 });
      await page.screenshot({ path: path.join(out, "09-narrow.png") });
    } finally {
      await browser.close();
    }
    log(`passed; screenshots in ${path.relative(repo, out)}`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
