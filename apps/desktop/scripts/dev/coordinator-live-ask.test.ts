import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorLivePlatformSummary,
  CoordinatorTranscriptMessage,
} from "./coordinator-live.js";
import {
  ASK_REPORT_MARKER,
  askAnswer,
  askApplies,
  askOptions,
  askScenarioPrompt,
  parseAskReport,
} from "./coordinator-live-ask.js";
import { runAskScenario } from "./coordinator-live-ask-orchestration.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import { runCoordinatorCleanup, type DelegationCoordinator } from "./coordinator-live-observer.js";

const token = "scripted";
const probe = { platform: "claude" as AgentPlatform, token };
const { first, chosen } = askOptions(probe);

const question = (labels: string[], id = "question-1") => ({
  id,
  kind: "question" as const,
  state: "pending" as const,
  sessionId: "provider-session",
  createdAt: Date.now(),
  presentation: {
    title: "Question",
    questions: [
      {
        id: "q1",
        prompt: "Which direction should the follow-up take?",
        required: true,
        multiple: false,
        secret: false,
        allowFreeText: false,
        options: labels.map((label, index) => ({
          id: `option-${index + 1}`,
          label,
          providerValue: label,
        })),
      },
    ],
  },
});

describe("ask scenario", () => {
  test("every platform says whether its coordinator can ask; Pi and Cursor cannot", () => {
    const skipped = AGENT_PLATFORMS.filter((platform) => !askApplies(platform).applies);
    expect(skipped.toSorted()).toEqual(["cursor", "pi"]);
  });

  test("the prompt names both options, the provider's question tool and the report line", () => {
    const prompt = askScenarioPrompt(probe);
    expect(prompt).toContain(first);
    expect(prompt).toContain(chosen);
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain(`name "ask-${token}"`);
    expect(prompt).toContain(ASK_REPORT_MARKER);
    expect(askScenarioPrompt({ platform: "codex", token })).toContain("request_user_input");
  });

  test("the harness answers only the one question offering both labels, with the second", () => {
    expect(askAnswer(probe, question([first, chosen]))).toEqual([
      { questionId: "q1", optionIds: ["option-2"] },
    ]);
    // Case and padding are not the model's choice to keep.
    expect(askAnswer(probe, question([` ${first.toUpperCase()}`, chosen.toUpperCase()]))).toEqual([
      { questionId: "q1", optionIds: ["option-2"] },
    ]);
    expect(askAnswer(probe, question(["Option A", "Option B"]))).toBeUndefined();
    expect(askAnswer(probe, question([chosen]))).toBeUndefined();
    expect(askAnswer(probe, { ...question([first, chosen]), kind: "permission" })).toBeUndefined();
  });

  test("the report: the last marker wins", () => {
    expect(
      parseAskReport(
        `${ASK_REPORT_MARKER} {"choice":"x"}\n${ASK_REPORT_MARKER} {"choice":" ${chosen} "}`,
      ),
    ).toEqual({ choice: chosen });
    expect(parseAskReport("no line")).toEqual({
      error: `the turn has no ${ASK_REPORT_MARKER} line`,
    });
    expect(parseAskReport(`${ASK_REPORT_MARKER} {nope}`)).toEqual({
      error: expect.stringContaining("not valid JSON"),
    });
  });

  test("its budget covers the turn, the worker's wake and the settle", () => {
    const budgets = coordinatorLiveBudgets({});
    expect(budgets.waits.ask).toBe(budgets.step * 3);
  });
});

// ---------------------------------------------------------------------------
// The orchestration over a scripted command transport

type Script = {
  /** The question arrives before launch_environment has run. */
  askBeforeLaunch?: boolean;
  /** The coordinator ends its turn after the launch and asks in a later one. */
  splitTurns?: boolean;
  /** The option labels the model used. */
  labels?: string[];
  /** The coordinator never asks. */
  noQuestion?: boolean;
  /** What it reports. */
  reported?: string;
  /** An approval escapes too. */
  approval?: boolean;
};

const tool = (toolName: string, toolOutput = ""): CoordinatorTranscriptMessage => ({
  role: "assistant",
  parts: [{ toolName, toolArgs: {}, toolOutput, toolState: "completed" }],
});

