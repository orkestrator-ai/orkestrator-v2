import { NATIVE_AGENT_GOAL_LIMITS } from "@orkestrator/protocol/native-agent-goal";
import type { NativeAgentGoalView } from "@orkestrator/protocol/native-agent-goal";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  PublicGoalMutationResult,
  PublicSessionGoal,
} from "@orkestrator/protocol/public-api-resources";
import { classifyGoalForWait } from "@orkestrator/protocol/public-api-wait";
import { CliError } from "../errors.js";
import { keyValues, receiptLines } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { ClientSession } from "../session.js";
import type {
  CommandContext,
  CommandOutcome,
  CommandSpec,
  OptionSpec,
  ParsedCommand,
} from "../spec.js";
import { observe, ObservationStopped, signalName } from "../wait.js";
import {
  DEFAULT_WAIT_MS,
  receiptFailure,
  REQUEST_ID_OPTION,
  submit,
  submitForWait,
  TIMEOUT_OPTION,
  waitForOperation,
} from "./common.js";
import { validateWaitOptions } from "./session.js";

/**
 * `session goal`: give a tab an objective the backend drives to an end.
 *
 * `--wait` follows `session prompt --wait`, except that the thing observed is
 * the goal rather than one turn, and the exit status says how it ended:
 * `complete` 0, `claimed` 10, `blocked` 11, `limited` 12, `paused` 13, and 14 for
 * a goal cleared or replaced before it ended (`PUBLIC_EXIT`). Only a passing
 * check or verifier exits 0, so a script cannot mistake an unverified claim for
 * a finished job.
 */

const WAIT_OPTIONS: OptionSpec[] = [
  {
    name: "wait",
    kind: "boolean",
    description:
      "Observe the goal until it stops. Exit 0 for complete, 10 claimed, 11 blocked, 12 limited, 13 paused, 14 cleared or replaced.",
  },
  TIMEOUT_OPTION,
  {
    name: "continue-on-interaction",
    kind: "boolean",
    description:
      "While waiting, keep waiting when a turn needs an answer (another client may answer).",
  },
];

const LIMIT_OPTIONS: OptionSpec[] = [
  {
    name: "max-iterations",
    kind: "integer",
    valueName: "N",
    description: `Turns the backend may send, at most ${NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit}.`,
  },
  {
    name: "budget",
    kind: "integer",
    valueName: "TOKENS",
    description: "Tokens the goal may spend; refused where the provider reports no usage.",
  },
];

const LIMIT_FIELDS = { budget: "tokenBudget" } as const;

function limitsInput(options: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(options["max-iterations"] !== undefined
      ? { maxIterations: options["max-iterations"] }
      : {}),
    ...(options.budget !== undefined ? { tokenBudget: options.budget } : {}),
  };
}

function goalLines(read: PublicSessionGoal): string[] {
  const goal = read.goal;
  if (!goal) return ["no goal"];
  return keyValues([
    ["goal", goal.goalId],
    ["status", goal.status],
    ["reason", read.description],
    ["iterations", `${goal.iterations}/${goal.maxIterations}`],
    [
      "tokens",
      goal.tokenBudget !== undefined ? `${goal.tokensUsed ?? 0}/${goal.tokenBudget}` : undefined,
    ],
    ["check", goal.check],
    ["last check", goal.lastCheck ? (goal.lastCheck.passed ? "passed" : "failed") : undefined],
    ["objective", goal.objective],
  ]);
}

/** Content-free: what an error envelope may say about the goal. */
function goalDetails(sessionId: string, goal: NativeAgentGoalView): Record<string, unknown> {
  return {
    sessionId,
    goalId: goal.goalId,
    status: goal.status,
    ...(goal.statusReason ? { statusReason: goal.statusReason } : {}),
    iterations: goal.iterations,
    maxIterations: goal.maxIterations,
  };
}

const STOPPED_MESSAGES = {
  "goal-claimed": "The agent says the goal is done, and nothing verified it",
  "goal-blocked": "The goal is blocked: the agent says it needs a person",
  "goal-limited": "The goal reached its iteration cap or token budget",
  "goal-paused": "The goal is paused",
} as const;

/**
 * Observe one goal until it stops, by reading `session.goal.get`. A deadline or
 * signal stops only the observing: the goal keeps running, and `session goal get
 * --wait` picks it up again.
 */
