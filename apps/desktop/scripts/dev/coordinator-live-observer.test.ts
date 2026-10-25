import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  runCoordinatorCleanup,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { deliverAsyncReport, finishFamilyExchange } from "./coordinator-live-orchestration.js";
import {
  deliveredWhileRunning,
  FAMILY_DONE_MARKER,
  type DelegationMailMessage,
} from "./coordinator-live-delegation.js";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTurnProjection,
} from "./coordinator-live.js";

const identity = {
  environmentId: "coordinator",
  agent: "codex" as const,
  logicalSessionKey: "session",
};
const summary = (): CoordinatorLivePlatformSummary => ({
  version: 1,
  platform: "codex",
  verdict: "passed",
  startedAt: "test",
});
const coordinator = (invoke: DelegationCoordinator["invoke"]): DelegationCoordinator => ({
  invoke,
  identity,
  projectId: "project",
  conversation: { id: "conversation", tabId: "tab" },
});
const mail = (id: string, placement = "inject-held"): DelegationMailMessage => ({
  id,
  createdAt: "2026-10-18T00:00:00Z",
  from: { kind: "tab", environmentId: "reporter" },
  toEnvironmentId: "coordinator",
  toTabId: "tab",
  placement,
});
const projection = (
  phase = "idle",
  messages: CoordinatorTurnProjection["messages"] = [],
): CoordinatorTurnProjection =>
  ({
    turn: { phase },
    messages,
  }) as CoordinatorTurnProjection;

/** No global mocks: exercise the observer against a scripted backend command transport. */
function fixture() {
  const state = {
    running: true,
    mail: [mail("progress"), mail("report")],
    workerMail: [] as DelegationMailMessage[],
    coordinatorPhase: "idle",
    workerPhase: "running",
    queued: 0,
    messages: [] as CoordinatorTurnProjection["messages"],
    commands: [] as string[],
    onCommand: (_command: string, _args: Record<string, unknown>) => {},
    outputs: new Map<string, string>(),
  };
  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    state.commands.push(command);
    state.onCommand(command, args);
    let value: unknown;
    switch (command) {
      case "get_agent_mail_mailbox":
        value = {
          messages:
            args.environmentId === "coordinator"
              ? state.mail.map((item) => ({ ...item }))
              : state.workerMail,
        };
        break;
      case "get_project_coordinator":
        value = {
          workflows: [
            {
              kind: "environment",
              conversationId: "conversation",
              resourceId: "reporter",
              delegation: {
                requestedAt: "start",
                workerTabId: "startup-agent",
                state: state.running ? "running" : "completed",
              },
            },
          ],
        };
        break;
      case "get_native_agent_projection":
        value = projection(
          args.environmentId === "coordinator" ? state.coordinatorPhase : state.workerPhase,
          args.environmentId === "coordinator" ? state.messages : [],
        );
        break;
      case "get_prompt_queue":
        value = { messages: Array.from({ length: state.queued }) };
        break;
      case "get_environments":
        value = [{ id: "reporter", name: "second-worker" }];
        break;
      case "get_native_agent_tool_details":
        value = { toolOutput: state.outputs.get(String(args.detailRef)) };
        break;
      case "dispatch_native_agent_intent":
      case "enqueue_prompt_queue_message":
        value = null;
        break;
      default:
        throw new Error(`Unexpected command ${command}`);
    }
    return value as T;
  };
  const owner = coordinator(invoke);
  const watch = createDelegationWatch(invoke, owner, summary(), 0);
  return { state, owner, watch };
}

