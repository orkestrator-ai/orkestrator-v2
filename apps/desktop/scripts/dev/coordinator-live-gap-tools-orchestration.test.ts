import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import { fillGapPlaceholders, parseGapSteps } from "./coordinator-live-gap-tools.js";
import { runGapToolsScenario, scheduleIds } from "./coordinator-live-gap-tools-orchestration.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";

/**
 * The gap-tools orchestration over a scripted command transport: a fake
 * coordinator that makes each numbered call of a harness prompt, a fake
 * worker whose turns end after a few reads, and, for the connected-node
 * case, a second transport standing for the leaf that owns the worker.
 */

type Invoke = DelegationCoordinator["invoke"];

const TOKEN = "scripted";
const FILE = `gap-${TOKEN}.txt`;
const BASE = "a".repeat(40);
const WORKER_HEAD = "c".repeat(40);
const WORKER = "worker-1";
const FORK = "fork-1";
const COORDINATOR = "coordinator";
const NO_PR =
  "This worker has no pull request, so there are no conflicts to resolve; raise one with create_pr";
const NO_QUESTION =
  "That tab has no pending interaction with that id (it was answered, withdrawn or its turn ended). Read state.interactions from get_tab_state.";

type Script = {
  /** The worker runs on a connected node, read through its own transport. */
  remote?: boolean;
  /** The tab lists Claude's own /compact, which starts a provider turn. */
  providerCompact?: boolean;
  /** The worker's long turn raises an approval, left pending for the harness. */
  workerApproval?: boolean;
  /** The worker's own node cannot read its session. */
  unobservableWorker?: boolean;
  /** update_schedule answers with the ID but leaves the time as it was. */
  noOpRetime?: boolean;
  /** The fork is checked out at a commit that is not the worker's. */
  staleFork?: boolean;
};

let previousStep: string | undefined;
beforeEach(() => {
  previousStep = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "2000";
});
afterEach(() => {
  if (previousStep === undefined)
    delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previousStep;
});

