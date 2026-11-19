/**
 * Failed native turns ring "Agent stopped with an error", live (to-do 5160 (retired)
 * task 4). Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL=1`) against a
 * running credential-free agent-test profile. No login and nothing billed:
 * the profile's own Claude settings, Codex config, Pi `models.json` and
 * OpenCode `opencode.json` are pointed at a loopback model that refuses every
 * key with a 401 (`refused-login-model.ts`), and restored afterwards. Codex is
 * given a made-up API key in the profile's own Codex home for the run.
 *
 *   env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile ork-bell --fixture --no-agent-credentials \
 *     --no-host-seed --headless --agent-platforms claude,codex,pi,opencode
 *   ORKESTRATOR_AGENT_TEST_PROFILE=ork-bell ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL=1 \
 *     mise run test:logged -- --name failed-turn-bell -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts failed-turn-bell-live.spec.ts
 *
 * For each platform in `ORKESTRATOR_AGENT_TEST_BELL_PLATFORMS` (default
 * Claude, Codex, Pi and OpenCode), one fresh local environment holds one
 * native tab while the page sits on a second environment, and these cases run
 * in order (`ORKESTRATOR_AGENT_TEST_BELL_CASES` narrows them):
 *
 * - `refused`: a turn dispatched from outside the view is refused. The
 *   environment must ring `agent_failed`, and opening it must show the toast.
 * - `stop`: a turn held at the model is stopped (the Stop button's command).
 *   It must ring `agent_finished`, never `agent_failed` (the unit tests'
 *   rule for every bridge; only a goal's own Stop rings nothing).
 * - `bridge-kill`: a held turn's bridge (OpenCode: its `opencode2 serve`) is
 *   SIGKILLed. The environment must ring `agent_failed`.
 * - `restart`: a held turn's backend is SIGKILLed and the profile restarted;
 *   a local bridge goes with it. The restarted backend must ring
 *   `agent_failed`.
 *
 * `ORKESTRATOR_AGENT_TEST_BELL_ENVIRONMENT=container` (to-do 5160 (retired) task 6) runs
 * the bell environment as a container instead, for native Claude only, and
 * by default only the `restart` case (`refused` and `stop` may be selected
 * too). The model is `refused-login-model.ts` again, run on the container's
 * loopback by the image's own `bun` and held or released by `docker exec
 * curl`; the container user's Claude settings point at it. The container's
 * bridge survives the backend's SIGKILL and restart, so the turn is still
 * held at the model afterwards: the case checks that the restarted backend
 * has not rung yet, then releases the hold, and the refusal the surviving
 * bridge reports must ring `agent_failed`. Build the profile's image first
 * (`mise run docker:build:dev --profile <p>`); a host whose firewall drops
 * container traffic to the profile needs the `docker:disposable
 * --host-loopback` daemon, as `container-claude-terminal-signal.spec.ts` does.
 *
 * Only processes under this profile's backend are signalled, after their
 * command line is checked. Each platform writes
 * `output/agent-testing/<run>/failed-turn-bell/<platform>.json`, and the
 * toasts are saved as `output/visual-previews/5160-bell-<platform>-<case>.png`.
 */
