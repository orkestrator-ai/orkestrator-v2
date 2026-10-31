import {
  goalForModel,
  goalIsRunning,
  goalPublicView,
  goalSetCommand,
  goalStatusSummary,
  sessionGoal,
  type GoalCommand,
  type NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import { requireCoordinatorWorker } from "./coordinator-surface-actions.js";
import { goalIdForRequest } from "./native-agent-goal-service.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { nativeTabsOfLayout } from "./public-api/summaries.js";
import { surfaceRecord as record } from "./worker-surface-runs.js";

/**
 * Backend commands behind a coordinator's worker goal tools. Each revalidates
 * the authenticated scope, and acts only on a tab this coordinator launched or
 * prompted: the durable delegation record says so, the same ownership status
 * wakes use. A tab a person opened in the same worker is theirs.
 *
 * Workers on another node are not covered. Their delegations settle from the
 * node's turn state, which does not yet know about goals, so a coordinator's
 * wake could arrive between iterations.
 */

interface OwnedTab {
  environmentId: string;
  tabId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
}

async function ownedWorkerTab(
  context: CommandContext,
  caller: CoordinatorCaller,
  input: Record<string, unknown>,
): Promise<OwnedTab> {
  const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
  const tabId = asNonBlankString(input.tabId, "tabId");
  const associations = await context.storage.coordinators.listCoordinatorWorkflowAssociations(
    caller.projectId,
  );
  const owned = associations.some(
    (association) =>
      association.coordinatorId === caller.coordinatorId &&
      association.kind === "environment" &&
      association.nodeId === undefined &&
      association.resourceId === environment.id &&
      association.delegation?.workerTabId === tabId,
  );
  if (!owned) {
    throw new Error(
      "This coordinator did not launch or prompt that tab, so it cannot act on the tab's goal",
    );
  }
  const tab = nativeTabsOfLayout(await context.storage.getPaneLayout(environment.id)).find(
    (candidate) => candidate.tabId === tabId,
  );
  if (!tab) throw new Error(`Native agent tab not found: ${tabId}`);
  return {
    environmentId: environment.id,
    tabId,
    agent: tab.agent,
    logicalSessionKey: nativeTabLogicalSessionKey(environment.id, tabId),
  };
}

async function storedSession(context: CommandContext, tab: OwnedTab) {
  return context.storage.getNativeAgentSession(
    nativeAgentSessionStorageKey(tab.environmentId, tab.agent, tab.logicalSessionKey),
  );
}

function nativeAgentsOf(context: CommandContext) {
  if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
  return context.nativeAgents;
}

function performOn(context: CommandContext, tab: OwnedTab, command: GoalCommand) {
  return nativeAgentsOf(context).performGoalCommand({
    environmentId: tab.environmentId,
    agent: tab.agent,
    logicalSessionKey: tab.logicalSessionKey,
    command,
  });
}

function summaryOf(view: NativeAgentGoalView | undefined) {
  return view ? goalStatusSummary(view) : null;
}

export function registerCoordinatorGoalActions(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  register("set_coordinator_worker_goal", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the goal input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const tab = await ownedWorkerTab(context, caller, input);
    const session = await storedSession(context, tab);
    if (!session) throw new Error("That tab has no conversation yet");
    // The loop waits behind a parked dispatch, and nothing would say why.
    if (session.pendingDispatch || session.pendingSteer) {
      throw new Error("An earlier message to that tab is still awaiting confirmation");
    }
    if (typeof input.objective !== "string") throw new Error("Expected objective");
    // Required here as well as in the tool's schema: limits are never defaulted
    // for a coordinator, which would otherwise spend whatever the default allows.
    if (typeof input.maxIterations !== "number") throw new Error("Expected maxIterations");
    const command = goalSetCommand({
      objective: input.objective,
      maxIterations: input.maxIterations,
      ...(typeof input.check === "string" ? { check: input.check } : {}),
      ...(typeof input.tokenBudget === "number" ? { tokenBudget: input.tokenBudget } : {}),
    });
    if (command.kind === "error") throw new Error(command.message);
    if (command.kind !== "set") throw new Error("Expected a goal");
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "set-worker-goal",
        payload: { environmentId: tab.environmentId, tabId: tab.tabId, command },
      },
      async () => {
        const { goal } = await performOn(context, tab, {
          ...command,
          goalId: goalIdForRequest(`${caller.coordinatorId}\0${requestId}`),
        });
        return {
          environmentId: tab.environmentId,
          tabId: tab.tabId,
          goal: summaryOf(goal),
          wakeOwed: await delegationCovers(context, caller, tab, requestId, dependencies),
        };
      },
    );
  });

  register("get_coordinator_worker_goal", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the goal input");
    const tab = await ownedWorkerTab(context, caller, input);
    const session = await storedSession(context, tab);
    const goal = session ? sessionGoal(session) : undefined;
    return {
      environmentId: tab.environmentId,
      tabId: tab.tabId,
      goal: goal
        ? goalForModel(goalPublicView(goal), {
            ...(goal.lastCheck?.outputTail ? { checkOutput: goal.lastCheck.outputTail } : {}),
          })
        : null,
      history: (session?.goalHistory ?? []).map(goalStatusSummary),
    };
  });

  register("pause_coordinator_worker_goal", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const tab = await ownedWorkerTab(context, caller, record(args.input, "the goal input"));
    const session = await storedSession(context, tab);
    const before = session ? sessionGoal(session) : undefined;
    if (!before) throw new Error("That tab has no goal");
    // A retry after a lost answer finds it already stopped.
    if (!goalIsRunning(before.status)) {
      return { ...tabResult(tab), goal: goalStatusSummary(before), alreadyStopped: true };
    }
    const { goal } = await performOn(context, tab, { kind: "pause" });
    return { ...tabResult(tab), goal: summaryOf(goal) };
  });

  register("clear_coordinator_worker_goal", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const tab = await ownedWorkerTab(context, caller, record(args.input, "the goal input"));
    const session = await storedSession(context, tab);
    const before = session ? sessionGoal(session) : undefined;
    if (!before) return { ...tabResult(tab), cleared: false };
    await performOn(context, tab, { kind: "clear" });
    return { ...tabResult(tab), cleared: true, goalId: before.goalId };
  });
}