function fixture(script: Script = {}) {
  let clock = Date.parse("2026-11-11T09:00:00.000Z");
  const now = () => new Date((clock += 1_000)).toISOString();
  const messages: CoordinatorTranscriptMessage[] = [];
  const workflows: Array<Record<string, unknown>> = [];
  const mail: Array<DelegationMailMessage & { body: string }> = [];
  const schedules = new Map<string, Record<string, unknown>>();
  /** Environments the worker's node holds, other than the fixture. */
  const workerEnvironments: Array<{ id: string; name: string }> = [];
  const calls = { command: [] as string[], worker: [] as string[] };
  const resolved = { command: 0, worker: 0 };
  let coordinatorWorking = 0;
  /** Reads until the worker's current turn ends; Infinity for the long turn. */
  let workerWorking = 0;
  let pendingApproval = false;
  let next = 0;

  const delegation = () =>
    workflows.find((workflow) => workflow.resourceId === WORKER)?.delegation as
      Record<string, unknown> | undefined;
  const openDelegation = (reads: number) => {
    const association = workflows.find((workflow) => workflow.resourceId === WORKER);
    const record = { requestedAt: now(), workerTabId: "startup-agent", state: "running" };
    if (association) association.delegation = record;
    else
      workflows.push({
        kind: "environment",
        conversationId: "conversation",
        resourceId: WORKER,
        delegation: record,
      });
    workerWorking = reads;
  };
  /** The worker's turn ended: its delegation completes and wakes the coordinator. */
  const finishTurn = () => {
    Object.assign(delegation() ?? {}, { state: "completed", completedAt: now(), wokenAt: now() });
    coordinatorWorking = 2;
  };

  /** What the scripted coordinator's tool call answers: output, or an error. */
  const runTool = (
    tool: string,
    args: Record<string, unknown>,
  ): { output: Record<string, unknown> } | { error: string } => {
    switch (tool) {
      case "get_launch_options":
        return { output: { coordinatorBase: { baseBranch: "main", baseCommit: BASE } } };
      case "launch_environment":
        workerEnvironments.push({ id: WORKER, name: String(args.name) });
        openDelegation(2);
        return { output: { environmentId: WORKER, name: args.name } };
      case "get_worker_changes":
        return {
          output: {
            environmentId: WORKER,
            committed: { files: [{ path: FILE }] },
            uncommitted: { files: [{ path: FILE }] },
            committedDiffs: { files: [{ path: FILE, diff: `+committed-${TOKEN}` }] },
            uncommittedDiffs: { files: [{ path: FILE, diff: `+uncommitted-${TOKEN}` }] },
          },
        };
      case "fork_worker":
        workerEnvironments.push({ id: FORK, name: `${WORKER}-fork` });
        return { output: { environmentId: FORK, baseCommit: WORKER_HEAD } };
      case "send_prompt_to_tab":
        openDelegation(Number.POSITIVE_INFINITY);
        if (script.workerApproval) pendingApproval = true;
        return { output: { environmentId: WORKER, delegationOpened: true } };
      case "stop_worker_turn": {
        workerWorking = 0;
        finishTurn();
        const id = `notice-${++next}`;
        mail.push({
          id,
          createdAt: now(),
          from: { kind: "system" },
          toEnvironmentId: COORDINATOR,
          toTabId: "coord-tab",
          placement: "injected",
          injectedAt: now(),
          body: "The worker stopped because you stopped its turn with stop_worker_turn.",
        });
        return { output: { stopped: true } };
      }
      case "list_worker_commands":
        return {
          output: {
            commands: script.providerCompact
              ? [{ id: "claude:/compact", name: "/compact", source: "builtin" }]
              : [{ id: "orkestrator:compact", name: "/compact", source: "orkestrator" }],
          },
        };
      case "run_worker_command":
        if (script.providerCompact) {
          openDelegation(2);
          return {
            output: {
              commandId: "claude:/compact",
              startsTurn: true,
              delegationOpened: true,
              outcome: "dispatched",
            },
          };
        }
        return {
          output: {
            commandId: "orkestrator:compact",
            startsTurn: false,
            delegationOpened: false,
            outcome: "dispatched",
          },
        };
      case "create_schedule": {
        const scheduleId = `job-${++next}`;
        const record = {
          scheduleId,
          state: "active",
          when: `once at ${new Date(clock + 6 * 3_600_000).toISOString()}`,
        };
        schedules.set(scheduleId, record);
        return { output: { ...record } };
      }
      case "pause_schedule":
      case "resume_schedule": {
        const record = schedules.get(String(args.scheduleId))!;
        record.state = tool === "pause_schedule" ? "paused" : "active";
        return { output: { ...record } };
      }
      case "update_schedule": {
        const record = schedules.get(String(args.scheduleId))!;
        if (!script.noOpRetime)
          record.when = `once at ${new Date(clock + 7 * 3_600_000).toISOString()}`;
        return { output: { ...record } };
      }
      case "cancel_schedule":
        schedules.delete(String(args.scheduleId));
        return { output: { scheduleId: args.scheduleId, cancelled: true } };
      case "resolve_conflicts":
        return { error: NO_PR };
      case "answer_worker_question":
        return { error: NO_QUESTION };
      default:
        throw new Error(`unscripted tool ${tool}`);
    }
  };

  /** The scripted coordinator's turn: each numbered call, in order, once. */
  const respond = (prompt: string) => {
    messages.push({ id: `row-${messages.length}`, role: "user", content: "harness prompt" });
    const results = new Map<string, unknown>();
    for (const step of parseGapSteps(prompt)) {
      const args = fillGapPlaceholders(step.args, results) ?? step.args;
      const answer = runTool(step.tool, args);
      if ("output" in answer) results.set(step.tool, answer.output);
      messages.push({
        id: `row-${messages.length}`,
        role: "assistant",
        parts: [
          "output" in answer
            ? {
                toolName: `mcp__orkestrator__${step.tool}`,
                toolArgs: args,
                toolState: "success",
                toolOutput: JSON.stringify(answer.output),
              }
            : {
                toolName: `mcp__orkestrator__${step.tool}`,
                toolArgs: args,
                toolState: "error",
                toolError: answer.error,
              },
        ],
      });
    }
    coordinatorWorking = 2;
  };

  /** The worker's session, as the node that owns it reads it. */
  const workerProjection = () => {
    if (script.unobservableWorker) return null;
    if (workerWorking > 0 && workerWorking !== Number.POSITIVE_INFINITY) {
      workerWorking -= 1;
      if (workerWorking === 0) finishTurn();
    }
    return {
      turn: { phase: workerWorking > 0 ? "working" : "idle" },
      messages: [],
      interactions: pendingApproval
        ? [
            {
              id: "approval-1",
              kind: "command-approval",
              state: "pending",
              sessionId: "worker-session",
              createdAt: clock,
            },
          ]
        : [],
    };
  };

  /** Commands only the node that owns the worker can answer. */
  const workerCommand = (command: string, args: Record<string, unknown>): unknown => {
    switch (command) {
      case "get_environments":
        return workerEnvironments.map((environment) => ({ ...environment }));
      case "get_native_agent_projection":
        return workerProjection();
      case "resolve_native_agent_interaction":
        pendingApproval = false;
        return null;
      case "get_agent_mail_mailbox":
        return { messages: [] };
      case "get_environment_uncommitted_paths":
        return args.environmentId === FORK
          ? { head: script.staleFork ? "d".repeat(40) : WORKER_HEAD, paths: [] }
          : { head: WORKER_HEAD, paths: [FILE] };
      case "read_environment_file_base64":
        return Buffer.from(`committed-${TOKEN}\n`).toString("base64");
      case "stop_environment":
        return null;
      case "delete_environment":
        workerEnvironments.splice(
          workerEnvironments.findIndex((environment) => environment.id === args.environmentId),
          1,
        );
        return null;
      default:
        return undefined;
    }
  };

  const commandNode: Invoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    calls.command.push(command);
    if (command === "resolve_native_agent_interaction") {
      if (args.environmentId !== COORDINATOR) resolved.command += 1;
      // The coordinator's node holds no session for a worker on another node.
      if (script.remote) throw new Error("Session not found");
    }
    switch (command) {
      case "dispatch_native_agent_intent":
        respond(String(args.prompt));
        return { outcome: "dispatched" } as T;
      case "get_project_coordinator":
        return { workflows: structuredClone(workflows) } as T;
      case "get_prompt_queue":
        return { messages: [] } as T;
      case "list_node_action_requests":
        return [] as T;
      case "list_scheduled_jobs":
        return {
          schedules: [...schedules.values()].map((record) => ({ id: record.scheduleId })),
        } as T;
      case "get_agent_mail_mailbox":
        return {
          messages:
            args.environmentId === COORDINATOR
              ? mail.map(({ body: _body, ...summary }) => summary)
              : [],
        } as T;
      case "get_agent_mail_message":
        return (mail.find((message) => message.id === args.messageId) ?? null) as T;
      case "get_native_agent_projection":
        if (args.environmentId === COORDINATOR) {
          const phase = coordinatorWorking > 0 ? "working" : "idle";
          if (coordinatorWorking > 0) coordinatorWorking -= 1;
          return { turn: { phase }, messages: messages.slice(-200) } as T;
        }
        // A worker on another node has no session record here.
        if (script.remote) return null as T;
        break;
      case "get_environments":
        if (script.remote) return [] as T;
        break;
    }
    if (script.remote)
      throw new Error(`the command node cannot answer ${command} for a leaf worker`);
    const answer = workerCommand(command, args);
    if (answer === undefined) throw new Error(`unscripted command ${command}`);
    return answer as T;
  };
  const leaf: Invoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    calls.worker.push(command);
    if (command === "resolve_native_agent_interaction") resolved.worker += 1;
    const answer = workerCommand(command, args);
    if (answer === undefined) throw new Error(`unscripted leaf command ${command}`);
    return answer as T;
  };

  const coordinator: DelegationCoordinator = {
    invoke: commandNode,
    identity: {
      environmentId: COORDINATOR,
      agent: script.providerCompact ? "claude" : "pi",
      logicalSessionKey: "coord",
    },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  return { coordinator, leaf, calls, resolved, schedules, workerEnvironments };
}

