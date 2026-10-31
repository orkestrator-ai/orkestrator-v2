import { expect, test } from "bun:test";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { GOAL_MAX_ITERATIONS } from "./coordinator-live-goal.js";
import { runGoalScenario } from "./coordinator-live-goal-orchestration.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";

const token = "scripted";
const tool = (toolName: string, toolOutput = ""): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs: {}, toolOutput, toolState: "completed" }],
});

/**
 * Script only the command transport: the live observer, waits and verdict run
 * unchanged. The scripted backend moves the goal on a little with each read of
 * it, as a real loop would between the harness's polls.
 */
type Script = {
  /** How the goal ends. */
  ending?: "complete" | "claimed" | "limited";
  /** Iterations it takes. */
  iterations?: number;
  /** A wake at the end of each iteration. */
  wakePerIteration?: boolean;
  /** The sweep's bug: the delegation closes at the first idle between iterations. */
  earlyClose?: boolean;
  /** `set_worker_goal` answers with a refusal. */
  refused?: boolean;
  /** The goal ends and the delegation is never woken. */
  neverWakes?: boolean;
  /** The coordinator ends its wake turn without reading the goal. */
  ignoresWake?: boolean;
  /** A second wake arrives in the quiet window. */
  duplicate?: boolean;
};

function fixture(platform: AgentPlatform, script: Script = {}) {
  const now = () => new Date().toISOString();
  const ending = script.ending ?? "complete";
  const totalIterations = script.iterations ?? 2;
  const environments: Array<{ id: string; name: string }> = [];
  const messages: CoordinatorTranscriptMessage[] = [];
  const mail: DelegationMailMessage[] = [];
  const delegations: Array<Record<string, unknown>> = [];
  const turns: Array<{ turnId: string }> = [];
  const sent: string[] = [];
  let goal: Record<string, unknown> | undefined;
  /** Reads of the coordinator that still answer "working". */
  let workingReads = 0;
  let extraWakes = 0;
  let wakeFinish: (() => void) | undefined;
  let workerWorking = true;
  let quietReads = 0;

  const wake = (turnId: string, finish?: () => void) => {
    workingReads = 2;
    wakeFinish = () => {
      turns.push({ turnId });
      finish?.();
    };
  };
  const deliverNotice = (id: string, body: string) => {
    mail.push({
      id,
      createdAt: now(),
      from: { kind: "system" },
      toEnvironmentId: "coordinator",
      toTabId: "coord-tab",
      placement: "injected",
      body,
    });
  };
  const closeNewest = (woken: boolean) => {
    const open = delegations.at(-1)!;
    open.state = "completed";
    open.completedAt = now();
    if (woken) open.wokenAt = now();
  };
  const advanceGoal = () => {
    if (!goal || !["active", "checking"].includes(goal.status as string)) return;
    // One wake at a time, so each is a turn of its own, as a real one would be.
    if (wakeFinish) return;
    const iterations = goal.iterations as number;
    if (script.earlyClose && iterations === 1 && !delegations.at(-1)!.completedAt) {
      closeNewest(true);
      deliverNotice("early-notice", "Worker finished without sending a report.");
      wake("early-wake");
    }
    if (script.wakePerIteration && iterations < totalIterations) {
      deliverNotice(`iteration-${iterations}`, "Worker finished without sending a report.");
      wake(`iteration-wake-${iterations}`);
    }
    if (iterations < totalIterations) {
      goal = { ...goal, iterations: iterations + 1, updatedAt: now() };
      return;
    }
    goal = {
      ...goal,
      status: ending,
      statusReason:
        ending === "complete"
          ? "check-passed"
          : ending === "claimed"
            ? "agent-claimed"
            : "iteration-cap",
      ...(ending === "complete"
        ? { lastCheck: { passed: true, exitCode: 0, durationMs: 1, outputTail: "", at: now() } }
        : {}),
      endedAt: now(),
    };
    workerWorking = false;
    if (script.neverWakes) return;
    if (!script.earlyClose) closeNewest(true);
    deliverNotice(
      "goal-notice",
      `Its goal is ${ending} (${goal.statusReason as string}) after ${totalIterations} of ${GOAL_MAX_ITERATIONS} iterations. Read more: \`get_worker_goal {}\`.`,
    );
    wake("goal-wake", () => {
      if (!script.ignoresWake) {
        messages.push(
          tool(
            "mcp__orkestrator__get_worker_goal",
            JSON.stringify({ goal: { status: ending, iterations: totalIterations } }),
          ),
        );
      }
    });
  };

  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    let value: unknown = null;
    switch (command) {
      case "get_environments":
        value = [...environments];
        break;
      case "get_prompt_queue":
        value = { messages: [] };
        break;
      case "get_project_coordinator":
        value = {
          workflows: delegations.map((delegation) => ({
            kind: "environment",
            conversationId: "conversation",
            resourceId: "worker",
            delegation: { ...delegation },
          })),
        };
        break;
      case "dispatch_native_agent_intent": {
        const prompt = String(args.prompt);
        sent.push(prompt);
        turns.push({ turnId: `prompt-${turns.length}` });
        messages.push({ role: "user", content: "harness prompt" });
        if (prompt.includes("launch_environment")) {
          environments.push({ id: "worker", name: `goal-${token}` });
          delegations.push({
            requestedAt: now(),
            workerTabId: "startup-agent",
            state: "completed",
            completedAt: now(),
            wokenAt: now(),
          });
          workerWorking = false;
          messages.push(tool("launch_environment", '{"environmentId":"worker"}'));
        } else if (script.refused) {
          messages.push(tool("set_worker_goal", "A goal is already running."));
        } else {
          goal = {
            goalId: "goal-1",
            objective: "private",
            status: "active",
            iterations: 1,
            maxIterations: GOAL_MAX_ITERATIONS,
            setAt: now(),
            updatedAt: now(),
          };
          delegations.push({ requestedAt: now(), workerTabId: "startup-agent", state: "running" });
          workerWorking = true;
          messages.push(
            tool(
              "mcp__orkestrator__set_worker_goal",
              JSON.stringify({
                goal: { goalId: "goal-1", status: "active", maxIterations: GOAL_MAX_ITERATIONS },
                wakeOwed: true,
              }),
            ),
          );
        }
        break;
      }
      case "get_native_agent_goal":
        advanceGoal();
        value = goal ? { goal: { ...goal }, history: [] } : { history: [] };
        break;
      case "get_agent_mail_mailbox":
        value = {
          messages: mail
            .filter(
              (message) =>
                message.toEnvironmentId === args.environmentId && message.toTabId === args.tabId,
            )
            .map(({ body: _body, ...rest }) => ({ ...rest })),
        };
        break;
      case "get_agent_mail_message": {
        const message = mail.find((item) => item.id === args.messageId);
        value = message ? { body: message.body } : null;
        break;
      }
      case "get_native_agent_projection":
        if (args.environmentId === "coordinator") {
          if (workingReads === 0 && wakeFinish) {
            wakeFinish();
            wakeFinish = undefined;
          }
          let phase = "idle";
          if (workingReads > 0) {
            workingReads -= 1;
            phase = "working";
          } else if (goal && !["active", "checking"].includes(goal.status as string)) {
            quietReads += 1;
            if (script.duplicate && quietReads === 3 && extraWakes === 0) {
              extraWakes += 1;
              turns.push({ turnId: "duplicate-wake" });
            }
          }
          value = { turn: { phase }, messages: [...messages], contextUsage: { turns: [...turns] } };
        } else {
          value = { turn: { phase: workerWorking ? "working" : "idle" }, messages: [] };
        }
        break;
      case "stop_environment":
      case "delete_environment":
        break;
      default:
        throw new Error(`unscripted command ${command}`);
    }
    return value as T;
  };
  const coordinator: DelegationCoordinator = {
    invoke,
    identity: { environmentId: "coordinator", agent: platform, logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform,
    verdict: "passed",
    startedAt: "test",
  };
  return { coordinator, summary, sent };
}

