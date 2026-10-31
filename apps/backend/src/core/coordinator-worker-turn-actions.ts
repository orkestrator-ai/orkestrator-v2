import { createHash } from "node:crypto";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import {
  coordinatorNodeTarget,
  RETRY_SAME_REQUEST,
  withRetryAdvice,
  type CoordinatorNodeTarget,
} from "./commands-registry-coordinator-nodes.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import { commandArguments } from "./public-api/actions-session-commands.js";
import {
  optionalText,
  requireProjectWorker,
  surfaceKey,
  surfaceRecord as record,
} from "./worker-surface-runs.js";
import {
  listWorkerCommands,
  runWorkerCommand,
  stopWorkerTurn,
  type WorkerCommandInput,
} from "./worker-turn-controls.js";

/**
 * Backend commands behind the coordinator's worker-turn tools:
 * `stop_worker_turn`, `list_worker_commands` and `run_worker_command`.
 *
 * Each `*_coordinator_*` command takes the authenticated `scope`, revalidates
 * it and acts on one native tab of a disposable worker of that project, never
 * the project home. With `nodeId` the worker is on a connected node: the
 * receipt and the delegations stay here, and the node runs the work through
 * its node-link-only `*_controller_*` command, with the dispatch ID derived
 * from this receipt's key so a retry after a lost answer replays there.
 */

type JsonRecord = Record<string, unknown>;

