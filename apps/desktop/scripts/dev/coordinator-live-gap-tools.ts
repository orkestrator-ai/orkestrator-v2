import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  escapedInteractionFailures,
  type CoordinatorLiveCheck,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import {
  orkestratorToolCalls,
  type DelegationMailMessage,
  type DelegationRecord,
} from "./coordinator-live-delegation.js";

/**
 * The `gap-tools` scenario (to-do 1021 (retired) task 1): one worker, and every
 * coordinator tool from the gap review called once against it, in the order
 * a coordinator would use them.
 *
 * 1. Launch a worker whose one shell command commits one line of a file and
 *    leaves a second line uncommitted.
 * 2. `get_worker_changes` with `diffScope: "split"` (each line on its own
 *    side), then `fork_worker` with no prompt (a new worker from the
 *    worker's last commit, no agent turn).
 * 3. `send_prompt_to_tab` gives the worker a long turn; then
 *    `stop_worker_turn` stops it, and the coordinator is woken once, told it
 *    stopped the turn itself.
 * 4. `list_worker_commands`, then `run_worker_command` runs `/compact`, a
 *    command that answers without an agent turn and opens no delegation.
 * 5. `create_schedule` (a self-timer hours away), then `pause_schedule`,
 *    `update_schedule`, `resume_schedule` and `cancel_schedule`.
 * 6. `resolve_conflicts` and `answer_worker_question` on a worker with no
 *    pull request and no question: both must refuse and change nothing.
 *    Conflicts and real questions need GitHub and a question-capable
 *    provider, which the manual-test checklist (7568) covers.
 *
 * Every tool step in a prompt is one line in a fixed form,
 * `N. Call the Orkestrator <tool> tool exactly once with these arguments:
 * <json>`, so a real model can follow it and the loopback fake model
 * (`e2e/agent-testing/coordinator-gap-tools-fake-model-script.ts`) can replay
 * it. A string value `<tool.field.path>` means that field of the named
 * tool's result earlier in the same turn. Pass `nodeId` to run every worker
 * tool against a worker on a connected node (to-do 1021 (retired) task 4).
 *
 * This module holds the prompts and the verdict; nothing here may use Bun
 * APIs.
 */

export interface GapToolsProbe {
  platform: AgentPlatform;
  /** Random hex; the worker's name, file and request IDs carry it. */
  token: string;
  /** The coordinator's project. */
  projectId: string;
  /** A connected node the worker runs on; absent for this node. */
  nodeId?: string;
}

export interface GapStep {
  tool: string;
  args: Record<string, unknown>;
}

/** The tools this scenario exists to qualify, each called exactly once. */
export const GAP_TOOLS = [
  "get_worker_changes",
  "fork_worker",
  "stop_worker_turn",
  "list_worker_commands",
  "run_worker_command",
  "pause_schedule",
  "update_schedule",
  "resume_schedule",
  "resolve_conflicts",
  "answer_worker_question",
] as const;
export type GapTool = (typeof GAP_TOOLS)[number];

export const GAP_WORKER_TAB = "startup-agent";
/** Session action that answers without an agent turn on every native platform. */
export const GAP_COMMAND = "/compact";
/** What the worker's shell command marks; the fake model reads the command after it. */
export const GAP_SHELL_MARKER = "Run exactly this one shell command in the workspace";
/** What makes the worker's second turn long; the fake model parks on it. */
export const GAP_LONG_TURN_MARKER = "sleep 900";

const STEP =
  /^\d+\. Call the Orkestrator ([a-z_]{1,80}) tool exactly once with these arguments: (\{.*\})$/;
const PLACEHOLDER = /^<([a-z_]{1,80})\.([A-Za-z0-9_.]{1,200})>$/;

const HARNESS_PREAMBLE =
  "This is Orkestrator's coordinator gap-tools conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";
const STEP_RULES =
  "Make exactly the numbered calls below, in order, each once, with exactly the arguments given. A string value written <tool.field> means that field of the named tool's result earlier in this turn: put the value itself there. If a call is refused, do not retry it or work around it; go on to the next step.";
const WAKE_RULE =
  "When you are woken by a worker or about one, reply with one short line and end that turn without calling any tools.";

export function gapWorkerName(probe: GapToolsProbe): string {
  return `gap-${probe.token}`;
}

