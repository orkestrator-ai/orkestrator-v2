import { coordinatorAccountSwitchedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendEmit } from "../backend-emit.js";
import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import {
  COORDINATOR_ACCOUNT_SWITCH_LIMIT,
  MAX_LISTED_COORDINATOR_ACCOUNT_SWITCHES,
  normalizeCoordinatorAccountSwitchGrants,
  type CoordinatorAccountSwitchGrantState,
  type CoordinatorAccountSwitchRecord,
} from "@orkestrator/protocol/coordinator-account-switch-grant";
import type { NodeActionRequest, NodeActionRequests } from "./node-action-requests.js";

/**
 * The user's standing permission for coordinators to switch accounts without
 * asking (`coordinatorAccountSwitchGrant` in this machine's global config).
 *
 * The permission is read here, on the machine whose coordinator asked, which
 * is also where an approval request would otherwise be filed: a command node
 * decides for the switches its coordinators make on its leaves, and a leaf
 * only receives the same `set_active_agent_account` an approved request sends,
 * so an older leaf needs nothing new. Every run is recorded in the request
 * store, which is also what the hourly limit counts, so the limit survives a
 * restart and the user can read each switch afterwards.
 */

export interface AccountSwitchGrantDeps {
  actions: NodeActionRequests;
  /** This machine's own global config. */
  loadGlobalConfig(): Promise<{ coordinatorAccountSwitchGrant?: unknown }>;
  projectName(projectId: string): Promise<string | undefined>;
  emit: BackendEmit;
}

export type GrantedAccountSwitchOutcome =
  | { outcome: "not-granted" }
  | { outcome: "over-limit"; recent: number; limit: number; windowMinutes: number }
  | { outcome: "ran" | "existing"; request: NodeActionRequest };

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Whether the user granted coordinators on this machine `platform` switches. */
export async function accountSwitchGranted(
  deps: Pick<AccountSwitchGrantDeps, "loadGlobalConfig">,
  platform: AgentAccountPlatform,
): Promise<boolean> {
  const global = await deps.loadGlobalConfig();
  return (
    normalizeCoordinatorAccountSwitchGrants(global.coordinatorAccountSwitchGrant)[platform] === true
  );
}

/** The switch's target and requester, from a command's arguments. */
function switchTarget(args: Record<string, unknown>) {
  const platform = args.platform;
  if (!isAgentAccountPlatform(platform)) throw new Error("Expected platform claude or codex.");
  const requestId = bounded(args.requestId, 256);
  const nodeId = bounded(args.nodeId, 256);
  const nodeName = bounded(args.nodeName, 64);
  const accountId = bounded(args.accountId, 100);
  const by = args.requestedBy as Record<string, unknown> | undefined;
  if (!requestId || !nodeId || !nodeName || !accountId) {
    throw new Error("Expected requestId, nodeId, nodeName and accountId.");
  }
  if (
    !by ||
    typeof by.coordinatorEnvironmentId !== "string" ||
    typeof by.coordinatorTabId !== "string" ||
    typeof by.projectId !== "string"
  ) {
    throw new Error("Expected the requesting coordinator.");
  }
  const accountLabel = bounded(args.accountLabel, 1024);
  const previousAccountId = bounded(args.previousAccountId, 100);
  const previousAccountLabel = bounded(args.previousAccountLabel, 1024);
  return {
    platform,
    requestId,
    nodeId,
    reason: bounded(args.reason, 500),
    target: {
      nodeId,
      nodeName,
      platform,
      accountId,
      ...(accountLabel ? { accountLabel } : {}),
      ...(previousAccountId ? { previousAccountId } : {}),
      ...(previousAccountLabel ? { previousAccountLabel } : {}),
    },
    requestedBy: {
      coordinatorEnvironmentId: by.coordinatorEnvironmentId,
      coordinatorTabId: by.coordinatorTabId,
      projectId: by.projectId,
    },
  };
}

async function coordinatorName(
  deps: Pick<AccountSwitchGrantDeps, "projectName">,
  projectId: string,
): Promise<string> {
  const projectName = await deps.projectName(projectId).catch(() => undefined);
  return projectName ? `${projectName} coordinator` : "Project coordinator";
}

/**
 * Run and record a switch the self-timer that woke the coordinator allows.
 * The caller (`switch_provider_account`) has checked that timer's permission:
 * its owner, provider, machines and the window since it fired. This records
 * the switch as already approved, with the user's words, and runs it, so the
 * user sees it with the standing permission's switches. It takes no hourly
 * limit: it is one switch the user asked for in their own turn.
 */
