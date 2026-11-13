/**
 * Live bytes per prompt send and per turn check (to-do 5340 (retired), task 1;
 * efficiency batch E9): what a real Claude bridge answers the backend for one
 * prompt send and for one turn check, on a `dev:test --fixture` profile with
 * no billed turn.
 *
 * Opt-in only (`ORKESTRATOR_AGENT_TEST_E9_READS=1`). Start a credential-free
 * profile of its own:
 *
 *   ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile e9-reads \
 *     --fixture --headless --no-agent-credentials --no-host-seed --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=e9-reads ORKESTRATOR_AGENT_TEST_E9_READS=1 \
 *     mise run test:logged -- --name e9-reads -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts \
 *     transcript-read-bytes-live.spec.ts --workers=1
 *
 * The profile's own Claude CLI (its isolated `CLAUDE_CONFIG_DIR`) is sent to
 * the loopback model `fake-anthropic-model.ts`, and a `bun` wrapper in the
 * profile's own toolchain directory loads `conditional-reads-bridge-counter.ts`
 * into the bridge, which counts the bytes of every answer by route. Both files
 * are removed at the end. No page renders the session: commands go through
 * the gateway's `/invoke` with the page's cookie, so the only bridge reads are
 * the backend's own.
 *
 * After a few streamed turns build a history, it measures:
 *
 * - **Prompt send**: `dispatch_native_agent_intent` with a prompt the model
 *   parks (`[hold:<id>]`), counted from the dispatch for `SEND_WINDOW_MS`, so
 *   the window holds the dispatch and any refresh it causes but no streaming.
 *   The same length straight after, still parked, is the background of a
 *   running turn.
 * - **Turn check**: `get_native_agent_session_state_update` (what the backend's
 *   turn checks call since E9) on an idle session, each counted from the
 *   command to its answer; the one-message projection the turn checks called
 *   before E9 (`get_native_agent_projection`, `messageLimit: 1`) is measured
 *   the same way for comparison. An idle window with no command is the
 *   background.
 *
 * The backend's own timers (the activity sweep's `POST /sessions/activity`
 * every two seconds, and the change-evidence poll) read the bridge whatever
 * the client does, so they are counted apart from each figure
 * (`transcript-read-bytes-support.ts`). Output is counts, bytes and milliseconds in
 * `output/agent-testing/<run id>/transcript-read-bytes.json`; no prompt, row
 * content, token or session id is written.
 */
import { expect, test, type Page } from "./browser-test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CounterFile } from "./conditional-reads-bridge-counter";
import { summarizeCounters, withCleanup } from "./conditional-reads-measurement";
import {
  fakeModelClaudeSettings,
  startFakeAnthropicModel,
  type FakeAnthropicModel,
} from "./fake-anthropic-model";
import { readWindowFigures, type ReadWindow } from "./transcript-read-bytes-support";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
  pids?: { backend?: number };
};
type Project = { id: string; localPath: string | null };
type Environment = { id: string; name: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "e9-reads";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_E9_READS === "1";
const HISTORY_TURNS = Number(process.env.E9_HISTORY_TURNS ?? 6);
/** Fixture lines per history answer (about 100 bytes each). */
const HISTORY_LINES = Number(process.env.E9_HISTORY_LINES ?? 80);
const SENDS = Number(process.env.E9_SENDS ?? 5);
const CHECKS = Number(process.env.E9_CHECKS ?? 10);
const SEND_WINDOW_MS = Number(process.env.E9_SEND_WINDOW_MS ?? 6_000);
const IDLE_WINDOW_MS = Number(process.env.E9_IDLE_WINDOW_MS ?? 10_000);
const TURN_TIMEOUT_MS = 120_000;
const TAB_ID = "e9-reads-tab";
const outputDirectory = path.join(repositoryRoot, "output", "agent-testing", runId);
const counterDirectory = path.join(outputDirectory, "bridge-counters-e9");

test.describe.configure({ mode: "serial" });
// Commands carry a fixture prompt only, but nothing here needs a trace.
test.use({ trace: "off" });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = JSON.parse(command.stdout) as Status;
  expect(status.profile).toBe(profile);
  expect(status.status).toBe("ready");
  expect(status.flavor, "runs only in an agent-test profile").toBe("agent-test");
  return status;
}

/** Cookie sign-in through a single-use link; the page then leaves the app. */
async function signIn(page: Page, status: Status): Promise<Invoke> {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error("dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  // No rendered app: its reads would land in the windows.
  await page.goto("about:blank");
  return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const answer = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command: name, args }, timeout: 60_000 },
    );
    expect(answer.ok(), `${name} failed with HTTP ${answer.status()}`).toBe(true);
    return ((await answer.json()) as { result: T }).result;
  };
}

