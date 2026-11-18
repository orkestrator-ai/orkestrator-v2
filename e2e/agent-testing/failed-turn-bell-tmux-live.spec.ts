/**
 * A refused login in a host `claude-tmux` tab rings "Agent stopped with an
 * error", live (#2317). Opt-in
 * (`ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL_TMUX=1`) against a running
 * credential-free agent-test profile with Claude in its toolchain. No login
 * and nothing billed: the profile's own Claude directory
 * (`<dataDir>/agent-credentials/claude`, the `CLAUDE_CONFIG_DIR` a host tmux
 * tab runs under) is pointed at `refused-login-model.ts`, which answers the
 * 401 a wrong key gets, with a bearer token so the interactive CLI asks no
 * API-key question; its first-run screens are answered in `.claude.json`.
 * Both files, and the `experimentalTmux` setting the run turns on, are
 * restored afterwards.
 *
 *   env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile ork-bell-tmux --fixture --no-agent-credentials \
 *     --no-host-seed --headless --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=ork-bell-tmux ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL_TMUX=1 \
 *     mise run test:logged -- --name failed-turn-bell-tmux -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts failed-turn-bell-tmux-live.spec.ts
 *
 * One fresh local environment holds one `claude-tmux` tab while the page sits
 * on a second environment. Once the CLI is idle a prompt is submitted from
 * outside the view; the model refuses it, and the environment must ring
 * `agent_failed`, the tab must stop reading busy, opening the environment
 * must show the toast, and the tab must find the CLI's transcript and show
 * its API-error reply. A second prompt is then submitted and the tab sampled
 * for up to 120 s, as evidence for the "Not logged in" gap the container CLI
 * showed (#2315); it is recorded, not asserted.
 *
 * Writes `output/agent-testing/<run>/failed-turn-bell/claude-tmux.json` and
 * saves the toast as `output/visual-previews/5160-bell-claude-tmux-refused.png`.
 */
import { expect, test, type Page } from "./browser-test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  fakeModelSettingsFile,
  startLocalFakeModel,
  withFakeModelCleanup,
  type FakeModelHandle,
} from "./idle-observation-fake-models";
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
import {
  onboardedClaudeState,
  refusedLoginTmuxSettings,
  removeEnvironments,
  TOAST_TITLES,
} from "./failed-turn-bell-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_FAILED_TURN_BELL_TMUX === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "ork-bell-tmux";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const REFUSED_MODEL = path.join(import.meta.dirname, "refused-login-model.ts");
/** The container CLI retried a refusal for about three minutes before `StopFailure`. */
const FAILURE_TIMEOUT_MS = 420_000;
/** How long the second prompt's tab is watched: longer than the slowest first refusal seen (46 s). */
const AFTER_SAMPLE_MS = 120_000;

type UnreadEnvironment = Environment & {
  hasUnreadWork?: boolean;
  unreadReason?: string;
  agentActivityState?: string;
};
type TmuxStatus = {
  running?: boolean;
  busy?: boolean;
  session_id?: string | null;
  transcript_path?: string | null;
  info_events?: Array<{ kind?: string }>;
};