export async function runTimerAccountSwitch(
  deps: AccountSwitchGrantDeps,
  args: Record<string, unknown>,
): Promise<{ outcome: "ran" | "existing"; request: NodeActionRequest }> {
  const { requestId, reason, target, requestedBy } = switchTarget(args);
  const timer = args.selfTimer as Record<string, unknown> | undefined;
  const scheduleId = bounded(timer?.scheduleId, 100);
  const userInstruction = bounded(timer?.userInstruction, 500);
  const grantedAt = bounded(timer?.grantedAt, 64);
  if (!scheduleId || !userInstruction || !grantedAt) {
    throw new Error("Expected the self-timer's scheduleId, userInstruction and grantedAt.");
  }
  const result = await deps.actions.runUnattended(
    {
      requestId,
      kind: "switch-agent-account",
      targets: [target],
      requestedBy,
      ...(reason ? { reason } : {}),
      coordinatorName: await coordinatorName(deps, requestedBy.projectId),
      authorizedBy: "self-timer",
      selfTimer: { scheduleId, userInstruction, grantedAt },
    },
    null,
  );
  if ("overLimit" in result) throw new Error("A self-timer's switch has no limit.");
  if (result.ran) {
    const record = accountSwitchRecord(result.request);
    if (record) deps.emit(coordinatorAccountSwitchedEvent, record);
  }
  return { outcome: result.ran ? "ran" : "existing", request: result.request };
}

/**
 * Switch at once under the standing permission, or say why not. The account
 * checks (signed in, not known to be exhausted) are the caller's, which has
 * the account list and usage readings in hand; this owns the permission, the
 * limit and the record.
 */
export async function runGrantedAccountSwitch(
  deps: AccountSwitchGrantDeps,
  args: Record<string, unknown>,
): Promise<GrantedAccountSwitchOutcome> {
  const { platform, requestId, nodeId, reason, target, requestedBy } = switchTarget(args);
  // Read on every call, so turning it off takes effect for the next one.
  if (!(await accountSwitchGranted(deps, platform))) return { outcome: "not-granted" };
  const result = await deps.actions.runUnattended(
    {
      requestId,
      kind: "switch-agent-account",
      targets: [target],
      requestedBy,
      ...(reason ? { reason } : {}),
      coordinatorName: await coordinatorName(deps, requestedBy.projectId),
    },
    {
      count: COORDINATOR_ACCOUNT_SWITCH_LIMIT.switches,
      windowMs: COORDINATOR_ACCOUNT_SWITCH_LIMIT.windowMs,
      scope: (request) =>
        request.kind === "switch-agent-account" &&
        request.targets[0]?.nodeId === nodeId &&
        request.targets[0]?.platform === platform,
    },
  );
  if ("overLimit" in result) {
    return {
      outcome: "over-limit",
      recent: result.overLimit.recent,
      limit: COORDINATOR_ACCOUNT_SWITCH_LIMIT.switches,
      windowMinutes: COORDINATOR_ACCOUNT_SWITCH_LIMIT.windowMs / 60_000,
    };
  }
  if (result.ran) {
    const record = accountSwitchRecord(result.request);
    if (record) deps.emit(coordinatorAccountSwitchedEvent, record);
  }
  return { outcome: result.ran ? "ran" : "existing", request: result.request };
}

/** A recorded unattended switch as the user reads it, or `null` for any other request. */
export function accountSwitchRecord(
  request: NodeActionRequest,
): CoordinatorAccountSwitchRecord | null {
  const [target] = request.targets;
  if (
    request.kind !== "switch-agent-account" ||
    !request.authorizedBy ||
    !target ||
    !isAgentAccountPlatform(target.platform) ||
    !target.accountId
  )
    return null;
  return {
    authorizedBy: request.authorizedBy,
    ...(request.selfTimer
      ? {
          scheduleId: request.selfTimer.scheduleId,
          userInstruction: request.selfTimer.userInstruction,
        }
      : {}),
    requestId: request.requestId,
    at: request.createdAt,
    platform: target.platform,
    nodeId: target.nodeId,
    nodeName: target.nodeName,
    ...(target.previousAccountId ? { fromAccountId: target.previousAccountId } : {}),
    ...(target.previousAccountLabel ? { fromAccountLabel: target.previousAccountLabel } : {}),
    toAccountId: target.accountId,
    toAccountLabel: target.accountLabel ?? target.accountId,
    coordinatorName: request.coordinatorName ?? "Project coordinator",
    ...(request.reason ? { reason: request.reason } : {}),
    state: request.state,
    ...(request.result?.message ? { message: request.result.message } : {}),
  };
}

/** The permission per provider and the switches made without asking, newest first. */
export async function accountSwitchGrantState(
  deps: Pick<AccountSwitchGrantDeps, "loadGlobalConfig"> & {
    actions: Pick<NodeActionRequests, "list"> | null;
  },
  platform?: AgentAccountPlatform,
): Promise<CoordinatorAccountSwitchGrantState> {
  const grants = normalizeCoordinatorAccountSwitchGrants(
    (await deps.loadGlobalConfig()).coordinatorAccountSwitchGrant,
  );
  const records = deps.actions
    ? (await deps.actions.list())
        .map(accountSwitchRecord)
        .filter(
          (record): record is CoordinatorAccountSwitchRecord =>
            record !== null && (!platform || record.platform === platform),
        )
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, MAX_LISTED_COORDINATOR_ACCOUNT_SWITCHES)
    : [];
  return {
    grants: { claude: grants.claude === true, codex: grants.codex === true },
    limit: {
      switches: COORDINATOR_ACCOUNT_SWITCH_LIMIT.switches,
      windowMinutes: COORDINATOR_ACCOUNT_SWITCH_LIMIT.windowMs / 60_000,
    },
    recentSwitches: records,
  };
}
