import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { escapedInteractionFailures, type CoordinatorLiveCheck } from "./coordinator-live.js";
import type {
  DelegationMailMessage,
  DelegationObservation,
  DelegationRecord,
} from "./coordinator-live-delegation.js";

/**
 * The `goal` scenario (`plans/goals/403`): a coordinator gives a worker a goal,
 * and hears once when it stops.
 *
 * The coordinator launches one worker with a one-word task, then sets a goal on
 * it. The objective takes two turns on purpose: with one, "not woken per
 * iteration" would hold however the wake behaved, because there would be no
 * iteration to wake on. The second turn reports done, ending as an unverified
 * claim because coordinator tools cannot configure shell checks. The coordinator reacts to its wake
 * by reading the goal.
 *
 * This module holds the prompts and the verdict; the spec and its orchestration
 * (`coordinator-live-goal-orchestration.ts`) share it. Nothing here may use Bun
 * APIs.
 */

export interface GoalProbe {
  platform: AgentPlatform;
  /** Random hex; the worker's name and its files carry it. */
  token: string;
}

/** The goal as the backend's `get_native_agent_goal` reads it. Never recorded. */
export interface GoalRecord {
  goalId: string;
  status: string;
  statusReason?: string;
  iterations: number;
  maxIterations: number;
  check?: string;
  lastCheck?: { passed: boolean; exitCode: number | null };
  endedAt?: string;
}

/** A goal loop runs only where the platform's live run has passed (D14). */
export function goalApplies(platform: AgentPlatform): boolean {
  return nativeAgentCapabilities(platform).actions?.goal === true;
}

export const GOAL_MAX_ITERATIONS = 3;
export const GOAL_WORKER_TAB = "startup-agent";

export function goalWorkerName(probe: GoalProbe): string {
  return `goal-${probe.token}`;
}

/** Created in the worker's workspace, where the check runs too. */
function goalFiles(probe: GoalProbe) {
  return { first: `goal-${probe.token}-one`, second: `goal-${probe.token}-two` };
}

export function goalCheckCommand(probe: GoalProbe): string {
  return `test -f ${goalFiles(probe).second}`;
}

export function goalObjective(probe: GoalProbe): string {
  const { first, second } = goalFiles(probe);
  return `If the file ${first} does not exist, run touch ${first} and end your turn at once without calling report_goal. If it exists, run touch ${second} and call report_goal with status done. Do nothing else and send no messages.`;
}

const HARNESS_PREAMBLE =
  "This is Orkestrator's worker goal conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything.";

export function goalDelegatingPrompt(probe: GoalProbe): string {
  const task = "Reply with the single word ready and end your turn. Send no messages.";
  return [
    HARNESS_PREAMBLE,
    "",
    "1. Call the Orkestrator get_launch_options tool once.",
    `2. Then call the Orkestrator launch_environment tool once with name "${goalWorkerName(probe)}", environmentType "local", agent "${probe.platform}", no model or reasoning fields, the baseBranch and baseCommit from coordinatorBase, a fresh requestId, and this exact prompt: ${JSON.stringify(task)}.`,
    "3. Then finish this turn at once with a one-line summary. Do not wait, sleep, read messages or check message status.",
    "",
    "When you are woken by that worker, reply with one short line and end that turn without calling any tools.",
  ].join("\n");
}

