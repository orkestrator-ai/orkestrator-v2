/**
 * Bounded waiting for an agent branch: the idle-poll grace of a turn that
 * settled without a result, a dispatch whose acceptance cannot be confirmed,
 * an unreachable provider, and the terminal failure that ends a branch which
 * can make no further progress.
 */
import { REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS } from "@orkestrator/protocol/review-fanout";
import type { AgentBranchContext } from "./agent-branch-commits.js";
import {
  agentBranchErrorMessage,
  agentBranchNowIso,
  type AgentBranchFailureKind,
  type AgentBranchRecord,
} from "./agent-branch-types.js";

/** Bounds how long a settled session may be polled for a missing result. */
export const AGENT_BRANCH_MAX_IDLE_RESULT_POLLS = REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS;

export function agentBranchPollScope<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  kind: "idle" | "usage",
): string {
  return `${context.host.workflowId}\0${branch.id}\0${kind}`;
}

/** Allocation is not acceptance; legacy sent journals still prove startup. */
export function classifyAgentBranchStartFailure(branch: AgentBranchRecord): void {
  if (branch.agentStarted ?? branch.dispatchState === "sent") delete branch.startFailed;
  else branch.startFailed = true;
}

/** Ends a branch that can make no further progress, best-effort aborting its turn. */
export async function failAgentBranch<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  error: string,
  kind: AgentBranchFailureKind = "provider",
): Promise<"continue"> {
  if (branch.providerSessionId) {
    await context.host.abandonSession(branch, branch.providerSessionId);
    context.host.progress.forget(branch.providerSessionId);
  }
  branch.status = "failed";
  classifyAgentBranchStartFailure(branch);
  branch.error = error;
  branch.completedAt = agentBranchNowIso();
  delete branch.stalledSince;
  context.host.branchFailed?.(branch, kind);
  await context.commits.commit();
  return "continue";
}

/**
 * Counts one stalled poll, failing the branch once the bound is reached.
 * `error` may be deferred so a costly explanation is built only then.
 * `retry`, when given, may claim the exhausted bound for one more turn
 * instead of failing.
 */
export async function recordAgentBranchStall<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  error: string | (() => Promise<string>),
  retry?: () => Promise<boolean>,
  kind: AgentBranchFailureKind = "provider",
): Promise<"continue" | "stop"> {
  const scope = agentBranchPollScope(context, branch, "idle");
  const gate = context.host.pollGate;
  if (gate && !gate.count(scope)) return "continue";
  branch.idleResultPolls = Math.min(
    (branch.idleResultPolls ?? 0) + 1,
    AGENT_BRANCH_MAX_IDLE_RESULT_POLLS,
  );
  if (
    branch.idleResultPolls >= AGENT_BRANCH_MAX_IDLE_RESULT_POLLS ||
    gate?.exhausted(scope, branch.idleResultPolls, AGENT_BRANCH_MAX_IDLE_RESULT_POLLS)
  ) {
    if (retry && (await retry())) return "stop";
    return failAgentBranch(
      context,
      branch,
      typeof error === "string" ? error : await error(),
      kind,
    );
  }
  await context.commits.commit();
  return "continue";
}

export function recordAgentBranchUnavailable<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  error: unknown,
): Promise<"continue" | "stop"> {
  return recordAgentBranchStall(
    context,
    branch,
    `The ${context.host.wording.subject}'s ${branch.agent} provider stayed unreachable: ${agentBranchErrorMessage(error)}`,
  );
}

/** Observed progress restarts the idle and final-usage windows. */
export async function clearAgentBranchStall<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
): Promise<"continue"> {
  if (branch.idleResultPolls === undefined && branch.usageFinalizationPolls === undefined)
    return "continue";
  delete branch.idleResultPolls;
  delete branch.usageFinalizationPolls;
  context.host.pollGate?.clear(agentBranchPollScope(context, branch, "idle"));
  context.host.pollGate?.clear(agentBranchPollScope(context, branch, "usage"));
  await context.commits.commit();
  return "continue";
}
