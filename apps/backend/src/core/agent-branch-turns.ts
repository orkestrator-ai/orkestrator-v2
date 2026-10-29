/**
 * Follow-up turns of an agent branch, each sent in the same session under a
 * new request id after the previous slot is retired: the bounded schema
 * repair, the one result reminder, the one continuation after a provider
 * restart, and an owner's own continuation (a graph node's `ask_human`
 * answer). Each is journaled `prepared` here and sent by the runner's
 * dispatch path on a later step, exactly like the original prompt.
 */
import { randomUUID } from "node:crypto";
import { REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS } from "@orkestrator/protocol/review-fanout";
import type { AgentBranchContext } from "./agent-branch-commits.js";
import { agentBranchPollScope } from "./agent-branch-stall.js";
import {
  agentBranchNowIso,
  type AgentBranchContractFailure,
  type AgentBranchRecord,
} from "./agent-branch-types.js";
import {
  workflowResultReminderPrompt,
  workflowRestartContinuationPrompt,
} from "./workflow-result-missing.js";

/** Bounds the durable correction budget for a rejected result. */
export const AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS = REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS;

function toolTransport<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
): "tool-v1" | "structured-output-v1" {
  return context.host.prepareResult && (context.host.supportsToolResult?.(branch) ?? true)
    ? "tool-v1"
    : "structured-output-v1";
}

/** The transport a new request of this branch uses. */
export function agentBranchResultTransport<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
): "tool-v1" | "structured-output-v1" {
  return toolTransport(context, branch);
}

export async function prepareAgentBranchRepair<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  error: AgentBranchContractFailure,
): Promise<"stop"> {
  const { host } = context;
  const attempt = (branch.schemaRepairAttempts ?? 0) + 1;
  if (attempt > AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS) {
    throw new Error(
      `${error.message} The ${host.wording.subject} could not produce ${host.wording.validResult} in ${AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
    );
  }
  const previousRequestId = branch.requestId;
  const previousTransport = branch.resultTransport;
  // Retire the old slot before the new request identity reaches memory: with
  // concurrent branches, a peer's commit could otherwise persist the new id
  // while the superseded slot was still accepting submissions.
  if (previousTransport === "tool-v1" && previousRequestId) {
    await host.closeResult?.(previousRequestId);
  }
  branch.schemaRepairAttempts = attempt;
  branch.schemaRepairPrompt = host.repairPrompt(
    branch,
    error.issues,
    attempt,
    AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS,
  );
  branch.requestId = randomUUID();
  branch.dispatchState = "prepared";
  branch.resultTransport = toolTransport(context, branch);
  branch.resultSubmission = branch.resultTransport === "tool-v1" ? "preparing" : undefined;
  delete branch.idleResultPolls;
  host.pollGate?.clear(agentBranchPollScope(context, branch, "idle"));
  host.pollGate?.clear(agentBranchPollScope(context, branch, "usage"));
  await context.commits.commit();
  return "stop";
}

/**
 * Queues the single reminder turn for a tool-transport branch that went idle
 * with no accepted result, in place of failing it. Returns false when the
 * reminder does not apply or was already spent.
 *
 * The branch's work is complete by now; only delivery failed, and a fresh
 * session would redo all of it. The follow-up runs in the same session under
 * a new result slot, exactly like a schema repair.
 */
export async function prepareAgentBranchReminder<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  toolName: string,
  finalText: () => Promise<string | undefined>,
): Promise<boolean> {
  if (
    branch.resultTransport !== "tool-v1" ||
    branch.resultReminderSent === true ||
    !branch.providerSessionId ||
    // Accepted-but-unread and budget-exhausted slots are not a delivery gap
    // another turn can close.
    branch.resultSubmission === "received" ||
    branch.resultSubmission === "needs-attention"
  ) {
    return false;
  }
  const prompt = workflowResultReminderPrompt({
    resultLabel: context.host.wording.resultLabel,
    toolName,
    submission: branch.resultSubmission,
    finalText: await finalText(),
  });
  // Retire the old slot before the new request identity reaches memory, for
  // the same reason a schema repair does.
  if (branch.requestId) await context.host.closeResult?.(branch.requestId);
  branch.resultReminderSent = true;
  branch.continuationPrompt = prompt;
  delete branch.schemaRepairPrompt;
  branch.requestId = randomUUID();
  branch.dispatchState = "prepared";
  branch.resultSubmission = "preparing";
  // The reminder is a new turn; the stall clock measures it, not the wait
  // that preceded it.
  branch.progressAt = agentBranchNowIso();
  delete branch.stalledSince;
  delete branch.idleResultPolls;
  context.host.pollGate?.clear(agentBranchPollScope(context, branch, "idle"));
  await context.commits.commit();
  return true;
}

/**
 * Queues the single continuation turn for a branch whose turn a provider
 * restart cut short. Returns false once it was spent, so a second restart
 * fails the branch instead of looping.
 *
 * The session still holds the partial work, so it continues there under a
 * new request id, exactly like the result reminder; only the prompt differs,
 * because this work is not finished.
 */
export async function prepareAgentBranchRestartContinuation<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  toolName: string,
): Promise<boolean> {
  if (branch.restartContinuationSent === true || !branch.providerSessionId) return false;
  const toolResult = branch.resultTransport === "tool-v1";
  const prompt = workflowRestartContinuationPrompt({
    workLabel: context.host.wording.workLabel,
    resultLabel: context.host.wording.resultLabel,
    ...(toolResult ? { toolName } : {}),
  });
  if (toolResult && branch.requestId) await context.host.closeResult?.(branch.requestId);
  branch.restartContinuationSent = true;
  branch.continuationPrompt = prompt;
  delete branch.schemaRepairPrompt;
  branch.requestId = randomUUID();
  branch.dispatchState = "prepared";
  branch.resultSubmission = toolResult ? "preparing" : undefined;
  branch.progressAt = agentBranchNowIso();
  delete branch.stalledSince;
  delete branch.idleResultPolls;
  context.host.pollGate?.clear(agentBranchPollScope(context, branch, "idle"));
  await context.commits.commit();
  return true;
}

/**
 * Queues an owner's own continuation turn in the same session (a graph
 * node's answer to its `ask_human` question). Like the reminder it retires
 * the current slot and sends under a new request id with a fresh result
 * instruction; unlike the reminder it spends no budget, since the owner
 * decides when one is due.
 */
export async function prepareAgentBranchContinuation<B extends AgentBranchRecord>(
  context: AgentBranchContext<B>,
  branch: B,
  prompt: string,
): Promise<void> {
  if (!branch.providerSessionId) throw new Error("The branch has no session to continue");
  if (branch.requestId && branch.resultTransport === "tool-v1") {
    await context.host.closeResult?.(branch.requestId);
  }
  branch.continuationPrompt = prompt;
  delete branch.schemaRepairPrompt;
  branch.requestId = randomUUID();
  branch.dispatchState = "prepared";
  branch.status = "running";
  branch.resultTransport = toolTransport(context, branch);
  branch.resultSubmission = branch.resultTransport === "tool-v1" ? "preparing" : undefined;
  branch.progressAt = agentBranchNowIso();
  delete branch.stalledSince;
  delete branch.idleResultPolls;
  context.host.pollGate?.clear(agentBranchPollScope(context, branch, "idle"));
  await context.commits.commit();
}
