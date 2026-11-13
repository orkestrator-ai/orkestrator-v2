import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  escapedInteractionFailures,
  type AnsweredQuestion,
  type CoordinatorLiveCheck,
  type CoordinatorTurnProjection,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import { orkestratorToolCalls } from "./coordinator-live-delegation.js";

/**
 * The live coordinator suite's `ask` scenario (to-do 6940 task 1, retired; see the
 * `ask` case under "Live coordinator suite" in `docs/development/agent-testing.md`).
 *
 * One coordinator turn launches a worker and then, in the same turn and
 * without waiting for it, asks the user one question with two named options.
 * The harness answers the card with the second option, so a model that picks
 * the first option or the one it would recommend is caught, and the
 * coordinator must report the answer it was given. What it proves is the
 * combination the fake-provider check (`e2e/InteractionPolicyChecks.spec.ts`)
 * cannot: a real model choosing to ask while its turn already holds a
 * delegation, and the provider's own question flow parking a card that a
 * person answers.
 *
 * Shared by the Node Playwright spec and the Bun tests, so nothing here may
 * use Bun APIs.
 */

export const ASK_REPORT_MARKER = "COORDINATOR_LIVE_ASK";

export interface AskProbe {
  platform: AgentPlatform;
  /** Random hex; the worker's name and both option labels carry it. */
  token: string;
}

/**
 * How a platform's coordinator asks the user. A `Record` over every platform,
 * so a new one fails the typecheck until someone says whether it can ask.
 */
export type AskQuestionSupport = { tool: string } | { unavailable: string };

export const ASK_QUESTION_SUPPORT: Readonly<Record<AgentPlatform, AskQuestionSupport>> =
  Object.freeze({
    // `canUseTool` parks AskUserQuestion before the coordinator's deny policy.
    claude: { tool: "AskUserQuestion" },
    // `item/tool/requestUserInput`, which the bridge turns on
    // (`default_mode_request_user_input`) for every policy but a pipeline's.
    codex: { tool: "request_user_input" },
    // OpenCode 2's own question tool (`opencode2/interactions.ts`).
    opencode: { tool: "question" },
    // ACP's question request (`acp-session.ts`).
    grok: { tool: "question" },
    pi: { unavailable: "Pi raises no question interactions, so its coordinator cannot ask" },
    cursor: {
      unavailable: "the Cursor SDK bridge raises no interactions, so its coordinator cannot ask",
    },
  });

/** Whether the scenario applies, or why it does not. */
export function askApplies(
  platform: AgentPlatform,
): { applies: true } | { applies: false; reason: string } {
  const support = ASK_QUESTION_SUPPORT[platform];
  return "unavailable" in support
    ? { applies: false, reason: support.unavailable }
    : { applies: true };
}

export function askWorkerName(probe: AskProbe): string {
  return `ask-${probe.token}`;
}

/** The two option labels; the harness answers with `chosen`. */
export function askOptions(probe: AskProbe): { first: string; chosen: string } {
  return { first: `north-${probe.token}`, chosen: `south-${probe.token}` };
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's delegate-and-ask conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below.";

export function askScenarioPrompt(probe: AskProbe): string {
  const support = ASK_QUESTION_SUPPORT[probe.platform];
  const tool = "tool" in support ? support.tool : "question";
  const { first, chosen } = askOptions(probe);
  const task = "Reply with the single word ready and end your turn. Send no messages.";
  return [
    HARNESS_PREAMBLE,
    "",
    "1. Call the Orkestrator get_launch_options tool once.",
    `2. Then call the Orkestrator launch_environment tool once with name "${askWorkerName(probe)}", environmentType "local", agent "${probe.platform}", no model or reasoning fields, the baseBranch and baseCommit from coordinatorBase, a fresh requestId, and this exact prompt: ${JSON.stringify(task)}.`,
    `3. Then, in this same turn and without waiting for the worker, ask the user exactly one question with your own ${tool} tool (the tool that shows the user a question card): "Which direction should the follow-up take?", single choice, no free text, with exactly two options labelled exactly ${first} and ${chosen}. Do not answer it yourself and do not ask anything else.`,
    "4. When the user has answered, end this turn with exactly one line in this format, and nothing after it:",
    `${ASK_REPORT_MARKER} {"choice":"<the exact label of the option the user chose>"}`,
    "Never wait, sleep, poll, read messages or check message status: you are woken when the worker finishes.",
    "",
    "When you are woken by that worker, reply with one short line and end that turn without calling any tools.",
  ].join("\n");
}

type Interaction = NonNullable<CoordinatorTurnProjection["interactions"]>[number];

/**
 * The answer the harness gives: the option labelled `chosen` of the one
 * question that offers both labels. Anything else (two questions, a free-text
 * prompt, renamed options) is left unanswered, so it escapes and fails.
 */
export function askAnswer(
  probe: AskProbe,
  request: Interaction,
): Array<{ questionId: string; optionIds: string[] }> | undefined {
  if (request.kind !== "question") return undefined;
  const questions = request.presentation?.questions ?? [];
  if (questions.length !== 1) return undefined;
  const question = questions[0]!;
  const { first, chosen } = askOptions(probe);
  const label = (value: string) => value.trim().toLowerCase();
  const find = (wanted: string) =>
    question.options.find((option) => label(option.label) === label(wanted));
  const pick = find(chosen);
  if (!pick || !find(first) || question.multiple) return undefined;
  return [{ questionId: question.id, optionIds: [pick.id] }];
}

/** The last report line in the coordinator's text, or why there is none. */
export function parseAskReport(text: string): { choice: string } | { error: string } {
  const raw = [...text.matchAll(new RegExp(`${ASK_REPORT_MARKER}\\s*(\\{[^\\n]*\\})`, "g"))].at(
    -1,
  )?.[1];
  if (!raw) return { error: `the turn has no ${ASK_REPORT_MARKER} line` };
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const choice = (value as Record<string, unknown>).choice;
      if (typeof choice === "string") return { choice: choice.trim() };
    }
    return { error: `the ${ASK_REPORT_MARKER} line has no choice` };
  } catch {
    return { error: `the ${ASK_REPORT_MARKER} line is not valid JSON` };
  }
}

