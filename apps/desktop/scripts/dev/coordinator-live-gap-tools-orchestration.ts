import { randomBytes } from "node:crypto";
import {
  transcriptToolCalls,
  type CoordinatorLivePlatformSummary,
  type CoordinatorTranscriptMessage,
  type ReadOnlyToolCall,
} from "./coordinator-live.js";
import type { DelegationRecord } from "./coordinator-live-delegation.js";
import {
  delegationsOpenedSince,
  evaluateGapToolsScenario,
  gapFileName,
  gapResultJson,
  gapSteps,
  gapTurnPrompt,
  GAP_WORKER_TAB,
  namedEnvironments,
  type GapForkCheckout,
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

/** The schedule IDs a `list_scheduled_jobs` answer names, whichever list key it uses. */
export function scheduleIds(listed: unknown): string[] {
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
 * the fake-model spec and `coordinator-live-gap-tools-orchestration.test.ts`,
 * which scripts the command transport. See `coordinator-live-gap-tools.ts` for
 * what it qualifies.
 *
 * For a worker on a connected node pass `nodeId`, the node's `workerInvoke`
 * (the leaf's own backend) and `workerProjectId` (the node's copy of the
 * project). Everything about the worker is read there: its turn, its
 * interactions and mailbox (through the delegation watch), its HEAD and the
 * fork's checkout. The coordinator's turn, delegations and mail stay on the
 * coordinator's own backend.
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
  const watch = createDelegationWatch(invoke, coordinator, summary, input.pollIntervalMs, {
    worker: { invoke: workerInvoke, projectId: workerProjectId },
  });
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
  /** An environment's HEAD, from the node that owns it. */
  const headOf = async (environmentId: string): Promise<string | undefined> => {
    const read = await workerInvoke<{ head?: unknown } | null>(
      "get_environment_uncommitted_paths",
      { environmentId },
    ).catch(() => null);
    return typeof read?.head === "string" && read.head ? read.head : undefined;
  };
  /**
   * The fork's HEAD, its uncommitted paths and the probe file, from the node
   * that owns it. A fresh fork's worktree may still be settling, so the read
   * is retried until it answers or the step budget runs out.
   */
  const checkoutOf = async (environmentId: string): Promise<GapForkCheckout | undefined> => {
    let checkout: GapForkCheckout | undefined;
    await watch.until("the fork's checkout", async () => {
      const read = await workerInvoke<{ head?: unknown; paths?: unknown } | null>(
        "get_environment_uncommitted_paths",
        { environmentId },
      ).catch(() => null);
      if (typeof read?.head !== "string" || !read.head) return false;
      const encoded = await workerInvoke<string>("read_environment_file_base64", {
        environmentId,
        filePath: gapFileName(probe),
      }).catch(() => null);
      checkout = {
        head: read.head,
        uncommittedPaths: Array.isArray(read.paths)
          ? read.paths.filter((path): path is string => typeof path === "string")
          : [],
        content:
          typeof encoded === "string" ? Buffer.from(encoded, "base64").toString("utf8") : null,
      };
      return true;
    });
    return checkout;
  };

  let finished: string | undefined;
  let worker: string | undefined;
  let baseCommit: string | undefined;
  let workerHead: string | undefined;
  let forkExists = false;
  let forkCheckout: GapForkCheckout | undefined;
  let phaseAfterStop: string | undefined;
  let phaseAfterCommand: string | undefined;
  let stoppedDelegation: DelegationRecord | undefined;
  let delegationsOpenedByCommand = 0;
  let commandDelegation: DelegationRecord | undefined;
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
    workerHead = await headOf(workerId);
    await turn("the changes and fork turn", gapSteps.changes(probe, workerId));
    const fork = namedEnvironments(outputs.fork_worker?.[0], workerId)[0];
    if (fork) {
      forkExists = (
        await workerInvoke<Array<{ id: string }>>("get_environments", {
          projectId: workerProjectId,
        })
      ).some((environment) => environment.id === fork);
      if (forkExists) forkCheckout = await checkoutOf(fork);
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

    // 4. List the tab's commands and run /compact as listed. Orkestrator's own
    // answers without a turn; a provider's own starts one, whose delegation
    // must wake the coordinator once the turn ends.
    const beforeCommand = delegationOn((await watch.observe()).delegations, workerId);
    await turn("the commands turn", gapSteps.commands(probe, workerId));
    const startsTurn = gapResultJson(outputs.run_worker_command?.[0] ?? "")?.startsTurn === true;
    const settledCommand = workerIdle(workerId, 3);
    const afterCommand = await watch.until("the command to settle", async (observation) => {
      const latest = delegationOn(observation.delegations, workerId);
      const woken =
        !startsTurn ||
        (delegationsOpenedSince(beforeCommand, latest) === 1 && latest?.wokenAt !== undefined);
      return woken && (await settledCommand());
    });
    phaseAfterCommand = await phase(workerId);
    const latest = delegationOn(afterCommand.delegations, workerId);
    delegationsOpenedByCommand = delegationsOpenedSince(beforeCommand, latest);
    if (delegationsOpenedByCommand > 0) commandDelegation = latest;
    if (startsTurn) await watch.coordinatorSettled("the coordinator after the command's wake");

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
      ...(workerHead ? { workerHead } : {}),
      forkExists,
      ...(forkCheckout ? { forkCheckout } : {}),
      ...(phaseAfterStop ? { phaseAfterStop } : {}),
      ...(phaseAfterCommand ? { phaseAfterCommand } : {}),
      ...(stoppedDelegation ? { stoppedDelegation } : {}),
      delegationsOpenedByCommand,
      ...(commandDelegation ? { commandDelegation } : {}),
      mail,
      scheduleGone,
      actionRequestsCreated,
      escapedInteractions: watch.escaped(),
      workerInteractions: watch.workerEscaped(),
      workerObserved: worker !== undefined && watch.workerObserved(worker),
    }),
  ];
  return { checks, watch, mail, probe, calls };
}