async function run(script: Script = {}) {
  const scripted = fixture(script);
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: scripted.coordinator.identity.agent,
    verdict: "passed",
    startedAt: "test",
  };
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const result = await runGapToolsScenario({
      coordinator: scripted.coordinator,
      summary,
      cleanup,
      token: TOKEN,
      pollIntervalMs: 1,
      ...(script.remote
        ? { nodeId: "node-leaf", workerInvoke: scripted.leaf, workerProjectId: "leaf-project" }
        : {}),
    });
    return { ...result, ...scripted };
  } finally {
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const failed = (checks: ReadonlyArray<{ name: string; passed: boolean }>) =>
  checks.filter((check) => !check.passed).map((check) => check.name);

test("a coordinator that makes every call as asked qualifies on this node", async () => {
  const { checks, schedules, workerEnvironments } = await run();
  expect(checks.filter((check) => !check.passed)).toEqual([]);
  expect(checks.find((check) => check.name === "command-ran-as-listed")?.detail).toContain(
    "session action",
  );
  // The schedule was cancelled, and cleanup removed the worker and its fork.
  expect(schedules.size).toBe(0);
  expect(workerEnvironments).toEqual([]);
});

test("a worker on a connected node is read, and its approvals answered, through that node", async () => {
  const { checks, calls, resolved, workerEnvironments } = await run({
    remote: true,
    workerApproval: true,
  });
  // The leaf's approval reached the harness, so the run does not qualify…
  expect(failed(checks)).toEqual(["no-user-action"]);
  expect(checks.find((check) => check.name === "no-user-action")?.detail).toContain(
    "worker: approvals escaped",
  );
  // …and it was seen and answered on the leaf, never on the coordinator's node.
  expect(resolved).toEqual({ command: 0, worker: 1 });
  for (const command of [
    "get_native_agent_projection",
    "get_environment_uncommitted_paths",
    "read_environment_file_base64",
  ]) {
    expect(calls.worker).toContain(command);
  }
  expect(calls.command).not.toContain("get_environment_uncommitted_paths");
  expect(workerEnvironments).toEqual([]);
});

test("a worker on a connected node that behaves qualifies", async () => {
  const { checks } = await run({ remote: true });
  expect(checks.filter((check) => !check.passed)).toEqual([]);
});

test("a worker whose session cannot be read fails rather than passing on no evidence", async () => {
  const { checks } = await run({ remote: true, unobservableWorker: true });
  expect(failed(checks)).toContain("no-user-action");
  expect(checks.find((check) => check.name === "no-user-action")?.detail).toContain("never read");
});

test("Claude's own /compact opens one delegation, which the harness waits on until it wakes", async () => {
  const { checks } = await run({ providerCompact: true });
  expect(checks.filter((check) => !check.passed)).toEqual([]);
  expect(checks.find((check) => check.name === "command-ran-as-listed")?.detail).toContain(
    "provider command, ran claude:/compact, startsTurn true, delegation true, outcome dispatched, 1 delegations opened, woken",
  );
});

test("an update that answers with the ID but does not retime fails schedule-edits", async () => {
  const { checks } = await run({ noOpRetime: true });
  expect(failed(checks)).toEqual(["schedule-edits"]);
  expect(checks.find((check) => check.name === "schedule-edits")?.detail).toContain("moved 0 min");
});

test("a fork checked out at another commit fails, though it reports the right base", async () => {
  const { checks } = await run({ staleFork: true });
  expect(failed(checks)).toEqual(["fork-from-last-commit"]);
});

test("schedule IDs are read from whichever list key the answer uses", () => {
  expect(scheduleIds({ schedules: [{ id: "a" }, { id: 1 }] })).toEqual(["a"]);
  expect(scheduleIds({ jobs: [{ id: "b" }] })).toEqual(["b"]);
  expect(scheduleIds([{ id: "c" }])).toEqual(["c"]);
  expect(scheduleIds(null)).toEqual([]);
});
