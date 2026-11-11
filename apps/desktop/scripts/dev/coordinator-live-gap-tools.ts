import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { SESSION_ACTION_SLASH_COMMANDS } from "@orkestrator/protocol/agent-slash-commands";
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
 *    worker's last commit, no agent turn). The harness reads the worker's
 *    HEAD and the fork's checkout from the node that owns them: the fork
 *    must sit on that HEAD, with the committed line and without the
 *    uncommitted one.
 * 3. `send_prompt_to_tab` gives the worker a long turn; then
 *    `stop_worker_turn` stops it, and the coordinator is woken once, told it
 *    stopped the turn itself.
 * 4. `list_worker_commands`, then `run_worker_command` runs `/compact` as the
 *    tab lists it. Orkestrator's own `/compact` (a session action, which Pi
 *    and Codex get) answers without an agent turn and opens no delegation; a
 *    provider's own `/compact` (Claude's SDK ships one, and Orkestrator defers
 *    to it) starts a provider turn, which opens one delegation that must wake
 *    the coordinator once it ends.
 * 5. `create_schedule` (a self-timer hours away), then `pause_schedule`,
 *    `update_schedule` (one hour later, still the same schedule, still
 *    paused), `resume_schedule` and `cancel_schedule`.
 * 6. `resolve_conflicts` and `answer_worker_question` on a worker with no
 *    pull request and no question: both must refuse, with the owning node's
 *    own reason (any other error, a broken route or an unknown tool, fails),
 *    and change nothing.
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
/**
 * The slash command the scenario runs. Orkestrator's session action answers
 * without an agent turn; a platform with its own `/compact` keeps it, and that
 * one starts a provider turn (see `SESSION_ACTION_SLASH_COMMANDS`).
 */
export const GAP_COMMAND = "/compact";
/** The catalogue ID of Orkestrator's own `/compact`, the one that starts no turn. */
export const GAP_SESSION_ACTION_COMMAND_ID = SESSION_ACTION_SLASH_COMMANDS[GAP_COMMAND]!.id;
/**
 * The owning node's own refusals for a worker with no pull request
 * (`coordinator-pr.ts`, `launchWorkerResolve`) and for a question it does not
 * have (`worker-question-relay.ts`). A refusal with any other text is not
 * evidence that the node checked: it could be a broken route or an unknown
 * tool.
 */
export const GAP_NO_PR_REFUSAL = /has no pull request, so there are no conflicts to resolve/;
export const GAP_NO_QUESTION_REFUSAL = /has no pending interaction with that id/;
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

/**
 * When a one-shot schedule result says it fires, in epoch milliseconds: its
 * trigger (`when: "once at <instant>"`), else `nextFireAt`. Undefined when
 * neither parses.
 */