function requestKey(caller: CoordinatorCaller, requestId: string): string {
  return createHash("sha256")
    .update(`${caller.coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

/** The connected node `nodeId` names; none for this node, even by its own ID. */
async function remoteNode(
  context: CommandContext,
  caller: CoordinatorCaller,
  nodeId: string | undefined,
): Promise<CoordinatorNodeTarget | undefined> {
  return nodeId && (await context.nodes?.status())?.nodeId !== nodeId
    ? coordinatorNodeTarget(context, caller.projectId, nodeId)
    : undefined;
}

/** A worker of the project (here, or on the node), checked before anything runs. */
async function workerTarget(context: CommandContext, caller: CoordinatorCaller, input: JsonRecord) {
  const remote = await remoteNode(context, caller, optionalText(input.nodeId, "nodeId", 200));
  const environmentId = asNonBlankString(input.environmentId, "environmentId");
  if (remote) await remote.environment(environmentId);
  else await requireProjectWorker(context, caller.projectId, environmentId);
  return { remote, environmentId, tabId: asNonBlankString(input.tabId, "tabId").trim() };
}

function commandInput(input: JsonRecord): WorkerCommandInput {
  const command = asNonBlankString(input.command, "command").trim();
  if (command.length > 500) throw new Error("command must be at most 500 characters");
  const args = commandArguments(input.arguments);
  const expectedBindingRevision = optionalText(
    input.expectedBindingRevision,
    "expectedBindingRevision",
    200,
  );
  return {
    command,
    ...(args !== undefined ? { arguments: args } : {}),
    ...(expectedBindingRevision ? { expectedBindingRevision } : {}),
  };
}

/** Delegations this conversation has open on that tab (kept on this node, even for a remote worker). */
function onTab(
  caller: CoordinatorCaller,
  target: { environmentId: string; tabId: string; nodeId?: string },
) {
  return (association: CoordinatorWorkflowAssociation) =>
    association.coordinatorId === caller.coordinatorId &&
    association.kind === "environment" &&
    association.nodeId === target.nodeId &&
    association.resourceId === target.environmentId &&
    association.delegation?.workerTabId === target.tabId &&
    association.delegation.state === "running";
}

/**
 * Record on each open delegation for the tab that the coordinator is stopping
 * its turn, so the wake the turn end produces says so. Returns what was marked,
 * so a stop that never happened can be unmarked.
 */
async function markStopRequested(
  context: CommandContext,
  match: (association: CoordinatorWorkflowAssociation) => boolean,
): Promise<{ ids: string[]; at: string; open: number }> {
  const at = new Date().toISOString();
  const ids: string[] = [];
  let open = 0;
  for (const association of await context.storage.coordinators.listOpenCoordinatorDelegations()) {
    if (!match(association)) continue;
    open += 1;
    await context.storage.coordinators.updateCoordinatorWorkflowAssociation(
      association.id,
      (current) => {
        if (current.delegation?.state !== "running" || current.delegation.stopRequestedAt)
          return false;
        current.delegation = { ...current.delegation, stopRequestedAt: at };
        ids.push(current.id);
        return true;
      },
    );
  }
  return { ids, at, open };
}

async function unmarkStopRequested(
  context: CommandContext,
  marked: { ids: string[]; at: string },
): Promise<void> {
  for (const id of marked.ids) {
    await context.storage.coordinators
      .updateCoordinatorWorkflowAssociation(id, (current) => {
        if (!current.delegation || current.delegation.stopRequestedAt !== marked.at) return false;
        const { stopRequestedAt: _stopRequestedAt, ...delegation } = current.delegation;
        current.delegation = delegation;
        return true;
      })
      .catch(() => undefined);
  }
}

export function registerCoordinatorWorkerTurnActions(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };
  const leafWorker = (args: JsonRecord, context: CommandContext) =>
    requireProjectWorker(
      context,
      asNonBlankString(args.projectId, "projectId"),
      args.environmentId,
    );

  /**
   * Stop the turn in one worker tab. An open delegation on that tab is marked,
   * then settles on the turn end as any other, so the coordinator is woken
   * once with what the worker had done, told it stopped the turn itself.
   */
  register("stop_coordinator_worker_turn", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the stop input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const { remote, environmentId, tabId } = await workerTarget(context, caller, input);
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "stop-worker-turn",
        payload: { environmentId, tabId, ...(remote ? { nodeId: remote.nodeId } : {}) },
      },
      async () => {
        const match = onTab(caller, { environmentId, tabId, nodeId: remote?.nodeId });
        const marks: Array<{ ids: string[]; at: string; open: number }> = [];
        const mark = async () => {
          marks.push(await markStopRequested(context, match));
        };
        const unmark = async () => {
          for (const marked of marks.splice(0)) await unmarkStopRequested(context, marked);
        };
        let result: JsonRecord;
        try {
          if (remote) {
            // The node decides whether a turn is running; mark first, so the
            // wake its turn end produces cannot overtake the mark.
            await mark();
            result = {
              ...(await withRetryAdvice(
                "The stop may have reached the worker. Check with get_tab_state (same nodeId) before retrying; a retry with the same requestId stops whatever turn is running then.",
                () =>
                  remote.call<JsonRecord>("stop_controller_worker_turn", {
                    projectId: remote.projectId,
                    environmentId,
                    tabId,
                  }),
              )),
              nodeId: remote.nodeId,
            };
            if (result.stopped !== true) await unmark();
          } else {
            result = await stopWorkerTurn(context, run, environmentId, tabId, mark);
          }
        } catch (error) {
          // A lost answer may still have stopped the turn: keep the mark then.
          if ((error as { code?: unknown }).code !== "outcome-unknown") await unmark();
          throw error;
        }
        const waiting = marks.reduce((count, marked) => count + marked.open, 0);
        if (result.stopped === true && result.acknowledged === true) {
          // The turn is over: settle now rather than on the next edge or sweep,
          // so a prompt to this tab is not refused over a stale delegation.
          await (
            remote
              ? context.coordinators?.settleRemoteWorker(remote.nodeId, environmentId)
              : context.coordinators?.settleWorkerDelegations({
                  environmentId,
                  tabId,
                  state: "completed",
                })
          )?.catch(() => undefined);
        }
        return { ...result, ...(result.stopped === true ? { delegationOpen: waiting > 0 } : {}) };
      },
    );
  });

  register("list_coordinator_worker_commands", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the command list input");
    const { remote, environmentId, tabId } = await workerTarget(context, caller, input);
    const refresh = input.refresh === true;
    if (!remote) return listWorkerCommands(context, run, environmentId, tabId, refresh);
    return {
      ...(await remote.call<JsonRecord>("list_controller_worker_commands", {
        projectId: remote.projectId,
        environmentId,
        tabId,
        refresh,
      })),
      nodeId: remote.nodeId,
    };
  });

  /**
   * Run one slash command in a worker tab. A command that starts a provider
   * turn opens a delegation the way `send_prompt_to_tab` does, so the
   * coordinator is woken once when the turn ends; one that answers without a
   * turn opens none.
   */
  register("run_coordinator_worker_command", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the command input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const { remote, environmentId, tabId } = await workerTarget(context, caller, input);
    const command = commandInput(input);
    const scope = { ...caller };
    // As for send_prompt_to_tab: one live request per tab.
    await run(
      context,
      remote
        ? "assert_coordinator_node_delegation_available"
        : "assert_coordinator_delegation_available",
      { scope, ...(remote ? { nodeId: remote.nodeId } : {}), environmentId, tabId, requestId },
    );
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "run-worker-command",
        payload: { environmentId, tabId, ...command, ...(remote ? { nodeId: remote.nodeId } : {}) },
      },
      async () => {
        const key = requestKey(caller, requestId);
        const result = remote
          ? {
              ...(await withRetryAdvice(RETRY_SAME_REQUEST, () =>
                remote.call<JsonRecord>(
                  "run_controller_worker_command",
                  { projectId: remote.projectId, environmentId, tabId, ...command, key },
                  `command:${caller.coordinatorId}:${requestId}`,
                ),
              )),
              nodeId: remote.nodeId,
            }
          : await runWorkerCommand(
              context,
              run,
              environmentId,
              tabId,
              command,
              `coordinator-command:${key}`,
            );
        let delegationOpened = false;
        if (result.startsTurn === true) {
          try {
            const opened = await run<{ opened?: boolean }>(
              context,
              remote ? "open_coordinator_node_delegation" : "open_coordinator_delegation",
              {
                scope,
                ...(remote ? { nodeId: remote.nodeId } : {}),
                environmentId,
                tabId,
                requestId,
              },
            );
            delegationOpened = opened.opened === true;
          } catch (error) {
            console.warn(
              "[coordinator] Could not open a delegation for a worker command:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        return { ...result, delegationOpened };
      },
    );
  });

  /*
   * The same three on the node that owns the worker, for a command node's
   * coordinator. Node-link only (never a workspace grant); the command node
   * checks its scope and keeps the receipt and the delegations.
   */
  register("stop_controller_worker_turn", async (args, context) => {
    const environment = await leafWorker(args, context);
    return stopWorkerTurn(context, run, environment.id, asNonBlankString(args.tabId, "tabId"));
  });

  register("list_controller_worker_commands", async (args, context) => {
    const environment = await leafWorker(args, context);
    return listWorkerCommands(
      context,
      run,
      environment.id,
      asNonBlankString(args.tabId, "tabId"),
      args.refresh === true,
    );
  });

  register("run_controller_worker_command", async (args, context) => {
    const environment = await leafWorker(args, context);
    return runWorkerCommand(
      context,
      run,
      environment.id,
      asNonBlankString(args.tabId, "tabId"),
      commandInput(args),
      `coordinator-command:${surfaceKey(args.key)}`,
    );
  });
}