async function waitForGoal(
  context: CommandContext,
  session: ClientSession,
  sessionId: string,
  goalId: string,
  timeoutMs: number,
  options: { continueOnInteraction: boolean; receipt?: PublicReceipt },
): Promise<PublicSessionGoal> {
  let latest: NativeAgentGoalView | undefined;
  const receiptOption = options.receipt ? { receipt: options.receipt } : {};
  try {
    return await observe<PublicSessionGoal>(
      async () => {
        const read = await session.read<PublicSessionGoal>("session.goal.get", { sessionId });
        const verdict = classifyGoalForWait(read, goalId, {
          continueOnInteraction: options.continueOnInteraction,
        });
        if (verdict.kind === "pending") {
          latest = verdict.goal;
          return { done: false };
        }
        if (verdict.kind === "complete") return { done: true, value: read };
        if (verdict.kind === "interaction") {
          throw new CliError(
            "interaction-required",
            "The goal's turn is waiting for an answer to a pending interaction",
            {
              ...receiptOption,
              details: {
                ...goalDetails(sessionId, verdict.goal),
                pendingInteractionCount: read.pendingInteractionCount,
              },
            },
          );
        }
        if (verdict.kind === "gone") {
          throw new CliError("goal-gone", "The goal was cleared or replaced before it ended", {
            ...receiptOption,
            details: {
              sessionId,
              goalId,
              ...(verdict.goal ? { status: verdict.goal.status } : {}),
            },
          });
        }
        throw new CliError(verdict.code, STOPPED_MESSAGES[verdict.code], {
          ...receiptOption,
          details: goalDetails(sessionId, verdict.goal),
        });
      },
      { timeoutMs, signal: context.signal },
    );
  } catch (error) {
    if (!(error instanceof ObservationStopped)) throw error;
    const details = { sessionId, goalId, ...(latest ? goalDetails(sessionId, latest) : {}) };
    if (error.reason === "signal") {
      throw new CliError(
        "observation-interrupted",
        "Stopped observing the goal; it continues in the backend",
        { ...receiptOption, details: { ...details, signal: signalName(context.signal) } },
      );
    }
    throw new CliError(
      "deadline-exceeded",
      "Timed out observing the goal; it continues in the backend. `session goal get --wait` observes it again",
      { ...receiptOption, details },
    );
  }
}

function waitOutcome(base: CommandOutcome, read: PublicSessionGoal): CommandOutcome {
  return {
    ...base,
    result: read,
    human: goalLines(read),
    ids: read.goal ? [read.goal.goalId] : [],
  };
}

/** A submission that starts the loop: set or resume, then optionally observe it. */
async function runLoopMutation(
  context: CommandContext,
  parsed: ParsedCommand,
  action: "session.goal.set" | "session.goal.resume",
  input: Record<string, unknown>,
): Promise<CommandOutcome> {
  const options = parsed.options;
  const sessionId = parsed.positionals.session as string;
  validateWaitOptions(options);
  if (options.wait !== true) {
    const { session, result, receipt, warnings } = await submit<PublicGoalMutationResult>(
      context,
      action,
      input,
      options,
    );
    return {
      action,
      result,
      receipt,
      warnings,
      connection: session.identity,
      ids: result.goal ? [result.goal.goalId] : [],
      human: result.goal
        ? keyValues([
            ["goal", result.goal.goalId],
            ["status", result.goal.status],
            ["iterations", `${result.goal.iterations}/${result.goal.maxIterations}`],
          ])
        : receipt
          ? receiptLines(receipt)
          : [],
    };
  }
  const budget = (options.timeout as number | undefined) ?? DEFAULT_WAIT_MS;
  const started = Date.now();
  const submitted = await submitForWait<PublicGoalMutationResult>(
    context,
    action,
    input,
    options,
    budget,
  );
  const { session, warnings } = submitted;
  let receipt = submitted.receipt;
  let mutation = submitted.result;
  // A lost response: only the receipt was recovered, and it may still be in flight.
  if (!mutation && receipt) {
    receipt = await waitForOperation(context, session, receipt, budget - (Date.now() - started));
    const failure = receiptFailure(receipt);
    if (failure) throw failure;
    mutation = receipt.result as unknown as PublicGoalMutationResult | undefined;
  }
  const goalId = mutation?.goal?.goalId;
  if (!goalId) throw new CliError("response-invalid", `${action} returned no goal`);
  const read = await waitForGoal(
    context,
    session,
    sessionId,
    goalId,
    Math.max(0, budget - (Date.now() - started)),
    {
      continueOnInteraction: options["continue-on-interaction"] === true,
      ...(receipt ? { receipt } : {}),
    },
  );
  return waitOutcome(
    { action, result: read, receipt, warnings, connection: session.identity },
    read,
  );
}