export function goalSetPrompt(probe: GoalProbe, workerEnvironmentId: string): string {
  return [
    HARNESS_PREAMBLE,
    `Call the Orkestrator set_worker_goal tool exactly once with a fresh requestId, environmentId "${workerEnvironmentId}", tabId "${GOAL_WORKER_TAB}", maxIterations ${GOAL_MAX_ITERATIONS}, and this exact objective: ${JSON.stringify(goalObjective(probe))}`,
    "Call no other tool, do not wait for the worker, and end this turn with one line.",
    "",
    `When you are woken about that worker, call the Orkestrator get_worker_goal tool once with the same environmentId and tabId, and end that turn with one line giving the status it returned.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tool output

/** What one `set_worker_goal` result says, without assuming how it is wrapped. */
export function goalSetOutcome(output: string): {
  goalId: string | null;
  maxIterations: number | null;
  wakeOwed: boolean;
} {
  const limit = /"maxIterations"\s*:\s*(\d+)/.exec(output)?.[1];
  return {
    goalId: /"goalId"\s*:\s*"([^"]{1,200})"/.exec(output)?.[1] ?? null,
    maxIterations: limit === undefined ? null : Number(limit),
    wakeOwed: /"wakeOwed"\s*:\s*true/.test(output),
  };
}

/** The status one `get_worker_goal` result reports, or null. */
export function goalReadStatus(output: string): string | null {
  return /"status"\s*:\s*"([a-z-]{1,40})"/.exec(output)?.[1] ?? null;
}

/** The newest delegation on the worker: launch opened one, and the goal another. */
export function goalDelegation(
  delegations: readonly DelegationRecord[],
  workerEnvironmentId: string | undefined,
): DelegationRecord | undefined {
  return delegations
    .filter((record) => record.environmentId === workerEnvironmentId)
    .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .at(-1);
}

/**
 * Coordinator turns in a window. Phase edges catch a running turn before its
 * usage record is published; durable usage records catch whole turns completed
 * between two samples.
 */
export function coordinatorTurnsAfter(
  observations: readonly DelegationObservation[],
  firstObservation: number | undefined,
): number {
  if (firstObservation === undefined) return 0;
  const known = new Set(
    observations.slice(0, firstObservation).flatMap((item) => item.coordinatorTurnIds ?? []),
  );
  const fresh = new Set<string>();
  let edges = 0;
  let previous = "idle";
  for (const observation of observations.slice(firstObservation)) {
    if (previous === "idle" && observation.coordinatorPhase !== "idle") edges += 1;
    for (const id of observation.coordinatorTurnIds ?? []) if (!known.has(id)) fresh.add(id);
    previous = observation.coordinatorPhase;
  }
  return Math.max(edges, fresh.size);
}

// ---------------------------------------------------------------------------
// Verdict

export interface GoalScenarioInput {
  coordinatorEnvironmentId: string;
  workerEnvironmentId?: string;
  /** `set_worker_goal` outputs from the set turn. */
  setResults: string[];
  /** `get_worker_goal` outputs from every turn since. */
  readResults: string[];
  /** The goal after the wake settled. */
  goal?: GoalRecord;
  setEndedAt?: number;
  /** First observation after the set turn. Earlier turns are not wakes. */
  wakeObservationStart?: number;
  /** Observations up to the end of the quiet window. */
  observations: readonly DelegationObservation[];
  delegations: readonly DelegationRecord[];
  /** Final mail, with bodies. */
  mail: readonly DelegationMailMessage[];
  escapedInteractions: readonly AgentInteractionKind[];
  workerInteractions: readonly AgentInteractionKind[];
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function at(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function evaluateGoalScenario(input: GoalScenarioInput): CoordinatorLiveCheck[] {
  const { goal } = input;
  const set = input.setResults.map(goalSetOutcome);
  const checks: CoordinatorLiveCheck[] = [
    check("worker-launched", input.workerEnvironmentId !== undefined),
    check(
      "goal-set",
      set.length === 1 &&
        set[0]!.goalId !== null &&
        set[0]!.maxIterations === GOAL_MAX_ITERATIONS &&
        set[0]!.wakeOwed,
      `${set.length} set_worker_goal results; goal ${set[0]?.goalId ? "named" : "missing"}, maxIterations ${set[0]?.maxIterations ?? "none"}, wakeOwed ${set[0]?.wakeOwed ?? false}`,
    ),
    check(
      "goal-claimed",
      goal?.status === "claimed" &&
        goal.statusReason === "agent-claimed" &&
        goal.goalId === set[0]?.goalId,
      goal
        ? `status ${goal.status}, reason ${goal.statusReason ?? "none"}${goal.goalId === set[0]?.goalId ? "" : ", a different goal than was set"}`
        : "the worker has no goal",
    ),
    check("no-shell-check", goal?.check === undefined && goal?.lastCheck === undefined),
    // One iteration proves nothing about waking per iteration.
    check(
      "ran-more-than-one-iteration",
      goal !== undefined && goal.iterations >= 2 && goal.iterations <= GOAL_MAX_ITERATIONS,
      `${goal?.iterations ?? 0} of ${goal?.maxIterations ?? GOAL_MAX_ITERATIONS} iterations`,
    ),
  ];

  // The delegation stayed open across the iterations: it closed, and woke the
  // coordinator, only after the goal ended.
  const delegation = goalDelegation(input.delegations, input.workerEnvironmentId);
  const endedAt = at(goal?.endedAt);
  const closedAt = at(delegation?.completedAt);
  const wokenAt = at(delegation?.wokenAt);
  checks.push(
    check(
      "delegation-held-until-goal-ended",
      delegation?.state === "completed" && closedAt >= endedAt && wokenAt >= endedAt,
      `delegation ${delegation?.state ?? "missing"}, closed ${
        Number.isFinite(closedAt) && Number.isFinite(endedAt)
          ? closedAt >= endedAt
            ? "after"
            : "before"
          : "at an unknown time relative to"
      } the goal's end, ${Number.isFinite(wokenAt) ? "woken" : "never woken"}`,
    ),
  );

  const turns = coordinatorTurnsAfter(input.observations, input.wakeObservationStart);
  checks.push(check("one-wake", turns === 1, `${turns} coordinator turns after the set turn`));

  // A report the worker mailed is that wake's text. Otherwise the notice says
  // how the goal ended, which is what the coordinator decides on.
  const notices = input.mail.filter(
    (message) =>
      message.toEnvironmentId === input.coordinatorEnvironmentId &&
      message.from.kind === "system" &&
      input.setEndedAt !== undefined &&
      at(message.createdAt) >= input.setEndedAt,
  );
  const reported = delegation?.wakeKind === "report";
  checks.push(
    check(
      "wake-names-outcome",
      reported ||
        (notices.length === 1 &&
          notices[0]!.body?.includes("Its goal is claimed (agent-claimed)") === true &&
          notices[0]!.body.includes("get_worker_goal")),
      reported ? "the worker's own report was the wake" : `${notices.length} notices after the set`,
    ),
  );

  const statuses = input.readResults.map(goalReadStatus);
  checks.push(
    check(
      "coordinator-read-goal",
      statuses.includes("claimed"),
      `${statuses.length} get_worker_goal results: ${statuses.map(String).join(", ") || "none"}`,
    ),
  );

  const interactions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...escapedInteractionFailures(input.workerInteractions).map((failure) => `worker: ${failure}`),
  ];
  checks.push(check("no-user-action", interactions.length === 0, interactions.join("; ")));
  return checks;
}
