import { randomBytes } from "node:crypto";
import {
  transcriptAssistantText,
  transcriptToolCalls,
  type CoordinatorLivePlatformSummary,
} from "./coordinator-live.js";
import {
  askAnswer,
  askScenarioPrompt,
  askWorkerName,
  evaluateAskScenario,
  type AskProbe,
  type AskQuestionMoment,
} from "./coordinator-live-ask.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";

/**
 * The `ask` scenario's backend orchestration, shared by the live spec and the
 * credential-free test that scripts the command transport. See
 * `coordinator-live-ask.ts` for what it qualifies.
 *
 * One build-mode turn: the coordinator launches a worker, then asks the user a
 * question. The harness answers the card with the second option while the
 * turn waits, then lets the worker's wake run and settle.
 */
export async function runAskScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  pollIntervalMs?: number;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, projectId } = coordinator;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  const probe: AskProbe = {
    platform: coordinator.identity.agent,
    token: input.token ?? randomBytes(6).toString("hex"),
  };
  let moment: AskQuestionMoment | undefined;
  let dispatchedAt = Number.POSITIVE_INFINITY;
  /**
   * Turn ids the coordinator had finalized before the dispatch, from the read
   * `coordinatorTurn` takes just before it dispatches. A bridge publishes a
   * turn's usage record when it finalizes the turn, so an id outside this set
   * is a turn that ended after the dispatch: durable evidence that survives a
   * turn ending and the next starting between two reads.
   */
  let baselineTurnIds: Set<string> | undefined;
  const endedTurnIds = new Set<string>();
  let sawActive = false;
  let idleReads = 0;
  let idleBefore = false;
  /** The observation whose read first carried the question. */
  let questionObservation: number | undefined;
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs, {
    answerCoordinatorQuestion: (request) => {
      const answers = askAnswer(probe, request);
      if (answers && !moment) {
        // The delegation is read in the same pass as this projection; it is
        // checked once that pass's observation is recorded (below).
        moment = { delegationOpen: false, idleBefore, turnsEndedBefore: endedTurnIds.size };
        questionObservation = watch.observations.length;
      }
      return answers;
    },
    onProjection: (projection) => {
      if (Date.now() < dispatchedAt || moment) return;
      const turnIds = (projection?.contextUsage?.turns ?? []).map((turn) => turn.turnId);
      if (!baselineTurnIds) {
        // The pre-dispatch read: the turn has not started yet.
        baselineTurnIds = new Set(turnIds);
        return;
      }
      for (const id of turnIds) if (!baselineTurnIds.has(id)) endedTurnIds.add(id);
      // Idle counts as the turn ending only once it holds for two reads, the
      // rule `coordinatorTurn` settles on: a provider can drop to idle for one
      // read between two steps of the same turn.
      const phase = projection?.turn.phase ?? "idle";
      if (phase !== "idle") {
        sawActive = true;
        idleReads = 0;
      } else if (sawActive && ++idleReads >= 2) idleBefore = true;
    },
  });
  const name = askWorkerName(probe);
  const findWorker = () => watch.workers.find((id) => watch.workerName(id) === name);

  let finished: string | undefined;
  let rowsBefore = 0;
  try {
    rowsBefore = watch.projection()?.messages.length ?? 0;
    dispatchedAt = Date.now();
    const turn = await coordinatorTurn(
      watch,
      coordinator,
      "the delegate-and-ask turn",
      askScenarioPrompt(probe),
    );
    rowsBefore = turn.rowsBefore;
    const worker = findWorker();
    if (worker) {
      // The worker's report or finished notice wakes the coordinator; let that
      // turn end so cleanup never deletes a worker mid-wake.
      await watch.until("the worker's wake", (observation) =>
        observation.delegations.some(
          (delegation) =>
            delegation.environmentId === worker &&
            (delegation.wokenAt !== undefined || delegation.state !== "running") &&
            observation.workerPhases?.[worker] === "idle",
        ),
      );
      await watch.coordinatorSettled("the coordinator after the worker's wake");
    }
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const worker = findWorker();
  if (moment && questionObservation !== undefined && worker) {
    const seen = watch.observations[questionObservation];
    moment = {
      ...moment,
      delegationOpen:
        seen?.delegations.some((delegation) => delegation.environmentId === worker) === true,
    };
  }
  const messages = (watch.projection()?.messages ?? []).slice(rowsBefore);
  const calls = transcriptToolCalls(messages);
  const launchResults = await watch.toolOutputs("launch_environment", messages);
  const verdict = evaluateAskScenario({
    probe,
    ...(worker ? { workerEnvironmentId: worker } : {}),
    calls,
    launchResults,
    answered: watch.answeredQuestions(),
    ...(moment ? { moment } : {}),
    text: transcriptAssistantText(messages),
    escapedInteractions: watch.escaped(),
    workerInteractions: watch.workerEscaped(),
  });
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...verdict.checks,
  ];
  return { checks, observed: verdict.observed, watch, probe };
}
