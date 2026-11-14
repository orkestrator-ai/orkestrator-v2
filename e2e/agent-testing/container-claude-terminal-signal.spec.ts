import { installFakeClaudeApiFixture } from "./container-fake-claude-install";
import { REFUSE_MARKER } from "./container-fake-claude-api";
import { expect, test, type Page, type TestInfo } from "./browser-test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";
import { sidebarActivity } from "./sidebar-activity";
import {
  containerProcessesInSessions,
  containerSessionsRunning,
} from "./container-terminal-processes";
import { terminalVisibleText } from "./terminal-visible-text";

/**
 * The Claude terminal state signal (`claude-state-signal=2`) with a real
 * `claude` turn in a container terminal tab, opened from the real renderer
 * against a profile started with
 * `--fixture-environments local,container --credential-source claude` and an
 * image built from this checkout. Terminal Claude is the only path whose
 * hooks ring the signal: bridge sessions set `ORKESTRATOR_NATIVE_AGENT_BRIDGE`
 * and the hooks stay silent there.
 *
 * Two turns in one interactive `claude`: the first with the container's
 * environment selected, the second sent and then left for the local fixture
 * environment, so the container is a background environment. For each it
 * measures, on the host clock, Enter to the backend's `claude-terminal`
 * activity and to the sidebar showing working (budget ≤ 4 s), and the Stop
 * hook's state-file write (container clock, corrected by a measured offset)
 * to the sidebar showing waiting (budget ≤ 3 s). The signal must stay
 * confirmed with no demotion: a demotion means a hook ring was missed.
 *
 * Opt-in on top of the Docker fixture (`ORKESTRATOR_AGENT_TEST_DOCKER=1`),
 * with one of two model backends:
 *
 * - `ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL=1`: the host's Claude login
 *   (access-only in the container), against a profile started with
 *   `--credential-source claude`. Real turns; they may cost money.
 * - `ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_API=1`: no login and no provider
 *   request. The image's own `claude` talks to `container-fake-claude-api.ts`
 *   on the container's loopback, through `ANTHROPIC_BASE_URL` and a fixture
 *   `ANTHROPIC_AUTH_TOKEN` merged into `~/.claude/settings.json` for the
 *   test and restored afterwards. The CLI, its hooks, the ring, the backend
 *   and the sidebar are all real; only the model is not. Use it with a
 *   credential-free profile (`--no-agent-credentials --agent-platforms claude`).
 *
 * `ORKESTRATOR_AGENT_TEST_CLAUDE_TERMINAL_FAILED_TURN=1` (fake API only) adds
 * a third turn in the background that the fake refuses with a 401, as a wrong
 * key would be (to-do 5160 task 4): the sidebar must leave working, the
 * environment must ring `agent_failed` and opening it must show "Agent
 * stopped with an error". The next prompt in that session is recorded: the
 * CLI then answers "Not logged in" locally, with no hook (to-do 8092).
 * Screenshots go to `output/visual-previews/5160-container-claude-*.png`.
 *
 * Nothing at module scope spawns `mise` or `docker`, so the file stays inert
 * without the opt-ins. The report is content-free: timings and counts only.
 */

type Status = { status: string; browserUrl: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = {
  id: string;
  name: string;
  containerId?: string | null;
  hasUnreadWork?: boolean;
  unreadReason?: string;
  agentActivityState?: string;
  agentActivityUpdatedAt?: string;
};
type SignalStatus = {
  containers: number;
  states: Record<string, number>;
  fallback: number;
  demotions: Record<string, number>;
  rings: number;
};
type TurnTiming = {
  background: boolean;
  enterToBackendWorkingMs: number;
  enterToSidebarWorkingMs: number;
  answerVisibleToSidebarWaitingMs: number;
  stopHookToBackendWaitingMs: number;
  stopHookToSidebarWaitingMs: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const containerName =
  process.env.ORKESTRATOR_AGENT_TEST_ROOT_TERMINAL_ENVIRONMENT ?? "fixture-container";
const localName = "fixture-local";
const FAKE_API = process.env.ORKESTRATOR_AGENT_TEST_FAKE_CLAUDE_API === "1";
const FAILED_TURN =
  FAKE_API && process.env.ORKESTRATOR_AGENT_TEST_CLAUDE_TERMINAL_FAILED_TURN === "1";
const ENABLED =
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1" &&
  (process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL === "1" || FAKE_API);
const ACTIVITY_BUDGET_MS = 4_000;
const COMPLETION_BUDGET_MS = 3_000;
const STATE_FILE = "/tmp/.claude-state";

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout) as T;
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 15_000, input });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout.trim();
}

