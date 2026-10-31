import { GOAL_TOKEN_BUDGET_PLATFORMS } from "@orkestrator/protocol/native-agent-goal";
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
/** `browser` runs the probe and browser cases; `extras` compaction and the verifier. */
const only = process.env.ORKESTRATOR_AGENT_TEST_GOAL_ONLY;
/**
 * Something slow for the agent to do. Grok's shell fails to spawn in Orkestrator
 * sessions, with or without a goal (`plans/goals/303`), so it writes instead.
 */
function slowStep(seconds: number): string {
  return platform === "grok"
    ? `Write out every whole number from 1 to ${seconds * 3} in words, separated by commas`
    : `Run the shell command "sleep ${seconds}"`;
}

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
  composer?: { selectedModelId?: string; selectedModeId?: string };
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
  test.describe.configure({ mode: "default" });
  test.setTimeout(1_200_000);

  test.afterAll(() => writeSummary());

  test("every scenario", async ({ page }) => {
    test.skip(only !== undefined, `only the ${only} cases`);
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
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        goal = (await detail(identity)).goal;
        if (statuses.includes(goal?.status ?? "")) return goal!;
        await page.waitForTimeout(2_000);
      }
      const phase = (await projection(identity).catch(() => undefined))?.turn.phase;
      throw new Error(
        `${label}: never reached ${statuses.join(" or ")}; last ${JSON.stringify({
          status: goal?.status,
          reason: goal?.statusReason,
          detail: goal?.statusDetail,
          iterations: goal?.iterations,
          report: goal?.lastReport?.status,
          phase,
        })}`,
      );
    }

    const note = (name: string, goal: Goal, extra: Record<string, unknown> = {}) => {
      console.log(
        `[goals-live] ${platform} ${name}: ${goal.status} (${goal.statusReason ?? "none"}), ${goal.iterations} iterations`,
      );
      scenarios[name] = {
        status: goal.status,
        reason: goal.statusReason,
        // Bounded by the record, and only a provider's own error text here.
        ...(goal.statusDetail ? { detail: goal.statusDetail } : {}),
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
        `On carrier iteration 0 only, ${slowStep(120)}. On every later carrier iteration, skip the delay. Then create goal-resumed.txt and ${report("done")}. --max-iterations 4 --check test -f goal-resumed.txt`,
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
        `${slowStep(20)}, then end your turn without calling report_goal. When you are told to continue, ${report("done")}. --max-iterations 5`,
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

  test("Plan mode, unchanged workspaces and token limits", async ({ page }) => {
    test.skip(only !== undefined, `only the ${only} cases`);
    const { invoke, environment, model, container } = await prepare(page);
    const scenarios = record.scenarios as Record<string, unknown>;
    const send = (identity: Awaited<ReturnType<typeof openTab>>, text: string) =>
      invoke("native_agent_goal_command", { ...identity, text, ...(model ? { model } : {}) });
    const wait = async (identity: Awaited<ReturnType<typeof openTab>>, label: string) => {
      let goal: Goal | undefined;
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        goal = (await invoke<{ goal?: Goal }>("get_native_agent_goal", identity)).goal;
        if (goal && !["active", "checking", "verifying"].includes(goal.status)) {
          console.log(
            `[goals-live] ${platform} ${label}: ${goal.status} (${goal.statusReason ?? "none"}), ${goal.iterations} iterations`,
          );
          scenarios[label] = {
            status: goal.status,
            reason: goal.statusReason,
            detail: goal.statusDetail,
            iterations: goal.iterations,
          };
          writeSummary();
          return goal;
        }
        await page.waitForTimeout(1_000);
      }
      throw new Error(`${label} did not end: ${JSON.stringify(goal)}`);
    };
    const objective =
      "Reply with the single word waiting and end this turn. Do not call any tools, report_goal, or change any files. Repeat exactly this for each continuation.";
    const planning = await openTab(invoke, environment, "goals-plan", container, model);
    await invoke("update_native_agent_controls", { ...planning, update: { mode: "plan" } });
    await send(planning, `${objective} --max-iterations 2`);
    const planned = await wait(planning, "plan-mode");
    expect(planned.status).toBe("limited");
    expect(planned.iterations).toBe(2);
    expect(
      (await invoke<Projection>("get_native_agent_projection", planning)).composer?.selectedModeId,
    ).toBe("plan");

    const unchanged = await openTab(invoke, environment, "goals-no-progress", container, model);
    await send(unchanged, `${objective} --max-iterations 8`);
    const stalled = await wait(unchanged, "no-progress");
    expect(stalled.status).toBe("paused");
    expect(stalled.statusReason).toBe("no-progress");

    if ((GOAL_TOKEN_BUDGET_PLATFORMS as readonly string[]).includes(platform)) {
      const budgeted = await openTab(invoke, environment, "goals-budget", container, model);
      await send(budgeted, `${objective} --max-iterations 8 --budget 1`);
      const limited = await wait(budgeted, "token-budget");
      expect(limited.status).toBe("limited");
      expect(limited.statusReason).toBe("token-budget");
    }
  });

  test("a compaction between turns, and a verifier's verdict", async ({ page }) => {
    test.skip(only === "browser", "run with the full suite, or alone as extras");
    page.setDefaultTimeout(15_000);
    const { invoke, environment, workspace, model, container } = await prepare(page);
    const send = (identity: Awaited<ReturnType<typeof openTab>>, text: string) =>
      invoke("native_agent_goal_command", {
        ...identity,
        text,
        ...(model ? { model } : {}),
      });
    const ended = async (identity: Awaited<ReturnType<typeof openTab>>) => {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let goal: Goal | undefined;
      while (Date.now() < deadline) {
        goal = (await invoke<{ goal?: Goal }>("get_native_agent_goal", identity)).goal;
        if (goal && !["active", "checking", "verifying"].includes(goal.status)) return goal;
        await page.waitForTimeout(2_000);
      }
      const queues = await invoke<
        {
          queueKey: string;
          messages?: { id: string }[];
          dispatchError?: unknown;
          inFlight?: unknown;
        }[]
      >("list_prompt_queues", { environmentId: environment.id }).catch(() => []);
      const view = await invoke<Projection>("get_native_agent_projection", identity).catch(
        () => undefined,
      );
      throw new Error(
        `never ended; last ${JSON.stringify({
          status: goal?.status,
          iterations: goal?.iterations,
          phase: view?.turn.phase,
          queues: queues.map((queue) => ({
            ids: queue.messages?.map((message) => message.id),
            dispatchError: queue.dispatchError,
            inFlight: Boolean(queue.inFlight),
          })),
        })}`,
      );
    };
    const scenarios = record.scenarios as Record<string, unknown>;

    // Compacting while a goal waits, then resuming: the loop carries on with the
    // shorter context. Providers also compact inside a turn, which the loop never sees.
    const compacting = await openTab(invoke, environment, "goals-compact", container, model);
    await send(
      compacting,
      `Inspect the workspace: if goal-compact-1.txt does not exist, create it and call report_goal with status "blocked". If goal-compact-1.txt already exists, create goal-compact-2.txt and call report_goal with status "done". End the turn immediately after the report. --max-iterations 4 --check test -f goal-compact-2.txt`,
    );
    const waiting = await ended(compacting);
    expect(waiting.status).toBe("blocked");
    const compacted = await invoke<{ outcome?: string }>("perform_native_agent_session_action", {
      ...compacting,
      action: { kind: "compact" },
    }).catch((error: unknown) => ({ outcome: `refused: ${String(error).slice(0, 200)}` }));
    // A compact may run as a turn of its own; let it finish before resuming.
    const settleBy = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < settleBy) {
      const phase = (await invoke<Projection>("get_native_agent_projection", compacting)).turn
        .phase;
      if (phase === "idle" || phase === "error") break;
      await page.waitForTimeout(2_000);
    }
    await send(compacting, "resume");
    const afterCompact = await ended(compacting);
    scenarios.compact = {
      compacted: compacted?.outcome,
      status: afterCompact.status,
      reason: afterCompact.statusReason,
      detail: afterCompact.statusDetail,
      iterations: afterCompact.iterations,
    };
    writeSummary();
    expect(afterCompact.status).toBe("complete");
    expect(workspace.read("goal-compact-2.txt")).toBeDefined();

    // A typed `/compact` delivered through the queue, with no goal anywhere: a
    // record of what it does on this provider, not an assertion about goals.
    const plain = await openTab(invoke, environment, "goals-plain-compact", container, model);
    await invoke("dispatch_native_agent_intent", {
      ...plain,
      requestId: `plain-${Date.now()}`,
      prompt: "Reply with one word.",
      ...(model ? { model } : {}),
    });
    await invoke("enqueue_prompt_queue_message", {
      queueKey: `${platform}\0${plain.logicalSessionKey}`,
      environmentId: environment.id,
      message: {
        id: `compact-${Date.now()}`,
        requestId: `compact-${Date.now()}`,
        text: "/compact",
        command: { kind: "typed" },
      },
    });
    let plainPhase: string | undefined;
    const plainBy = Date.now() + 120_000;
    await page.waitForTimeout(20_000);
    while (Date.now() < plainBy) {
      plainPhase = (await invoke<Projection>("get_native_agent_projection", plain)).turn.phase;
      if (plainPhase === "idle" || plainPhase === "error") break;
      await page.waitForTimeout(2_000);
    }
    record.queuedCompactWithNoGoal = plainPhase;
    writeSummary();

    // No check: an independent read-only session decides.
    const verifying = await openTab(invoke, environment, "goals-verifier", container, model);
    await send(
      verifying,
      `Create goal-verified.txt holding the single word verified, then call the orkestrator report_goal tool with status "done". The objective is met when that file exists and holds that word. --max-iterations 3 --verifier ${platform}`,
    );
    const verified = await ended(verifying);
    scenarios.verifier = {
      status: verified.status,
      reason: verified.statusReason,
      detail: verified.statusDetail,
      iterations: verified.iterations,
    };
    writeSummary();
    expect(verified.status).toBe("complete");
    expect(verified.statusReason).toBe("verdict-passed");
  });

  test("what the provider offers, and a live background task", async ({ page }) => {
    test.skip(only === "extras", "only the extras");
    page.setDefaultTimeout(15_000);
    const { invoke, environment, workspace, model, container } = await prepare(page);
    const identity = await openTab(invoke, environment, "goals-probe", container, model);
    const facts: Record<string, unknown> = {};
    record.probe = facts;
    // Which goal tools reach a session, as the model sees them. A closure this
    // qualification relies on shows up here as an empty list.
    const ask = async (name: string, prompt: string) => {
      const before = (await invoke<Projection | null>("get_native_agent_projection", identity))
        ?.messages?.length;
      await invoke("dispatch_native_agent_intent", {
        ...identity,
        requestId: `probe-${name}-${Date.now()}`,
        prompt,
        ...(model ? { model } : {}),
      });
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const view = await invoke<Projection>("get_native_agent_projection", identity);
        const rows = view.messages ?? [];
        const reply = [...rows].reverse().find((row) => row.role === "assistant");
        if (
          (view.turn.phase === "idle" || view.turn.phase === "error") &&
          rows.length > (before ?? 0) &&
          reply
        ) {
          const text =
            typeof reply.content === "string"
              ? reply.content
              : JSON.stringify((reply as { parts?: unknown }).parts ?? reply.content ?? "");
          facts[name] = text.slice(0, 400);
          writeSummary();
          return text;
        }
        await page.waitForTimeout(2_000);
      }
      throw new Error(`the ${name} probe turn never ended`);
    };
    // What the model says it has. Codex defers MCP tools, so it may not list
    // report_goal even though it can call it: this is a record, not an assertion.
    await ask(
      "goalToolsTheModelNames",
      "List every tool available to you whose name contains the word goal, in any letter case, one name per line. If there are none, reply NONE. Use no tools.",
    );
    // Whether the agent's shell works in this session at all, with no goal set.
    const shell = await ask(
      "shellWithNoGoal",
      "Run the shell command: echo probe-shell-ok . Reply with its output only.",
    );
    const shellWorks = shell.includes("probe-shell-ok");

    // A task the agent leaves running must not hide the turn's end from the loop.
    await invoke("native_agent_goal_command", {
      ...identity,
      text: `Start the shell command "sleep 240" in the background and end your turn without waiting for it and without calling report_goal. When you are told to continue, call the orkestrator report_goal tool with status "done". --max-iterations 4`,
      ...(model ? { model } : {}),
    });
    let goal: Goal | undefined;
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      goal = (await invoke<{ goal?: Goal }>("get_native_agent_goal", identity)).goal;
      if (goal && !["active", "checking"].includes(goal.status)) break;
      await page.waitForTimeout(2_000);
    }
    facts.backgroundTask = {
      status: goal?.status,
      reason: goal?.statusReason,
      iterations: goal?.iterations,
    };
    writeSummary();
    // With no working shell or model, the loop's only job is to stop and say why.
    if (shellWorks) expect(goal?.status).toBe("claimed");
    else expect(["active", "checking"]).not.toContain(goal?.status);
    void workspace;
  });

  test("the browser: set, watch from elsewhere, reload, pause and clear", async ({
    page,
  }, testInfo) => {
    test.skip(only === "extras", "only the extras");
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
    await expect(input).toHaveText("");
    await page.screenshot({ path: testInfo.outputPath("goal-running.png") });

    // A reload mid-goal renders from the snapshot.
    await page.reload();
    await open(environment.name);
    await expect(page.getByTestId("goal-pill")).toBeVisible();

    // Away from the tab, the loop keeps going with nothing mounted.
    await open(other.name);
    await expect(page.getByTestId("goal-pill")).toHaveCount(0);
    let ended: Goal | undefined;
    const endBy = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < endBy) {
      ended = (await detail()).goal;
      if (ended && !["active", "checking"].includes(ended.status)) break;
      await page.waitForTimeout(2_000);
    }
    expect(
      { status: ended?.status, reason: ended?.statusReason, detail: ended?.statusDetail },
      "the goal set in the browser",
    ).toEqual({ status: "complete", reason: "check-passed", detail: undefined });
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