describe("delegation observer", () => {
  test("completion and injection between reads cannot fabricate a held-mail violation", async () => {
    const { state, watch } = fixture();
    state.onCommand = (command, args) => {
      // In the old snapshot-first order this returns running, then injects on
      // the mailbox read, permanently recording a false leak.
      if (command === "get_agent_mail_mailbox" && args.environmentId === "coordinator") {
        state.running = false;
        state.mail = state.mail.map((message) => ({ ...message, placement: "injected" }));
      }
    };
    const first = await watch.observe();
    expect(state.commands[0]).toBe("get_agent_mail_mailbox");
    expect(first.delegations[0]?.state).toBe("completed");
    await watch.observe();
    expect(deliveredWhileRunning(watch.observations, "reporter", "coordinator")).toBe(0);
    expect(watch.observations.at(-1)?.mail[0]?.placement).toBe("injected");
  });

  test("a real injection during a running delegation still fails", async () => {
    const { state, watch } = fixture();
    state.mail = [mail("leak", "injected")];
    await watch.observe();
    expect(deliveredWhileRunning(watch.observations, "reporter", "coordinator")).toBe(1);
  });

  test("poll result collection resolves detail refs and nested calls in order", async () => {
    const { state, watch } = fixture();
    state.outputs.set(
      "fourth",
      JSON.stringify({ content: [{ type: "text", text: '{"repeatedRead":true}' }] }),
    );
    const messages = [
      {
        role: "assistant",
        parts: [
          ...Array.from({ length: 3 }, () => ({ toolName: "read_messages", toolOutput: "{}" })),
          {
            toolName: "wrapper",
            childTools: [{ toolName: "mcp__orkestrator__read_messages", detailRef: "fourth" }],
          },
          { toolName: "read_messages", toolOutput: "{}" },
        ],
      },
    ];
    const results = await watch.toolOutputs("read_messages", messages);
    expect(results).toHaveLength(5);
    expect(JSON.parse(results[3]!).content[0].text).toBe('{"repeatedRead":true}');
    expect(state.commands).toEqual(["get_native_agent_tool_details"]);
  });
});

test("one failed deletion does not prevent later workers or cleanup steps, and fails the summary", async () => {
  const calls: string[] = [];
  let reads = 0;
  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    if (command === "get_environments")
      return (
        reads++ === 0 ? [{ id: "existing" }] : [{ id: "existing" }, { id: "one" }, { id: "two" }]
      ) as T;
    calls.push(`${command}:${args.environmentId}`);
    if (args.environmentId === "one") throw new Error("synthetic stop/delete failure");
    return null as T;
  };
  const cleanup: Array<() => Promise<unknown>> = [async () => calls.push("last cleanup")];
  const result = summary();
  await removeLaunchedEnvironments(invoke, "project", cleanup);
  await runCoordinatorCleanup(cleanup, result);
  expect(calls).toEqual([
    "stop_environment:one",
    "delete_environment:one",
    "stop_environment:two",
    "delete_environment:two",
    "last cleanup",
  ]);
  expect(result.verdict).toBe("failed");
  expect(result.reason).toBe("1 cleanup steps failed");
});