/** What the orchestration saw when the question first reached the harness. */
export interface AskQuestionMoment {
  /** The worker's delegation was in the coordinator's snapshot of that read. */
  delegationOpen: boolean;
  /** The coordinator had gone idle between the dispatch and that read. */
  idleBefore: boolean;
}

export function evaluateAskScenario(input: {
  probe: AskProbe;
  workerEnvironmentId?: string;
  /** Every tool row of the delegating turn. */
  calls: readonly ReadOnlyToolCall[];
  launchResults: readonly string[];
  answered: readonly AnsweredQuestion[];
  moment?: AskQuestionMoment;
  /** The coordinator's text from the delegating turn on. */
  text: string;
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
}): { checks: CoordinatorLiveCheck[]; observed: Record<string, number> } {
  const launches = orkestratorToolCalls(input.calls, "launch_environment");
  const asyncLaunch = input.launchResults.some((output) => /"delivery"\s*:\s*"async"/.test(output));
  const report = parseAskReport(input.text);
  const { chosen } = askOptions(input.probe);
  const escaped = escapedInteractionFailures([
    ...input.escapedInteractions,
    ...input.workerInteractions,
  ]);
  const checks: CoordinatorLiveCheck[] = [
    {
      name: "one-launch",
      passed: launches.length === 1 && input.workerEnvironmentId !== undefined,
      ...(launches.length !== 1 || input.workerEnvironmentId === undefined
        ? {
            detail: `${launches.length} launch_environment calls; worker ${input.workerEnvironmentId ? "found" : "not found"}`,
          }
        : {}),
    },
    {
      name: "launch-async",
      passed: asyncLaunch,
      ...(asyncLaunch ? {} : { detail: 'no launch_environment result says delivery "async"' }),
    },
    {
      name: "asked-once",
      passed: input.answered.length === 1,
      ...(input.answered.length !== 1
        ? { detail: `${input.answered.length} questions answered by the harness` }
        : {}),
    },
    {
      name: "asked-after-launch",
      passed: input.moment?.delegationOpen === true,
      ...(input.moment?.delegationOpen === true
        ? {}
        : {
            detail: input.moment
              ? "the question reached the harness before the worker's delegation was open"
              : "no question reached the harness",
          }),
    },
    {
      name: "asked-in-the-same-turn",
      passed: input.moment !== undefined && !input.moment.idleBefore,
      ...(input.moment?.idleBefore
        ? { detail: "the coordinator went idle between the launch and the question" }
        : {}),
    },
    {
      name: "answer-reported",
      passed: !("error" in report) && report.choice.toLowerCase() === chosen.toLowerCase(),
      ...("error" in report
        ? { detail: report.error }
        : report.choice.toLowerCase() !== chosen.toLowerCase()
          ? { detail: "the reported choice is not the option the harness chose" }
          : {}),
    },
    {
      name: "no-escaped-interactions",
      passed: escaped.length === 0,
      ...(escaped.length > 0 ? { detail: escaped.join("; ") } : {}),
    },
  ];
  return {
    checks,
    observed: {
      launches: launches.length,
      questionsAnswered: input.answered.length,
      answerDelayMs: input.answered[0]
        ? Math.max(0, input.answered[0].answeredAt - input.answered[0].createdAt)
        : 0,
    },
  };
}
