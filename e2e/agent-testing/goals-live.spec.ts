/**
 * The goal loop against real providers (`mise run test:agent:goals`,
 * `plans/goals/109`, Phase 3). Opt-in only: every case runs real model turns on
 * the host's credentials, so it is skipped unless
 * `ORKESTRATOR_AGENT_TEST_LIVE_GOALS=1`.
 *
 * Assertions read the durable goal record and the workspace. The transcript is
 * read only to record what a provider showed. The summary it writes is the
 * qualification record for `plans/goals/001` and `305`: what each provider
 * answered, with no prompts or output.
 */
import { expect, test, type Page } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  authenticatedInvoke,
  containerWorkspace,
  hostWorkspace,
  sidebarNavigator,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Invoke,
  type Project,
  type Workspace,
} from "./slash-command-live-support";

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "qa-goals";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const platform = process.env.ORKESTRATOR_AGENT_TEST_GOAL_PLATFORM ?? "claude";
const environmentKind = process.env.ORKESTRATOR_AGENT_TEST_GOAL_ENVIRONMENT ?? "local";
const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_GOALS === "1";
const TURN_TIMEOUT_MS = 300_000;

type Goal = {
  goalId: string;
  status: string;
  statusReason?: string;
  statusDetail?: string;
  iterations: number;
  maxIterations: number;
  tokensUsed?: number;
  lastCheck?: { passed: boolean; exitCode: number | null; outputTail: string };
  lastReport?: { status: string };
};
type Projection = {
  turn: { phase: string };
  goal?: { status: string };
  slashCommands?: { name: string; executionKind?: string }[];
  contextUsage?: { sessionTokens?: number; usedTokens?: number };
  composer?: { selectedModelId?: string };
  messages?: { role?: string; content?: unknown }[];
};

/** Filled as the cases run, then written even when one fails. */
const record: Record<string, unknown> = { platform, environmentKind, scenarios: {} };