async function withGates(
  body: (probe: {
    platform: "codex";
    token: string;
    gatePath: string;
    finishGatePath: string;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coordinator-orchestration-"));
  try {
    await body({
      platform: "codex",
      token: "test",
      gatePath: path.join(directory, "report.go"),
      finishGatePath: path.join(directory, "finish.go"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("async gates open in order, queue overlaps pending mail, then delivery settles", async () => {
  await withGates(async (probe) => {
    const { state, watch, owner } = fixture();
    let queuedReads = 0;
    state.onCommand = (command, args) => {
      if (command === "dispatch_native_agent_intent") {
        expect(existsSync(probe.gatePath)).toBe(true);
        expect(existsSync(probe.finishGatePath)).toBe(false);
        state.coordinatorPhase = "running";
      }
      if (command === "enqueue_prompt_queue_message") {
        expect(existsSync(probe.finishGatePath)).toBe(false);
        state.queued = 1;
        state.running = false;
        state.mail = state.mail.map((message) => ({ ...message, placement: "pending-inject" }));
      }
      // Preserve the overlap for two samples, then emulate queue drain and
      // carrier delivery. The observer still captures the pending sample.
      if (
        command === "get_agent_mail_mailbox" &&
        args.environmentId === "coordinator" &&
        state.queued > 0
      ) {
        queuedReads += 1;
        if (queuedReads > 2) {
          state.queued = 0;
          state.coordinatorPhase = "idle";
          state.workerPhase = "idle";
          state.mail = state.mail.map((message) => ({ ...message, placement: "injected" }));
        }
      }
    };
    expect(
      await deliverAsyncReport({
        coordinator: owner,
        watch,
        probe,
        fromReporter: (message) => message.from.environmentId === "reporter",
      }),
    ).toBe(true);
    expect(await readFile(probe.gatePath, "utf8")).toBe("open\n");
    expect(await readFile(probe.finishGatePath, "utf8")).toBe("open\n");
    expect(
      watch.observations.some(
        (sample) =>
          sample.queueLength === 1 &&
          sample.coordinatorPhase === "running" &&
          sample.mail.some((message) => message.placement === "pending-inject"),
      ),
    ).toBe(true);
    expect(
      watch.observations
        .slice(-2)
        .every(
          (sample) =>
            sample.mail.every((message) => message.placement === "injected") &&
            sample.queueLength === 0,
        ),
    ).toBe(true);
    expect(state.commands.indexOf("dispatch_native_agent_intent")).toBeLessThan(
      state.commands.indexOf("enqueue_prompt_queue_message"),
    );
  });
});

test("family gate requires a held follow-up to a busy worker and waits for quiet completion", async () => {
  await withGates(async (probe) => {
    const { state, watch } = fixture();
    state.mail = [];
    state.workerMail = [
      {
        ...mail("follow-up", "pending-inject"),
        from: { kind: "coordinator" },
        toEnvironmentId: "reporter",
      },
    ];
    let reads = 0;
    state.workerPhase = "idle";
    state.onCommand = (command) => {
      if (command === "get_project_coordinator") {
        reads += 1;
        if (reads <= 2) expect(existsSync(probe.gatePath)).toBe(false);
        else expect(existsSync(probe.gatePath)).toBe(true);
        if (reads === 2) state.workerPhase = "running";
        if (reads > 2) {
          state.workerPhase = "idle";
          state.workerMail = [];
          state.messages = [{ role: "assistant", content: FAMILY_DONE_MARKER }];
        }
      }
    };
    await finishFamilyExchange(watch, probe, "second-worker");
    expect(await readFile(probe.gatePath, "utf8")).toBe("open\n");
    expect(watch.observations[0]?.workerPhases?.reporter).toBe("idle");
    expect(watch.observations[1]?.workerPhases?.reporter).toBe("running");
    expect(watch.observations.length).toBeGreaterThanOrEqual(4);
  });
});

test("a held worker's approval stays pending until it is released, then is denied once", async () => {
  const resolved: Array<{ environmentId: unknown; interactionId: unknown; action: unknown }> = [];
  let interactions = [
    { id: "approval-1", kind: "command-approval", state: "pending", sessionId: "s" },
  ];
  const invoke: DelegationCoordinator["invoke"] = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    let value: unknown = null;
    if (command === "get_agent_mail_mailbox") value = { messages: [] };
    else if (command === "get_project_coordinator")
      value = {
        workflows: ["held", "other"].map((resourceId) => ({
          kind: "environment",
          conversationId: "conversation",
          resourceId,
        })),
      };
    else if (command === "get_native_agent_projection")
      value = {
        ...projection(args.environmentId === "coordinator" ? "idle" : "waiting"),
        interactions: args.environmentId === "coordinator" ? [] : interactions,
      };
    else if (command === "get_prompt_queue") value = { messages: [] };
    else if (command === "get_environments") value = [];
    else if (command === "resolve_native_agent_interaction") {
      const resolution = args.resolution as { action: unknown };
      resolved.push({
        environmentId: args.environmentId,
        interactionId: args.interactionId,
        action: resolution.action,
      });
    } else throw new Error(`Unexpected command ${command}`);
    return value as T;
  };
  const watch = createDelegationWatch(invoke, coordinator(invoke), summary(), 0, {
    holdWorkerInteractions: (environmentId) => environmentId === "held",
  });
  await watch.observe();
  await watch.observe();
  // The other worker's approval is denied at once and recorded as escaped;
  // the held worker's is only recorded.
  expect(resolved).toEqual([
    { environmentId: "other", interactionId: "approval-1", action: "deny" },
  ]);
  expect(watch.workerEscaped()).toEqual(["command-approval"]);
  expect(watch.held("held")).toEqual([{ kind: "command-approval", seenAt: expect.any(Number) }]);
  await watch.release("held");
  await watch.release("held");
  expect(resolved.slice(1)).toEqual([
    { environmentId: "held", interactionId: "approval-1", action: "deny" },
  ]);
  expect(watch.held("held")[0]?.releasedAt).toEqual(expect.any(Number));
  interactions = [];
  await watch.observe();
  expect(watch.held("held")).toHaveLength(1);
});