export function scheduleFiresAt(answer: Record<string, unknown> | undefined): number | undefined {
  const when =
    typeof answer?.when === "string" ? /^once at (.+)$/.exec(answer.when)?.[1] : undefined;
  for (const value of [when, answer?.nextFireAt]) {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/** The `/compact` row a `list_worker_commands` result lists, by its name or its session-action ID. */
export function compactRow(
  output: string | undefined,
): { id: string; source?: string } | undefined {
  const rows = gapResultJson(output ?? "")?.commands;
  if (!Array.isArray(rows)) return undefined;
  const name = GAP_COMMAND.replace(/^\/+/, "");
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { id, name: rowName, source } = row as Record<string, unknown>;
    if (typeof id !== "string") continue;
    const named = typeof rowName === "string" && rowName.replace(/^\/+/, "").toLowerCase() === name;
    if (named || id === GAP_SESSION_ACTION_COMMAND_ID)
      return { id, ...(typeof source === "string" ? { source } : {}) };
  }
  return undefined;
}

/**
 * Delegations the command opened on the worker: the newest one after the
 * command, when it is not the one the harness saw before it. An absent
 * `before` means the worker had none, so any delegation after is new.
 */
export function delegationsOpenedSince(
  before: DelegationRecord | undefined,
  after: DelegationRecord | undefined,
): number {
  if (!after) return 0;
  return before !== undefined && after.requestedAt === before.requestedAt ? 0 : 1;
}

/** What the harness read of the fork's checkout on the node that owns it. */
export interface GapForkCheckout {
  head: string;
  /** Paths `git status` reports in the fork. */
  uncommittedPaths: readonly string[];
  /** The probe file's content in the fork, or null when it is not there. */
  content: string | null;
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
  /** The worker's HEAD, read from its own node after its commit. */
  workerHead?: string;
  /** The fork exists as an environment after the fork turn. */
  forkExists: boolean;
  /** The fork's checkout, read from its own node. */
  forkCheckout?: GapForkCheckout;
  /** The worker's turn phase once the stop settled. */
  phaseAfterStop?: string;
  /** The worker's turn phase after the command ran and settled. */
  phaseAfterCommand?: string;
  /** The delegation `send_prompt_to_tab` opened, after the stop settled. */
  stoppedDelegation?: DelegationRecord;
  /**
   * Delegations `run_worker_command` opened ({@link delegationsOpenedSince}):
   * none for a command that starts no turn, one for a provider command.
   */
  delegationsOpenedByCommand: number;
  /** The delegation a provider command opened, once it settled. */
  commandDelegation?: DelegationRecord;
  /** Final mail, with bodies. */
  mail: readonly DelegationMailMessage[];
  /** The scenario's schedule is gone after cancel_schedule. */
  scheduleGone: boolean;
  /** Node action requests the scenario created (answer_worker_question must make none). */
  actionRequestsCreated: number;
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
  /**
   * The worker's own session was read at least once, through the node that
   * owns it. Without that, `workerInteractions` proves nothing.
   */
  workerObserved: boolean;
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

/** A refusal's whole error text (the observer bounds it), or undefined when it is not a refusal. */
function refusalText(output: string | undefined): string | undefined {
  if (!output || !refused(undefined, output)) return undefined;
  const error = gapResultJson(output)?.error;
  return typeof error === "string" ? error : output;
}

/**
 * Why a call was refused, from the product's own error text, on one line and
 * bounded; the fixture worker's names are all it can mention. Undefined when
 * the output is not a refusal.
 */
export function refusalReason(output: string | undefined): string | undefined {
  const text = refusalText(output);
  if (text === undefined) return undefined;
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
  const head = input.workerHead;
  const checkout = input.forkCheckout;
  const file = gapFileName(probe);
  const forkLines = checkout?.content?.split("\n") ?? [];
  const forkProblems = [
    forks.length === 1 ? "" : `${forks.length} new environments named`,
    input.forkExists ? "" : "the fork was not found",
    head === undefined
      ? "the worker's HEAD was not read"
      : head === input.baseCommit
        ? "the worker's HEAD is still the coordinator base"
        : "",
    forkBase === undefined
      ? "no base reported"
      : forkBase === input.baseCommit
        ? "the reported base is the coordinator base, not the worker's commit"
        : forkBase !== head
          ? "the reported base is not the worker's HEAD"
          : "",
    checkout === undefined
      ? "the fork's checkout was not read"
      : checkout.head !== head
        ? "the fork is not checked out at the worker's HEAD"
        : "",
    checkout && !forkLines.includes(COMMITTED_LINE(probe)) ? "the committed line is missing" : "",
    checkout && forkLines.includes(UNCOMMITTED_LINE(probe))
      ? "the uncommitted line came with it"
      : "",
    checkout?.uncommittedPaths.some((path) => path === file || path.endsWith(`/${file}`))
      ? "the fork has the probe file uncommitted"
      : "",
  ].filter(Boolean);
  checks.push(
    check(
      "fork-from-last-commit",
      forkProblems.length === 0,
      `${forkProblems.length === 0 ? "the fork is the worker's commit, without its uncommitted line" : forkProblems.join(", ")}${unexpected(forkOutput)}`,
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

  const listed = one("list_worker_commands");
  const row = compactRow(listed);
  const ran = gapResultJson(one("run_worker_command") ?? "");
  // Orkestrator's own /compact answers without a turn; a provider's own
  // starts one, which opens a delegation that must wake the coordinator.
  const sessionAction = row?.id === GAP_SESSION_ACTION_COMMAND_ID;
  const commandRan =
    row !== undefined &&
    !refused(callOf("run_worker_command"), one("run_worker_command")) &&
    ran?.commandId === row.id &&
    ran?.outcome !== "rejected" &&
    input.phaseAfterCommand === "idle" &&
    (sessionAction
      ? ran?.startsTurn === false &&
        ran?.delegationOpened === false &&
        input.delegationsOpenedByCommand === 0
      : ran?.startsTurn === true &&
        ran?.delegationOpened === true &&
        input.delegationsOpenedByCommand === 1 &&
        input.commandDelegation?.wokenAt !== undefined);
  checks.push(
    check(
      "commands-listed",
      row !== undefined,
      row
        ? `${GAP_COMMAND} listed as ${row.id}`
        : listed
          ? `no ${GAP_COMMAND} row${unexpected(listed)}`
          : "no output",
    ),
    check(
      "command-ran-as-listed",
      commandRan,
      `${row ? (sessionAction ? "session action" : "provider command") : "unlisted"}, ran ${String(ran?.commandId ?? "missing")}, startsTurn ${String(ran?.startsTurn ?? "missing")}, delegation ${String(ran?.delegationOpened ?? "missing")}, outcome ${String(ran?.outcome ?? "missing")}, ${input.delegationsOpenedByCommand} delegations opened${
        input.commandDelegation ? (input.commandDelegation.wokenAt ? ", woken" : ", not woken") : ""
      }, worker ${input.phaseAfterCommand ?? "unread"}${unexpected(one("run_worker_command"))}`,
    ),
  );

  const created = gapResultJson(one("create_schedule") ?? "");
  const paused = scheduleState(one("pause_schedule"));
  const updated = gapResultJson(one("update_schedule") ?? "");
  const resumed = scheduleState(one("resume_schedule"));
  const createdAt = scheduleFiresAt(created);
  const updatedAt = scheduleFiresAt(updated);
  // "+6h" then "+7h", each resolved when its call ran: an hour apart, give or
  // take the seconds between the two calls.
  const moved =
    createdAt !== undefined && updatedAt !== undefined ? updatedAt - createdAt : undefined;
  const retimed = moved !== undefined && Math.abs(moved - 3_600_000) <= 10 * 60_000;
  const sameSchedule =
    typeof created?.scheduleId === "string" && updated?.scheduleId === created.scheduleId;
  checks.push(
    check(
      "schedule-edits",
      paused === "paused" &&
        sameSchedule &&
        retimed &&
        updated?.state === "paused" &&
        !refused(callOf("update_schedule"), one("update_schedule")) &&
        resumed === "active" &&
        input.scheduleGone,
      `paused ${paused ?? "missing"}, updated ${
        updated?.scheduleId === undefined
          ? "missing"
          : `${sameSchedule ? "same schedule" : "a different schedule"}, ${
              moved === undefined ? "time unread" : `moved ${Math.round(moved / 60_000)} min`
            }, ${String(updated.state ?? "no state")}`
      }, resumed ${resumed ?? "missing"}, ${input.scheduleGone ? "cancelled" : "still there"}${[
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

  /** Refused with the owning node's own reason, not just any error. */
  const refusedFor = (tool: string, reason: RegExp) =>
    refused(callOf(tool), one(tool)) && reason.test(refusalText(one(tool)) ?? "");
  const refusalDetail = (tool: string) =>
    refusalReason(one(tool)) ?? (callOf(tool) ? "the call was not refused" : "not called");
  checks.push(
    check(
      "resolve-refused-without-pr",
      refusedFor("resolve_conflicts", GAP_NO_PR_REFUSAL),
      refusalDetail("resolve_conflicts"),
    ),
    check(
      "answer-refused-without-question",
      refusedFor("answer_worker_question", GAP_NO_QUESTION_REFUSAL) &&
        input.actionRequestsCreated === 0,
      `${input.actionRequestsCreated} approval requests created; ${refusalDetail("answer_worker_question")}`,
    ),
  );

  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
    ...(worker !== undefined && !input.workerObserved
      ? ["the worker's session was never read, so its interactions are unknown"]
      : []),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}