import { expect, test, type Page } from "./browser-test";
import type { Route } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  CONTAINER_FAKE_PORT,
  installContainerFakeClaude,
  startLocalFakeModel,
  withFakeModelCleanup,
  type FakeModelHandle,
} from "./idle-observation-fake-models";
import { PI_FAKE_MODEL_REF, PI_FAKE_PROVIDER } from "./idle-observation-fake-pi";
import { allowOpenCodeFakeProvider } from "./opencode-fake-provider";
import { refusedLoginStats, setRefusedLoginHold } from "./refused-login-model";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  sidebarNavigator,
  type Environment,
  type Invoke,
  type Project,
  type Status,
} from "./slash-command-live-support";
import { devTestRestartArgs, type StoredProfileSelection } from "./profile-restart-args";
import { outlivingProcessEnv } from "../../tests/private-tmpdir";
import {
  bellEnvironment,
  bellSelection,
  bridgeProcess,
  expectedUnread,
  loggedBridgePid,
  parseProcessRows,
  removeEnvironments,
  TOAST_TITLES,
  type BellCase,
  type BellPlatform,
} from "./failed-turn-bell-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "ork-bell";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const ENVIRONMENT = bellEnvironment(process.env.ORKESTRATOR_AGENT_TEST_BELL_ENVIRONMENT);
const IN_CONTAINER = ENVIRONMENT === "container";
const { platforms: PLATFORMS, cases: CASES } = bellSelection(
  ENVIRONMENT,
  process.env.ORKESTRATOR_AGENT_TEST_BELL_PLATFORMS,
  process.env.ORKESTRATOR_AGENT_TEST_BELL_CASES,
);
const REFUSED_MODEL = path.join(import.meta.dirname, "refused-login-model.ts");
/** Codex retries a refused request before it fails the turn. */
const FAILURE_TIMEOUT_MS = 600_000;
/** How long a stopped turn's bell must stay `agent_finished` before it is believed. */
const QUIET_MS = 20_000;

type FullStatus = Status & {
  pids?: { backend?: number };
  processStartTimes?: { backend?: number };
};
type UnreadEnvironment = Environment & {
  hasUnreadWork?: boolean;
  unreadReason?: string;
  agentActivityState?: string;
};
type Projection = { turn?: { phase?: string; error?: string } };
type CaseRecord = {
  result: "passed" | "failed";
  unreadReason?: string | null;
  turnPhase?: string;
  turnError?: string;
  toast?: boolean;
  bridge?: string;
  /** The environment's activity states sampled for 6 s while the model held the turn. */
  activityWhileHeld?: string[];
  /** Container restart: the states sampled for 10 s after the restart, model still holding. */
  activityAfterRestart?: string[];
  /** Container restart: whether the bell stayed silent until the hold was released. */
  quietUntilReleased?: boolean;
  /** Container restart: the in-container bridge's PID before and after the restart. */
  containerBridgePid?: { before?: number; after?: number };
  ms?: number;
  note?: string;
};