export function gapFileName(probe: GapToolsProbe): string {
  return `gap-${probe.token}.txt`;
}

const COMMITTED_LINE = (probe: GapToolsProbe) => `committed-${probe.token}`;
const UNCOMMITTED_LINE = (probe: GapToolsProbe) => `uncommitted-${probe.token}`;

/** The worker's one command: a commit with one line, then a second line left uncommitted. */
export function gapShellCommand(probe: GapToolsProbe): string {
  const file = gapFileName(probe);
  return [
    `printf '%s\\n' ${COMMITTED_LINE(probe)} > ${file}`,
    `git add ${file}`,
    `git -c user.email=qa@example.com -c user.name=QA commit -q -m 'gap-tools ${probe.token}'`,
    `printf '%s\\n' ${UNCOMMITTED_LINE(probe)} >> ${file}`,
  ].join(" && ");
}

export function gapWorkerTask(probe: GapToolsProbe): string {
  return `${GAP_SHELL_MARKER} and nothing else, then reply with the single word ready and end your turn. Send no messages. The command: ${gapShellCommand(probe)}`;
}

export function gapLongTask(): string {
  return `Run the shell command ${GAP_LONG_TURN_MARKER} and wait for it to finish, then reply with the single word done. Send no messages.`;
}

function node(probe: GapToolsProbe): Record<string, string> {
  return probe.nodeId ? { nodeId: probe.nodeId } : {};
}

function requestId(probe: GapToolsProbe, step: string): string {
  return `gap-${probe.token}-${step}`;
}

export function gapStepLine(index: number, step: GapStep): string {
  return `${index}. Call the Orkestrator ${step.tool} tool exactly once with these arguments: ${JSON.stringify(step.args)}`;
}

/** One harness turn: the numbered steps, then end the turn. */
export function gapTurnPrompt(steps: readonly GapStep[]): string {
  return [
    HARNESS_PREAMBLE,
    STEP_RULES,
    "",
    ...steps.map((step, index) => gapStepLine(index + 1, step)),
    `${steps.length + 1}. Then end this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.`,
    "",
    WAKE_RULE,
  ].join("\n");
}

