import { agentAccountSwitchEffect } from "@orkestrator/protocol/agent-usage-limits";
import { isAgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type { NodeActionRequest } from "./node-action-requests.js";
import { NodeOutcomeUnknownError } from "./node-link.js";
import type { RoutedResult } from "./node-routing.js";

/**
 * Runs an approved `switch-agent-account` request: the same
 * `set_active_agent_account` the Settings switch calls, on this machine
 * directly or on another through the node link (as Settings → Machines
 * does). Nothing here writes a credential; the command only records which
 * existing login is active.
 */

export interface AgentAccountSwitchDeps {
  selfId(): Promise<string> | string;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
  invokeOnNode(input: {
    nodeId: string;
    command: string;
    args: Record<string, unknown>;
    requestKey: string;
  }): Promise<RoutedResult<unknown>>;
}

export async function executeAgentAccountSwitch(
  request: Pick<NodeActionRequest, "requestId" | "targets">,
  deps: AgentAccountSwitchDeps,
): Promise<{ code: string; message: string; outcomeUnknown?: boolean }> {
  const [target] = request.targets;
  if (
    request.targets.length !== 1 ||
    !target ||
    !isAgentAccountPlatform(target.platform) ||
    !target.accountId
  ) {
    throw new Error("An account switch names one machine, one provider and one account.");
  }
  const args = { platform: target.platform, accountId: target.accountId };
  const name = target.accountLabel ?? target.accountId;
  if (target.nodeId === (await deps.selfId())) {
    await deps.invoke("set_active_agent_account", args);
  } else {
    let routed: RoutedResult<unknown>;
    try {
      routed = await deps.invokeOnNode({
        nodeId: target.nodeId,
        command: "set_active_agent_account",
        args,
        requestKey: `switch-account:${request.requestId}`,
      });
    } catch (error) {
      if (!(error instanceof NodeOutcomeUnknownError)) throw error;
      routed = { outcome: "unknown", requestKey: "", outcomeId: "" };
    }
    if (routed.outcome !== "ok") {
      return {
        code: "outcome-unknown",
        message: `The connection to ${target.nodeName} was lost; check its active account in Settings → Machines before trying again.`,
        outcomeUnknown: true,
      };
    }
  }
  return {
    code: "switched",
    message: `The active ${target.platform === "codex" ? "Codex" : "Claude"} account on ${target.nodeName} is now “${name}”. ${agentAccountSwitchEffect(target.platform)}`,
  };
}