async function installFakeClaudeApi(containerId: string): Promise<() => void> {
  return installFakeClaudeApiFixture({
    asNode: (script, input) =>
      docker(["exec", "-i", "--user", "node", containerId, "sh", "-c", script], input),
    startServer: (args) => docker(["exec", "-d", "--user", "node", containerId, ...args]),
    stopServer: () => {
      // The bracket pattern cannot match pkill's own command line. Exit 1 is fine.
      spawnSync(
        "docker",
        ["exec", containerId, "pkill", "-f", "orkestrator-qa-fake-claude-ap[i]"],
        {
          timeout: 15_000,
        },
      );
    },
    source: readFileSync(path.join(import.meta.dirname, "container-fake-claude-api.ts"), "utf8"),
    waitUntilReady: async () => {
      await expect
        .poll(
          () =>
            spawnSync(
              "docker",
              [
                "exec",
                containerId,
                "curl",
                "-fsS",
                "-o",
                "/dev/null",
                "-X",
                "POST",
                "-d",
                "{}",
                "http://127.0.0.1:47123/v1/messages/count_tokens",
              ],
              { timeout: 5_000 },
            ).status,
          { timeout: 15_000 },
        )
        .toBe(0);
    },
  });
}

/** Container clock minus host clock, in ms, from the tightest of five reads. */
function containerClockOffsetMs(containerId: string): number {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };
  for (let index = 0; index < 5; index += 1) {
    const before = Date.now();
    const seconds = Number(docker(["exec", containerId, "date", "+%s.%N"]));
    const after = Date.now();
    if (after - before < best.rtt) {
      best = { rtt: after - before, offset: seconds * 1_000 - (before + after) / 2 };
    }
  }
  return best.offset;
}

/**
 * Whether the container can open a TCP connection to the backend's agent
 * tools server, the doorbell's only route. Reads just the `url` line of the
 * installed doorbell config (never its credential header) and reports
 * `host:port`, or why it could not tell.
 */
function doorbellReachability(containerId: string): string {
  const probe = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "node",
      containerId,
      "sh",
      "-c",
      // curl's 000 is "no HTTP answer at all"; any status means the port answered.
      `u=$(sed -n 's/^url = "\\(http:\\/\\/[^/]*\\)\\/.*"$/\\1/p' /tmp/.orkestrator-claude-state-signal 2>/dev/null); [ -n "$u" ] || { echo no-config; exit 0; }; printf '%s ' "\${u#http://}"; curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --connect-timeout 3 --max-time 4 "$u/" || true`,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  return probe.status === 0 ? probe.stdout.trim() : "probe-failed";
}

/** The Stop/UserPromptSubmit hook's last state-file write, on the host clock. */
function stateFileWrittenAt(containerId: string, offsetMs: number): number {
  return Number(docker(["exec", containerId, "stat", "-c", "%.9Y", STATE_FILE])) * 1_000 - offsetMs;
}