test.use({ trace: "off", screenshot: "off" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readyStatus(): Status {
  const status = profileStatus(profile);
  expect(status.profile, "dev:status answered for a different profile").toBe(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  expect(status.dataDir, "dev:status names no data directory").toBeTruthy();
  return status;
}

/** Refuses to touch anything but a credential-free profile's own Claude directory. */
function credentialFreeClaudeDirectory(dataDir: string): string {
  const resolved = path.resolve(dataDir);
  const parts = resolved.split(path.sep);
  expect(
    parts.at(-1) === "data" && parts.at(-2) === profile && parts.at(-3) === "profiles",
    "the data directory is not this dev:test profile's",
  ).toBe(true);
  const manifest = JSON.parse(readFileSync(path.join(resolved, "..", "profile.json"), "utf8")) as {
    flavor?: string;
    credentialSources?: unknown;
  };
  expect(manifest.flavor).toBe("agent-test");
  expect(
    Array.isArray(manifest.credentialSources) && manifest.credentialSources.length === 0,
    "start the profile with --no-agent-credentials",
  ).toBe(true);
  return path.join(resolved, "agent-credentials", "claude");
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return {};
  }
}

async function dismissStartupDialogs(page: Page) {
  for (const name of ["Continue without Claude", "Continue without Docker", "Hide"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
  }
}

test.describe("a refused login in a claude-tmux tab rings the failed bell", () => {
  test.skip(!LIVE, "opt-in live check against a credential-free agent-test profile");

  test("claude-tmux: a refused turn rings agent_failed and the tab stops reading busy", async ({
    page,
  }) => {
    test.setTimeout(FAILURE_TIMEOUT_MS + 360_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.setDefaultTimeout(60_000);
    for (const name of ["Continue without Claude", "Continue without Docker"]) {
      const button = page.getByRole("button", { name, exact: true });
      await page.addLocatorHandler(button, () => button.click());
    }
    const progress = (step: string) => console.log(`[bell-tmux] ${step}`);
    const status = readyStatus();
    const claudeDirectory = credentialFreeClaudeDirectory(status.dataDir!);
    const invoke: Invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      // A profile restarted without `--fixture` keeps the fixture but stops naming it.
      (project) =>
        project.localPath ===
        (status.testProject ??
          path.join(path.dirname(status.dataDir!), "fixtures", "test-project")),
    );
    expect(fixture, "the fixture project is missing").toBeTruthy();

    const summary: Record<string, unknown> = {
      platform: "claude-tmux",
      profile,
      fakeModel: "refused-login",
      startedAt: new Date().toISOString(),
      result: "failed",
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
        path.join(directory, "claude-tmux.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
    };
    const handles: FakeModelHandle[] = [];
    const created: string[] = [];
    let origin = "";
    let tab: { environmentId: string; tabId: string } | undefined;
    const beat = setInterval(() => progress("still waiting"), 60_000);
    try {
      await withFakeModelCleanup(handles, async () => {
        const previousTmux = (
          await invoke<{ global?: { experimentalTmux?: boolean } }>("get_config")
        ).global?.experimentalTmux;
        await invoke("patch_global_config", { patch: { experimentalTmux: true } });
        handles.push({
          origin: "experimental-tmux",
          stop: async () => {
            await invoke("patch_global_config", {
              patch: { experimentalTmux: previousTmux ?? false },
            });
          },
        });

        // An earlier run of this spec that was killed left its two environments.
        for (const environment of await invoke<Environment[]>("get_environments", {
          projectId: fixture!.id,
        })) {
          if (!/^bell-(park-)?tmux-\d+$/.test(environment.name)) continue;
          await invoke("stop_environment", { environmentId: environment.id }).catch(() => {});
          await invoke("delete_environment", { environmentId: environment.id });
        }
        const stamp = Date.now();
        const bell = await invoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `bell-tmux-${stamp}`,
          environmentType: "local",
          networkAccessMode: "restricted",
        });
        created.push(bell.id);
        const parked = await invoke<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `bell-park-tmux-${stamp}`,
          environmentType: "local",
          networkAccessMode: "restricted",
        });
        created.push(parked.id);
        await invoke("start_environment", { environmentId: bell.id });
        const started = await invoke<Environment | null>("get_environment", {
          environmentId: bell.id,
        });
        const worktreePath = started?.worktreePath;
        expect(worktreePath, "the local environment has no worktree").toBeTruthy();

        // The model, then the two Claude files, both restored by the handles.
        const settingsFile = fakeModelSettingsFile("claude", status.dataDir!);
        expect(path.dirname(settingsFile)).toBe(claudeDirectory);
        const fake = await startLocalFakeModel("claude", status.dataDir!, {
          script: REFUSED_MODEL,
        });
        handles.push(fake);
        origin = fake.origin;
        summary.fakeModelOrigin = origin;
        writeFileSync(
          settingsFile,
          `${JSON.stringify(refusedLoginTmuxSettings(readJson(settingsFile), origin), null, 2)}\n`,
          { mode: 0o600 },
        );
        const stateFile = path.join(claudeDirectory, ".claude.json");
        const restoreState = snapshotFixtureFiles([stateFile]);
        handles.push({ origin: "claude-state", stop: async () => restoreState() });
        writeFileSync(
          stateFile,
          `${JSON.stringify(onboardedClaudeState(readJson(stateFile), worktreePath!), null, 2)}\n`,
          { mode: 0o600 },
        );

        const tabId = `bell-tmux-${randomUUID().slice(0, 8)}`;
        tab = { environmentId: bell.id, tabId };
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: bell.id,
        });
        await invoke("save_pane_layout", {
          environmentId: bell.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "bell-tmux-pane",
            root: {
              kind: "leaf",
              id: "bell-tmux-pane",
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  type: "claude-tmux",
                  displayTitle: "Claude tmux bell",
                  claudeTmuxData: { environmentId: bell.id, isLocal: true },
                },
              ],
            },
          },
        });
        const launchedAt = Date.now();
        await invoke("launch_terminal_job", {
          environmentId: bell.id,
          requestId: `bell-tmux-${stamp}`,
          tabId,
          tabType: "claude-tmux",
          title: "Claude tmux bell",
        });
        const tmux = () => invoke<TmuxStatus | null>("claude_tmux_status", tab!);
        await expect
          .poll(
            async () => {
              const current = await tmux();
              return current?.running === true && current.busy !== true;
            },
            { timeout: 120_000, intervals: [1_000] },
          )
          .toBe(true);
        summary.tabReadyMs = Date.now() - launchedAt;
        summary.modelRequestsAtStart = (await refusedLoginStats(origin)).requests;
        progress("tab idle");

        const environmentState = () =>
          invoke<UnreadEnvironment | null>("get_environment", { environmentId: bell.id });
        const unread = async () => {
          const environment = await environmentState();
          return environment?.hasUnreadWork === true ? (environment.unreadReason ?? "?") : null;
        };
        const openEnvironment = sidebarNavigator(page, fixture!.name);
        const goto = async (name: string) => {
          await dismissStartupDialogs(page);
          await openEnvironment(name);
        };
        await page.goto(status.browserUrl!);
        await dismissStartupDialogs(page);
        // Read any earlier bell (the CLI's start), then park on the other environment.
        await goto(bell.name);
        await expect.poll(unread, { timeout: 30_000 }).toBeNull();
        await goto(parked.name);
        progress("parked");

        await setRefusedLoginHold(origin, false);
        const before = (await refusedLoginStats(origin)).requests;
        const submittedAt = Date.now();
        await invoke("claude_tmux_submit", { ...tab, text: "Reply with only OK (refused)." });
        await expect
          .poll(async () => (await refusedLoginStats(origin)).requests, { timeout: 120_000 })
          .toBeGreaterThan(before);
        summary.firstRefusalMs = Date.now() - submittedAt;
        progress("refused at the model");
        const seenWhileFailing = new Set<string>();
        await expect
          .poll(
            async () => {
              seenWhileFailing.add((await environmentState())?.agentActivityState ?? "unknown");
              return unread();
            },
            { timeout: FAILURE_TIMEOUT_MS, intervals: [1_000] },
          )
          .not.toBeNull();
        summary.bellMs = Date.now() - submittedAt;
        summary.activityWhileFailing = [...seenWhileFailing];
        summary.unreadReason = await unread();
        summary.modelRequestsForTurn = (await refusedLoginStats(origin)).requests - before;
        expect(summary.unreadReason).toBe("agent_failed");
        await expect
          .poll(async () => (await tmux())?.busy === true, { timeout: 30_000 })
          .toBe(false);
        const settled = await environmentState();
        summary.activityAfterBell = settled?.agentActivityState ?? null;
        expect(settled?.agentActivityState).not.toBe("working");

        await goto(bell.name);
        await expect(page.getByText(TOAST_TITLES.agent_failed, { exact: true })).toBeVisible({
          timeout: 10_000,
        });
        summary.toast = true;
        await sleep(800);
        const shot = path.join(
          repositoryRoot,
          "output",
          "visual-previews",
          "5160-bell-claude-tmux-refused.png",
        );
        mkdirSync(path.dirname(shot), { recursive: true });
        await page.screenshot({ path: shot });
        // The toast sends the user to the tab, so the tab must show the error:
        // the CLI's synthetic API-error reply in its transcript. Before the
        // 2026-11-16 fix to `encodeCwd` a host tab under a path with a space
        // (every macOS worktree) never found its transcript and showed nothing.
        const afterFailure = await tmux();
        summary.transcriptFound = Boolean(afterFailure?.transcript_path);
        summary.infoEventKinds = (afterFailure?.info_events ?? []).map((event) => event.kind);
        summary.tabShowsError = await page
          .getByText(
            /Not logged in|Please run \/login|API Error|Invalid API key|authentication_error/i,
          )
          .first()
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(
            () => true,
            () => false,
          );
        await page.screenshot({
          path: path.join(
            repositoryRoot,
            "output",
            "visual-previews",
            "5160-bell-claude-tmux-tab-after.png",
          ),
        });
        writeSummary();
        expect(summary.transcriptFound, "the tab found no transcript").toBe(true);
        expect(summary.tabShowsError, "the tab shows no error").toBe(true);
        summary.result = "passed";
        writeSummary();
        progress("refused turn passed");

        // Evidence for 8092: whether the next prompt reaches the model and the
        // tab settles, within AFTER_SAMPLE_MS. Recorded, not asserted.
        await goto(parked.name);
        const beforeNext = (await refusedLoginStats(origin)).requests;
        await invoke("claude_tmux_submit", { ...tab, text: "Reply with only OK (after)." });
        const busySamples: boolean[] = [];
        const activitySamples = new Set<string>();
        const nextAt = Date.now();
        let requestAfterMs: number | null = null;
        let busyClearedAfterMs: number | null = null;
        let sawBusy = false;
        while (Date.now() - nextAt < AFTER_SAMPLE_MS) {
          const busy = (await tmux())?.busy === true;
          busySamples.push(busy);
          sawBusy ||= busy;
          if (sawBusy && !busy && busyClearedAfterMs === null) {
            busyClearedAfterMs = Date.now() - nextAt;
          }
          if (requestAfterMs === null && (await refusedLoginStats(origin)).requests > beforeNext) {
            requestAfterMs = Date.now() - nextAt;
          }
          activitySamples.add((await environmentState())?.agentActivityState ?? "unknown");
          if (busyClearedAfterMs !== null && requestAfterMs !== null) break;
          await sleep(1_000);
        }
        summary.nextPrompt = {
          modelRequests: (await refusedLoginStats(origin)).requests - beforeNext,
          requestAfterMs,
          busyClearedAfterMs,
          busyAtEnd: busySamples.at(-1) ?? null,
          busySamples: busySamples.filter(Boolean).length,
          activity: [...activitySamples],
          unreadReason: await unread(),
        };
        writeSummary();
      });
    } finally {
      clearInterval(beat);
      summary.finishedAt = new Date().toISOString();
      writeSummary();
      if (tab) await invoke("claude_tmux_stop", tab).catch(() => undefined);
      const leftovers = await removeEnvironments(invoke, created);
      if (leftovers.length) {
        summary.cleanupFailures = leftovers;
        writeSummary();
      }
      expect.soft(leftovers, "the run could not delete its environments").toEqual([]);
    }
  });
});