function writeSummary() {
  const file = path.join(
    repositoryRoot,
    "output",
    "agent-testing",
    runId,
    "goals",
    `summary-${platform}.json`,
  );
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function prepare(page: Page) {
  const status = profileStatus(profile);
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  const invoke = await authenticatedInvoke(page, status, profile);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();
  const container = environmentKind === "container";
  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `goals-${platform}-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: container ? "containerized" : "local",
    agentSettings: { executionPolicy: { approvals: "auto-approve" } },
  });
  await invoke("start_environment", { environmentId: environment.id });
  let started = await invoke<Environment>("get_environment", { environmentId: environment.id });
  await expect
    .poll(
      async () => {
        started = await invoke<Environment>("get_environment", { environmentId: environment.id });
        return (
          started.status === "running" &&
          (!container ||
            (!!started.containerId &&
              started.setupPhase !== "pending" &&
              started.setupPhase !== "running"))
        );
      },
      { timeout: 300_000, intervals: [2_000], message: "the environment never started" },
    )
    .toBe(true);
  const workspace: Workspace = container
    ? containerWorkspace(started.containerId!)
    : hostWorkspace(started.worktreePath!);
  const model = await smallestModel(invoke, environment.id);
  record.model = model ?? "provider default";
  return {
    invoke,
    environment: started,
    workspace,
    model,
    container,
    projectName: fixture!.name,
    projectId: fixture!.id,
  };
}

/** The cheapest model the catalogue names, so a qualification run costs little. */
async function smallestModel(invoke: Invoke, environmentId: string) {
  const override = process.env[`ORKESTRATOR_AGENT_TEST_GOAL_MODEL_${platform.toUpperCase()}`];
  if (override) return override;
  const models = await invoke<{ id: string; sessionDefault?: boolean }[]>(
    "get_native_agent_model_catalog",
    { environmentId, agent: platform },
  ).catch(() => []);
  return models.find((entry) => /haiku|mini|flash|lite|fast/i.test(entry.id))?.id;
}

async function openTab(
  invoke: Invoke,
  environment: Environment,
  tabId: string,
  container: boolean,
  model: string | undefined,
) {
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  const existing = (layout as { layout?: { root?: { tabs?: unknown[] } } } | null)?.layout?.root
    ?.tabs;
  const tab = {
    id: tabId,
    type: "agent-native",
    nativeAgentData: {
      environmentId: environment.id,
      platform,
      ...(container ? { containerId: environment.containerId } : {}),
      isLocal: !container,
    },
    ...(model ? { initialAgentModel: model } : {}),
  };
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: container ? environment.containerId : null,
      activePaneId: "pane-goals",
      root: {
        kind: "leaf",
        id: "pane-goals",
        activeTabId: tabId,
        tabs: [...(existing ?? []), tab],
      },
    },
  });
  return {
    environmentId: environment.id,
    agent: platform,
    logicalSessionKey: `env-${environment.id}:${tabId}`,
  };
}

test.describe(`goal loop: ${platform}`, () => {
  test.skip(!LIVE, "opt-in live goal turns with host credentials");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(1_200_000);

  test.afterAll(() => writeSummary());

  test("every scenario", async ({ page }) => {
    page.setDefaultTimeout(15_000);
    const { invoke, environment, workspace, model, container } = await prepare(page);
    const scenarios = record.scenarios as Record<string, unknown>;
    let tabNumber = 0;

    const tab = async () =>
      openTab(invoke, environment, `goals-${(tabNumber += 1)}`, container, model);
    const command = (identity: Awaited<ReturnType<typeof tab>>, text: string) =>
      invoke<{ message: string; goal?: Goal }>("native_agent_goal_command", {
        ...identity,
        text,
        ...(model ? { model } : {}),
      });
    const detail = (identity: Awaited<ReturnType<typeof tab>>) =>
      invoke<{ goal?: Goal; history: Goal[] }>("get_native_agent_goal", identity);
    const projection = (identity: Awaited<ReturnType<typeof tab>>) =>
      invoke<Projection>("get_native_agent_projection", identity);

    async function until(
      identity: Awaited<ReturnType<typeof tab>>,
      statuses: string[],
      label: string,
    ): Promise<Goal> {
      let goal: Goal | undefined;
      await expect
        .poll(
          async () => {
            goal = (await detail(identity)).goal;
            return statuses.includes(goal?.status ?? "");
          },
          {
            timeout: TURN_TIMEOUT_MS,
            intervals: [2_000],
            message: `${label}: never reached ${statuses.join(" or ")}; last ${JSON.stringify({
              status: goal?.status,
              reason: goal?.statusReason,
              detail: goal?.statusDetail,
              iterations: goal?.iterations,
            })}`,
          },
        )
        .toBe(true);
      return goal!;
    }

    const note = (name: string, goal: Goal, extra: Record<string, unknown> = {}) => {
      scenarios[name] = {
        status: goal.status,
        reason: goal.statusReason,
        // Bounded by the record, and only a provider's own error text here.
        ...(goal.statusReason === "turn-failed" ? { detail: goal.statusDetail } : {}),
        iterations: goal.iterations,
        tokensUsed: goal.tokensUsed,
        ...extra,
      };
      writeSummary();
    };

    const report = (status: "done" | "blocked") =>
      `call the orkestrator report_goal tool with status "${status}"`;

    // The catalogue: which goal row the provider's list ends up with.
    const first = await tab();
    await invoke("ensure_native_agent_session", { ...first, ...(model ? { model } : {}) }).catch(
      () => undefined,
    );
    const catalogue = await projection(first).catch(() => undefined);
    record.goalRows = (catalogue?.slashCommands ?? [])
      .filter((row) => /goal/i.test(row.name))
      .map((row) => ({ name: row.name, executionKind: row.executionKind }));
    writeSummary();

    await test.step("a passing check after several iterations ends complete", async () => {
      await command(
        first,
        `In this first turn, create the file goal-step-1.txt, then end your turn without calling report_goal. ` +
          `When you are told to continue, create the file goal-done.txt and then ${report("done")}. --max-iterations 6 --check test -f goal-done.txt`,
      );
      const goal = await until(first, ["complete", "limited", "paused", "blocked"], "check passes");
      const view = await projection(first);
      note("check-passes", goal, {
        projectionHasGoal: view.goal?.status === goal.status,
        sessionTokens: view.contextUsage?.sessionTokens ?? null,
        selectedModel: view.composer?.selectedModelId ?? null,
      });
      expect(goal.status).toBe("complete");
      expect(goal.iterations).toBeGreaterThanOrEqual(1);
      expect(goal.lastCheck?.passed).toBe(true);
      expect(workspace.read("goal-done.txt")).toBeDefined();
    });

    await test.step("no check ends claimed, never complete", async () => {
      const identity = await tab();
      await command(identity, `Reply with one word, then ${report("done")}. --max-iterations 3`);
      const goal = await until(identity, ["claimed", "complete", "limited", "paused"], "no check");
      note("no-check", goal);
      expect(goal.status).toBe("claimed");
    });

    await test.step("a check that never passes stops at the cap with its output", async () => {
      const identity = await tab();
      await command(
        identity,
        `Do no other work: reply with one word, then ${report("done")}. Repeat that each time you are told to continue. --max-iterations 2 --check echo goal-check-output && false`,
      );
      const goal = await until(
        identity,
        ["limited", "complete", "claimed", "paused"],
        "never passes",
      );
      note("cap", goal, { outputSeen: goal.lastCheck?.outputTail.includes("goal-check-output") });
      expect(goal.status).toBe("limited");
      expect(goal.statusReason).toBe("iteration-cap");
      expect(goal.lastCheck?.passed).toBe(false);
      expect(goal.lastCheck?.outputTail).toContain("goal-check-output");
    });

    await test.step("blocked waits for a person", async () => {
      const identity = await tab();
      await command(
        identity,
        `Do no other work: ${report("blocked")}, saying you need a key. --max-iterations 3`,
      );
      const goal = await until(identity, ["blocked", "limited", "claimed", "paused"], "blocked");
      note("blocked", goal);
      expect(goal.status).toBe("blocked");
    });

    await test.step("Stop pauses, no turn follows, and resume continues", async () => {
      const identity = await tab();
      await command(
        identity,
        `Run the shell command "sleep 120", then create goal-resumed.txt and ${report("done")}. --max-iterations 4 --check test -f goal-resumed.txt`,
      );
      await expect
        .poll(async () => (await projection(identity)).turn.phase, {
          timeout: TURN_TIMEOUT_MS,
          intervals: [1_000],
        })
        .toMatch(/running|starting|active|working|waiting/);
      await invoke("stop_native_agent_session", identity);
      const paused = await until(identity, ["paused", "complete", "limited"], "stop");
      const before = paused.iterations;
      note("stop", paused);
      expect(paused.status).toBe("paused");
      expect(paused.statusReason).toBe("user-stopped");
      // Long enough for a wrongly queued continuation to have started.
      await page.waitForTimeout(15_000);
      const after = (await detail(identity)).goal!;
      expect(after.status).toBe("paused");
      expect(after.iterations).toBe(before);
      await command(identity, "resume");
      const resumed = await until(identity, ["complete", "limited", "paused"], "resume");
      note("resume", resumed);
      expect(resumed.status).toBe("complete");
    });

    await test.step("a user's queued prompt runs first and costs no iteration", async () => {
      const identity = await tab();
      await command(
        identity,
        `Run the shell command "sleep 20", then end your turn without calling report_goal. When you are told to continue, ${report("done")}. --max-iterations 5`,
      );
      await invoke("enqueue_prompt_queue_message", {
        queueKey: `${platform}\0${identity.logicalSessionKey}`,
        environmentId: environment.id,
        message: {
          id: `user-${Date.now()}`,
          requestId: `user-${Date.now()}`,
          text: "Create the file goal-user-prompt.txt. Do nothing else in this turn.",
        },
      });
      const goal = await until(
        identity,
        ["claimed", "complete", "limited", "paused"],
        "user prompt",
      );
      note("user-prompt", goal, { userFile: workspace.read("goal-user-prompt.txt") !== undefined });
      expect(goal.status).toBe("claimed");
      expect(workspace.read("goal-user-prompt.txt")).toBeDefined();
    });

    await test.step("clear ends a running goal, and nothing more is sent", async () => {
      const identity = await tab();
      await command(identity, `Reply with one word and end your turn. --max-iterations 6`);
      await command(identity, "clear");
      expect((await detail(identity)).goal).toBeUndefined();
    });
  });

  test("the browser: set, watch from elsewhere, reload, pause and clear", async ({
    page,
  }, testInfo) => {
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { invoke, environment, workspace, model, container, projectName, projectId } =
      await prepare(page);
    const other = await invoke<Environment>("create_environment", {
      projectId,
      name: `goals-other-${Date.now()}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: other.id });
    const identity = await openTab(invoke, environment, "goals-ui", container, model);
    const detail = () => invoke<{ goal?: Goal }>("get_native_agent_goal", identity);
    const open = sidebarNavigator(page, projectName);
    const status = profileStatus(profile);
    await page.goto(status.browserUrl!);
    await open(environment.name);
    const composeBar = page.getByTestId("shared-native-compose-bar");
    const input = composeBar.getByRole("textbox").first();
    const pill = page.getByTestId("goal-pill");

    // Set it by typing, as a person would. The draft clears and the pill appears.
    await input.fill(
      `/goal First create goal-ui-1.txt and end your turn without calling report_goal. When told to continue, create goal-ui-2.txt, then call the orkestrator report_goal tool with status "done". --max-iterations 4 --check test -f goal-ui-2.txt`,
    );
    await input.press("Enter");
    await expect(pill).toBeVisible();
    await expect(input).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("goal-running.png") });

    // A reload mid-goal renders from the snapshot.
    await page.reload();
    await expect(page.getByTestId("goal-pill")).toBeVisible();

    // Away from the tab, the loop keeps going with nothing mounted.
    await open(other.name);
    await expect(page.getByTestId("goal-pill")).toHaveCount(0);
    await expect
      .poll(async () => (await detail()).goal?.status, {
        timeout: TURN_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toBe("complete");
    expect(workspace.read("goal-ui-2.txt")).toBeDefined();

    // Back on the tab: the ended state, tiles rather than user bubbles.
    await open(environment.name);
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/complete/i);
    await expect(page.getByText("orkestrator-goal", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("goal-complete.png") });

    // The narrow composer keeps the pill reachable.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(pill).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("goal-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 900 });

    // The panel's own controls, on a goal that is still running.
    await input.fill(
      `/goal Run the shell command "sleep 90", then end your turn. --max-iterations 4`,
    );
    await input.press("Enter");
    await expect
      .poll(async () => (await detail()).goal?.status, { timeout: 30_000 })
      .toBe("active");
    await pill.click();
    const panel = page.getByTestId("goal-panel");
    await expect(panel).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("goal-panel.png") });
    await panel.getByRole("button", { name: /^Pause/ }).click();
    await expect
      .poll(async () => (await detail()).goal?.status, { timeout: 30_000 })
      .toBe("paused");
    await panel.getByRole("button", { name: /^Clear/ }).click();
    const confirm = page.getByRole("button", { name: /^(Clear goal|Confirm)$/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect.poll(async () => (await detail()).goal, { timeout: 30_000 }).toBeUndefined();
    await invoke("stop_native_agent_session", identity).catch(() => undefined);
  });
});
