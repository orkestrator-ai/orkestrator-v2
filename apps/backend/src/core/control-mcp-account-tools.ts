import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_ACCOUNT_PLATFORMS,
  parseAgentAccountsSnapshot,
  type AgentAccountPlatform,
  type AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";
import {
  agentAccountSwitchEffect,
  exhaustedUsageWindows,
  usageWindowView,
} from "@orkestrator/protocol/agent-usage-limits";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { COORDINATOR_ACCOUNT_SWITCH_LIMIT } from "@orkestrator/protocol/coordinator-account-switch-grant";
import { isPlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import {
  SCHEDULED_JOB_LIMITS,
  scheduleAccountSwitchGrant,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
import { Schema } from "effect";
import { describe, str, toolInput } from "./tool-schema.js";
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
 * `authorizeAccountSwitch`), or the user gave coordinators standing
 * permission for that provider in Settings
 * (`@orkestrator/protocol/coordinator-account-switch-grant`). The standing
 * permission is this machine's, checked here and again by
 * `run_granted_agent_account_switch` as it records the switch; it still
 * refuses a signed-out or known-exhausted account, and past the hourly limit
 * the switch asks the user after all. A switch either permission allowed is
 * recorded as a request that ran without asking, which is how the user sees
 * it. Resuming the tabs the limit stopped stays the coordinator's job: a
 * switch that ran returns them (`limitedTabs`, `resumeStep`) and an approved
 * one's mail says to read them.
 */

export const ACCOUNT_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["get_usage_limits", "environments"],
  // Main coordinator only: side agents are not granted `accounts`.
  ["list_provider_accounts", "accounts"],
  ["switch_provider_account", "accounts"],
  ["set_account_auto_switch", "accounts"],
];

const PLATFORM_NAMES: Record<AgentAccountPlatform, string> = { claude: "Claude", codex: "Codex" };

function accountName(account: AgentAccountSummary): string {
  return account.identity.email ? `${account.label} (${account.identity.email})` : account.label;
}

/** A recorded switch request, as the account switch commands return it (a `NodeActionRequest`). */
interface GrantedRequest {
  requestId: string;
  state: string;
  authorizedBy?: string;
  result?: { code: string; message: string };
}

/** `run_granted_agent_account_switch`'s answer. */
type GrantedSwitch =
  | { outcome: "not-granted" }
  | { outcome: "over-limit"; recent: number; limit: number; windowMinutes: number }
  | { outcome: "ran" | "existing"; request: GrantedRequest };

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
    measured: value.windows.some(
      (window) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent),
    ),
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

function accountView(
  account: AgentAccountSummary,
  usage: JsonRecord | null,
  autoSwitch: AgentAccountAutoSwitchState | undefined,
): JsonRecord {
  const exhausted = usage?.exhausted === true;
  return {
    ...(autoSwitch
      ? { autoSwitchIncluded: autoSwitch.includedAccountIds.includes(account.id) }
      : {}),
    accountId: account.id,
    label: account.label,
    ...(account.identity.email ? { email: account.identity.email } : {}),
    ...(account.identity.plan ? { plan: account.identity.plan } : {}),
    active: account.isActive,
    hostLogin: account.isDefault,
    signedIn: account.signedIn,
    ...(usage ? { usage } : {}),
    // Known to have allocation left only when a fresh-enough reading says so.
    hasAllocationLeft: !account.signedIn
      ? false
      : usage?.status === "ok" && usage.stale !== true && usage.measured === true
        ? !exhausted
        : "unknown",
  };
}

function autoSwitchView(state: AgentAccountAutoSwitchState): JsonRecord {
  return {
    mode: state.mode,
    ...(state.pinnedAccountId ? { pinnedAccountId: state.pinnedAccountId } : {}),
    includedAccountIds: state.includedAccountIds,
    ...(state.lastSwitch ? { lastSwitch: state.lastSwitch } : {}),
    meaning:
      state.mode === "automatic"
        ? "The backend moves this machine by itself. A manual switch pins it and turns this off."
        : state.mode === "pinned"
          ? "A manual switch pinned this account. Automatic switching stays off until the tick is set again."
          : "Automatic switching is off.",
  };
}

/**
 * The standing permission never switches to an account its usage reading says
 * is used up. No reading (an idle Claude account often has none) is not
 * evidence either way, so it does not refuse.
 */
