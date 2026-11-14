/**
 * Failed native turns ring "Agent stopped with an error", live (to-do 5160
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
 * Only processes under this profile's backend are signalled, after their
 * command line is checked. Each platform writes
 * `output/agent-testing/<run>/failed-turn-bell/<platform>.json`, and the
 * toasts are saved as `output/visual-previews/5160-bell-<platform>-<case>.png`.
 */
import { expect, test, type Page } from "./browser-test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
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
  bellCases,
  bellPlatforms,
  bridgeProcess,
  expectedUnread,
  loggedBridgePid,
  parseProcessRows,
  TOAST_TITLES,
  type BellCase,
  type BellPlatform,
} from "./failed-turn-bell-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "ork-bell";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const PLATFORMS = bellPlatforms(process.env.ORKESTRATOR_AGENT_TEST_BELL_PLATFORMS);
const CASES = bellCases(process.env.ORKESTRATOR_AGENT_TEST_BELL_CASES);
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

async function dismissStartupDialogs(page: Page) {
  for (const name of ["Continue Without Claude", "Continue Without Docker", "Hide"]) {
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
      for (const name of ["Continue Without Claude", "Continue Without Docker"]) {
        const button = page.getByRole("button", { name, exact: true });
        await page.addLocatorHandler(button, () => button.click());
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
      const created: string[] = [];
      // Content-free heartbeat: keeps the logged runner's no-output watchdog fed.
      const beat = setInterval(() => progress("still waiting"), 60_000);
      try {
        await withFakeModelCleanup(handles, async () => {
          const fake = await startLocalFakeModel(platform, status.dataDir!, {
            script: REFUSED_MODEL,
          });
          handles.push(fake);
          const origin = fake.origin;
          summary.fakeModelOrigin = origin;
          if (platform === "codex") handles.push(madeUpCodexKey(status.dataDir!));
          if (platform === "opencode") {
            const restore = await allowOpenCodeFakeProvider(current, PI_FAKE_PROVIDER);
            handles.push({ origin: "opencode-allowlist", stop: restore });
          }
          const model = platform === "pi" || platform === "opencode" ? PI_FAKE_MODEL_REF : null;
          // An earlier run of this spec that was killed left its two environments.
          const stale = new RegExp(`^bell-(park-)?${platform}-\\d+$`);
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
            name: `bell-${platform}-${stamp}`,
            environmentType: "local",
            networkAccessMode: "restricted",
          });
          created.push(bell.id);
          const parked = await invoke<Environment>("create_environment", {
            projectId: fixture!.id,
            name: `bell-park-${platform}-${stamp}`,
            environmentType: "local",
            networkAccessMode: "restricted",
          });
          created.push(parked.id);
          const tabId = `bell-${platform}`;
          const identity = {
            environmentId: bell.id,
            agent: platform,
            logicalSessionKey: `env-${bell.id}:${tabId}`,
          };
          const prepare = async () => {
            await invoke("start_environment", { environmentId: bell.id });
            const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
              environmentId: bell.id,
            });
            await invoke("save_pane_layout", {
              environmentId: bell.id,
              expectedRevision: layout?.revision ?? 0,
              layout: {
                version: PANE_LAYOUT_VERSION,
                containerId: null,
                activePaneId: "bell-pane",
                root: {
                  kind: "leaf",
                  id: "bell-pane",
                  activeTabId: tabId,
                  tabs: [
                    {
                      id: tabId,
                      type: "agent-native",
                      displayTitle: `${platform} bell`,
                      nativeAgentData: { environmentId: bell.id, platform, isLocal: true },
                      ...(model ? { initialAgentModel: model } : {}),
                    },
                  ],
                },
              },
            });
          };
          await prepare();
          await invoke("ensure_native_agent_session", {
            ...identity,
            ...(model ? { model } : {}),
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
            await setRefusedLoginHold(origin, hold);
            const before = await refusedLoginStats(origin);
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
                .poll(async () => (await refusedLoginStats(origin)).held, {
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
                status = await crashAndRestart(status);
                invoke = await authenticatedInvoke(page, status, profile);
                openEnvironment = sidebarNavigator(page, fixture!.name);
                await page.goto(status.browserUrl!);
                await goto(parked.name);
                progress("profile restarted");
              }
            } else {
              await expect
                .poll(async () => (await refusedLoginStats(origin)).requests, {
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
            await setRefusedLoginHold(origin, false);
            const turn = (await projection())?.turn;
            record.turnPhase = turn?.phase;
            record.turnError = turn?.error?.slice(0, 200);
            expect(record.unreadReason).toBe(expected);
            await goto(bell.name);
            await expect(page.getByText(TOAST_TITLES[expected], { exact: true })).toBeVisible({
              timeout: 10_000,
            });
            record.toast = true;
            // Let the toast finish sliding in before the screenshot.
            await sleep(800);
            const shot = path.join(
              repositoryRoot,
              "output",
              "visual-previews",
              `5160-bell-${platform}-${kind}.png`,
            );
            mkdirSync(path.dirname(shot), { recursive: true });
            await page.screenshot({ path: shot });
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
                      ...(model ? { model } : {}),
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
        await setRefusedLoginHold(String(summary.fakeModelOrigin ?? ""), false).catch(
          () => undefined,
        );
        for (const environmentId of created) {
          await invoke("stop_environment", { environmentId }).catch(() => undefined);
          await invoke("delete_environment", { environmentId }).catch(() => undefined);
        }
      }
    });
  }
});