export const sessionGoalCommands: CommandSpec[] = [
  {
    path: ["session", "goal", "set"],
    action: "session.goal.set",
    summary: "Give a session a goal: the backend sends turns until a check proves it or it stops.",
    description:
      "Pass the objective with --objective, --objective-file or --objective-stdin. Without --check, a done report ends the goal as claimed: nothing verified it, and --wait exits 10. A session holds one goal, and a running goal is refused (exit 8) until it is cleared. A goal never changes the permission mode, so an approval still parks a turn (--wait exits 6).",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "objective-file",
        kind: "string",
        valueName: "PATH",
        description: "Read the objective from a local file.",
      },
      { name: "objective-stdin", kind: "boolean", description: "Read the objective from stdin." },
      { name: "objective", kind: "string", valueName: "TEXT", description: "Inline objective." },
      {
        name: "check",
        kind: "string",
        valueName: "COMMAND",
        description:
          "One-line shell command run in the workspace on a done report; exit 0 completes the goal.",
      },
      ...LIMIT_OPTIONS,
      ...WAIT_OPTIONS,
      REQUEST_ID_OPTION,
    ],
    inputFields: { ...LIMIT_FIELDS, "objective-file": "objective", "objective-stdin": "objective" },
    idOutput: "goal ID",
    examples: [
      'orkestrator session goal set ses_… --objective "Make the tests pass" --check "bun test" --max-iterations 10 --wait --timeout 2h',
    ],
    async run(context, parsed) {
      const options = parsed.options;
      validateWaitOptions(options);
      const objective = await readTextSource(context.io, {
        file: options["objective-file"],
        stdin: options["objective-stdin"],
        inline: options.objective,
        label: "Objective",
        maxBytes: NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars * 4,
        names: {
          file: "--objective-file",
          stdin: "--objective-stdin",
          inline: "--objective",
        },
        required: true,
      });
      return runLoopMutation(context, parsed, "session.goal.set", {
        sessionId: parsed.positionals.session,
        objective,
        ...(options.check !== undefined ? { check: options.check } : {}),
        ...limitsInput(options),
      });
    },
  },
  {
    path: ["session", "goal", "get"],
    action: "session.goal.get",
    summary: "Show a session's goal: status, iterations, limits and the last check.",
    description:
      "Reads the session record and starts nothing. With no goal the result's goal is null and the exit is 0, unless --wait is given, which exits 14. --wait observes the goal the session holds now, so it picks up a goal after an earlier --wait timed out.",
    positionals: [{ name: "session", required: true }],
    options: [
      {
        name: "check-output",
        kind: "boolean",
        description: "Include the last check's output tail. It is untrusted command output.",
      },
      ...WAIT_OPTIONS,
    ],
    inputFields: { "check-output": "includeCheckOutput" },
    idOutput: "goal ID",
    async run(context, parsed) {
      const options = parsed.options;
      validateWaitOptions(options);
      const sessionId = parsed.positionals.session as string;
      const session = await context.session();
      const first = await session.read<PublicSessionGoal>("session.goal.get", {
        sessionId,
        ...(options["check-output"] === true ? { includeCheckOutput: true } : {}),
      });
      const base = { action: "session.goal.get", connection: session.identity };
      if (options.wait !== true) return waitOutcome({ ...base, result: first }, first);
      const goalId = first.goal?.goalId;
      if (!goalId) {
        throw new CliError("goal-gone", "The session has no goal to wait for", {
          details: { sessionId },
        });
      }
      const read = await waitForGoal(
        context,
        session,
        sessionId,
        goalId,
        (options.timeout as number | undefined) ?? DEFAULT_WAIT_MS,
        { continueOnInteraction: options["continue-on-interaction"] === true },
      );
      return waitOutcome({ ...base, result: read }, read);
    },
  },
  {
    path: ["session", "goal", "pause"],
    action: "session.goal.pause",
    summary: "Pause a running goal; no further turn starts until it is resumed.",
    description:
      "A turn already running finishes. Use `session stop` to stop it too. Refused (exit 8) when no goal is running.",
    positionals: [{ name: "session", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "goal ID",
    run: (context, parsed) => runGoalControl(context, parsed, "session.goal.pause"),
  },
  {
    path: ["session", "goal", "resume"],
    action: "session.goal.resume",
    summary: "Resume a stopped goal, optionally with a higher limit.",
    description:
      "A goal stopped by its limit needs a higher --max-iterations or --budget. An ended goal (claimed, complete) cannot resume; set a new one. Refused with exit 8.",
    positionals: [{ name: "session", required: true }],
    options: [...LIMIT_OPTIONS, ...WAIT_OPTIONS, REQUEST_ID_OPTION],
    inputFields: LIMIT_FIELDS,
    idOutput: "goal ID",
    run: (context, parsed) =>
      runLoopMutation(context, parsed, "session.goal.resume", {
        sessionId: parsed.positionals.session,
        ...limitsInput(parsed.options),
      }),
  },
  {
    path: ["session", "goal", "clear"],
    action: "session.goal.clear",
    summary: "Remove a session's goal, in any status.",
    description:
      "What the agent did stays, and the goal stays readable in the goal history. A session with no goal stays that way and exits 0.",
    positionals: [{ name: "session", required: true }],
    options: [REQUEST_ID_OPTION],
    idOutput: "goal ID",
    run: (context, parsed) => runGoalControl(context, parsed, "session.goal.clear"),
  },
];

async function runGoalControl(
  context: CommandContext,
  parsed: ParsedCommand,
  action: "session.goal.pause" | "session.goal.clear",
): Promise<CommandOutcome> {
  const { session, result, receipt, warnings } = await submit<PublicGoalMutationResult>(
    context,
    action,
    { sessionId: parsed.positionals.session },
    parsed.options,
  );
  return {
    action,
    result,
    receipt,
    warnings,
    connection: session.identity,
    ids: result.goal ? [result.goal.goalId] : [],
    human:
      action === "session.goal.clear"
        ? [result.cleared ? "cleared" : "no goal"]
        : [
            `paused${result.goal ? ` at ${result.goal.iterations}/${result.goal.maxIterations}` : ""}`,
          ],
  };
}