test.use({ trace: "off", screenshot: "off" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readyStatus(): FullStatus {
  const status = profileStatus(profile) as FullStatus;
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  expect(status.dataDir, "dev:status names no data directory").toBeTruthy();
  return status;
}

/** This profile's backend, after checking its command line and start time. */
function profileBackendPid(status: FullStatus): number {
  const pid = status.pids?.backend;
  expect(pid, "dev:status names no backend pid").toBeTruthy();
  const inspect = (field: string) =>
    spawnSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).stdout.trim();
  const command = inspect("command");
  expect(
    command.includes(path.join(repositoryRoot, "apps", "backend", "src", "main.ts")) &&
      command.includes(status.dataDir!),
    "the recorded backend PID is not this profile's backend",
  ).toBe(true);
  const expectedStart = status.processStartTimes?.backend;
  if (typeof expectedStart === "number") {
    expect(
      Math.abs(Date.parse(inspect("lstart")) - expectedStart) < 1_000,
      "refusing to signal a reused backend PID",
    ).toBe(true);
  }
  return pid!;
}

function killBridge(status: FullStatus, platform: BellPlatform, environmentId: string): string {
  const backend = profileBackendPid(status);
  const logDir = (status as { logDir?: string }).logDir;
  expect(logDir, "dev:status names no log directory").toBeTruthy();
  const pid = loggedBridgePid(
    readFileSync(path.join(logDir!, "electron.log"), "utf8"),
    platform,
    environmentId,
  );
  expect(pid, `the backend logged no ${platform} bridge for this environment`).toBeTruthy();
  const rows = parseProcessRows(
    spawnSync("ps", ["-ww", "-e", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout,
  );
  const bridge = bridgeProcess(rows, backend, platform, repositoryRoot, pid!);
  expect(bridge, `PID ${pid} is not a ${platform} bridge under the profile's backend`).toBeTruthy();
  process.kill(bridge!.pid, "SIGKILL");
  // The command names the entry only; it holds no prompt or credential.
  return bridge!.command.replace(repositoryRoot, "<repo>").slice(0, 160);
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

/** SIGKILL this profile's backend (only it), then bring the profile back headless. */
async function crashAndRestart(status: FullStatus): Promise<FullStatus> {
  const stored = JSON.parse(
    readFileSync(path.join(path.dirname(status.dataDir!), "profile.json"), "utf8"),
  ) as StoredProfileSelection;
  process.kill(profileBackendPid(status), "SIGKILL");
  const stop = await runAsync("mise", ["run", "dev:stop", "--profile", profile], 120_000);
  expect(stop.code, `dev:stop failed: ${stop.stderr}`).toBe(0);
  const output = openSync(test.info().outputPath(`dev-test-restart-${Date.now()}.log`), "a");
  const env: NodeJS.ProcessEnv = {
    ...outlivingProcessEnv(),
    ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
  };
  // Never the user's desktop: the restart stays headless.
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  // `--fixture` stays off: it recreates the repository every worktree points at.
  const launcher = spawn("bun", [...devTestRestartArgs(profile, stored), "--headless"], {
    cwd: repositoryRoot,
    detached: true,
    env,
    stdio: ["ignore", output, output],
  });
  launcher.unref();
  let next: FullStatus | undefined;
  await expect
    .poll(
      () => {
        next = profileStatus(profile) as FullStatus;
        return next.status === "ready" && Boolean(next.browserUrl);
      },
      { timeout: 300_000, intervals: [2_000] },
    )
    .toBe(true);
  return next!;
}

/** A made-up Codex API key in the profile's own Codex home, for the run only. */
function madeUpCodexKey(dataDir: string): FakeModelHandle {
  const file = path.join(dataDir, "agent-credentials", "codex", "auth.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([file]);
  writeFileSync(
    file,
    JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: `sk-proj-refused-${randomBytes(18).toString("hex")}`,
    }),
    { mode: 0o600 },
  );
  return { origin: "codex-auth", stop: async () => restore() };
}

/** Holds, releases and counts the refused-login model wherever it runs. */
type ModelControl = {
  hold(hold: boolean): Promise<void>;
  stats(): Promise<{ requests: number; held: number }>;
};

function hostModelControl(origin: string): ModelControl {
  return {
    hold: (hold) => setRefusedLoginHold(origin, hold),
    stats: () => refusedLoginStats(origin),
  };
}

/** The same routes on a container's loopback, through `docker exec curl`. */
function containerModelControl(containerId: string): ModelControl {
  const curl = (args: string[]) => {
    const result = spawnSync(
      "docker",
      ["exec", containerId, "curl", "-fsS", "--max-time", "10", ...args],
      { encoding: "utf8", timeout: 20_000 },
    );
    if (result.status !== 0) throw new Error(`the container's model did not answer ${args.at(-1)}`);
    return result.stdout;
  };
  const base = `http://127.0.0.1:${CONTAINER_FAKE_PORT}`;
  return {
    hold: async (hold) => {
      curl([
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "-d",
        JSON.stringify({ hold }),
        `${base}/__qa/hold`,
      ]);
    },
    stats: async () =>
      JSON.parse(curl([`${base}/__qa/stats`])) as { requests: number; held: number },
  };
}

/** The oldest Claude bridge process in the container, or undefined. */
function containerBridgePid(containerId: string): number | undefined {
  // The bracket keeps pgrep from matching a shell that carries the pattern.
  const result = spawnSync(
    "docker",
    ["exec", containerId, "pgrep", "-of", "/opt/claude-bridg[e]/"],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  const pid = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Keep the real provider read pending while the mobile pane switcher changes views. */
async function viewUnreadCodexResult(
  page: Page,
  identity: { logicalSessionKey: string },
  environmentName: string,
  open: () => Promise<void>,
  unread: () => Promise<string | null>,
) {
  const gateway = "**/__orkestrator/invoke";
  let requested = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = async (name: string) => {
    const row = page.getByRole("button", { name: new RegExp(`^${environmentName}\\b`) }).first();
    const shot = path.join(
      repositoryRoot,
      "output",
      "visual-previews",
      `unread-${runId}-${name}.png`,
    );
    mkdirSync(path.dirname(shot), { recursive: true });
    await row.screenshot({ path: shot });
  };
  await capture("desktop-unseen");
  const delayResult = async (route: Route) => {
    const body = route.request().postDataJSON();
    if (
      body?.command !== "get_native_agent_transcript_update" ||
      body.args?.logicalSessionKey !== identity.logicalSessionKey ||
      body.args?.freshSource !== true
    ) {
      await route.fallback();
      return;
    }
    requested = true;
    await held;
    if (!route.request().failure()) await route.fallback();
  };
  await page.route(gateway, delayResult);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    const panes = page.getByRole("tablist", { name: "Split panes" });
    const other = panes.getByRole("tab", { name: /Other pane/ });
    const result = panes.getByRole("tab", { name: /codex bell/ });
    await expect(other).toHaveAttribute("aria-selected", "true");
    expect(await unread()).toBe("agent_failed");
    await expect(page.getByText(TOAST_TITLES.agent_failed, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open projects and environments", exact: true }).click();
    await capture("mobile-unseen");
    await page
      .getByRole("button", { name: "Close projects and environments", exact: true })
      .first()
      .click();

    await result.click();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => requested).toBe(true);
    expect(await unread()).toBe("agent_failed");
    release();
    await expect.poll(unread, { timeout: 30_000 }).toBeNull();
    await page.getByRole("button", { name: "Open projects and environments", exact: true }).click();
    await capture("mobile-viewed");
    await page
      .getByRole("button", { name: "Close projects and environments", exact: true })
      .first()
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await capture("desktop-viewed");
  } finally {
    release();
    await page.unroute(gateway, delayResult);
  }
}

async function dismissStartupDialogs(page: Page) {
  for (const name of ["Continue without Claude", "Continue without Docker", "Hide"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
  }
}

test.describe("failed native turns ring the right bell", () => {
  test.skip(!LIVE, "opt-in live check against a credential-free agent-test profile");

  for (const platform of PLATFORMS) {
    test(`${platform}: refused, stopped, bridge-killed and restarted turns`, async ({ page }) => {
      test.setTimeout(CASES.length * (FAILURE_TIMEOUT_MS + 360_000));
      await page.setViewportSize({ width: 1440, height: 1000 });
      page.setDefaultTimeout(60_000);
      // Startup notices can open at any time (no Claude login is expected here).
      for (const name of ["Continue without Claude", "Continue without Docker"]) {
        const button = page.getByRole("button", { name, exact: true });
        await page.addLocatorHandler(button, () => button.click());
      }
      if (!IN_CONTAINER) {
        const reachability = page.getByRole("dialog", {
          name: "Docker containers can't reach Orkestrator",
        });
        await page.addLocatorHandler(reachability, () =>
          reachability.getByRole("button", { name: "Close", exact: true }).first().click(),
        );
      }
      const progress = (step: string) => console.log(`[bell] ${platform} ${step}`);
      let status = readyStatus();
      let invoke: Invoke = await authenticatedInvoke(page, status, profile);
      const current: Invoke = (command, args) => invoke(command, args);
      const enabled = (
        await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>("get_config")
      ).global?.enabledAgentPlatforms;
      test.skip(
        Array.isArray(enabled) && !enabled.includes(platform),
        `${platform} is not enabled in profile "${profile}"`,
      );
      const fixture = (await invoke<Project[]>("get_projects")).find(
        // A restart without `--fixture` keeps the fixture but stops naming it.
        (project) =>
          project.localPath ===
          (status.testProject ??
            path.join(path.dirname(status.dataDir!), "fixtures", "test-project")),
      );
      expect(fixture, "the fixture project is missing").toBeTruthy();

      const records: Partial<Record<BellCase, CaseRecord>> = {};
      const summary: Record<string, unknown> = {
        platform,
        profile,
        fakeModel: "refused-login",
        startedAt: new Date().toISOString(),
        cases: records,
      };
      const writeSummary = () => {
        const directory = path.join(
          repositoryRoot,
          "output",
          "agent-testing",
          runId,
          "failed-turn-bell",
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, `${platform}.json`),
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      };

      const handles: FakeModelHandle[] = [];
      let model: ModelControl | undefined;
      const created: string[] = [];
      // Content-free heartbeat: keeps the logged runner's no-output watchdog fed.
      const beat = setInterval(() => progress("still waiting"), 60_000);
      try {
        await withFakeModelCleanup(handles, async () => {
          if (!IN_CONTAINER) {
            const fake = await startLocalFakeModel(platform, status.dataDir!, {
              script: REFUSED_MODEL,
            });
            handles.push(fake);
            summary.fakeModelOrigin = fake.origin;
            model = hostModelControl(fake.origin);
          }
          summary.environment = ENVIRONMENT;
          if (platform === "codex") handles.push(madeUpCodexKey(status.dataDir!));
          if (platform === "opencode") {
            const restore = await allowOpenCodeFakeProvider(current, PI_FAKE_PROVIDER);
            handles.push({ origin: "opencode-allowlist", stop: restore });
          }
          const modelRef = platform === "pi" || platform === "opencode" ? PI_FAKE_MODEL_REF : null;
          const prefix = IN_CONTAINER ? `ctr-${platform}` : platform;
          // An earlier run of this spec that was killed left its two environments.
          const stale = new RegExp(`^bell-(park-)?${prefix}-\\d+$`);
          for (const environment of await invoke<Environment[]>("get_environments", {
            projectId: fixture!.id,
          })) {
            if (!stale.test(environment.name)) continue;
            await invoke("stop_environment", { environmentId: environment.id }).catch(() => {});
            await invoke("delete_environment", { environmentId: environment.id });
          }
          const stamp = Date.now();
          const bell = await invoke<Environment>("create_environment", {
            projectId: fixture!.id,
            name: `bell-${prefix}-${stamp}`,
            environmentType: IN_CONTAINER ? "containerized" : "local",
            networkAccessMode: "restricted",
          });
          created.push(bell.id);
          const parked = await invoke<Environment>("create_environment", {
            projectId: fixture!.id,
            name: `bell-park-${prefix}-${stamp}`,
            environmentType: "local",
            networkAccessMode: "restricted",
          });
          created.push(parked.id);
          const tabId = `bell-${platform}`;
          const checkSplitUnread =
            platform === "codex" && !IN_CONTAINER && CASES.includes("refused");
          const identity = {
            environmentId: bell.id,
            agent: platform,
            logicalSessionKey: `env-${bell.id}:${tabId}`,
          };
          let containerId: string | null = null;
          const prepare = async () => {
            await invoke("start_environment", { environmentId: bell.id });
            if (IN_CONTAINER) {
              const started = await invoke<(Environment & { containerId?: string | null }) | null>(
                "get_environment",
                { environmentId: bell.id },
              );
              containerId = started?.containerId ?? null;
              expect(
                containerId,
                "the container environment started without a container",
              ).toBeTruthy();
              const fake = await installContainerFakeClaude(containerId!, {
                source: readFileSync(REFUSED_MODEL, "utf8"),
                serverArgs: [],
                readyPath: "/__qa/stats",
              });
              handles.push(fake);
              summary.fakeModelOrigin = fake.origin;
              model = containerModelControl(containerId!);
            }
            const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
              environmentId: bell.id,
            });
            const agentPane = {
              kind: "leaf",
              id: "bell-pane",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "agent-native",
                  displayTitle: `${platform} bell`,
                  nativeAgentData: {
                    environmentId: bell.id,
                    platform,
                    isLocal: !IN_CONTAINER,
                  },
                  ...(modelRef ? { initialAgentModel: modelRef } : {}),
                },
              ],
            };
            const otherPane = {
              kind: "leaf",
              id: "other-bell-pane",
              activeTabId: "other-bell-tab",
              tabs: [
                {
                  id: "other-bell-tab",
                  type: "browser",
                  displayTitle: "Other pane",
                  browserData: { url: "" },
                },
              ],
            };
            await invoke("save_pane_layout", {
              environmentId: bell.id,
              expectedRevision: layout?.revision ?? 0,
              layout: {
                version: PANE_LAYOUT_VERSION,
                containerId,
                activePaneId: checkSplitUnread ? otherPane.id : agentPane.id,
                root: checkSplitUnread
                  ? {
                      kind: "split",
                      id: "bell-split",
                      direction: "horizontal",
                      children: [otherPane, agentPane],
                    }
                  : agentPane,
              },
            });
          };
          await prepare();
          await invoke("ensure_native_agent_session", {
            ...identity,
            ...(modelRef ? { model: modelRef } : {}),
          });
          progress("session ready");

          const unread = async () => {
            const environment = await invoke<UnreadEnvironment | null>("get_environment", {
              environmentId: bell.id,
            });
            return environment?.hasUnreadWork === true ? (environment.unreadReason ?? "?") : null;
          };
          const projection = () =>
            invoke<Projection | null>("get_native_agent_projection", {
              ...identity,
              messageLimit: 20,
            });
          let openEnvironment = sidebarNavigator(page, fixture!.name);
          const goto = async (name: string) => {
            await dismissStartupDialogs(page);
            await openEnvironment(name);
          };
          await page.goto(status.browserUrl!);
          await dismissStartupDialogs(page);

          for (const kind of CASES) {
            const record: CaseRecord = { result: "failed" };
            records[kind] = record;
            const startedAt = Date.now();
            // Read any earlier bell, then park the page on the other environment.
            await goto(bell.name);
            await expect.poll(unread, { timeout: 30_000 }).toBeNull();
            await goto(parked.name);
            progress(`${kind} parked`);
            const hold = kind !== "refused";
            const control = model!;
            await control.hold(hold);
            const before = await control.stats();
            const dispatch = await invoke<{ outcome: string; error?: string }>(
              "dispatch_native_agent_intent",
              {
                ...identity,
                prompt: `Reply with only OK (${kind}).`,
                requestId: randomUUID(),
                ...(platform === "pi" ? {} : { mode: "build" }),
              },
            );
            expect(dispatch.outcome, dispatch.error ?? "").toBe("accepted");
            progress(`${kind} dispatched`);
            if (hold) {
              await expect
                .poll(async () => (await control.stats()).held, {
                  timeout: 180_000,
                  intervals: [500],
                })
                .toBeGreaterThan(0);
              progress(`${kind} held at the model`);
              // What the backend shows while the provider waits on the model.
              const seen = new Set<string>();
              for (let sample = 0; sample < 6; sample += 1) {
                const environment = await invoke<UnreadEnvironment | null>("get_environment", {
                  environmentId: bell.id,
                });
                seen.add(environment?.agentActivityState ?? "unknown");
                await sleep(1_000);
              }
              record.activityWhileHeld = [...seen];
              if (kind === "stop") {
                await invoke("stop_native_agent_session", identity);
              } else if (kind === "bridge-kill") {
                record.bridge = killBridge(status, platform, bell.id);
              } else {
                const bridgeBefore = containerId ? containerBridgePid(containerId) : undefined;
                status = await crashAndRestart(status);
                invoke = await authenticatedInvoke(page, status, profile);
                openEnvironment = sidebarNavigator(page, fixture!.name);
                await page.goto(status.browserUrl!);
                await goto(parked.name);
                progress("profile restarted");
                if (IN_CONTAINER) {
                  // The container's bridge survived, so the turn is still held
                  // at the model: nothing may ring until the model answers.
                  record.containerBridgePid = {
                    before: bridgeBefore,
                    after: containerBridgePid(containerId!),
                  };
                  expect(
                    bridgeBefore,
                    "no container bridge was running before the restart",
                  ).toBeGreaterThan(0);
                  expect(
                    record.containerBridgePid.after,
                    "the container bridge was replaced or disappeared during the backend restart",
                  ).toBe(bridgeBefore);
                  const seen = new Set<string>();
                  let quiet = true;
                  for (let sample = 0; sample < 10; sample += 1) {
                    const environment = await invoke<UnreadEnvironment | null>("get_environment", {
                      environmentId: bell.id,
                    });
                    seen.add(environment?.agentActivityState ?? "unknown");
                    expect(
                      environment,
                      "the held environment disappeared after the restart",
                    ).not.toBeNull();
                    expect(
                      environment?.agentActivityState,
                      `the held turn was not working after the restart (sample ${sample + 1})`,
                    ).toBe("working");
                    if (environment?.hasUnreadWork === true) quiet = false;
                    await sleep(1_000);
                  }
                  record.activityAfterRestart = [...seen];
                  record.quietUntilReleased = quiet;
                  expect(quiet, "the restarted backend rang while the turn was still held").toBe(
                    true,
                  );
                  expect(
                    (await control.stats()).held,
                    "the held request did not survive the restart",
                  ).toBeGreaterThan(0);
                  await control.hold(false);
                  progress("hold released after the restart");
                }
              }
            } else {
              await expect
                .poll(async () => (await control.stats()).requests, {
                  timeout: 180_000,
                })
                .toBeGreaterThan(before.requests);
            }
            const expected = expectedUnread(kind);
            await expect
              .poll(unread, { timeout: FAILURE_TIMEOUT_MS, intervals: [1_000] })
              .not.toBeNull();
            if (kind === "stop") {
              // A later edge must not turn the stop into a failure.
              await sleep(QUIET_MS);
            }
            record.unreadReason = await unread();
            await control.hold(false);
            const turn = (await projection())?.turn;
            record.turnPhase = turn?.phase;
            record.turnError = turn?.error?.slice(0, 200);
            expect(record.unreadReason).toBe(expected);
            if (checkSplitUnread && kind === "refused") {
              await viewUnreadCodexResult(page, identity, bell.name, () => goto(bell.name), unread);
              record.toast = true;
            } else {
              await goto(bell.name);
              await expect(page.getByText(TOAST_TITLES[expected], { exact: true })).toBeVisible({
                timeout: 10_000,
              });
              record.toast = true;
            }
            // Let the toast finish sliding in before the screenshot.
            await sleep(800);
            const shot = path.join(
              repositoryRoot,
              "output",
              "visual-previews",
              `5160-bell-${platform}-${kind}.png`,
            );
            mkdirSync(path.dirname(shot), { recursive: true });
            if (!checkSplitUnread || kind !== "refused") await page.screenshot({ path: shot });
            record.ms = Date.now() - startedAt;
            record.result = "passed";
            writeSummary();
            progress(`${kind} passed`);
            if (kind === "bridge-kill") {
              // The next case needs a bridge again; ensuring the session starts one.
              await expect
                .poll(
                  () =>
                    invoke("ensure_native_agent_session", {
                      ...identity,
                      ...(modelRef ? { model: modelRef } : {}),
                    }).then(
                      () => true,
                      () => false,
                    ),
                  { timeout: 120_000, intervals: [2_000] },
                )
                .toBe(true);
            }
          }
        });
      } finally {
        clearInterval(beat);
        summary.finishedAt = new Date().toISOString();
        writeSummary();
        await model?.hold(false).catch(() => undefined);
        // A restarted backend refuses container changes until it wins the lease.
        const leftovers = await removeEnvironments(current, created);
        if (leftovers.length) {
          summary.cleanupFailures = leftovers;
          writeSummary();
        }
        expect.soft(leftovers, "the run could not delete its environments").toEqual([]);
      }
    });
  }
});
