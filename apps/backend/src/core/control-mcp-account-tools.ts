import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_ACCOUNT_PLATFORMS,
  parseAgentAccountsSnapshot,
  type AgentAccountPlatform,
  type AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import {
  agentAccountSwitchEffect,
  exhaustedUsageWindows,
  usageWindowView,
} from "@orkestrator/protocol/agent-usage-limits";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { isPlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  SCHEDULED_JOB_LIMITS,
  scheduleAccountSwitchGrant,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
import { z } from "zod";
import { createNodeTargets, type NodeTarget } from "./control-mcp-nodes.js";
import {
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * Provider accounts and usage limits for the main coordinator: which agent
 * tabs stopped on a usage limit, which Claude and Codex logins each machine
 * has and how much of their plan is left, and a switch of the active login.
 *
 * The switch goes through `set_active_agent_account`, the command the
 * Settings switch calls, on this machine or another through the node link;
 * nothing here writes a credential. A switch changes which subscription pays
 * for every new turn on that machine, so it is a request the user approves
 * (`switch-agent-account`, like `request_environment_deletion`) unless the
 * self-timer that woke the coordinator carries the user's permission, which
 * only a turn the user started can attach (`remind_me` with
 * `authorizeAccountSwitch`).
 */

export const ACCOUNT_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["get_usage_limits", "environments"],
  // Main coordinator only: side agents are not granted `accounts`.
  ["list_provider_accounts", "accounts"],
  ["switch_provider_account", "accounts"],
];

const NO_ACCOUNTS_NOTE =
  "Only Claude and Codex keep switchable accounts. Grok, Pi, OpenCode and Cursor use one login per machine; signing in another is the user's job in Settings.";

export interface AccountToolContext {
  invoke: ControlMcpInvoker;
  coordinatorScope: CoordinatorControlScope;
  onNode(nodeId: string | undefined): Promise<NodeTarget | null>;
  onNodeResult(target: NodeTarget | null): JsonRecord;
  /** One of this coordinator's schedules, as its owner sees it. */
  getSchedule(scheduleId: string): Promise<ScheduledJob>;
  now?: () => number;
}

interface Machine {
  self: boolean;
  nodeId: string;
  nodeName: string;
  call<T>(command: string, args?: JsonRecord, requestKey?: string): Promise<T>;
}

/**
 * The machine whose accounts a call reads or switches: this one, or another
 * connected node. Accounts belong to the machine, not to a project copy, so
 * unlike the environment tools a node needs no copy of the project.
 */
async function machineFor(invoke: ControlMcpInvoker, nodeId: string | undefined): Promise<Machine> {
  let status: NodeStatus | null = null;
  try {
    status = await invoke<NodeStatus>("get_node_status");
  } catch {
    status = null;
  }
  if (!nodeId || nodeId === status?.nodeId) {
    return {
      self: true,
      nodeId: status?.nodeId ?? "self",
      nodeName: "this machine",
      call: <T>(command: string, args: JsonRecord = {}) => invoke<T>(command, args),
    };
  }
  if (!status) throw new Error("Other machines are unavailable here; omit nodeId.");
  if (status.mode === "leaf") {
    throw new Error("This machine is a leaf node; only its command node reaches other machines.");
  }
  const summaries = await invoke<NodeSummariesResult>("get_node_summaries", { nodeIds: [nodeId] });
  const node = summaries.nodes[0];
  if (!node) throw new Error(`No connected node has ID ${nodeId}. Call list_nodes.`);
  if (!node.available) throw new Error(`${node.view.displayName} is not connected.`);
  const nodeName = node.view.displayName;
  return {
    self: false,
    nodeId,
    nodeName,
    async call<T>(command: string, args: JsonRecord = {}, requestKey?: string): Promise<T> {
      const routed = await invoke<{ outcome: string; result?: T }>("invoke_on_node", {
        nodeId,
        command,
        args,
        ...(requestKey ? { requestKey } : {}),
      });
      if (routed.outcome !== "ok") {
        throw new Error(
          `The connection to ${nodeName} was lost before it answered ${command}; its outcome is unknown. Check before trying again.`,
        );
      }
      return routed.result as T;
    },
  };
}

async function machineAccounts(machine: Machine) {
  const snapshot = parseAgentAccountsSnapshot(await machine.call<unknown>("list_agent_accounts"));
  if (!snapshot) throw new Error(`${machine.nodeName} returned no readable account list.`);
  return snapshot;
}

function usageSummary(value: unknown, now: number): JsonRecord {
  if (!isPlanUsageSnapshot(value)) return { status: "unavailable" };
  const windows = value.windows.map((window) => usageWindowView(window, now));
  const exhausted = exhaustedUsageWindows(value.windows, now);
  const remaining = windows
    .map((window) => window.remainingPercent)
    .filter((percent): percent is number => percent !== undefined);
  return {
    status: value.status,
    ...(value.stale ? { stale: true } : {}),
    fetchedAt: value.fetchedAt,
    ...(value.message ? { message: value.message } : {}),
    ...(value.plan ? { plan: value.plan } : {}),
    windows,
    exhausted: exhausted.length > 0,
    ...(remaining.length ? { lowestRemainingPercent: Math.min(...remaining) } : {}),
    ...(exhausted.length
      ? {
          availableAgainAt: exhausted
            .map((window) => window.resetsAt)
            .filter(Boolean)
            .sort()
            .at(-1),
        }
      : {}),
  };
}

function accountView(account: AgentAccountSummary, usage: JsonRecord | null): JsonRecord {
  const exhausted = usage?.exhausted === true;
  return {
    accountId: account.id,
    label: account.label,
    ...(account.identity.email ? { email: account.identity.email } : {}),
    ...(account.identity.plan ? { plan: account.identity.plan } : {}),
    active: account.isActive,
    hostLogin: account.isDefault,
    signedIn: account.signedIn,
    ...(usage ? { usage } : {}),
    // Known to have allocation left only when a fresh-enough reading says so.
    hasAllocationLeft: !account.signedIn ? false : usage?.status === "ok" ? !exhausted : "unknown",
  };
}

export function registerAccountTools(server: McpServer, context: AccountToolContext): void {
  const { invoke, coordinatorScope: scope } = context;
  const now = () => (context.now ?? Date.now)();
  const { mailbox } = createNodeTargets(invoke, {
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
  });

  server.registerTool(
    "get_usage_limits",
    {
      title: "Find usage-limited workers",
      description:
        "Which agent tabs in this project's environments stopped because their provider account ran out of plan usage (from each tab's last recorded turn; no transcript or bridge reads), and the active accounts' last-known quota windows on that machine (exhaustedWindows lists those used up until resetsAt). Cheap; call it instead of reading every tab. A turn typed into a terminal CLI is not recorded; get_tab_state reads one tab live. With nodeId, of that node's copy of the project.",
      inputSchema: z.object({ nodeId: nodeIdField }),
      annotations: readAnnotations(),
    },
    async ({ nodeId }) => {
      const target = await context.onNode(nodeId);
      const limits = target
        ? await target.call<JsonRecord>("get_project_usage_limits", {
            projectId: target.projectId,
          })
        : await invoke<JsonRecord>("get_project_usage_limits", { projectId: scope.projectId });
      const limited = Array.isArray(limits.limitedTabs) ? limits.limitedTabs.length : 0;
      return toolResult({
        ...limits,
        ...context.onNodeResult(target),
        ...(limited
          ? {
              nextStep:
                "Compare accounts with list_provider_accounts, switch with switch_provider_account, then send each limited tab a short prompt (send_prompt_to_tab, for example 'continue') so it runs again on the new account.",
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "list_provider_accounts",
    {
      title: "List provider accounts and their usage",
      description:
        "List the Claude and Codex logins on this machine (or another with nodeId), which one is active per provider, and each one's plan usage: quota windows with usedPercent, remainingPercent and resetsAt, exhausted, and hasAllocationLeft (true, false, or unknown when no current reading exists: an idle Claude account's usage can only be read while it is in use, so it may show a stale reading). Reads usage endpoints, never runs a model turn. " +
        NO_ACCOUNTS_NOTE,
      inputSchema: z.object({
        nodeId: nodeIdField.describe("A machine from list_nodes; omit for this one."),
        platform: z.enum(AGENT_ACCOUNT_PLATFORMS).optional().describe("Only this provider."),
        includeUsage: z.boolean().optional().describe("Default true. false skips the usage reads."),
      }),
      annotations: { ...readAnnotations(), openWorldHint: true },
    },
    async ({ nodeId, platform, includeUsage }) => {
      const machine = await machineFor(invoke, nodeId);
      const snapshot = await machineAccounts(machine);
      const at = now();
      const platforms = platform ? [platform] : [...AGENT_ACCOUNT_PLATFORMS];
      const providers: JsonRecord = {};
      for (const name of platforms) {
        const accounts = snapshot.accounts.filter((account) => account.platform === name);
        const views = await Promise.all(
          accounts.map(async (account) => {
            if (includeUsage === false || !account.signedIn) return accountView(account, null);
            try {
              const usage = await machine.call<unknown>("get_agent_account_usage", {
                platform: name,
                accountId: account.id,
              });
              return accountView(account, usageSummary(usage, at));
            } catch (error) {
              return accountView(account, {
                status: "error",
                message: error instanceof Error ? error.message.slice(0, 300) : "Usage read failed",
              });
            }
          }),
        );
        providers[name] = { activeAccountId: snapshot.active[name], accounts: views };
      }
      return toolResult({
        machine: { nodeId: machine.nodeId, name: machine.nodeName, self: machine.self },
        providers,
        note: NO_ACCOUNTS_NOTE,
      });
    },
  );

  /**
   * The self-timer's permission, when `scheduleId` names one of this
   * coordinator's timers that carries it for this provider and machine and
   * fired recently enough.
   */
  const timerPermission = async (
    scheduleId: string,
    platform: AgentAccountPlatform,
    machine: Machine,
  ) => {
    const job = await context.getSchedule(scheduleId);
    const grant = scheduleAccountSwitchGrant(job.action);
    if (
      job.owner.kind !== "coordinator" ||
      job.owner.coordinatorId !== scope.coordinatorId ||
      job.owner.projectId !== scope.projectId ||
      job.action.kind !== "action" ||
      job.action.action !== "send_message" ||
      !grant
    ) {
      throw new Error(
        `Timer ${scheduleId} carries no permission to switch accounts. Call again without scheduleId to ask the user.`,
      );
    }
    if (!grant.platforms.includes(platform)) {
      throw new Error(
        `Timer ${scheduleId} may switch ${grant.platforms.join(" and ")} only. Call again without scheduleId to ask the user.`,
      );
    }
    if (!machine.self && !grant.nodeIds?.includes(machine.nodeId)) {
      throw new Error(
        `Timer ${scheduleId} may not switch accounts on ${machine.nodeName}. Call again without scheduleId to ask the user.`,
      );
    }
    const delivered = job.fires
      .filter((fire) => fire.state === "succeeded" && fire.finishedAt)
      .map((fire) => Date.parse(fire.finishedAt!))
      .filter((at) => Number.isFinite(at))
      .sort((left, right) => left - right)
      .at(-1);
    if (delivered === undefined) {
      throw new Error(
        `Timer ${scheduleId} has not fired yet; its permission applies only after it fires.`,
      );
    }
    if (now() - delivered > SCHEDULED_JOB_LIMITS.selfTimerGrantWindowMs) {
      throw new Error(
        `Timer ${scheduleId}'s permission lapsed ${SCHEDULED_JOB_LIMITS.selfTimerGrantWindowMs / 3_600_000} hours after it fired. Call again without scheduleId to ask the user.`,
      );
    }
    return grant;
  };

  server.registerTool(
    "switch_provider_account",
    {
      title: "Switch the active provider account",
      description:
        "Make another signed-in Claude or Codex login the active account for that provider on this machine (or another with nodeId), through the same switch as Settings. Machine-wide: every session of that provider on that machine moves to it on its next turn; a turn already running finishes on the current account; no restart. It changes which subscription is billed, so: with scheduleId of the self-timer that woke you, whose reminder says it carries the user's permission, it switches at once; otherwise it creates a request the user approves in Orkestrator and you are told the outcome by mail. Only when the user asked for a switch, never on your own initiative. Take accountId from list_provider_accounts and prefer one with hasAllocationLeft true.",
      inputSchema: z.object({
        requestId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Stable key for this switch; reuse it only to retry the same call."),
        platform: z.enum(AGENT_ACCOUNT_PLATFORMS),
        accountId: z.string().trim().min(1).max(100),
        reason: z.string().trim().min(1).max(500).describe("What the user asked, in their words."),
        nodeId: nodeIdField.describe("A machine from list_nodes; omit for this one."),
        scheduleId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "The self-timer whose reminder carries the user's permission to switch, so no approval is needed.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, platform, accountId, reason, nodeId, scheduleId }) => {
      const machine = await machineFor(invoke, nodeId);
      const snapshot = await machineAccounts(machine);
      const account = snapshot.accounts.find(
        (entry) => entry.platform === platform && entry.id === accountId,
      );
      if (!account) {
        throw new Error(
          `${machine.nodeName} has no ${platform} account ${accountId}; take one from list_provider_accounts.`,
        );
      }
      const previousAccountId = snapshot.active[platform];
      const machineView = { nodeId: machine.nodeId, name: machine.nodeName, self: machine.self };
      if (account.isActive) {
        return toolResult({
          state: "already-active",
          machine: machineView,
          platform,
          accountId,
          note: `“${account.label}” is already the active ${platform} account there. Nothing changed.`,
        });
      }
      if (!account.signedIn) {
        throw new Error(
          `“${account.label}” is not signed in on ${machine.nodeName}; ask the user to sign it in under Settings → Agent accounts first.`,
        );
      }
      if (scheduleId) {
        const grant = await timerPermission(scheduleId, platform, machine);
        await machine.call(
          "set_active_agent_account",
          { platform, accountId },
          `switch-account:${scope.coordinatorId}:${requestId}`,
        );
        return toolResult({
          state: "switched",
          machine: machineView,
          platform,
          previousAccountId,
          accountId,
          accountLabel: account.label,
          authorizedBy: {
            scheduleId,
            userInstruction: grant.userInstruction,
            grantedAt: grant.grantedAt,
          },
          scope: "machine",
          effect: agentAccountSwitchEffect(platform),
          nextStep:
            "Tell the user which account you switched from and to, on which machine, and why. Tabs stopped on a usage limit need a new prompt to run again.",
        });
      }
      const request = await invoke<JsonRecord>("create_node_action_request", {
        requestId: `switch-account:${scope.coordinatorId}:${requestId}`,
        kind: "switch-agent-account",
        targets: [
          {
            nodeId: machine.nodeId,
            nodeName: machine.nodeName,
            platform,
            accountId,
            accountLabel: account.identity.email
              ? `${account.label} (${account.identity.email})`
              : account.label,
          },
        ],
        requestedBy: { ...(await mailbox()), projectId: scope.projectId },
        reason,
      });
      return toolResult({
        state: "pending",
        approvalRequestId: request.requestId,
        machine: machineView,
        platform,
        previousAccountId,
        accountId,
        scope: "machine",
        effect: agentAccountSwitchEffect(platform),
        note: `Waiting for the user to approve switching the active ${platform} account on ${machine.nodeName} to “${account.label}”. Nothing has changed yet; you will be told the outcome by mail. Finish your turn.`,
      });
    },
  );
}