async function refuseExhausted(
  machine: Machine,
  platform: AgentAccountPlatform,
  account: AgentAccountSummary,
  at: number,
): Promise<void> {
  let reading: unknown;
  try {
    reading = await machine.call<unknown>("get_agent_account_usage", {
      platform,
      accountId: account.id,
    });
  } catch {
    return;
  }
  if (!isPlanUsageSnapshot(reading)) return;
  const exhausted = exhaustedUsageWindows(reading.windows, at);
  if (exhausted.length === 0) return;
  const until = exhausted
    .map((window) => window.resetsAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  throw new Error(
    `“${account.label}” has used up its ${PLATFORM_NAMES[platform]} plan on ${machine.nodeName}${until ? ` until ${until}` : ""}, so it is not switched to without the user, even with the standing permission. Pick an account with hasAllocationLeft true from list_provider_accounts.`,
  );
}

/**
 * The tabs a switch should resume: this project's tabs on that machine whose
 * newest recorded turn stopped on that provider's usage limit, from the same
 * reader as `get_usage_limits`. `undefined` when it cannot be read.
 */
export type ResumeTabs = JsonRecord[] | undefined;

/** What the coordinator does about the limited tabs once a switch ran. */
export function resumeAfterSwitch(tabs: ResumeTabs): JsonRecord {
  if (tabs === undefined) {
    return {
      resumeStep:
        "Call get_usage_limits to find the tabs that stopped on this provider's usage limit, then send each a short prompt with send_prompt_to_tab (for example 'continue') so it runs on the new account.",
    };
  }
  if (tabs.length === 0) {
    return {
      limitedTabs: [],
      resumeStep:
        "No tab of this project is recorded as stopped on this provider's usage limit, so there is nothing to resume.",
    };
  }
  return {
    limitedTabs: tabs,
    resumeStep:
      "Resume each tab in limitedTabs: send it one short prompt with send_prompt_to_tab (for example 'continue'), so it runs again on the new account. Only these tabs: any other tab was not stopped by the limit, and a tab that is busy now was already resumed. Each one wakes you when its turn ends.",
  };
}

/**
 * The answer for a switch that ran without asking, under the standing
 * permission or a self-timer's. Either way it is recorded where the user sees
 * it, and there is nothing for the user to approve.
 */
async function unattendedResult(
  request: GrantedRequest,
  view: {
    machineView: JsonRecord;
    platform: AgentAccountPlatform;
    previousAccountId: string | undefined;
    accountId: string;
    accountLabel: string;
  },
  authorizedBy: JsonRecord,
  resume: () => Promise<ResumeTabs>,
) {
  const permission =
    request.authorizedBy === "self-timer" ? "the timer's permission" : "the standing permission";
  if (request.state === "failed") {
    throw new Error(
      `The switch under ${permission} failed: ${request.result?.message ?? "no reason given"}.`,
    );
  }
  const base = {
    machine: view.machineView,
    platform: view.platform,
    previousAccountId: view.previousAccountId,
    accountId: view.accountId,
    accountLabel: view.accountLabel,
    authorizedBy,
    scope: "machine",
  };
  if (request.state === "outcome-unknown") {
    return toolResult({
      ...base,
      state: "outcome-unknown",
      note: `${request.result?.message ?? "The outcome is unknown."} No approval was needed; do not ask the user to approve it.`,
    });
  }
  if (request.state !== "executed") {
    return toolResult({
      ...base,
      state: "switching",
      note: `This switch is already running under ${permission}. Check list_provider_accounts before calling again.`,
    });
  }
  return toolResult({
    ...base,
    state: "switched",
    effect: agentAccountSwitchEffect(view.platform),
    nextStep:
      request.authorizedBy === "self-timer"
        ? "It already ran under the permission the user gave this timer; it is listed for them with the account. Tell the user which account you switched from and to, on which machine, and why. Then follow resumeStep."
        : "It already ran: the user allowed coordinators to switch without asking, so there is nothing for them to approve. Tell the user which account you switched from and to, on which machine, and why. Then follow resumeStep.",
    ...resumeAfterSwitch(await resume()),
  });
}

/** The answer when the `requestId` already named a request the user was asked about. */
function existingRequestResult(
  request: GrantedRequest,
  requestId: string,
  machineView: JsonRecord,
  platform: AgentAccountPlatform,
  accountId: string,
) {
  return toolResult({
    state: request.state,
    approvalRequestId: request.requestId,
    machine: machineView,
    platform,
    accountId,
    ...(request.result ? { result: request.result } : {}),
    note:
      request.state === "pending"
        ? `requestId ${requestId} already asked the user to approve this switch. Nothing has changed yet; you will be told the outcome by mail.`
        : `requestId ${requestId} was already used for this switch, which is ${request.state}. Use a new requestId for a new switch.`,
  });
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
      inputSchema: toolInput(Schema.Struct({ nodeId: nodeIdField })),
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
      const snapshot = limited
        ? await machineAccounts(await machineFor(invoke, nodeId))
        : undefined;
      const automatic =
        snapshot &&
        Object.values(snapshot.autoSwitch ?? {}).some((state) => state.mode === "automatic");
      return toolResult({
        ...limits,
        ...context.onNodeResult(target),
        ...(limited
          ? {
              nextStep: automatic
                ? "Automatic recovery is active: the backend handles confirmed 5-hour and weekly limit stops and resends them when the bridge is idle. Wait for its outcome; no coordinator action is needed."
                : "Compare accounts with list_provider_accounts, switch with switch_provider_account, then send each limited tab a short prompt (send_prompt_to_tab, for example 'continue') so it runs again on the new account.",
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
      inputSchema: toolInput(
        Schema.Struct({
          nodeId: describe(nodeIdField, "A machine from list_nodes; omit for this one."),
          platform: Schema.optionalKey(
            describe(Schema.Literals(AGENT_ACCOUNT_PLATFORMS), "Only this provider."),
          ),
          includeUsage: Schema.optionalKey(
            describe(Schema.Boolean, "Default true. false skips the usage reads."),
          ),
        }),
      ),
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
        const autoSwitch = snapshot.autoSwitch?.[name];
        const views = await Promise.all(
          accounts.map(async (account) => {
            if (includeUsage === false || !account.signedIn) {
              return accountView(account, null, autoSwitch);
            }
            try {
              const usage = await machine.call<unknown>("get_agent_account_usage", {
                platform: name,
                accountId: account.id,
              });
              return accountView(account, usageSummary(usage, at), autoSwitch);
            } catch (error) {
              return accountView(
                account,
                {
                  status: "error",
                  message:
                    error instanceof Error ? error.message.slice(0, 300) : "Usage read failed",
                },
                autoSwitch,
              );
            }
          }),
        );
        providers[name] = {
          activeAccountId: snapshot.active[name],
          ...(autoSwitch ? { autoSwitch: autoSwitchView(autoSwitch) } : {}),
          accounts: views,
        };
      }
      return toolResult({
        machine: { nodeId: machine.nodeId, name: machine.nodeName, self: machine.self },
        providers,
        note: NO_ACCOUNTS_NOTE,
      });
    },
  );

  server.registerTool(
    "set_account_auto_switch",
    {
      title: "Change automatic account switching",
      description:
        "Turn automatic account switching on or off for a provider, or change whether one account is included. When on, the backend keeps the machine on the included signed-in account with room whose general weekly limit resets soonest, staying put unless another login resets more than an hour sooner and counting entries with the same email as one login. It moves on at 98% of that limit or of the 5-hour limit, or when a fresh reading confirms a limit error used one up, comes back when that 5-hour limit resets, and resends the work either limit stopped. The ticks apply on every machine this one controls, matched by email; an account with no email has its tick on its own machine only and stays out until ticked. With enabled true it also ends this machine's pin, or the pin on nodeId, left by a manual switch, and no other machine's. A machine with a command node takes the shared ticks from it and refuses to change them, but can still end its own pin and change the tick of an account with no email. list_provider_accounts shows the state. The coordinator is authorized to change email-matched ticks and end pins only when the user explicitly asked; these changes can move subscriptions and trigger automatic recovery. No-email accounts must be included by the user in Settings.",
      inputSchema: toolInput(
        Schema.Struct({
          platform: Schema.Literals(AGENT_ACCOUNT_PLATFORMS),
          enabled: Schema.optionalKey(describe(Schema.Boolean, "The provider's main tick.")),
          accountId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 100 }),
              "One account from list_provider_accounts, with included.",
            ),
          ),
          included: Schema.optionalKey(describe(Schema.Boolean, "That account's own tick.")),
          nodeId: describe(
            nodeIdField,
            "The machine the account or pin is on; omit for this one. The ticks themselves stay here.",
          ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ platform, enabled, accountId, included, nodeId }) => {
      if (enabled === undefined && accountId === undefined) {
        throw new Error("Pass enabled, or accountId with included.");
      }
      if ((accountId === undefined) !== (included === undefined)) {
        throw new Error("accountId and included go together.");
      }
      const machine = await machineFor(invoke, nodeId);
      if (accountId !== undefined && included === true) {
        const account = (await machineAccounts(machine)).accounts.find(
          (entry) => entry.platform === platform && entry.id === accountId,
        );
        if (account && !account.identity.email)
          throw new Error(
            "Include no-email accounts in Settings; coordinator tools cannot authorize their billing identity.",
          );
      }
      if (enabled !== undefined) {
        // Already as asked, this only ends a pin. A leaf can do that, but not set the
        // tick its command node holds.
        const here = parseAgentAccountsSnapshot(await invoke<unknown>("list_agent_accounts"))
          ?.autoSwitch?.[platform];
        if (!here || (here.mode !== "off") !== enabled) {
          await invoke("set_agent_account_auto_switch", { platform, enabled });
        }
        // A machine that predates this reports no state, so has no pin to end.
        if (enabled && (await machineAccounts(machine)).autoSwitch?.[platform]?.pinnedAccountId) {
          await machine.call("resume_agent_account_auto_switch", { platform });
        }
      }
      if (accountId !== undefined && included !== undefined) {
        const account = (await machineAccounts(machine)).accounts.find(
          (entry) => entry.platform === platform && entry.id === accountId,
        );
        if (!account) {
          throw new Error(
            `${machine.nodeName} has no ${platform} account ${accountId}; take one from list_provider_accounts.`,
          );
        }
        const email = account.identity.email;
        if (email) {
          await invoke("set_agent_account_auto_switch", { platform, email, included });
        } else {
          await machine.call("set_agent_account_auto_switch", { platform, accountId, included });
        }
      }
      const state = (await machineAccounts(machine)).autoSwitch?.[platform];
      return toolResult({
        machine: { nodeId: machine.nodeId, name: machine.nodeName, self: machine.self },
        platform,
        ...(state ? { autoSwitch: autoSwitchView(state) } : {}),
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
      !grant ||
      job.trigger.kind !== "once"
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
        "Make another signed-in Claude or Codex login the active account for that provider on this machine (or another with nodeId), through the same switch as Settings. Machine-wide: every session of that provider on that machine moves to it on its next turn; a turn already running finishes on the current account; no restart. " +
        `It changes which subscription is billed, so it needs the user's permission, in one of three forms. (1) With scheduleId of the self-timer that woke you, whose reminder says it carries the user's permission, it switches at once. (2) When the user turned on "Let coordinators switch accounts without asking" for that provider in Settings on this machine, it switches at once with no approval, on this machine and on machines this one controls (state switched, authorizedBy standing-grant); the user is shown each such switch, but you still tell them what you did. Even then it refuses a signed-out account or one whose usage reading says it is used up, and after ${COORDINATOR_ACCOUNT_SWITCH_LIMIT.switches} switches of one provider on one machine within an hour it asks the user instead and says why. (3) Otherwise it creates a request the user approves in Orkestrator and you are told the outcome by mail. Read state in the result: only pending means the user must approve; never ask the user to approve a switch that already ran. Only switch when the user asked for switches, never on your own initiative; the standing permission is that request made in advance. Take accountId from list_provider_accounts and prefer one with hasAllocationLeft true. Like any manual switch, it pins the account while automatic switching is on. A switch that ran lists limitedTabs, this project's tabs on that machine whose last turn stopped on that provider's usage limit: nothing restarts them, so send each one short prompt with send_prompt_to_tab (resumeStep says so).`,
      inputSchema: toolInput(
        Schema.Struct({
          requestId: describe(
            str({ trim: true, min: 1, max: 200 }),
            "Stable key for this switch; reuse it only to retry the same call.",
          ),
          platform: Schema.Literals(AGENT_ACCOUNT_PLATFORMS),
          accountId: str({ trim: true, min: 1, max: 100 }),
          reason: describe(
            str({ trim: true, min: 1, max: 500 }),
            "What the user asked, in their words, and why this account now. Shown to the user with the switch.",
          ),
          nodeId: describe(nodeIdField, "A machine from list_nodes; omit for this one."),
          scheduleId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 100 }),
              "The self-timer whose reminder carries the user's permission to switch, so no approval is needed. Not needed when Settings already lets coordinators switch without asking.",
            ),
          ),
        }),
      ),
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
      const switchRequestId = `switch-account:${scope.coordinatorId}:${requestId}`;
      const requestedBy = { ...(await mailbox()), projectId: scope.projectId };
      const target = {
        nodeId: machine.nodeId,
        nodeName: machine.nodeName,
        platform,
        accountId,
        accountLabel: accountName(account),
      };
      const previous = snapshot.accounts.find(
        (entry) => entry.platform === platform && entry.id === previousAccountId,
      );
      // Read once the switch ran: the tabs of this project on that machine
      // whose last turn stopped on this provider's limit.
      const resumeTabs = async (): Promise<ResumeTabs> => {
        try {
          const target = machine.self ? null : await context.onNode(machine.nodeId);
          if (!machine.self && !target) return undefined;
          const limits = target
            ? await target.call<JsonRecord>("get_project_usage_limits", {
                projectId: target.projectId,
              })
            : await invoke<JsonRecord>("get_project_usage_limits", {
                projectId: scope.projectId,
              });
          if (!Array.isArray(limits.limitedTabs)) return undefined;
          return (limits.limitedTabs as JsonRecord[])
            .filter((tab) => tab.agent === platform)
            .map((tab) => ({
              environmentId: tab.environmentId,
              environmentName: tab.environmentName,
              tabId: tab.tabId,
              observedAt: tab.observedAt,
              ...(tab.signal ? { signal: tab.signal } : {}),
              ...(target ? { nodeId: machine.nodeId } : {}),
            }));
        } catch {
          return undefined;
        }
      };
      const previousTarget = {
        ...(previousAccountId ? { previousAccountId } : {}),
        ...(previous ? { previousAccountLabel: accountName(previous) } : {}),
      };
      if (scheduleId) {
        const grant = await timerPermission(scheduleId, platform, machine);
        // Recorded as a request that ran without asking, so the user sees it
        // with the switches the standing permission made.
        const run = await invoke<{ request: GrantedRequest }>("run_timer_agent_account_switch", {
          requestId: switchRequestId,
          ...target,
          ...previousTarget,
          requestedBy,
          reason,
          selfTimer: {
            scheduleId,
            userInstruction: grant.userInstruction,
            grantedAt: grant.grantedAt,
          },
        });
        if (run.request.authorizedBy !== "self-timer") {
          // The same requestId already asked the user; report that request.
          return existingRequestResult(run.request, requestId, machineView, platform, accountId);
        }
        return await unattendedResult(
          run.request,
          {
            machineView,
            platform,
            previousAccountId,
            accountId,
            accountLabel: account.label,
          },
          {
            scheduleId,
            userInstruction: grant.userInstruction,
            grantedAt: grant.grantedAt,
            recordId: run.request.requestId,
          },
          resumeTabs,
        );
      }
      let askedBecause: string | undefined;
      // A permission that cannot be read is not a permission: ask instead.
      const granted = await invoke<{ grants?: Partial<Record<AgentAccountPlatform, boolean>> }>(
        "get_coordinator_account_switch_grant",
        { platform },
      ).then(
        (state) => state.grants?.[platform] === true,
        () => false,
      );
      if (granted) {
        await refuseExhausted(machine, platform, account, now());
        const run = await invoke<GrantedSwitch>("run_granted_agent_account_switch", {
          requestId: switchRequestId,
          ...target,
          ...previousTarget,
          requestedBy,
          reason,
        });
        if (run.outcome === "ran" || run.outcome === "existing") {
          const { request } = run;
          if (request.authorizedBy) {
            return await unattendedResult(
              request,
              {
                machineView,
                platform,
                previousAccountId,
                accountId,
                accountLabel: account.label,
              },
              { setting: "standing-grant", recordId: request.requestId },
              resumeTabs,
            );
          }
          // The same requestId already asked the user; report that request.
          return existingRequestResult(request, requestId, machineView, platform, accountId);
        }
        if (run.outcome === "over-limit") {
          askedBecause = `Coordinators already switched the active ${PLATFORM_NAMES[platform]} account on ${machine.nodeName} ${run.recent} times in the last ${run.windowMinutes} minutes, the most Settings allows without asking.`;
        }
        // not-granted: the user turned it off since the read; ask as before.
      }
      const request = await invoke<JsonRecord>("create_node_action_request", {
        requestId: switchRequestId,
        kind: "switch-agent-account",
        targets: [target],
        requestedBy,
        reason,
        ...(askedBecause ? { askedBecause } : {}),
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
        ...(askedBecause ? { askedBecause } : {}),
        note: `${askedBecause ? `${askedBecause} So this one needs approval. ` : ""}Waiting for the user to approve switching the active ${platform} account on ${machine.nodeName} to “${account.label}”. Nothing has changed yet; you will be told the outcome by mail. Finish your turn.`,
      });
    },
  );
}
