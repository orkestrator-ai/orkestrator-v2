import { randomBytes } from "node:crypto";
import {
  transcriptToolCalls,
  type CoordinatorLivePlatformSummary,
  type CoordinatorTranscriptMessage,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import type { DelegationRecord } from "./coordinator-live-delegation.js";
import {
  evaluateGapToolsScenario,
  gapResultJson,
  gapSteps,
  gapTurnPrompt,
  GAP_WORKER_TAB,
  namedEnvironments,
  type GapStep,
  type GapToolsProbe,
} from "./coordinator-live-gap-tools.js";
import {
  createDelegationWatch,
  removeLaunchedEnvironments,
  type DelegationCoordinator,
} from "./coordinator-live-observer.js";
import { coordinatorTurn } from "./coordinator-live-orchestration.js";

type Invoke = DelegationCoordinator["invoke"];

/** The newest delegation the coordinator holds on one worker. */
function delegationOn(
  delegations: readonly DelegationRecord[],
  environmentId: string | undefined,
): DelegationRecord | undefined {
  return delegations
    .filter((record) => record.environmentId === environmentId)
    .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .at(-1);
}

function scheduleIds(listed: unknown): string[] {
  const rows = Array.isArray(listed)
    ? listed
    : Array.isArray((listed as { jobs?: unknown } | null)?.jobs)
      ? (listed as { jobs: unknown[] }).jobs
      : Array.isArray((listed as { schedules?: unknown } | null)?.schedules)
        ? (listed as { schedules: unknown[] }).schedules
        : [];
  return rows.flatMap((row) =>
    row && typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : [],
  );
}

/**
 * The gap-tools scenario's backend orchestration, shared by the live spec,
 * the fake-model specs and the credential-free test that scripts the command
 * transport. See `coordinator-live-gap-tools.ts` for what it qualifies.
 *
 * For a worker on a connected node pass `nodeId`, the node's `workerInvoke`
 * (the leaf's own backend, for reading the worker's turn and environments)
 * and `workerProjectId` (the node's copy of the project).
 */
export async function runGapToolsScenario(input: {
  coordinator: DelegationCoordinator;
  summary: CoordinatorLivePlatformSummary;
  cleanup: Array<() => Promise<unknown>>;
  token?: string;
  nodeId?: string;
  workerInvoke?: Invoke;
  workerProjectId?: string;
  pollIntervalMs?: number;
}) {
  const { coordinator, summary, cleanup } = input;
  const { invoke, identity, projectId } = coordinator;
  const platform = identity.agent;
  const workerInvoke = input.workerInvoke ?? invoke;
  const workerProjectId = input.workerProjectId ?? projectId;
  await removeLaunchedEnvironments(invoke, projectId, cleanup);
  if (input.workerInvoke) await removeLaunchedEnvironments(workerInvoke, workerProjectId, cleanup);
  const probe: GapToolsProbe = {
    platform,
    token: input.token ?? randomBytes(6).toString("hex"),
    projectId,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
  };
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs);
  const outputs: Record<string, string[]> = {};
  const calls: ReadOnlyToolCall[] = [];

  /** One harness turn; its tool calls and outputs are kept for the verdict. */
  const turn = async (label: string, steps: GapStep[]) => {
    const ran = await coordinatorTurn(watch, coordinator, label, gapTurnPrompt(steps));
    const messages: CoordinatorTranscriptMessage[] = (watch.projection()?.messages ?? []).slice(
      ran.rowsBefore,
    );
    calls.push(...transcriptToolCalls(messages));
    for (const tool of new Set(steps.map((step) => step.tool))) {
      const found = await watch.toolOutputs(tool, messages);
      if (found.length > 0) (outputs[tool] ??= []).push(...found);
    }
    return ran;
  };
  const phase = async (environmentId: string): Promise<string> =>
    (
      await workerInvoke<{ turn?: { phase?: string } } | null>("get_native_agent_projection", {
        environmentId,
        agent: platform,
        logicalSessionKey: `env-${environmentId}:${GAP_WORKER_TAB}`,
        messageLimit: 1,
      }).catch(() => null)
    )?.turn?.phase ?? "unknown";
  /** The worker idle on `reads` consecutive reads. */
  const workerIdle = (environmentId: string, reads = 2) => {
    let idle = 0;
    return async () => {
      idle = (await phase(environmentId)) === "idle" ? idle + 1 : 0;
      return idle >= reads;
    };
  };
  const actionRequests = async () =>
    (await invoke<unknown[]>("list_node_action_requests", {}).catch(() => [])).length;

  let finished: string | undefined;
  let worker: string | undefined;
  let baseCommit: string | undefined;
  let forkExists = false;
  let phaseAfterStop: string | undefined;
  let phaseAfterCommand: string | undefined;
  let stoppedDelegation: DelegationRecord | undefined;
  let delegationsAfterStop = 0;
  let scheduleGone = false;
  let actionRequestsCreated = 0;
  const requestsBefore = await actionRequests();

  try {
    // 1. Launch the worker; its one command commits a line and leaves one uncommitted.
    await turn("the launch turn", gapSteps.launch(probe));
    worker = namedEnvironments(outputs.launch_environment?.[0], "")[0];
    if (!worker) throw new Error("launch_environment named no worker");
    const workerId = worker;
    baseCommit = (
      gapResultJson(outputs.get_launch_options?.[0] ?? "")?.coordinatorBase as
        { baseCommit?: unknown } | undefined
    )?.baseCommit as string | undefined;
    const settledFirst = workerIdle(workerId);
    await watch.until(
      "the worker's first turn and its wake",
      async (observation) =>
        delegationOn(observation.delegations, workerId)?.wokenAt !== undefined &&
        (await settledFirst()),
    );
    await watch.coordinatorSettled("the coordinator after the worker's first turn");

    // 2. Read its changes split at HEAD, then fork it.
    await turn("the changes and fork turn", gapSteps.changes(probe, workerId));
    const fork = namedEnvironments(outputs.fork_worker?.[0], workerId)[0];
    if (fork) {
      forkExists = (
        await workerInvoke<Array<{ id: string }>>("get_environments", {
          projectId: workerProjectId,
        })
      ).some((environment) => environment.id === fork);
    }

    // 3. A long turn, then stop it.
    await turn("the long-turn turn", gapSteps.longTurn(probe, workerId));
    await watch.until(
      "the worker's long turn to start",
      async (observation) =>
        delegationOn(observation.delegations, workerId)?.state === "running" &&
        (await phase(workerId)) !== "idle",
    );
    await watch.coordinatorSettled("the coordinator after the long-turn turn");
    await turn("the stop turn", gapSteps.stop(probe, workerId));
    const settledStop = workerIdle(workerId);
    const stopWake = await watch.until(
      "the stopped turn's wake",
      async (observation) =>
        delegationOn(observation.delegations, workerId)?.wokenAt !== undefined &&
        (await settledStop()),
    );
    stoppedDelegation = delegationOn(stopWake.delegations, workerId);
    phaseAfterStop = await phase(workerId);
    await watch.coordinatorSettled("the coordinator after the stop wake");

    // 4. List the tab's commands and run one that answers without a turn.
    await turn("the commands turn", gapSteps.commands(probe, workerId));
    const settledCommand = workerIdle(workerId, 3);
    const afterCommand = await watch.until("the command to settle", () => settledCommand());
    phaseAfterCommand = await phase(workerId);
    const latest = delegationOn(afterCommand.delegations, workerId);
    delegationsAfterStop = latest && latest.requestedAt !== stoppedDelegation?.requestedAt ? 1 : 0;

    // 5. A self-timer, paused, retimed, resumed and cancelled.
    await turn("the schedules turn", gapSteps.schedules(probe));
    const scheduleId = gapResultJson(outputs.create_schedule?.[0] ?? "")?.scheduleId;
    scheduleGone =
      typeof scheduleId === "string" &&
      !scheduleIds(await invoke<unknown>("list_scheduled_jobs", { projectId })).includes(
        scheduleId,
      );

    // 6. Conflicts and a question the worker does not have: both refused.
    await turn("the refusals turn", gapSteps.refusals(probe, workerId));
    actionRequestsCreated = Math.max(0, (await actionRequests()) - requestsBefore);
  } catch (error) {
    finished = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }

  const mail = await watch.mailWithBodies();
  const checks = [
    { name: "finished", passed: finished === undefined, ...(finished ? { detail: finished } : {}) },
    ...evaluateGapToolsScenario({
      probe,
      coordinatorEnvironmentId: identity.environmentId,
      ...(worker ? { workerEnvironmentId: worker } : {}),
      calls,
      outputs,
      ...(baseCommit ? { baseCommit } : {}),
      forkExists,
      ...(phaseAfterStop ? { phaseAfterStop } : {}),
      ...(phaseAfterCommand ? { phaseAfterCommand } : {}),
      ...(stoppedDelegation ? { stoppedDelegation } : {}),
      delegationsAfterStop,
      mail,
      scheduleGone,
      actionRequestsCreated,
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
    }),
  ];
  return { checks, watch, mail, probe, calls };
}