async function run(script: Script = {}, platform: AgentPlatform = "claude") {
  const { coordinator, summary, sent } = fixture(platform, script);
  const cleanup: Array<() => Promise<unknown>> = [];
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "120";
  try {
    const result = await runGoalScenario({
      coordinator,
      summary,
      cleanup,
      token,
      pollIntervalMs: 1,
      quietMs: 25,
    });
    return { ...result, sent };
  } finally {
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const names = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

test("a goal that completes after two iterations, with one wake and a read, qualifies", async () => {
  const { checks, sent, watch } = await run();
  expect(checks.filter((item) => !item.passed)).toEqual([]);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContain("set_worker_goal");
  expect(sent[1]).toContain('environmentId "worker"');
  expect(watch.observations.length).toBeGreaterThan(0);
});

test("the set turn waits for the launch's own wake, so that wake is not counted", async () => {
  const { checks } = await run();
  expect(checks.find((item) => item.name === "one-wake")).toMatchObject({
    passed: true,
    detail: "1 coordinator turns after the set turn",
  });
});

test("a wake per iteration fails", async () => {
  const { checks } = await run({ wakePerIteration: true, iterations: 3 });
  expect(names(checks)).toContain("one-wake");
});

test("a delegation the sweep closed between iterations fails", async () => {
  const { checks } = await run({ earlyClose: true, iterations: 3 });
  expect(names(checks)).toContain("delegation-held-until-goal-ended");
});

test("a second wake in the quiet window fails even with an idle final sample", async () => {
  const { checks, watch } = await run({ duplicate: true });
  expect(names(checks)).toEqual(["one-wake"]);
  expect(watch.observations.at(-1)?.coordinatorPhase).toBe("idle");
});

test("a goal that ends with no wake is reported, not hung on", async () => {
  const { checks } = await run({ neverWakes: true });
  expect(names(checks)).toEqual(
    expect.arrayContaining(["finished", "delegation-held-until-goal-ended", "one-wake"]),
  );
});

test("a claim, which nothing verified, fails", async () => {
  const { checks } = await run({ ending: "claimed" });
  expect(names(checks)).toEqual(
    expect.arrayContaining(["goal-complete", "check-pass-recorded", "wake-names-outcome"]),
  );
});

test("a goal stopped at its cap fails", async () => {
  const { checks } = await run({ ending: "limited", iterations: 3 });
  expect(names(checks)).toEqual(expect.arrayContaining(["goal-complete", "check-pass-recorded"]));
});

test("one iteration fails, because it proves nothing about iterations", async () => {
  const { checks } = await run({ iterations: 1 });
  expect(names(checks)).toEqual(["ran-more-than-one-iteration"]);
});

test("a coordinator that ignores its wake fails", async () => {
  const { checks } = await run({ ignoresWake: true });
  expect(names(checks)).toEqual(["coordinator-read-goal"]);
});

test("a refused set ends the case at once with the reason", async () => {
  const { checks, sent } = await run({ refused: true });
  expect(sent).toHaveLength(2);
  const failed = names(checks);
  expect(failed).toEqual(expect.arrayContaining(["finished", "goal-set", "goal-complete"]));
  expect(checks.find((item) => item.name === "finished")?.detail).toContain("set no goal");
});
