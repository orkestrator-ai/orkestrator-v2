import {
  isAgentAccountPlatform,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import {
  COORDINATOR_ACCOUNT_SWITCH_LIMIT,
  COORDINATOR_ACCOUNT_SWITCHED_EVENT,
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
  emit(event: string, payload: unknown): void;
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
  // Read on every call, so turning it off takes effect for the next one.
  if (!(await accountSwitchGranted(deps, platform))) return { outcome: "not-granted" };
  const accountLabel = bounded(args.accountLabel, 1024);
  const previousAccountId = bounded(args.previousAccountId, 100);
  const previousAccountLabel = bounded(args.previousAccountLabel, 1024);
  const reason = bounded(args.reason, 500);
  const projectName = await deps.projectName(by.projectId).catch(() => undefined);
  const result = await deps.actions.runUnattended(
    {
      requestId,
      kind: "switch-agent-account",
      targets: [
        {
          nodeId,
          nodeName,
          platform,
          accountId,
          ...(accountLabel ? { accountLabel } : {}),
          ...(previousAccountId ? { previousAccountId } : {}),
          ...(previousAccountLabel ? { previousAccountLabel } : {}),
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: by.coordinatorEnvironmentId,
        coordinatorTabId: by.coordinatorTabId,
        projectId: by.projectId,
      },
      ...(reason ? { reason } : {}),
      coordinatorName: projectName ? `${projectName} coordinator` : "Project coordinator",
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
    if (record) deps.emit(COORDINATOR_ACCOUNT_SWITCHED_EVENT, record);
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
    request.authorizedBy !== "standing-grant" ||
    !target ||
    !isAgentAccountPlatform(target.platform) ||
    !target.accountId
  )
    return null;
  return {
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

/** The permission per provider and the switches it allowed, newest first. */
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
