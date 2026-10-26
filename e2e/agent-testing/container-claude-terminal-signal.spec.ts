import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

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
 * Opt-in on top of the Docker fixture (`ORKESTRATOR_AGENT_TEST_DOCKER=1`):
 * `ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL=1`, because the turns use the
 * host's Claude login (access-only in the container) and may cost money.
 * Nothing at module scope spawns `mise` or `docker`, so the file stays inert
 * without both opt-ins. The report is content-free: timings and counts only.
 */

type Status = { status: string; browserUrl: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Environment = {
  id: string;
  name: string;
  containerId?: string | null;
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
const ENABLED =
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1" &&
  process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE_TERMINAL === "1";
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

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout.trim();
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

/** Terminal output as plain text, without escape sequences. */
const visibleText = (output: string): string =>
  output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_=>]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** The environment row's status marker state (`working`, `waiting`, `idle`, `inactive`). */
async function sidebarActivity(page: Page, environmentName: string): Promise<string> {
  return page
    .evaluate((name) => {
      const label = Array.from(document.querySelectorAll("span")).find(
        (span) => span.textContent === name && span.id,
      );
      let node: Element | null = label ?? null;
      while (node && !node.querySelector('[data-testid="environment-status-marker"]')) {
        node = node.parentElement;
      }
      return (
        node
          ?.querySelector('[data-testid="environment-status-marker"]')
          ?.getAttribute("data-state") ?? "unknown"
      );
    }, environmentName)
    .catch(() => "unknown");
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
  test.setTimeout(10 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  await page.setViewportSize({ width: 1280, height: 860 });
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
  const backendState = async (): Promise<string | undefined> => {
    for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
      const found = (
        await invoke<Environment[]>("get_environments", { projectId: project.id })
      ).find((entry) => entry.id === container!.id);
      if (found) return found.agentActivityState;
    }
    return undefined;
  };
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
    await expect
      .poll(async () => (await signal()).states.confirmed, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(1);
    const signalBefore = await signal();

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
    const sessionId = ((await (await attached).json()) as { result: { sessionId: string } }).result
      .sessionId;
    const output = async () =>
      visibleText(
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
    // Claude Code may follow with a one-time offer to make auto mode the
    // default. Keep bypass permissions, the mode the image configures.
    await page.waitForTimeout(3_000);
    if ((await screen()).includes("makeautomodeyourdefault")) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => (await screen(600)).includes("bypasspermissionson"), {
          timeout: 15_000,
        })
        .toBe(true);
    }
    await page.waitForTimeout(1_000);

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

    const signalAfter = await signal();
    const report = {
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

    // Leave Claude so the terminal returns to its shell.
    await containerItem.click();
    await focusTerminal();
    await page.keyboard.type("/exit");
    await page.keyboard.press("Enter");
  } finally {
    // Close the page first so the renderer cannot save its layout again, then
    // restore the original tabs, which drops the terminal tab this test opened.
    await page.close();
    const current = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: container!.id,
    });
    if (current) {
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
  }
});