function tabResult(tab: OwnedTab) {
  return { environmentId: tab.environmentId, tabId: tab.tabId };
}

/**
 * Make sure this coordinator is owed a wake when the goal stops. An open
 * delegation on the tab already is that wake: the goal holds it back until it
 * stops. A failure here leaves the goal running with no wake, which the result
 * reports rather than promises.
 */
async function delegationCovers(
  context: CommandContext,
  caller: CoordinatorCaller,
  tab: OwnedTab,
  requestId: string,
  dependencies: Pick<RegistryDependencies, "commands">,
): Promise<boolean> {
  const open = await context.storage.coordinators.listOpenCoordinatorDelegations();
  const covering = open.some(
    (association) =>
      association.coordinatorId === caller.coordinatorId &&
      association.conversationId === caller.conversationId &&
      association.kind === "environment" &&
      association.nodeId === undefined &&
      association.resourceId === tab.environmentId &&
      association.delegation?.workerTabId === tab.tabId,
  );
  if (covering) return true;
  try {
    const opened = await dependencies.commands.get("open_coordinator_delegation")?.(
      {
        scope: caller,
        environmentId: tab.environmentId,
        tabId: tab.tabId,
        requestId: `goal:${requestId}`,
      },
      context,
    );
    return (opened as { opened?: unknown } | undefined)?.opened === true;
  } catch (error) {
    console.warn(
      "[coordinator] Could not open a delegation for a worker goal:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
