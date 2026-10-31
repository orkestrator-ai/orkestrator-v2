import { randomBytes } from "node:crypto";
import type { CoordinatorLivePlatformSummary } from "./coordinator-live.js";
import type { DelegationRecord } from "./coordinator-live-delegation.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";
import {
  evaluateGoalScenario,
  GOAL_WORKER_TAB,
  goalDelegatingPrompt,
  goalDelegation,
  goalSetOutcome,
  goalSetPrompt,
  goalWorkerName,
  type GoalProbe,
  type GoalRecord,
} from "./coordinator-live-goal.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";

const STOPPED = new Set(["paused", "blocked", "limited", "claimed", "complete"]);

/**
 * The goal scenario's backend orchestration, shared by the live spec and the
 * credential-free test that scripts the command transport. See
 * `coordinator-live-goal.ts` for what it qualifies.
 */
export async function runGoalScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  pollIntervalMs?: number;
  /** How long the harness watches for a second wake after the first (default 30 s). */
  quietMs?: number;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const probe: GoalProbe = {
    platform,
    token: input.token ?? randomBytes(6).toString("hex"),
  };
  const budgets = coordinatorLiveBudgets();
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs);
  const turnMessages = (rowsBefore: number) =>
    (watch.projection()?.messages ?? []).slice(rowsBefore);
  const name = goalWorkerName(probe);
  const findWorker = () => watch.workers.find((id) => watch.workerName(id) === name);

  let finished: string | undefined;
  let worker: string | undefined;
  let goal: GoalRecord | undefined;
  let setResults: string[] = [];
  let readResults: string[] = [];
  let setEndedAt: number | undefined;
  let wakeObservationStart: number | undefined;
  let wakeObservationEnd: number | undefined;
  const readGoal = async (environmentId: string) =>
    (
      await invoke<{ goal?: GoalRecord } | null>("get_native_agent_goal", {
        environmentId,
        agent: platform,
        logicalSessionKey: `env-${environmentId}:${GOAL_WORKER_TAB}`,
      }).catch(() => null)
    )?.goal;

  try {
    await coordinatorTurn(watch, coordinator, "the delegating turn", goalDelegatingPrompt(probe));
    await watch.until("the launched worker", () => findWorker() !== undefined);
    worker = findWorker()!;
    const workerId = worker;

    // The launch's own delegation must be over, so the next wake is the goal's.
    await watch.until("the worker's first turn and its wake", (observation) => {
      const launch = goalDelegation(observation.delegations, workerId);
      return launch?.wokenAt !== undefined && observation.workerPhases?.[workerId] === "idle";
    });
    await watch.coordinatorSettled("the coordinator after the worker's first turn");

    const set = await coordinatorTurn(
      watch,
      coordinator,
      "the set turn",
      goalSetPrompt(probe, workerId),
    );
    setEndedAt = set.endedAt;
    wakeObservationStart = watch.observations.length;
    setResults = await watch.toolOutputs("set_worker_goal", turnMessages(set.rowsBefore));
    const goalId = setResults.map(goalSetOutcome).find((outcome) => outcome.goalId)?.goalId;
    if (!goalId) throw new Error("set_worker_goal set no goal");

    // Two worker turns, a check and the wake. An ended goal with no wake is the
    // failure this waits to expose, so it is left to time out and be reported.
    const previousTurnIds = new Set(watch.observations.at(-1)?.coordinatorTurnIds ?? []);
    let woke = false;
    let idleReads = 0;
    await watch.until(
      "the goal to stop and the coordinator's wake turn",
      async (observation) => {
        goal = await readGoal(workerId);
        if (
          observation.coordinatorPhase !== "idle" ||
          observation.coordinatorTurnIds?.some((id) => !previousTurnIds.has(id))
        )
          woke = true;
        idleReads = observation.coordinatorPhase === "idle" ? idleReads + 1 : 0;
        const delegation = goalDelegation(observation.delegations, workerId);
        return (
          goal !== undefined &&
          STOPPED.has(goal.status) &&
          woke &&
          idleReads >= 2 &&
          observation.queueLength === 0 &&
          delegation?.wokenAt !== undefined
        );
      },
      budgets.step * 3,
    );

    const quietDeadline = Date.now() + (input.quietMs ?? 30_000);
    await watch.observe();
    do {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(input.pollIntervalMs ?? 2_000, Math.max(0, quietDeadline - Date.now())),
        ),
      );
      await watch.observe();
    } while (Date.now() < quietDeadline);
    wakeObservationEnd = watch.observations.length;
    readResults = await watch.toolOutputs("get_worker_goal", turnMessages(set.rowsBefore));
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  if (worker) goal = (await readGoal(worker)) ?? goal;
  const mail = await watch.mailWithBodies();
  const delegations: DelegationRecord[] = (watch.observations.at(-1)?.delegations ?? []).slice();
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...evaluateGoalScenario({
      coordinatorEnvironmentId: identity.environmentId,
      ...(worker ? { workerEnvironmentId: worker } : {}),
      setResults,
      readResults,
      ...(goal ? { goal } : {}),
      ...(setEndedAt !== undefined ? { setEndedAt } : {}),
      ...(wakeObservationStart !== undefined ? { wakeObservationStart } : {}),
      observations: watch.observations.slice(0, wakeObservationEnd),
      delegations,
      mail,
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
    }),
  ];
  return { checks, watch, mail, probe };
}