async function login(page: Page, testInfo: TestInfo, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = profileCommand<{ loginUrl?: unknown }>("dev:login");
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
  const request = page.context().request;
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await request.post(new URL("/__orkestrator/invoke", status.browserUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** Poll every 50 ms until `predicate` holds; the host time it first held. */
async function firstTimeTrue(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test.skip(!ENABLED, "Docker fixture profile and live Claude terminal opt-in required");

test("Docker fixture live terminal Claude turn rings the state signal within budget", async ({
  page,
}, testInfo) => {
  test.setTimeout((FAILED_TURN ? 20 : 10) * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1280, height: 860 });
  // A control that never becomes actionable fails the run instead of hanging it.
  page.setDefaultTimeout(60_000);
  if (FAKE_API) {
    // The fake-API profile has no host Claude login by design. The container's
    // CLI gets its fixture token from settings, so the host notice is moot.
    // A live run keeps the notice: there it means the login is missing.
    await page.addLocatorHandler(
      page.getByRole("button", { name: "Continue Without Claude", exact: true }),
      (button) => button.click(),
    );
  }
  const invoke = await login(page, testInfo, status);

  let container: Environment | undefined;
  let local: Environment | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    const environments = await invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    container ??= environments.find((entry) => entry.name === containerName);
    local ??= environments.find((entry) => entry.name === localName);
  }
  expect(container?.containerId, `${containerName} has no container`).toBeTruthy();
  expect(local, `${localName} is missing`).toBeTruthy();
  const containerId = container!.containerId!;
  // The client projection carries the aggregate activity; this fixture has no
  // other agent, so it is the terminal Claude source.
  const backendEnvironment = async (): Promise<Environment | undefined> => {
    for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
      const found = (
        await invoke<Environment[]>("get_environments", { projectId: project.id })
      ).find((entry) => entry.id === container!.id);
      if (found) return found;
    }
    return undefined;
  };
  const backendState = async (): Promise<string | undefined> =>
    (await backendEnvironment())?.agentActivityState;
  const signal = async (): Promise<SignalStatus> => {
    const diagnostics = await invoke<{ signals: Array<{ name: string; status: SignalStatus }> }>(
      "get_recurring_work_diagnostics",
    );
    const entry = diagnostics.signals.find(({ name }) => name === "claude-state-signal");
    if (!entry) throw new Error("claude-state-signal is not registered");
    return entry.status;
  };
  const originalLayout = await invoke<unknown>("get_pane_layout", {
    environmentId: container!.id,
  });
  let sessionId: string | undefined;
  let undoFakeApi: (() => void) | undefined;
  // The terminal sessions (session IDs) running `claude` before this test's
  // tab, so cleanup can tell its own shell from an earlier one.
  const claudeSessionsBefore = containerSessionsRunning(containerId, "claude");
  let claudeSessions = new Set<number>();

  try {
    const expand = page.getByRole("button", { name: /^Expand project / }).first();
    const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
    await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    const containerItem = page.getByText(containerName, { exact: true }).first();
    const localItem = page.getByText(localName, { exact: true }).first();
    await expect(containerItem).toBeVisible({ timeout: 15_000 });
    await containerItem.click();

    // The signal is armed per container lineage, before any terminal exists.
    try {
      await expect
        .poll(async () => (await signal()).states.confirmed, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
    } catch (error) {
      // An armed signal that never rings is almost always the route, not the
      // hooks: on Linux Engine a host firewall that drops container traffic
      // to the host (ufw's default-deny input, say) leaves it armed forever.
      const reach = doorbellReachability(containerId);
      if (reach.endsWith(" 000")) {
        throw new Error(
          `The container cannot reach the backend's agent tools server (${reach.split(" ")[0]}), so the signal can never confirm. Allow the profile's agent tools port from Docker's address ranges in the host firewall.`,
        );
      }
      throw error;
    }
    const signalBefore = await signal();
    if (FAKE_API) undoFakeApi = await installFakeClaudeApi(containerId);

    const attached = page.waitForResponse(
      (response) => {
        if (!response.url().endsWith("/__orkestrator/invoke")) return false;
        try {
          const body = response.request().postDataJSON() as {
            command?: string;
            args?: { user?: string };
          };
          return body.command === "create_terminal_session" && body.args?.user !== "orkroot";
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    // The product's terminal Claude: **Claude CLI** from the terminal button's
    // context menu starts `claude --dangerously-skip-permissions` in the tab.
    const newTerminal = page.getByRole("button", { name: "New terminal tab", exact: true });
    await expect(newTerminal).toBeEnabled({ timeout: 60_000 });
    await newTerminal.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Claude CLI" }).click();
    sessionId = ((await (await attached).json()) as { result: { sessionId: string } }).result
      .sessionId;
    const output = async () =>
      terminalVisibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    /** The latest screenful, lower-cased without whitespace (cursor moves are stripped). */
    const screen = async (tail = 2_000) =>
      (await output()).replace(/\s+/g, "").toLowerCase().slice(-tail);

    const writtenSessions: string[] = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/__orkestrator/invoke")) return;
      try {
        const body = request.postDataJSON() as { command?: string; args?: { sessionId?: string } };
        if (body.command === "terminal_write" && body.args?.sessionId) {
          writtenSessions.push(body.args.sessionId);
        }
      } catch {
        // Not a JSON command.
      }
    });
    const focusTerminal = async () => {
      const terminals = page.locator(".xterm:visible");
      await expect(terminals.first()).toBeVisible({ timeout: 30_000 });
      for (let index = (await terminals.count()) - 1; index >= 0; index -= 1) {
        await terminals.nth(index).click();
        const before = writtenSessions.length;
        await page.keyboard.press("Space");
        await expect
          .poll(() => writtenSessions.length, { timeout: 10_000 })
          .toBeGreaterThan(before);
        await page.keyboard.press("Backspace");
        if (writtenSessions.at(-1) === sessionId) return;
      }
      throw new Error("no visible terminal writes to the Claude session");
    };
    await focusTerminal();

    // Claude's input box is ready once its footer hint renders. The image
    // records the bypass-mode consent, so a consent dialog is a failed boot.
    await expect
      .poll(
        async () => {
          const text = await screen(20_000);
          return text.includes("bypasspermissionson") || text.includes("yes,iaccept");
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    expect(
      (await screen(20_000)).includes("yes,iaccept"),
      "Claude asked for bypass-mode consent",
    ).toBe(false);
    // The image also records the answer to Claude Code's "Make auto mode your
    // default permission mode?" offer, so the offer is a failed boot too.
    expect(
      docker([
        "exec",
        "--user",
        "node",
        containerId,
        "sh",
        "-c",
        'jq -r .hasSeenAutoDefaultNudge "$HOME/.claude.json"',
      ]),
      "the container's ~/.claude.json does not record the auto-mode answer",
    ).toBe("true");
    expect(
      (await screen(20_000)).includes("makeautomodeyourdefault"),
      "Claude offered to make auto mode the default",
    ).toBe(false);
    await page.waitForTimeout(1_000);
    claudeSessions = new Set(
      [...containerSessionsRunning(containerId, "claude")].filter(
        (sid) => !claudeSessionsBefore.has(sid),
      ),
    );
    expect(claudeSessions.size, "the tab's claude is not running in the container").toBe(1);

    const offsetMs = containerClockOffsetMs(containerId);
    const turns: TurnTiming[] = [];
    // Arithmetic in each prompt keeps the echoed input from matching the answer.
    for (const [background, prompt, answer] of [
      [false, "Reply with only the word PONG and then 41 plus 1 as digits. No tools.", /PONG\s*42/],
      [true, "Reply with only the word PONG and then 50 plus 5 as digits. No tools.", /PONG\s*55/],
    ] as const) {
      if (background) {
        await containerItem.click();
        await focusTerminal();
      }
      const previous = await backendState();
      expect(previous ?? "idle", "Claude is still working before the turn").not.toBe("working");
      await page.keyboard.type(prompt);
      // Fast typing reads as a paste; an Enter inside it is a newline, not a
      // submit, so let the input settle first.
      await page.waitForTimeout(1_000);
      const enter = Date.now();
      await page.keyboard.press("Enter");
      // The second turn runs while another environment is selected.
      if (background) await localItem.click();
      const [backendWorking, sidebarWorking] = await Promise.all([
        firstTimeTrue(
          async () => (await backendState()) === "working",
          "the backend's working state",
          30_000,
        ),
        firstTimeTrue(
          async () => (await sidebarActivity(page, containerName)) === "working",
          "the sidebar's working indicator",
          30_000,
        ),
      ]);
      const answerVisible = await firstTimeTrue(
        async () => answer.test(await output()),
        "Claude's answer",
        180_000,
      );
      const [backendWaiting, sidebarWaiting] = await Promise.all([
        firstTimeTrue(
          async () => (await backendState()) === "waiting",
          "the backend's waiting state",
          30_000,
        ),
        firstTimeTrue(
          async () => (await sidebarActivity(page, containerName)) === "waiting",
          "the sidebar's waiting indicator",
          30_000,
        ),
      ]);
      const stopHook = stateFileWrittenAt(containerId, offsetMs);
      turns.push({
        background,
        enterToBackendWorkingMs: backendWorking - enter,
        enterToSidebarWorkingMs: sidebarWorking - enter,
        answerVisibleToSidebarWaitingMs: sidebarWaiting - answerVisible,
        stopHookToBackendWaitingMs: backendWaiting - stopHook,
        stopHookToSidebarWaitingMs: sidebarWaiting - stopHook,
      });
    }

    let failedTurn: Record<string, unknown> | undefined;
    if (FAILED_TURN) {
      /** Content-free step names; they also feed the logged runner's watchdog. */
      const step = (name: string) =>
        process.stderr.write(`[claude-terminal-failed-turn] ${name}\n`);
      step("good turns done");
      const unreadReason = async () => {
        const environment = await backendEnvironment();
        return environment?.hasUnreadWork ? (environment.unreadReason ?? "?") : null;
      };
      const shot = async (name: string) =>
        page.screenshot({
          path: path.join(repositoryRoot, "output", "visual-previews", `5160-${name}.png`),
        });
      // Read the bell the good turns left, then fail a turn in the background.
      await containerItem.click();
      await expect.poll(unreadReason, { timeout: 30_000 }).toBeNull();
      await focusTerminal();
      await page.keyboard.type(`Reply with only the word ${REFUSE_MARKER}. No tools.`);
      await page.waitForTimeout(1_000);
      const enter = Date.now();
      await page.keyboard.press("Enter");
      await localItem.click();
      step("refused turn sent");
      await firstTimeTrue(
        async () => (await backendState()) === "working",
        "the refused turn's working state",
        30_000,
      );
      step("refused turn working");
      // The CLI retries a refused request with backoff before it gives up: 179 s
      // for `claude -p` in the image on 2026-11-14 (to-do 5160 task 4).
      const left = await firstTimeTrue(
        async () => (await backendState()) !== "working",
        "the refused turn to leave working",
        360_000,
      );
      await firstTimeTrue(
        async () => (await sidebarActivity(page, containerName)) !== "working",
        "the sidebar to leave working",
        30_000,
      );
      await expect.poll(unreadReason, { timeout: 60_000 }).toBe("agent_failed");
      step("refused turn rang");
      failedTurn = {
        enterToLeftWorkingMs: left - enter,
        backendStateAfter: (await backendState()) ?? null,
        sidebarAfter: await sidebarActivity(page, containerName),
        unreadReason: "agent_failed",
      };
      await containerItem.click();
      await expect(page.getByText("Agent stopped with an error", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(800);
      await shot("container-claude-failed-turn");
      step("toast shown");
      // The next prompt in the same session. After a refused login the CLI
      // says "Not logged in" and answers nothing locally. An answer must ring
      // waiting; a local refusal is recorded, not asserted: the CLI fires no
      // Stop or StopFailure hook for it, so the tab reads working until the
      // next hook (to-do 8092).
      await focusTerminal();
      await page.keyboard.type(
        "Reply with only the word PONG and then 60 plus 6 as digits. No tools.",
      );
      await page.waitForTimeout(1_000);
      await page.keyboard.press("Enter");
      await localItem.click();
      await firstTimeTrue(
        async () =>
          /PONG\s*66/.test(await output()) || (await screen(4_000)).includes("notloggedin"),
        "the next prompt's answer or the CLI's sign-in notice",
        360_000,
      );
      const answered = /PONG\s*66/.test(await output());
      step(answered ? "next prompt answered" : "next prompt refused locally");
      // Long enough for a working ring, and a Stop or StopFailure ring, to land.
      await page.waitForTimeout(15_000);
      failedTurn.followingTurn = answered ? "answered" : "not-logged-in";
      failedTurn.followingTurnBackendState = (await backendState()) ?? null;
      failedTurn.followingTurnSidebar = await sidebarActivity(page, containerName);
      failedTurn.followingTurnUnreadReason = await unreadReason();
      process.stderr.write(`[claude-terminal-failed-turn] ${JSON.stringify(failedTurn)}\n`);
      if (answered) {
        expect(failedTurn.followingTurnBackendState).not.toBe("working");
        expect(failedTurn.followingTurnUnreadReason).toBe("agent_waiting");
      } else {
        testInfo.annotations.push({
          type: "known gap",
          description: `after a refused login the next prompt reads ${String(failedTurn.followingTurnBackendState)} (to-do 8092)`,
        });
      }
      await containerItem.click();
      await page.waitForTimeout(1_000);
      await shot("container-claude-following-turn");
    }

    const signalAfter = await signal();
    const report = {
      api: FAKE_API ? "fake" : "live",
      ...(failedTurn ? { failedTurn } : {}),
      clockOffsetMs: Math.round(offsetMs),
      turns: turns.map((turn) =>
        Object.fromEntries(
          Object.entries(turn).map(([key, value]) => [
            key,
            typeof value === "number" ? Math.round(value) : value,
          ]),
        ),
      ),
      signalBefore,
      signalAfter,
    };
    await testInfo.attach("claude-terminal-signal.json", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
    process.stderr.write(`[claude-terminal-signal] ${JSON.stringify(report)}\n`);

    for (const turn of turns) {
      expect(turn.enterToSidebarWorkingMs, "activity indicator budget").toBeLessThanOrEqual(
        ACTIVITY_BUDGET_MS,
      );
      expect(turn.stopHookToSidebarWaitingMs, "turn completion budget").toBeLessThanOrEqual(
        COMPLETION_BUDGET_MS,
      );
    }
    // Each turn rang twice (working, waiting); none was missed.
    expect(signalAfter.rings - signalBefore.rings).toBeGreaterThanOrEqual(2 * turns.length);
    expect(signalAfter.demotions).toEqual(signalBefore.demotions);
    expect(signalAfter.states.confirmed).toBeGreaterThanOrEqual(1);
    expect(signalAfter.fallback).toBe(signalBefore.fallback);
  } finally {
    // Close the page first so the renderer cannot save its layout again.
    // Restore the original tabs even if closing the page or terminal fails.
    try {
      await page.close();
    } finally {
      try {
        // Layout removal only orphans a terminal. Explicitly stop both Claude
        // and its shell, including when a turn or an assertion failed.
        if (sessionId) {
          await invoke("detach_terminal", { sessionId });
          expect(
            (await invoke<{ running: boolean }>("get_terminal_session", { sessionId })).running,
            "the test's terminal is still running after cleanup",
          ).toBe(false);
          expect(await invoke<string[]>("list_terminal_sessions")).not.toContain(sessionId);
          // The backend's view is not enough: Docker keeps an exec running
          // after its client is gone, so check the container itself.
          if (claudeSessions.size > 0) {
            await expect
              .poll(() => containerProcessesInSessions(containerId, claudeSessions).length, {
                timeout: 15_000,
                message: "the tab's shell or claude is still running in the container",
              })
              .toBe(0);
          }
        }
      } finally {
        // Undo the fake API last: Claude must stop before its settings change.
        try {
          await restoreLayout();
        } finally {
          undoFakeApi?.();
        }
      }
    }
  }

  async function restoreLayout(): Promise<void> {
    const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: container!.id,
    });
    if (!current) return;
    const restored = originalLayout as {
      version?: number;
      containerId?: string | null;
      activePaneId?: string;
      root?: unknown;
    } | null;
    await (restored?.root
      ? invoke("save_pane_layout", {
          environmentId: container!.id,
          expectedRevision: current.revision ?? 0,
          layout: {
            version: restored.version,
            containerId: restored.containerId ?? null,
            activePaneId: restored.activePaneId,
            root: restored.root,
          },
        })
      : invoke("delete_pane_layout", {
          environmentId: container!.id,
          expectedRevision: current.revision ?? 0,
        }));
  }
});
