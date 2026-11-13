/**
 * Two browser clients, backend and bridge restarts at durable transition
 * boundaries, and an older backend, against a real `dev:test` profile with a
 * fake model (todo 0048 task 11,
 * docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md).
 *
 * The provider is the profile's real Claude CLI and bridge, sent to a loopback
 * Anthropic endpoint (`fake-anthropic-model.ts`) through the profile's own
 * isolated `CLAUDE_CONFIG_DIR`, so no turn is billed and no real Claude home
 * is read. The endpoint parks any prompt carrying `[hold:<id>]`, which pins a
 * turn at "the provider is working" across a disconnect or a restart, and
 * counts every call, so a prompt delivered twice shows.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_MULTI_CLIENT=1`): it restarts the
 * profile several times, so run it alone against a credential-free profile of
 * its own:
 *
 *   mise run dev:test --profile q48t11 --fixture --no-agent-credentials --agent-platforms claude --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=q48t11 ORKESTRATOR_AGENT_TEST_LIVE_MULTI_CLIENT=1 \
 *     mise run test:logged -- --name multi-client -- \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     multi-client-restarts-live.spec.ts --workers=1
 *
 * The older-backend case runs first, and only when `ORKESTRATOR_AGENT_TEST_OLDER_BACKEND_URL`
 * and `ORKESTRATOR_AGENT_TEST_OLDER_BACKEND_AUTH_FILE` name a running older
 * backend (its gateway URL and its `gateway-auth.json`), started with
 * `--renderer-dev-server-url` set to this profile's renderer, so the browser
 * runs today's renderer against it. `scripts/older-release-stack.ts backend
 * --tag v2.21.0 --renderer-profile q48t11 --toolchain-bin-dir <the profile's
 * toolchain>` starts one and prints both values. Its Claude CLI must already point at the
 * same fake model (`ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT` fixes the port).
 *
 * Every measurement is a wall-clock interval read in this process, recorded
 * as an annotation and in `evidence-*.json` beside the run. Prompts are
 * fixture strings; no token, transcript or file content reaches output.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { expect, fetchModulesOutsideChromium, test, type Page } from "./browser-test";
import { startOutageLink, type OutageLink } from "./client-outage-support";
import {
  answerFor,
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import { environmentMarkerState } from "./idle-observation-live-support";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  rendererUrl?: string;
  testProject?: string;
  pids?: { backend?: number };
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "q48t11";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_MULTI_CLIENT === "1";
const OLDER_URL = process.env.ORKESTRATOR_AGENT_TEST_OLDER_BACKEND_URL;
const OLDER_AUTH = process.env.ORKESTRATOR_AGENT_TEST_OLDER_BACKEND_AUTH_FILE;
const FAKE_MODEL_PORT = Number(process.env.ORKESTRATOR_AGENT_TEST_FAKE_MODEL_PORT ?? "0");
const TAB_ID = "mc-claude";
/** Rounds of the two-client and queued cases, for a p95 rather than one sample. */
const ROUNDS = Math.max(1, Number(process.env.ORKESTRATOR_AGENT_TEST_MULTI_CLIENT_ROUNDS ?? "1"));
/** docs/architecture/recurring-work.md, "Latency budgets" (p95). */
const BUDGET = {
  turnCompletionMs: 3_000,
  queuedDispatchMs: 3_000,
  activityMs: 4_000,
  watchedDiffMs: 2_000,
} as const;

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(!LIVE, "Set ORKESTRATOR_AGENT_TEST_LIVE_MULTI_CLIENT=1 against a disposable profile");

// ---------------------------------------------------------------------------
// Profile lifecycle

function runtime() {
  return resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" });
}

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(`dev:status for "${profile}" returned no manifest`);
  return JSON.parse(command.stdout) as Status;
}

function readyStatus(): Status {
  const status = profileStatus();
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  return status;
}

function processCommand(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** This profile's backend PID, after confirming the process is that backend. */
function profileBackendPid(status: Status): number {
  const pid = status.pids?.backend;
  expect(pid, "dev:status names no backend pid").toBeTruthy();
  const command = processCommand(pid!);
  expect(
    command.includes("apps/backend/src/main.ts") && command.includes(runtime().dataDir),
    "the recorded backend PID is not this profile's backend",
  ).toBe(true);
  return pid!;
}

/** The Claude bridge the profile's backend spawned: its direct child, by command. */
function claudeBridgePid(status: Status): number {
  const backend = profileBackendPid(status);
  const children = spawnSync("ps", ["-o", "pid=,command=", "--ppid", String(backend)], {
    encoding: "utf8",
  }).stdout;
  const line = children
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes(path.join(repositoryRoot, "bridges/claude-bridge/")));
  expect(line, "the profile's backend has no Claude bridge child").toBeTruthy();
  return Number(line!.split(/\s+/, 1)[0]);
}