function fixture(script: Script = {}) {
  const now = () => new Date().toISOString();
  const environments: Array<{ id: string; name: string }> = [];
  const messages: CoordinatorTranscriptMessage[] = [];
  const delegations: Array<Record<string, unknown>> = [];
  const resolutions: Array<Record<string, unknown>> = [];
  let interactions: Array<Record<string, unknown>> = [];
  let phase = "idle";
  let step = 0;
  let workerPhase = "working";
  let workerReads = 0;
  let wakeReads = 0;

  const launch = () => {
    environments.push({ id: "worker", name: `ask-${token}` });
    delegations.push({ requestedAt: now(), workerTabId: "startup-agent", state: "running" });
    messages.push(tool("mcp__orkestrator__get_launch_options", "{}"));
    messages.push(
      tool(
        "mcp__orkestrator__launch_environment",
        JSON.stringify({ environmentId: "worker", delivery: "async" }),
      ),
    );
  };
  const ask = () => {
    if (script.noQuestion) return;
    interactions = [question(script.labels ?? [first, chosen])];
    if (script.approval) {
      interactions.push({
        id: "approval-1",
        kind: "command-approval",
        state: "pending",
        sessionId: "provider-session",
        createdAt: Date.now(),
      });
    }
  };
  /** The coordinator's turn, one projection read at a time. */
  const advance = () => {
    if (phase === "idle" && step === 0) return;
    step += 1;
    if (script.askBeforeLaunch) {
      if (step === 1) ask();
      if (step === 3) launch();
    } else if (script.splitTurns) {
      if (step === 1) launch();
      if (step === 2) phase = "idle";
      if (step === 4) {
        phase = "working";
        ask();
      }
    } else if (step === 1) {
      launch();
      ask();
    }
    const unanswered = interactions.some((item) => item.state === "pending");
    if (!unanswered && step >= 5 && phase !== "idle") {
      messages.push({
        role: "assistant",
        content: `Asked.\n${ASK_REPORT_MARKER} ${JSON.stringify({ choice: script.reported ?? chosen })}`,
      });
      phase = "idle";
    }
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
      case "dispatch_native_agent_intent":
        messages.push({ role: "user", content: "harness prompt" });
        phase = "working";
        step = 0;
        break;
      case "resolve_native_agent_interaction":
        resolutions.push(args.resolution as Record<string, unknown>);
        interactions = interactions.map((item) =>
          item.id === args.interactionId ? { ...item, state: "resolved" } : item,
        );
        break;
      case "get_agent_mail_mailbox":
        value = { messages: [] };
        break;
      case "get_native_agent_tool_details":
        value = null;
        break;
      case "get_native_agent_projection":
        if (args.environmentId === "coordinator") {
          advance();
          if (phase === "idle" && wakeReads > 0) {
            wakeReads -= 1;
          }
          value = {
            turn: { phase: wakeReads > 0 ? "working" : phase },
            messages: [...messages],
            interactions: interactions.map((item) => ({ ...item })),
          };
        } else {
          workerReads += 1;
          if (workerReads === 4 && delegations[0]) {
            workerPhase = "idle";
            delegations[0] = {
              ...delegations[0],
              state: "completed",
              completedAt: now(),
              wokenAt: now(),
            };
            wakeReads = 2;
          }
          value = { turn: { phase: workerPhase }, messages: [] };
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
    identity: { environmentId: "coordinator", agent: "claude", logicalSessionKey: "coord" },
    conversation: { id: "conversation", tabId: "coord-tab" },
    projectId: "project",
  };
  const summary: CoordinatorLivePlatformSummary = {
    version: 1,
    platform: "claude",
    verdict: "passed",
    startedAt: "test",
  };
  return { coordinator, summary, resolutions };
}

async function run(script: Script = {}) {
  const { coordinator, summary, resolutions } = fixture(script);
  const cleanup: Array<() => Promise<unknown>> = [];
  const previous = process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
  process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = "300";
  try {
    const result = await runAskScenario({
      coordinator,
      summary,
      cleanup,
      token,
      pollIntervalMs: 1,
    });
    return { ...result, resolutions, summary };
  } finally {
    if (previous === undefined)
      delete process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS;
    else process.env.ORKESTRATOR_AGENT_TEST_COORDINATOR_STEP_TIMEOUT_MS = previous;
    await runCoordinatorCleanup(cleanup, summary);
  }
}

const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

describe("ask scenario orchestration", () => {
  test("a launch, then a question in the same turn, answered from the card and reported, qualifies", async () => {
    const { checks, resolutions, observed, summary } = await run();
    expect(checks.filter((item) => !item.passed)).toEqual([]);
    expect(observed).toMatchObject({ launches: 1, questionsAnswered: 1 });
    // The card was answered with the second option, as a person would.
    expect(resolutions).toEqual([
      expect.objectContaining({
        action: "answer",
        interactionId: "question-1",
        answer: expect.objectContaining({
          interactionId: "question-1",
          answers: [{ questionId: "q1", optionIds: ["option-2"] }],
        }),
      }),
    ]);
    // An answered question is not an escaped one.
    expect(summary.escapedInteractions).toBeUndefined();
  });

  test("a question asked before the worker was launched fails", async () => {
    const { checks } = await run({ askBeforeLaunch: true });
    expect(failed(checks)).toEqual(["asked-after-launch"]);
  });

  test("a question asked in a later turn than the launch fails", async () => {
    const { checks } = await run({ splitTurns: true });
    expect(failed(checks)).toEqual(["asked-in-the-same-turn"]);
  });

  test("a coordinator that reports the other option fails", async () => {
    const { checks } = await run({ reported: first });
    expect(failed(checks)).toEqual(["answer-reported"]);
  });

  test("renamed options are left for the turn to fail on, and recorded as escaped", async () => {
    const { checks, resolutions, summary } = await run({ labels: ["Left", "Right"] });
    expect(failed(checks)).toEqual(
      expect.arrayContaining(["asked-once", "no-escaped-interactions"]),
    );
    expect(resolutions).toEqual([expect.objectContaining({ action: "cancel" })]);
    expect(summary.escapedInteractions).toEqual(["question"]);
  });

  test("a coordinator that never asks fails", async () => {
    const { checks } = await run({ noQuestion: true });
    expect(failed(checks)).toEqual(
      expect.arrayContaining(["asked-once", "asked-after-launch", "asked-in-the-same-turn"]),
    );
  });

  test("an approval that reaches the harness is denied and fails the case", async () => {
    const { checks, resolutions } = await run({ approval: true });
    expect(failed(checks)).toEqual(["no-escaped-interactions"]);
    expect(resolutions).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "deny" })]),
    );
  });
});