/** The steps of each turn, in order. Worker-scoped steps need the worker's ID. */
export const gapSteps = {
  launch(probe: GapToolsProbe): GapStep[] {
    return [
      { tool: "get_launch_options", args: { projectId: probe.projectId, ...node(probe) } },
      {
        tool: "launch_environment",
        args: {
          requestId: requestId(probe, "launch"),
          projectId: probe.projectId,
          environmentType: "local",
          name: gapWorkerName(probe),
          agent: probe.platform,
          baseBranch: "<get_launch_options.coordinatorBase.baseBranch>",
          baseCommit: "<get_launch_options.coordinatorBase.baseCommit>",
          prompt: gapWorkerTask(probe),
          ...node(probe),
        },
      },
    ];
  },
  changes(probe: GapToolsProbe, worker: string): GapStep[] {
    return [
      {
        tool: "get_worker_changes",
        args: { environmentId: worker, diffScope: "split", ...node(probe) },
      },
      {
        tool: "fork_worker",
        args: { requestId: requestId(probe, "fork"), environmentId: worker, ...node(probe) },
      },
    ];
  },
  longTurn(probe: GapToolsProbe, worker: string): GapStep[] {
    return [
      {
        tool: "send_prompt_to_tab",
        args: {
          requestId: requestId(probe, "long-turn"),
          environmentId: worker,
          tabId: GAP_WORKER_TAB,
          prompt: gapLongTask(),
          ...node(probe),
        },
      },
    ];
  },
  stop(probe: GapToolsProbe, worker: string): GapStep[] {
    return [
      {
        tool: "stop_worker_turn",
        args: {
          requestId: requestId(probe, "stop"),
          environmentId: worker,
          tabId: GAP_WORKER_TAB,
          ...node(probe),
        },
      },
    ];
  },
  commands(probe: GapToolsProbe, worker: string): GapStep[] {
    return [
      {
        tool: "list_worker_commands",
        args: { environmentId: worker, tabId: GAP_WORKER_TAB, ...node(probe) },
      },
      {
        tool: "run_worker_command",
        args: {
          requestId: requestId(probe, "command"),
          environmentId: worker,
          tabId: GAP_WORKER_TAB,
          command: GAP_COMMAND,
          ...node(probe),
        },
      },
    ];
  },
  schedules(probe: GapToolsProbe): GapStep[] {
    const scheduleId = "<create_schedule.scheduleId>";
    return [
      {
        tool: "create_schedule",
        args: {
          requestId: requestId(probe, "schedule"),
          at: "+6h",
          action: {
            type: "remind_me",
            body: `Gap-tools harness reminder ${probe.token}: cancel this if it is still here.`,
          },
        },
      },
      { tool: "pause_schedule", args: { scheduleId } },
      { tool: "update_schedule", args: { scheduleId, at: "+7h" } },
      { tool: "resume_schedule", args: { scheduleId } },
      { tool: "cancel_schedule", args: { scheduleId } },
    ];
  },
  refusals(probe: GapToolsProbe, worker: string): GapStep[] {
    return [
      {
        tool: "resolve_conflicts",
        args: { requestId: requestId(probe, "resolve"), environmentId: worker, ...node(probe) },
      },
      {
        tool: "answer_worker_question",
        args: {
          requestId: requestId(probe, "answer"),
          environmentId: worker,
          tabId: GAP_WORKER_TAB,
          interactionId: `gap-${probe.token}-no-such-question`,
          answers: [{ questionId: "q1", freeText: "yes" }],
          reason: "Harness check: the worker has no question, so this must be refused.",
          ...node(probe),
        },
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Prompt parsing (the fake model's half)

/** The numbered tool steps of a harness prompt, in order. */
export function parseGapSteps(prompt: string): GapStep[] {
  const steps: GapStep[] = [];
  for (const line of prompt.split("\n")) {
    const match = STEP.exec(line.trim());
    if (!match) continue;
    try {
      const args = JSON.parse(match[2]!) as unknown;
      if (args && typeof args === "object" && !Array.isArray(args))
        steps.push({ tool: match[1]!, args: args as Record<string, unknown> });
    } catch {
      // A line that is not one of ours.
    }
  }
  return steps;
}

function field(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The step's arguments with each `<tool.field>` replaced from that tool's
 * result earlier in the turn. Undefined when a placeholder cannot be filled.
 */
export function fillGapPlaceholders(
  args: Record<string, unknown>,
  results: ReadonlyMap<string, unknown>,
): Record<string, unknown> | undefined {
  let missing = false;
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const match = PLACEHOLDER.exec(value);
      if (!match) return value;
      const resolved = field(results.get(match[1]!), match[2]!);
      if (typeof resolved !== "string" && typeof resolved !== "number") missing = true;
      return resolved;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  const filled = fill(args) as Record<string, unknown>;
  return missing ? undefined : filled;
}

// ---------------------------------------------------------------------------
// Tool output

/** The first JSON object in a tool result, or undefined. */
export function gapResultJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What `get_worker_changes` with `diffScope: "split"` says about the probe's file. */
export function changesOutcome(
  output: string | undefined,
  probe: GapToolsProbe,
): {
  listed: boolean;
  committedSide: boolean;
  uncommittedSide: boolean;
  unsupported: boolean;
} {
  const answer = output ? gapResultJson(output) : undefined;
  const file = gapFileName(probe);
  const committed = JSON.stringify(answer?.committedDiffs ?? null);
  const uncommitted = JSON.stringify(answer?.uncommittedDiffs ?? null);
  const plus = (line: string) => `+${line}`;
  return {
    listed:
      JSON.stringify(answer?.committed ?? null).includes(file) &&
      JSON.stringify(answer?.uncommitted ?? null).includes(file),
    committedSide:
      committed.includes(plus(COMMITTED_LINE(probe))) &&
      !committed.includes(plus(UNCOMMITTED_LINE(probe))),
    uncommittedSide:
      uncommitted.includes(plus(UNCOMMITTED_LINE(probe))) &&
      !uncommitted.includes(plus(COMMITTED_LINE(probe))),
    unsupported: answer?.diffScopeUnsupported !== undefined,
  };
}

/** Every environment ID a result names other than `except`. */
export function namedEnvironments(output: string | undefined, except: string): string[] {
  const ids = [...(output ?? "").matchAll(/"environmentId"\s*:\s*"([^"]{1,200})"/g)].map(
    (match) => match[1]!,
  );
  return [...new Set(ids)].filter((id) => id !== except);
}

/** A schedule edit's resulting state, or null. */
export function scheduleState(output: string | undefined): string | null {
  const answer = output ? gapResultJson(output) : undefined;
  return typeof answer?.state === "string" ? answer.state : null;
}

// ---------------------------------------------------------------------------
// Verdict

export interface GapToolsInput {
  probe: GapToolsProbe;
  coordinatorEnvironmentId: string;
  workerEnvironmentId?: string;
  /** Every Orkestrator tool call the coordinator made in the scenario. */
  calls: readonly ReadOnlyToolCall[];
  /** Each tool's outputs, in call order. Read for the verdict, never recorded. */
  outputs: Partial<Record<string, string[]>>;
  /** The coordinator base commit the worker started from. */
  baseCommit?: string;
  /** The fork exists as an environment after the fork turn. */
  forkExists: boolean;
  /** The worker's turn phase once the stop settled. */
  phaseAfterStop?: string;
  /** The worker's turn phase after the command ran and settled. */
  phaseAfterCommand?: string;
  /** The delegation `send_prompt_to_tab` opened, after the stop settled. */
  stoppedDelegation?: DelegationRecord;
  /** Delegations opened after the stop (run_worker_command must open none). */
  delegationsAfterStop: number;
  /** Final mail, with bodies. */
  mail: readonly DelegationMailMessage[];
  /** The scenario's schedule is gone after cancel_schedule. */
  scheduleGone: boolean;
  /** Node action requests the scenario created (answer_worker_question must make none). */
  actionRequestsCreated: number;
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function refused(call: ReadOnlyToolCall | undefined, output: string | undefined): boolean {
  if (call?.state === "refused") return true;
  if (!output) return false;
  return /"isError"\s*:\s*true/.test(output) || /^\s*(Error|MCP error)\b/i.test(output);
}

const MAX_REASON_CHARS = 200;

/**
 * Why a call was refused, from the product's own error text, on one line and
 * bounded; the fixture worker's names are all it can mention. Undefined when
 * the output is not a refusal.
 */
export function refusalReason(output: string | undefined): string | undefined {
  if (!output || !refused(undefined, output)) return undefined;
  const error = gapResultJson(output)?.error;
  const text = typeof error === "string" ? error : output;
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS) || "no reason given";
}

/** The detail of a call that should have succeeded: its refusal, if it was one. */
function unexpected(output: string | undefined): string {
  const reason = refusalReason(output);
  return reason ? `; refused: ${reason}` : "";
}

export function evaluateGapToolsScenario(input: GapToolsInput): CoordinatorLiveCheck[] {
  const { probe } = input;
  const worker = input.workerEnvironmentId;
  const one = (tool: string) => input.outputs[tool]?.[0];
  const callOf = (tool: string) => orkestratorToolCalls(input.calls, tool)[0];
  const checks: CoordinatorLiveCheck[] = [check("worker-launched", worker !== undefined)];

  const counts = GAP_TOOLS.map(
    (tool) => [tool, orkestratorToolCalls(input.calls, tool).length] as const,
  );
  const wrong = counts.filter(([, count]) => count !== 1);
  checks.push(
    check(
      "each-gap-tool-called-once",
      wrong.length === 0,
      wrong.map(([tool, count]) => `${tool} ${count}`).join(", "),
    ),
  );

  const changes = changesOutcome(one("get_worker_changes"), probe);
  checks.push(
    check(
      "changes-split",
      changes.listed && changes.committedSide && changes.uncommittedSide && !changes.unsupported,
      `listed ${changes.listed}, committed side ${changes.committedSide}, uncommitted side ${changes.uncommittedSide}${changes.unsupported ? ", diffScope unsupported" : ""}${unexpected(one("get_worker_changes"))}`,
    ),
  );

  const forkOutput = one("fork_worker");
  const forks = worker ? namedEnvironments(forkOutput, worker) : [];
  const forkBase = /"baseCommit"\s*:\s*"([0-9a-f]{40})"/i.exec(forkOutput ?? "")?.[1];
  checks.push(
    check(
      "fork-from-last-commit",
      forks.length === 1 &&
        input.forkExists &&
        forkBase !== undefined &&
        input.baseCommit !== undefined &&
        forkBase !== input.baseCommit,
      `${forks.length} new environments named, ${input.forkExists ? "exists" : "not found"}, base ${
        forkBase === undefined
          ? "missing"
          : forkBase === input.baseCommit
            ? "is the coordinator base, not the worker's commit"
            : "is the worker's commit"
      }${unexpected(forkOutput)}`,
    ),
  );

  const stop = gapResultJson(one("stop_worker_turn") ?? "");
  const stopNotice = input.mail.filter(
    (message) =>
      message.toEnvironmentId === input.coordinatorEnvironmentId &&
      message.body?.includes("you stopped its turn with stop_worker_turn") === true,
  );
  checks.push(
    check(
      "turn-stopped",
      stop?.stopped === true && input.phaseAfterStop === "idle",
      `stopped ${String(stop?.stopped ?? "missing")}, worker ${input.phaseAfterStop ?? "unread"} after${unexpected(one("stop_worker_turn"))}`,
    ),
    check(
      "stop-wakes-once",
      input.stoppedDelegation?.wokenAt !== undefined &&
        stopNotice.length === 1 &&
        stopNotice[0]!.injectedAt !== undefined,
      `delegation ${input.stoppedDelegation?.state ?? "missing"}${input.stoppedDelegation?.wokenAt ? ", woken" : ", not woken"}; ${stopNotice.length} stop notices`,
    ),
  );

  const listed = one("list_worker_commands") ?? "";
  const ran = gapResultJson(one("run_worker_command") ?? "");
  checks.push(
    check(
      "commands-listed",
      listed.includes("orkestrator:compact"),
      listed.includes("orkestrator:compact")
        ? "/compact listed"
        : listed
          ? `no /compact row${unexpected(listed)}`
          : "no output",
    ),
    check(
      "command-ran-without-a-turn",
      !refused(callOf("run_worker_command"), one("run_worker_command")) &&
        ran?.startsTurn === false &&
        ran?.delegationOpened === false &&
        ran?.outcome !== "rejected" &&
        input.delegationsAfterStop === 0 &&
        input.phaseAfterCommand === "idle",
      `startsTurn ${String(ran?.startsTurn ?? "missing")}, delegation ${String(ran?.delegationOpened ?? "missing")}, outcome ${String(ran?.outcome ?? "missing")}, ${input.delegationsAfterStop} delegations after the stop, worker ${input.phaseAfterCommand ?? "unread"}${unexpected(one("run_worker_command"))}`,
    ),
  );

  const paused = scheduleState(one("pause_schedule"));
  const updated = gapResultJson(one("update_schedule") ?? "");
  const resumed = scheduleState(one("resume_schedule"));
  checks.push(
    check(
      "schedule-edits",
      paused === "paused" &&
        typeof updated?.scheduleId === "string" &&
        !refused(callOf("update_schedule"), one("update_schedule")) &&
        resumed === "active" &&
        input.scheduleGone,
      `paused ${paused ?? "missing"}, updated ${updated?.scheduleId ? "yes" : "no"}, resumed ${resumed ?? "missing"}, ${input.scheduleGone ? "cancelled" : "still there"}${[
        "create_schedule",
        "pause_schedule",
        "update_schedule",
        "resume_schedule",
        "cancel_schedule",
      ]
        .map((tool) =>
          refusalReason(one(tool)) ? `; ${tool} refused: ${refusalReason(one(tool))}` : "",
        )
        .join("")}`,
    ),
  );

  checks.push(
    check(
      "resolve-refused-without-pr",
      refused(callOf("resolve_conflicts"), one("resolve_conflicts")),
      refusalReason(one("resolve_conflicts")) ??
        (callOf("resolve_conflicts") ? "the call was not refused" : "not called"),
    ),
    check(
      "answer-refused-without-question",
      refused(callOf("answer_worker_question"), one("answer_worker_question")) &&
        input.actionRequestsCreated === 0,
      `${input.actionRequestsCreated} approval requests created; ${
        refusalReason(one("answer_worker_question")) ??
        (callOf("answer_worker_question") ? "the call was not refused" : "not called")
      }`,
    ),
  );

  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}