/** The profile backend's own toolchain directory, from its command line. */
function toolchainBinDir(status: Status): string {
  const argv = readFileSync(`/proc/${status.pids!.backend}/cmdline`, "utf8").split("\0");
  const directory = argv[argv.indexOf("--toolchain-bin-dir") + 1];
  if (!directory?.startsWith(status.dataDir!)) throw new Error("toolchain is not the profile's");
  return directory;
}

const earlierBridges = new Set<string>();
function counterFiles(): CounterFile[] {
  return readdirSync(counterDirectory)
    .filter((name) => name.endsWith(".json") && !earlierBridges.has(name))
    .map((name) => JSON.parse(readFileSync(path.join(counterDirectory, name), "utf8")));
}

test.describe("E9 live: bytes per prompt send and per turn check", () => {
  test.skip(!OPT_IN, "Set ORKESTRATOR_AGENT_TEST_E9_READS=1 on a credential-free profile");

  test("a real Claude bridge against a loopback model", async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const status = profileStatus();
    const claudeConfigDir = path.join(status.dataDir!, "agent-credentials", "claude");
    const settingsFile = path.join(claudeConfigDir, "settings.json");
    const wrapper = path.join(toolchainBinDir(status), "bun");
    expect(existsSync(settingsFile), "the profile already has Claude settings").toBe(false);
    expect(existsSync(wrapper), "the profile toolchain already has a bun").toBe(false);
    const realBun = execFileSync("mise", ["which", "bun"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();

    const results: Record<string, unknown> = {
      profile,
      platform: "claude",
      commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
      historyTurns: HISTORY_TURNS,
      historyLines: HISTORY_LINES,
      sendWindowMs: SEND_WINDOW_MS,
    };
    let model: FakeAnthropicModel | undefined;
    let ownsSettings = false;
    let ownsWrapper = false;
    let invoke: Invoke | undefined;
    let environmentId: string | undefined;
    await withCleanup(
      async () => {
        rmSync(counterDirectory, { recursive: true, force: true });
        mkdirSync(counterDirectory, { recursive: true });
        await sleep(1_500);
        for (const name of readdirSync(counterDirectory)) earlierBridges.add(name);
        model = await startFakeAnthropicModel();
        mkdirSync(claudeConfigDir, { recursive: true });
        ownsSettings = true;
        writeFileSync(settingsFile, JSON.stringify(fakeModelClaudeSettings(model.origin)));
        ownsWrapper = true;
        writeFileSync(
          wrapper,
          [
            "#!/bin/sh",
            `export E10_BRIDGE_COUNTER_DIR=${JSON.stringify(counterDirectory)}`,
            `exec ${JSON.stringify(realBun)} --preload ${JSON.stringify(path.join(import.meta.dirname, "conditional-reads-bridge-counter.ts"))} "$@"`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );

        invoke = await signIn(page, status);
        const call = invoke;
        const fixture = (await call<Project[]>("get_projects")).find(
          (project) => project.localPath === status.testProject,
        );
        expect(fixture, "the profile has no seeded fixture project").toBeTruthy();
        const environment = await call<Environment>("create_environment", {
          projectId: fixture!.id,
          name: `e9-reads-${Date.now()}`,
          environmentType: "local",
          networkAccessMode: "restricted",
        });
        environmentId = environment.id;
        await call("start_environment", { environmentId });
        const layout = await call<{ revision?: number } | null>("get_pane_layout", {
          environmentId,
        });
        await call("save_pane_layout", {
          environmentId,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "e9-pane",
            root: {
              kind: "leaf",
              id: "e9-pane",
              activeTabId: TAB_ID,
              tabs: [
                {
                  id: TAB_ID,
                  type: "agent-native",
                  displayTitle: "E9 reads",
                  nativeAgentData: { environmentId, platform: "claude", isLocal: true },
                },
              ],
            },
          },
        });
        const identity = {
          environmentId,
          agent: "claude",
          logicalSessionKey: `env-${environmentId}:${TAB_ID}`,
        };
        await call("ensure_native_agent_session", identity);

        const phase = async () => {
          const update = await call<{ status: string; value?: { turn?: { phase?: string } } }>(
            "get_native_agent_session_state_update",
            { ...identity, viewVersion: 1, forceSnapshot: true },
          );
          return update.value?.turn?.phase ?? update.status;
        };
        const dispatch = async (prompt: string) => {
          const outcome = await call<{ outcome: string }>("dispatch_native_agent_intent", {
            ...identity,
            prompt,
            requestId: randomUUID(),
          });
          expect(outcome.outcome, "the prompt was not accepted").toBe("accepted");
        };
        const settle = async () => {
          // Two idle answers in a row: the turn ended and stayed ended.
          let idle = 0;
          await expect
            .poll(
              async () => {
                idle = (await phase()) === "idle" ? idle + 1 : 0;
                return idle;
              },
              { timeout: TURN_TIMEOUT_MS, intervals: [1_000] },
            )
            .toBeGreaterThanOrEqual(2);
        };

        // A history, so a read that carries rows has rows to carry.
        for (let turn = 0; turn < HISTORY_TURNS; turn += 1) {
          await dispatch(`E9 history ${turn} [stream:${HISTORY_LINES}]`);
          await expect
            .poll(() => model!.callsWith(`E9 history ${turn}`).some((c) => c.streamedAt), {
              timeout: TURN_TIMEOUT_MS,
            })
            .toBe(true);
          await settle();
        }
        await sleep(3_000);

        const windows: ReadWindow[] = [];
        // Idle background, before any measured command.
        {
          const from = Date.now();
          await sleep(IDLE_WINDOW_MS);
          windows.push({ kind: "idle-background", from, to: Date.now() });
        }
        for (let check = 0; check < CHECKS; check += 1) {
          const from = Date.now();
          await call("get_native_agent_session_state_update", {
            ...identity,
            viewVersion: 1,
            forceSnapshot: true,
          });
          windows.push({ kind: "turn-check", from, to: Date.now() + 50 });
          await sleep(1_500);
        }
        for (let check = 0; check < CHECKS; check += 1) {
          const from = Date.now();
          await call("get_native_agent_projection", { ...identity, messageLimit: 1 });
          windows.push({ kind: "pre-e9-turn-check", from, to: Date.now() + 50 });
          await sleep(1_500);
        }
        for (let send = 0; send < SENDS; send += 1) {
          const hold = `e9-send-${send}`;
          const from = Date.now();
          await dispatch(`E9 send ${send} [hold:${hold}]`);
          const answeredAt = Date.now();
          await expect
            .poll(() => model!.held().includes(hold), { timeout: 60_000, intervals: [100] })
            .toBe(true);
          const parkedAt = Date.now();
          await sleep(Math.max(0, from + SEND_WINDOW_MS - Date.now()));
          const to = Date.now();
          windows.push({
            kind: "prompt-send",
            from,
            to,
            dispatchMs: answeredAt - from,
            modelReachedMs: parkedAt - from,
          });
          await sleep(SEND_WINDOW_MS);
          windows.push({ kind: "running-background", from: to, to: Date.now() });
          model!.release(hold);
          await settle();
          await sleep(2_000);
        }
        // The counter files are flushed once a second.
        await sleep(1_500);
        const files = counterFiles();
        const figures = readWindowFigures(windows, (from, to) =>
          summarizeCounters(files, from, to),
        );
        results.windows = figures.windows;
        results.summary = figures.summary;
        results.modelCalls = model!.calls().length;

        const summary = figures.summary;
        expect(summary["prompt-send"]?.windows).toBe(SENDS);
        expect(summary["turn-check"]?.windows).toBe(CHECKS);
        // Every prompt send reached the bridge.
        for (const window of figures.windows.filter((entry) => entry.kind === "prompt-send")) {
          expect(window.requests, "a prompt send made no bridge request").toBeGreaterThan(0);
        }
        // E9: a turn check reads session state, never a transcript.
        for (const window of figures.windows.filter((entry) => entry.kind === "turn-check")) {
          expect(window.transcriptBytes, "a turn check read transcript rows").toBe(0);
        }
      },
      async () => {
        try {
          mkdirSync(outputDirectory, { recursive: true });
          writeFileSync(
            path.join(outputDirectory, "transcript-read-bytes.json"),
            `${JSON.stringify(results, null, 2)}\n`,
          );
          if (invoke && environmentId) {
            await invoke("stop_environment", { environmentId }).catch(() => undefined);
            await invoke("delete_environment", { environmentId }).catch(() => undefined);
          }
        } finally {
          try {
            if (ownsWrapper) rmSync(wrapper, { force: true });
          } finally {
            try {
              if (ownsSettings) rmSync(settingsFile, { force: true });
            } finally {
              await model?.stop();
            }
          }
        }
      },
    );
  });
});