function runAsync(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * Stops and starts the profile with the selection in its `profile.json`.
 * `crash` first SIGKILLs this profile's backend (and only it). `--fixture` is
 * not passed back: it would recreate the repository every worktree points at.
 * As in `cold-restart-live.spec.ts`, never `spawnSync` the stop: an earlier
 * restart's launcher is this worker's child and must be reaped.
 */
async function restartProfile(mode: "graceful" | "crash") {
  const startedAt = Date.now();
  const stored = JSON.parse(
    await fs.readFile(path.join(runtime().profileRoot, "profile.json"), "utf8"),
  ) as { credentialSources?: string[]; agentPlatforms?: string[] };
  if (mode === "crash") {
    const backend = profileBackendPid(readyStatus());
    process.kill(backend, "SIGKILL");
    await expect.poll(() => processAlive(backend), { timeout: 10_000 }).toBe(false);
  }
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const stoppedAt = Date.now();
  const args = [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    "--headless",
    ...(stored.credentialSources?.length
      ? ["--credential-source", stored.credentialSources.join(",")]
      : ["--no-agent-credentials"]),
    ...(stored.agentPlatforms?.length
      ? ["--agent-platforms", stored.agentPlatforms.join(",")]
      : []),
  ];
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  const launcher = spawn("bun", args, {
    cwd: repositoryRoot,
    detached: true,
    env: { ...outlivingProcessEnv(), ORKESTRATOR_HOST_REACHABILITY_CHECK: "off" },
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  let status: Status | undefined;
  await expect
    .poll(
      () => {
        status = profileStatus();
        return status.status === "ready" && Boolean(status.browserUrl);
      },
      { timeout: 240_000, intervals: [500] },
    )
    .toBe(true);
  const readyAt = Date.now();
  return { status: status!, readyAt, stopMs: stoppedAt - startedAt, startMs: readyAt - stoppedAt };
}

// ---------------------------------------------------------------------------
// Clients

type Client = {
  label: string;
  context: BrowserContext;
  page: Page;
  link?: OutageLink;
};

function mintLoginUrl(): string {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  return login.loginUrl;
}

async function newClient(
  browser: Browser,
  label: string,
  options: { status: Status; throughLink?: boolean },
): Promise<Client> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fetchModulesOutsideChromium(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const link = options.throughLink
    ? await startOutageLink({
        owner: label,
        gatewayUrl: options.status.browserUrl!,
        rendererUrl: options.status.rendererUrl!,
      })
    : undefined;
  await signIn({ label, context, page, link }, options.status);
  return { label, context, page, link };
}

/** A restart lapses every cookie session by design; a fresh one-shot link signs back in. */
async function signIn(client: Client, status: Status): Promise<void> {
  const login = new URL(mintLoginUrl());
  const base = client.link?.url ?? status.browserUrl!;
  const response = await client.page.goto(new URL(`${login.pathname}${login.search}`, base).href, {
    waitUntil: "domcontentloaded",
  });
  expect(response?.ok() ?? false, `${client.label}: sign-in`).toBe(true);
}

async function closeClient(client: Client | undefined): Promise<void> {
  if (!client) return;
  await client.context.close().catch(() => undefined);
  await client.link?.close().catch(() => undefined);
}

function invokeThrough(page: Page, gatewayUrl: string): Invoke {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", gatewayUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command}: HTTP ${response.status()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** Opens the environment's row in the sidebar; the seeded layout shows the Claude tab. */
async function openEnvironment(page: Page, fixtureName: string, environmentName: string) {
  const expand = page.getByRole("button", { name: `Expand project ${fixtureName}` });
  const entry = page.getByText(environmentName, { exact: true }).first();
  // Startup notices can open before or a moment after the sidebar paints,
  // and hide it from the accessibility tree while open.
  const dialog = page.getByRole("alertdialog");
  // The fake key is not a Claude login, so the startup check reports none.
  // A notice can reopen after a remount, so wait until none has shown for 2 s.
  let quietSince = Date.now();
  const clicks: string[] = [];
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    for (const label of [
      "Continue Without Docker",
      "Continue Without GitHub CLI",
      "Continue Without Claude",
    ]) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.isVisible()) {
        clicks.push(
          await button
            .click({ timeout: 5_000 })
            .then(() => "ok")
            .catch((error: Error) => error.message.split("\n", 1)[0]!.slice(0, 120)),
        );
      }
    }
    if (await dialog.first().isVisible()) quietSince = Date.now();
    else if (!(await expand.or(entry).first().isVisible())) quietSince = Date.now();
    else if (Date.now() - quietSince >= 2_000) break;
    await page.waitForTimeout(200);
  }
  if (await dialog.first().isVisible()) {
    await page
      .screenshot({ path: test.info().outputPath(`blocked-${Date.now()}.png`) })
      .catch(() => undefined);
    const heading = await dialog
      .first()
      .getByRole("heading")
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(
      `An unexpected dialog blocks the sidebar: ${heading ?? "(no heading)"}; dismiss clicks: ${JSON.stringify(clicks.slice(-6))} of ${clicks.length}`,
    );
  }
  await expect(expand.or(entry).first()).toBeVisible({ timeout: 5_000 });
  if (await expand.isVisible()) await expand.click();
  await page.mouse.move(1100, 20);
  await entry.click({ timeout: 15_000 });
  await expect(composer(page)).toBeVisible({ timeout: 90_000 });
}

function composer(page: Page) {
  return page
    .getByTestId("shared-native-compose-bar")
    .getByRole("textbox", { name: /^Message Claude/ });
}

async function send(page: Page, prompt: string): Promise<number> {
  const box = composer(page);
  await box.fill(prompt);
  const button = page
    .getByTestId("shared-native-compose-bar")
    .getByRole("button", { name: "Send", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  const sentAt = Date.now();
  await box.press("Enter");
  await expect(box).toHaveText("", { timeout: 30_000 });
  return sentAt;
}

/** Rendered transcript rows whose text contains `needle`. */
async function rowsWith(page: Page, needle: string): Promise<number> {
  return page
    .evaluate((wanted) => {
      let count = 0;
      for (const row of Array.from(document.querySelectorAll("[data-chat-message-index]"))) {
        if ((row.textContent ?? "").includes(wanted)) count += 1;
      }
      return count;
    }, needle)
    .catch(() => -1);
}

async function activity(page: Page, environmentName: string): Promise<string | null> {
  return page.evaluate(environmentMarkerState, environmentName).catch(() => null);
}

/** The sidebar change badge's text for one environment row, projection or legacy. */
async function badgeText(page: Page, environmentName: string): Promise<string | null> {
  return page
    .evaluate((name) => {
      for (const label of Array.from(document.querySelectorAll("span[id]"))) {
        if (label.textContent !== name) continue;
        const badge = label
          .closest('[role="button"]')
          // An older backend has no projection; its rows show the legacy counts.
          ?.querySelector(
            '[data-testid="environment-change-badge"], [data-testid="environment-diff-stats"]',
          );
        if (badge) return badge.textContent;
      }
      return null;
    }, environmentName)
    .catch(() => null);
}

/** The `+N` additions the change badge shows, or null when it shows none. */
async function badgeAdditions(page: Page, environmentName: string): Promise<number | null> {
  const match = /\+(\d+)/.exec((await badgeText(page, environmentName)) ?? "");
  return match ? Number(match[1]) : null;
}

/** Milliseconds from `since` until `done` first holds; throws after `timeoutMs`. */
async function msUntil(
  since: number,
  done: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return Date.now() - since;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const evidence: Record<string, Record<string, unknown[]>> = {};
const budgets = new Map<string, number>();

/** Adds one observation; a key recorded in several rounds keeps every sample. */
function record(scenario: string, key: string, value: unknown, budgetMs?: number): void {
  ((evidence[scenario] ??= {})[key] ??= []).push(value);
  if (budgetMs !== undefined) budgets.set(`${scenario}:${key}`, budgetMs);
  test.info().annotations.push({
    type: `${scenario}:${key}`,
    description: JSON.stringify(budgetMs === undefined ? value : { ms: value, budgetMs }),
  });
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

/** Numeric samples become n/p50/p95/max, judged against their budget's p95. */
function summarize(): Record<string, Record<string, unknown>> {
  const summary: Record<string, Record<string, unknown>> = {};
  for (const [scenario, keys] of Object.entries(evidence)) {
    for (const [key, values] of Object.entries(keys)) {
      const numbers = values.filter((value): value is number => typeof value === "number");
      const budgetMs = budgets.get(`${scenario}:${key}`);
      (summary[scenario] ??= {})[key] =
        numbers.length === values.length && numbers.length > 0
          ? (() => {
              const sorted = [...numbers].sort((first, second) => first - second);
              const p95 = percentile(sorted, 0.95);
              return {
                n: sorted.length,
                p50: percentile(sorted, 0.5),
                p95,
                max: sorted.at(-1),
                ...(budgetMs === undefined ? {} : { budgetMs, withinP95: p95 <= budgetMs }),
              };
            })()
          : values.length === 1
            ? values[0]
            : values;
    }
  }
  return summary;
}

/**
 * The first public `session.transcript` read after a restart, through the
 * worktree's CLI: row count, freshness and `complete` only.
 */
async function firstTranscriptRead(environmentId: string): Promise<unknown> {
  const cli = (...args: string[]) =>
    spawnSync("bun", ["packages/cli/bin/orkestrator.js", "--profile", profile, ...args, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: test.info().outputPath("cli-config") },
    });
  const listed = JSON.parse(
    cli("session", "list", "--environment", environmentId).stdout || "{}",
  ) as {
    result?: { items?: Array<{ id: string; tabId: string }> };
  };
  const session = listed.result?.items?.find((item) => item.tabId === TAB_ID);
  if (!session) return { unavailable: "no session" };
  const read = JSON.parse(
    cli("session", "transcript", session.id, "--limit", "50").stdout || "{}",
  ) as {
    ok?: boolean;
    result?: { messages?: unknown[]; freshness?: string; complete?: boolean; truncated?: boolean };
    error?: { code?: string };
  };
  return read.ok
    ? {
        rows: read.result?.messages?.length ?? 0,
        freshness: read.result?.freshness,
        complete: read.result?.complete,
        truncated: read.result?.truncated,
      }
    : { error: read.error?.code };
}

// ---------------------------------------------------------------------------
// Fixture

let model: FakeAnthropicModel;
let settingsPath: string;
let priorSettings: string | null = null;
let environment: Environment;
let fixture: Project;

/** Whether two JSON texts hold the same value, whatever their layout. */
function sameJson(first: string | null, second: string): boolean {
  try {
    return (
      first !== null && JSON.stringify(JSON.parse(first)) === JSON.stringify(JSON.parse(second))
    );
  } catch {
    return false;
  }
}

function tag(prefix: string): string {
  return `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`;
}

async function seedClaudeTab(invoke: Invoke, environmentId: string): Promise<void> {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", { environmentId });
  await invoke("save_pane_layout", {
    environmentId,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "mc-pane",
      root: {
        kind: "leaf",
        id: "mc-pane",
        activeTabId: TAB_ID,
        tabs: [
          {
            id: TAB_ID,
            type: "agent-native",
            displayTitle: "Multi-client qualification",
            nativeAgentData: { environmentId, platform: "claude", isLocal: true },
            initialAgentModel: "haiku",
          },
        ],
      },
    },
  });
}

async function createEnvironment(invoke: Invoke, name: string): Promise<Environment> {
  const created = await invoke<Environment>("create_environment", {
    projectId: fixture.id,
    name: `${name}-${Date.now()}`,
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  await invoke("start_environment", { environmentId: created.id });
  await expect
    .poll(
      async () =>
        (
          await invoke<Environment & { status?: string }>("get_environment", {
            environmentId: created.id,
          })
        ).status,
      { timeout: 120_000 },
    )
    .toBe("running");
  const started = await invoke<Environment>("get_environment", { environmentId: created.id });
  expect(started.worktreePath).toBeTruthy();
  await seedClaudeTab(invoke, created.id);
  return started;
}

/** The fixture project, found by the seeded repository's path. */
async function fixtureProject(invoke: Invoke, status: Status): Promise<Project> {
  const testProject = status.testProject ?? path.join(runtime().fixtureDir, "test-project");
  const found = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === testProject,
  );
  expect(found, "the profile has no seeded fixture project").toBeTruthy();
  return found!;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  model = await startFakeAnthropicModel(FAKE_MODEL_PORT);
  const claudeDir = path.join(runtime().dataDir, "agent-credentials", "claude");
  // The profile's own isolated Claude home, never a real one.
  expect(claudeDir.startsWith(runtime().profileRoot)).toBe(true);
  await fs.mkdir(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const settings = JSON.stringify(fakeModelClaudeSettings(model.origin));
  // Restart only when the endpoint changed, so no Claude process started
  // before this run keeps an old one. A fixed port keeps the profile up.
  let status = readyStatus();
  if (!sameJson(priorSettings, settings)) {
    await fs.writeFile(settingsPath, settings);
    ({ status } = await restartProfile("graceful"));
  }
  const setup = await newClient(browser, "setup", { status });
  try {
    const invoke = invokeThrough(setup.page, status.browserUrl!);
    fixture = await fixtureProject(invoke, status);
    environment = await createEnvironment(invoke, "mc");
  } finally {
    await closeClient(setup);
  }
});

test.afterAll(async ({ browser }) => {
  if (environment) {
    const status = profileStatus();
    if (status.status === "ready") {
      const cleanup = await newClient(browser, "cleanup", { status });
      const invoke = invokeThrough(cleanup.page, status.browserUrl!);
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
      await closeClient(cleanup);
    }
  }
  await fs.writeFile(
    path.join(test.info().outputDir, "..", `evidence-multi-client-${Date.now()}.json`),
    `${JSON.stringify(summarize(), null, 2)}\n`,
  );
  if (settingsPath) {
    if (priorSettings === null) await fs.rm(settingsPath, { force: true });
    else if (!sameJson(priorSettings, readFileSync(settingsPath, "utf8")))
      await fs.writeFile(settingsPath, priorSettings);
  }
  await model?.stop();
});

// ---------------------------------------------------------------------------
// Cases

test("older backend: today's renderer against the oldest supported backend", async ({
  browser,
}) => {
  test.skip(
    !OLDER_URL || !OLDER_AUTH,
    "No older backend named (ORKESTRATOR_AGENT_TEST_OLDER_BACKEND_URL)",
  );
  test.setTimeout(8 * 60_000);
  const token = (JSON.parse(readFileSync(OLDER_AUTH!, "utf8")) as { token: string }).token;
  const clients: Client[] = [];
  try {
    for (const label of ["older-a", "older-b"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await fetchModulesOutsideChromium(context);
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      // The token goes only into the login form's body, never a URL or output.
      const login = await page.request.post(new URL("/__orkestrator/login", OLDER_URL!).href, {
        form: { token },
        maxRedirects: 0,
      });
      expect([200, 303]).toContain(login.status());
      clients.push({ label, context, page });
    }
    const [a, b] = clients as [Client, Client];
    const invoke = invokeThrough(a.page, OLDER_URL!);
    const version = await invoke<unknown>("get_app_version").catch(() => null);
    record("older-backend", "backend-version", version);
    const projects = await invoke<Project[]>("get_projects");
    expect(projects.length, "the older backend has no project").toBeGreaterThan(0);
    const project = projects[0]!;
    const older = await invoke<Environment>("create_environment", {
      projectId: project.id,
      name: `older-${Date.now()}`,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    await invoke("start_environment", { environmentId: older.id });
    await seedClaudeTab(invoke, older.id);
    const consoleErrors: string[] = [];
    for (const client of clients) {
      client.page.on("pageerror", (error) => consoleErrors.push(error.name));
      const loadedAt = Date.now();
      await client.page.goto(OLDER_URL!);
      await openEnvironment(client.page, project.name, older.name);
      record("older-backend", `${client.label}-open-ms`, Date.now() - loadedAt);
    }
    const word = tag("MCOLD");
    const hold = word.toLowerCase();
    const sentAt = await send(a.page, `${word} on an older backend [hold:${hold}]`);
    record(
      "older-backend",
      "b-sees-prompt-ms",
      await msUntil(sentAt, async () => (await rowsWith(b.page, word)) >= 1, "B prompt row"),
    );
    record(
      "older-backend",
      "a-activity-working-ms",
      await msUntil(
        sentAt,
        async () => (await activity(a.page, older.name)) === "working",
        "A working",
      ),
      BUDGET.activityMs,
    );
    await expect.poll(() => model.callsWith(word).length, { timeout: 60_000 }).toBe(1);
    const releasedAt = Date.now();
    model.release(hold);
    const answer = answerFor(`${word} on an older backend [hold:${hold}]`);
    for (const client of clients) {
      record(
        "older-backend",
        `${client.label}-turn-completion-ms`,
        await msUntil(
          releasedAt,
          async () => (await rowsWith(client.page, answer)) >= 1,
          `${client.label} answer`,
        ),
        BUDGET.turnCompletionMs,
      );
      record(
        "older-backend",
        `${client.label}-idle-ms`,
        await msUntil(
          releasedAt,
          async () => (await activity(client.page, older.name)) === "idle",
          `${client.label} idle`,
        ),
        BUDGET.activityMs,
      );
    }
    const worktree = (await invoke<Environment>("get_environment", { environmentId: older.id }))
      .worktreePath;
    if (worktree) {
      const writtenAt = Date.now();
      await fs.writeFile(path.join(worktree, `older-${word.toLowerCase()}.txt`), "a\nb\nc\n");
      for (const client of clients) {
        record(
          "older-backend",
          `${client.label}-diff-badge-ms`,
          await msUntil(
            writtenAt,
            async () => (await badgeText(client.page, older.name))?.includes("+3") === true,
            `${client.label} badge`,
            60_000,
          ),
          BUDGET.watchedDiffMs,
        );
      }
    }
    record("older-backend", "page-errors", consoleErrors);
    expect(model.callsWith(word)).toHaveLength(1);
    await invoke("stop_environment", { environmentId: older.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: older.id }).catch(() => undefined);
  } finally {
    for (const client of clients) await closeClient(client);
  }
});

test("two clients, one disconnected: the connected one meets the budgets, the other converges", async ({
  browser,
}) => {
  test.setTimeout((4 + ROUNDS) * 60_000);
  const status = readyStatus();
  let a: Client | undefined;
  let b: Client | undefined;
  try {
    a = await newClient(browser, "client-a", { status });
    b = await newClient(browser, "client-b", { status, throughLink: true });
    await openEnvironment(a.page, fixture.name, environment.name);
    await openEnvironment(b.page, fixture.name, environment.name);
    for (let round = 0; round < ROUNDS; round += 1) {
      await msUntil(
        Date.now(),
        async () => (await activity(a!.page, environment.name)) === "idle",
        "A idle before the round",
      );

      const disconnectedAt = Date.now();
      b.link!.setMode("reset");
      const word = tag("MCTWO");
      const hold = word.toLowerCase();
      const sentAt = await send(a.page, `${word} first turn [hold:${hold}]`);
      record(
        "two-clients",
        "a-prompt-row-ms",
        await msUntil(sentAt, async () => (await rowsWith(a!.page, word)) >= 1, "A prompt row"),
      );
      record(
        "two-clients",
        "a-activity-working-ms",
        await msUntil(
          sentAt,
          async () => (await activity(a!.page, environment.name)) === "working",
          "A working",
        ),
        BUDGET.activityMs,
      );
      await expect.poll(() => model.callsWith(word).length, { timeout: 60_000 }).toBe(1);

      const releasedAt = Date.now();
      model.release(hold);
      const answer = answerFor(`${word} first turn [hold:${hold}]`);
      record(
        "two-clients",
        "a-turn-completion-ms",
        await msUntil(releasedAt, async () => (await rowsWith(a!.page, answer)) >= 1, "A answer"),
        BUDGET.turnCompletionMs,
      );
      record(
        "two-clients",
        "a-activity-idle-ms",
        await msUntil(
          releasedAt,
          async () => (await activity(a!.page, environment.name)) === "idle",
          "A idle",
        ),
        BUDGET.activityMs,
      );

      // A watched local worktree save, while B is still cut off.
      const lines = 7;
      const before = (await badgeAdditions(a.page, environment.name)) ?? 0;
      const expected = before + lines;
      const writtenAt = Date.now();
      await fs.writeFile(
        path.join(environment.worktreePath!, `mc-${word.toLowerCase()}.txt`),
        Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n") + "\n",
      );
      record(
        "two-clients",
        "a-diff-badge-ms",
        await msUntil(
          writtenAt,
          async () => (await badgeAdditions(a!.page, environment.name)) === expected,
          "A diff badge",
        ),
        BUDGET.watchedDiffMs,
      );
      // B really was cut off: it has seen neither the answer nor the badge.
      expect(await rowsWith(b.page, answer), "B saw the answer while disconnected").toBe(0);
      record("two-clients", "b-cut-off-ms", Date.now() - disconnectedAt);

      const reconnectedAt = Date.now();
      b.link!.setMode("up");
      record(
        "two-clients",
        "b-answer-after-resume-ms",
        await msUntil(
          reconnectedAt,
          async () => (await rowsWith(b!.page, answer)) >= 1,
          "B answer",
          120_000,
        ),
      );
      record(
        "two-clients",
        "b-idle-after-resume-ms",
        await msUntil(
          reconnectedAt,
          async () => (await activity(b!.page, environment.name)) === "idle",
          "B idle",
          120_000,
        ),
      );
      record(
        "two-clients",
        "b-diff-badge-after-resume-ms",
        await msUntil(
          reconnectedAt,
          async () => (await badgeAdditions(b!.page, environment.name)) === expected,
          "B diff badge",
          120_000,
        ),
      );

      // Both clients show one prompt and one answer; the provider saw it once.
      for (const client of [a, b]) {
        expect(await rowsWith(client.page, word), `${client.label}: prompt rows`).toBe(2);
        expect(await rowsWith(client.page, answer), `${client.label}: answer rows`).toBe(1);
      }
      expect(model.callsWith(word)).toHaveLength(1);
    }
  } finally {
    await closeClient(a);
    await closeClient(b);
  }
});

test("queued prompt: dispatched on the turn-end edge and shown on both clients", async ({
  browser,
}) => {
  test.setTimeout((4 + ROUNDS) * 60_000);
  const status = readyStatus();
  let a: Client | undefined;
  let b: Client | undefined;
  try {
    a = await newClient(browser, "client-a", { status });
    b = await newClient(browser, "client-b", { status });
    await openEnvironment(a.page, fixture.name, environment.name);
    await openEnvironment(b.page, fixture.name, environment.name);
    const invoke = invokeThrough(a.page, status.browserUrl!);
    for (let round = 0; round < ROUNDS; round += 1) {
      await msUntil(
        Date.now(),
        async () => (await activity(a!.page, environment.name)) === "idle",
        "A idle before the round",
      );
      const first = tag("MCQONE");
      const second = tag("MCQTWO");
      const hold = first.toLowerCase();
      await send(a.page, `${first} running turn [hold:${hold}]`);
      await expect.poll(() => model.callsWith(first).length, { timeout: 60_000 }).toBe(1);
      await enqueue(invoke, environment.id, `${second} queued turn`);
      record("queued", "queued-while-running", true);

      const releasedAt = Date.now();
      model.release(hold);
      record(
        "queued",
        "dispatch-after-turn-end-ms",
        await msUntil(
          releasedAt,
          async () => model.callsWith(second).length >= 1,
          "queued dispatch",
        ),
        BUDGET.queuedDispatchMs,
      );
      const answer = answerFor(`${second} queued turn`);
      for (const client of [a, b]) {
        record(
          "queued",
          `${client.label}-queued-answer-ms`,
          await msUntil(
            releasedAt,
            async () => (await rowsWith(client.page, answer)) >= 1,
            `${client.label} queued answer`,
          ),
        );
      }
      expect(model.callsWith(second)).toHaveLength(1);
    }
  } finally {
    await closeClient(a);
    await closeClient(b);
  }
});

/**
 * Queues a prompt behind the running turn through the backend's own durable
 * queue, the call the composer makes (`useNativeAgentSession`'s `enqueue`).
 */
async function enqueue(invoke: Invoke, environmentId: string, prompt: string): Promise<void> {
  await invoke("enqueue_prompt_queue_message", {
    queueKey: `claude\u0000env-${environmentId}:${TAB_ID}`,
    environmentId,
    message: { id: randomBytes(8).toString("hex"), text: prompt },
  });
}

for (const mode of ["crash", "graceful"] as const) {
  test(`backend ${mode} restart with a turn at the provider and a queued prompt`, async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000);
    let status = readyStatus();
    let a: Client | undefined;
    let b: Client | undefined;
    const scenario = `backend-${mode}`;
    try {
      a = await newClient(browser, "client-a", { status });
      await openEnvironment(a.page, fixture.name, environment.name);
      const running = tag("MCRUN");
      const queued = tag("MCQUE");
      const hold = running.toLowerCase();
      await send(a.page, `${running} turn across a restart [hold:${hold}]`);
      await expect.poll(() => model.callsWith(running).length, { timeout: 60_000 }).toBe(1);
      await enqueue(
        invokeThrough(a.page, status.browserUrl!),
        environment.id,
        `${queued} queued across a restart`,
      );
      await closeClient(a);
      a = undefined;

      const restart = await restartProfile(mode);
      status = restart.status;
      record(scenario, "stop-ms", restart.stopMs);
      record(scenario, "start-to-ready-ms", restart.startMs);
      await expect.poll(() => model.callsWith(running)[0]?.aborted, { timeout: 30_000 }).toBe(true);
      record(scenario, "held-call-aborted", model.callsWith(running)[0]?.aborted === true);

      record(scenario, "first-transcript-read", await firstTranscriptRead(environment.id));
      const opened = Date.now();
      a = await newClient(browser, "client-a", { status });
      b = await newClient(browser, "client-b", { status });
      await Promise.all([
        openEnvironment(a.page, fixture.name, environment.name),
        openEnvironment(b.page, fixture.name, environment.name),
      ]);
      record(scenario, "sign-in-and-open-ms", Date.now() - opened);
      const shownAt = Date.now();
      for (const client of [a, b]) {
        record(
          scenario,
          `${client.label}-prompt-row-after-open-ms`,
          await msUntil(
            shownAt,
            async () => (await rowsWith(client.page, running)) >= 1,
            `${client.label} prompt row`,
            120_000,
          ),
        );
        record(
          scenario,
          `${client.label}-settled-after-open-ms`,
          await msUntil(
            shownAt,
            async () => (await activity(client.page, environment.name)) !== "working",
            `${client.label} settled`,
            120_000,
          ),
        );
      }
      // Give a re-send or a queue drain time to happen, then count.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      record(scenario, "running-prompt-provider-calls", model.callsWith(running).length);
      record(scenario, "queued-calls-before-follow-up", model.callsWith(queued).length);
      // At most once: the interrupted prompt is never sent again on its own.
      expect(model.callsWith(running)).toHaveLength(1);
      for (const client of [a, b]) {
        record(
          scenario,
          `${client.label}-running-prompt-rows`,
          await rowsWith(client.page, running),
        );
        expect(
          await rowsWith(client.page, running),
          `${client.label}: running prompt rows`,
        ).toBeLessThanOrEqual(2);
      }

      // The conversation continues afterwards, on the same provider session.
      const next = tag("MCAFTER");
      const sentAt = await send(a.page, `${next} after the restart`);
      record(
        scenario,
        "follow-up-completion-ms",
        await msUntil(
          sentAt,
          async () => (await rowsWith(a!.page, answerFor(`${next} after the restart`))) >= 1,
          "follow-up answer",
        ),
      );
      record(scenario, "follow-up-user-prompts-in-context", model.callsWith(next)[0]?.userPrompts);
      expect(model.callsWith(next)).toHaveLength(1);
      expect(model.callsWith(next)[0]!.context.some((prompt) => prompt.includes(running))).toBe(
        true,
      );
      // A turn a restart cut short is not a model failure, so the queue drains
      // as after an idle turn: the queued prompt goes out once, before the
      // prompt typed later (to-do 7120 (retired) task 1). Before that fix it was
      // held until the later turn ended, which inverted the user's order.
      await expect.poll(() => model.callsWith(queued).length, { timeout: 60_000 }).toBe(1);
      const queuedCall = model.callsWith(queued)[0]!;
      const followUpCall = model.callsWith(next)[0]!;
      record(scenario, "queued-sent-after-later-prompt", queuedCall.index > followUpCall.index);
      expect(queuedCall.index, "queued prompt goes out before the later one").toBeLessThan(
        followUpCall.index,
      );
      record(scenario, "queued-dispatch-after-ready-ms", queuedCall.receivedAt - restart.readyAt);
      await msUntil(
        Date.now(),
        async () => (await activity(a!.page, environment.name)) === "idle",
        "idle after queued",
        60_000,
      );
    } finally {
      await closeClient(a);
      await closeClient(b);
    }
  });
}

test("bridge restart: mid-turn and idle", async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const status = readyStatus();
  let a: Client | undefined;
  let b: Client | undefined;
  try {
    a = await newClient(browser, "client-a", { status });
    b = await newClient(browser, "client-b", { status });
    await openEnvironment(a.page, fixture.name, environment.name);
    await openEnvironment(b.page, fixture.name, environment.name);

    // Mid-turn: the bridge (and the CLI under it) dies with the call parked.
    const running = tag("MCBRUN");
    const hold = running.toLowerCase();
    await send(a.page, `${running} turn across a bridge restart [hold:${hold}]`);
    await expect.poll(() => model.callsWith(running).length, { timeout: 60_000 }).toBe(1);
    const bridge = claudeBridgePid(status);
    const killedAt = Date.now();
    process.kill(bridge, "SIGKILL");
    await expect.poll(() => processAlive(bridge), { timeout: 10_000 }).toBe(false);
    for (const client of [a, b]) {
      record(
        "bridge-mid-turn",
        `${client.label}-settled-ms`,
        await msUntil(
          killedAt,
          async () => (await activity(client.page, environment.name)) !== "working",
          `${client.label} settled`,
          120_000,
        ),
        BUDGET.activityMs,
      );
    }
    await expect.poll(() => model.callsWith(running)[0]?.aborted, { timeout: 30_000 }).toBe(true);
    record("bridge-mid-turn", "held-call-aborted", model.callsWith(running)[0]?.aborted === true);
    const after = tag("MCBNEXT");
    const sentAt = await send(a.page, `${after} after the bridge restart`);
    record(
      "bridge-mid-turn",
      "follow-up-completion-ms",
      await msUntil(
        sentAt,
        async () => (await rowsWith(a!.page, answerFor(`${after} after the bridge restart`))) >= 1,
        "follow-up answer",
        120_000,
      ),
    );
    record(
      "bridge-mid-turn",
      "follow-up-user-prompts-in-context",
      model.callsWith(after)[0]?.userPrompts,
    );
    expect(model.callsWith(running)).toHaveLength(1);
    expect(model.callsWith(after)).toHaveLength(1);
    expect(model.callsWith(after)[0]!.context.some((prompt) => prompt.includes(running))).toBe(
      true,
    );

    // An answer can render before the SDK settles the turn. Wait for the
    // authoritative idle state so this kill exercises the idle boundary.
    await expect.poll(() => activity(a!.page, environment.name), { timeout: 60_000 }).toBe("idle");
    // Idle: the next prompt starts a new bridge and resumes the conversation.
    const idleBridge = claudeBridgePid(status);
    process.kill(idleBridge, "SIGKILL");
    await expect.poll(() => processAlive(idleBridge), { timeout: 10_000 }).toBe(false);
    const idle = tag("MCBIDLE");
    const idleSentAt = await send(a.page, `${idle} after an idle bridge restart`);
    const idleAnswer = answerFor(`${idle} after an idle bridge restart`);
    for (const client of [a, b]) {
      record(
        "bridge-idle",
        `${client.label}-completion-ms`,
        await msUntil(
          idleSentAt,
          async () => (await rowsWith(client.page, idleAnswer)) >= 1,
          `${client.label} answer`,
          120_000,
        ),
      );
    }
    expect(model.callsWith(idle)[0]!.context.some((prompt) => prompt.includes(after))).toBe(true);
    record("bridge-idle", "user-prompts-in-context", model.callsWith(idle)[0]?.userPrompts);
    expect(model.callsWith(idle)).toHaveLength(1);
  } finally {
    await closeClient(a);
    await closeClient(b);
  }
});

// Restart after the accepted result is observable and the turn has settled.
// This is distinct from killing a held provider call: durable result recovery
// must preserve the answer and must not repeat its dispatch.
for (const boundary of ["backend", "bridge"] as const) {
  test(`${boundary} restart after result acceptance preserves the result without dispatch replay`, async ({
    browser,
  }) => {
    test.setTimeout(10 * 60_000);
    let status = readyStatus();
    let client: Client | undefined;
    const marker = tag("MCACCEPT");
    const prompt = `${marker} accepted result before restart`;
    const answer = answerFor(prompt);
    try {
      client = await newClient(browser, "accepted-result", { status });
      await openEnvironment(client.page, fixture.name, environment.name);
      await send(client.page, prompt);
      await expect.poll(() => rowsWith(client!.page, answer), { timeout: 120_000 }).toBe(1);
      await expect
        .poll(() => activity(client!.page, environment.name), { timeout: 60_000 })
        .toBe("idle");
      expect(model.callsWith(marker)).toHaveLength(1);
      expect(model.callsWith(marker)[0]?.answeredAt).toEqual(expect.any(Number));
      await closeClient(client);
      client = undefined;
      if (boundary === "backend") {
        status = (await restartProfile("crash")).status;
      } else {
        const bridge = claudeBridgePid(status);
        process.kill(bridge, "SIGKILL");
        await expect.poll(() => processAlive(bridge), { timeout: 10_000 }).toBe(false);
      }
      client = await newClient(browser, "accepted-result-recovered", { status });
      await openEnvironment(client.page, fixture.name, environment.name);
      await expect.poll(() => rowsWith(client!.page, answer), { timeout: 120_000 }).toBe(1);
      await client.page.reload();
      await openEnvironment(client.page, fixture.name, environment.name);
      await expect.poll(() => rowsWith(client!.page, answer), { timeout: 120_000 }).toBe(1);
      const followUp = tag("MCACCEPTNEXT");
      const followUpPrompt = `${followUp} continue accepted conversation`;
      await send(client.page, followUpPrompt);
      await expect
        .poll(() => rowsWith(client!.page, answerFor(followUpPrompt)), { timeout: 120_000 })
        .toBe(1);
      expect(model.callsWith(followUp)).toHaveLength(1);
      expect(model.callsWith(followUp)[0]!.context.some((text) => text.includes(marker))).toBe(
        true,
      );
      expect(model.callsWith(marker)).toHaveLength(1);
      record(
        `${boundary}-result-accepted`,
        "original-dispatch-count",
        model.callsWith(marker).length,
      );
      record(
        `${boundary}-result-accepted`,
        "recovered-answer-rows",
        await rowsWith(client.page, answer),
      );
    } finally {
      await closeClient(client);
    }
  });
}
