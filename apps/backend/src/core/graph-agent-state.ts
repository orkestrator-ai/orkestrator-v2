/**
 * A graph agent activation as the shared agent branch runner sees it
 * (item 204): its session mapped to an {@link AgentBranchRecord} and back,
 * and the deterministic identities its turns use.
 *
 * The runner works on a plain branch record; the activation keeps the same
 * fields in its session (`GraphAgentSessionState`), so every journal write
 * maps the branch back into the session the pass saves. Nothing here reads
 * storage or the clock.
 */
import { createHash } from "node:crypto";
import type {
  GraphActivationSession,
  GraphAgentQuestion,
  GraphAgentTurnMode,
  GraphModelBinding,
  NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { WorkflowResultTransport } from "@orkestrator/protocol/workflow-results";
import type { AgentBranchRecord } from "./agent-branch-types.js";

/** UUID-shaped SHA-256 of the parts: stable, and unique across runs (the run id is a part). */
export function graphAgentUuid(...parts: readonly string[]): string {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex");
  // Version 5 and the RFC 4122 variant, so every UUID check accepts it.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The result slot key of one output port for one request: derived from the
 * run, the activation and the request, so a retried `start` reproduces it and
 * two runs never share one (the activation capability needs UUID keys).
 */
export function graphAgentResultKey(
  runId: string,
  activationKey: string,
  requestId: string,
  port: string,
): string {
  return graphAgentUuid("graph-result", runId, activationKey, requestId, port);
}

/** The provider session key of an activation: stable across restarts. */
export function graphAgentSessionKey(runId: string, activationKey: string): string {
  return `graph:${runId}:${activationKey}`.slice(0, 256);
}

/** Facts beside the branch fields that the session also keeps. */
export interface GraphAgentSessionExtras {
  resultKeys?: Record<string, string>;
  question?: GraphAgentQuestion;
  questionsAsked?: number;
  continuedFrom?: string;
  turnMode?: GraphAgentTurnMode;
  transcript?: GraphActivationSession["transcript"];
}

function branchStatus(activation: Readonly<NodeActivation>): AgentBranchRecord["status"] {
  if (!activation.session) return "pending";
  switch (activation.state) {
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
    case "superseded":
      return "cancelled";
    default:
      return "running";
  }
}

/** The branch record of an activation, from its session (or a fresh one). */
export function graphAgentBranch(
  activation: Readonly<NodeActivation>,
  binding: GraphModelBinding,
): AgentBranchRecord {
  const session = activation.session;
  const model = session ? session.model : binding.model;
  return {
    id: activation.key,
    agent: session?.agent ?? binding.platform,
    ...(model !== undefined ? { model } : { modelUnpinned: true }),
    ...((session?.effort ?? binding.reasoningEffort) !== undefined
      ? { reasoningEffort: session?.effort ?? binding.reasoningEffort }
      : {}),
    ...(typeof binding.fastMode === "boolean" ? { fastMode: binding.fastMode } : {}),
    status: branchStatus(activation),
    ...(session
      ? {
          ...(session.sessionKey !== undefined ? { sessionKey: session.sessionKey } : {}),
          ...(session.providerSessionId !== undefined
            ? { providerSessionId: session.providerSessionId }
            : {}),
          agentStarted: session.agentStarted ?? session.dispatchState === "sent",
          requestId: session.requestId,
          dispatchState: session.dispatchState,
          resultTransport: session.resultTransport as WorkflowResultTransport,
          ...(session.resultSubmission !== undefined
            ? { resultSubmission: session.resultSubmission }
            : {}),
          ...(session.repairAttempts !== undefined
            ? { schemaRepairAttempts: session.repairAttempts }
            : {}),
          ...(session.repairPrompt !== undefined
            ? { schemaRepairPrompt: session.repairPrompt }
            : {}),
          ...(session.continuationPrompt !== undefined
            ? { continuationPrompt: session.continuationPrompt }
            : {}),
          ...(session.reminderSent !== undefined
            ? { resultReminderSent: session.reminderSent }
            : {}),
          ...(session.restartContinuationSent !== undefined
            ? { restartContinuationSent: session.restartContinuationSent }
            : {}),
          ...(session.usageLimitResends !== undefined
            ? { usageLimitResends: session.usageLimitResends }
            : {}),
          ...(session.idlePolls !== undefined ? { idleResultPolls: session.idlePolls } : {}),
          ...(session.progressAt !== undefined ? { progressAt: session.progressAt } : {}),
          ...(session.progressDigest !== undefined
            ? { progressDigest: session.progressDigest }
            : {}),
          ...(session.stalledSince !== undefined ? { stalledSince: session.stalledSince } : {}),
          ...(session.tokenCount !== undefined ? { tokenCount: session.tokenCount } : {}),
          ...(session.cacheReadTokens !== undefined
            ? { cacheReadTokens: session.cacheReadTokens }
            : {}),
          ...(session.usagePolls !== undefined
            ? { usageFinalizationPolls: session.usagePolls }
            : {}),
          ...(session.commandSandboxOff !== undefined
            ? { commandSandboxOff: session.commandSandboxOff }
            : {}),
          ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
          ...(session.turnStartedAt !== undefined ? { turnStartedAt: session.turnStartedAt } : {}),
        }
      : {}),
  };
}

/**
 * The session to record for a branch that has a session and a request. Null
 * while the branch has neither (nothing to journal yet).
 */
export function graphAgentSession(
  branch: AgentBranchRecord,
  extras: GraphAgentSessionExtras,
): GraphActivationSession | null {
  if (!branch.providerSessionId || !branch.requestId || !branch.dispatchState) return null;
  const session: GraphActivationSession = {
    agent: branch.agent,
    ...(branch.model !== undefined && !branch.modelUnpinned ? { model: branch.model } : {}),
    ...(branch.reasoningEffort !== undefined ? { effort: branch.reasoningEffort } : {}),
    providerSessionId: branch.providerSessionId,
    ...(branch.agentStarted !== undefined ? { agentStarted: branch.agentStarted } : {}),
    requestId: branch.requestId,
    dispatchState: branch.dispatchState,
    resultTransport: branch.resultTransport ?? "tool-v1",
    ...(extras.resultKeys && Object.keys(extras.resultKeys).length > 0
      ? { resultKeys: { ...extras.resultKeys } }
      : {}),
    ...(branch.tokenCount !== undefined ? { tokenCount: branch.tokenCount } : {}),
    ...(branch.cacheReadTokens !== undefined ? { cacheReadTokens: branch.cacheReadTokens } : {}),
    ...(extras.transcript ? { transcript: extras.transcript } : {}),
    ...(branch.sessionKey !== undefined ? { sessionKey: branch.sessionKey } : {}),
    ...(extras.continuedFrom !== undefined ? { continuedFrom: extras.continuedFrom } : {}),
    ...(extras.turnMode !== undefined ? { turnMode: extras.turnMode } : {}),
    ...(branch.startedAt !== undefined ? { startedAt: branch.startedAt } : {}),
    ...(branch.turnStartedAt !== undefined ? { turnStartedAt: branch.turnStartedAt } : {}),
    ...(branch.resultSubmission !== undefined ? { resultSubmission: branch.resultSubmission } : {}),
    ...(branch.schemaRepairAttempts !== undefined
      ? { repairAttempts: branch.schemaRepairAttempts }
      : {}),
    ...(branch.schemaRepairPrompt !== undefined ? { repairPrompt: branch.schemaRepairPrompt } : {}),
    ...(branch.continuationPrompt !== undefined
      ? { continuationPrompt: branch.continuationPrompt }
      : {}),
    ...(branch.resultReminderSent !== undefined ? { reminderSent: branch.resultReminderSent } : {}),
    ...(branch.restartContinuationSent !== undefined
      ? { restartContinuationSent: branch.restartContinuationSent }
      : {}),
    ...(branch.usageLimitResends !== undefined
      ? { usageLimitResends: branch.usageLimitResends }
      : {}),
    ...(branch.idleResultPolls !== undefined ? { idlePolls: branch.idleResultPolls } : {}),
    ...(branch.usageFinalizationPolls !== undefined
      ? { usagePolls: branch.usageFinalizationPolls }
      : {}),
    ...(branch.progressAt !== undefined ? { progressAt: branch.progressAt } : {}),
    ...(branch.progressDigest !== undefined ? { progressDigest: branch.progressDigest } : {}),
    ...(branch.stalledSince !== undefined ? { stalledSince: branch.stalledSince } : {}),
    ...(branch.commandSandboxOff !== undefined
      ? { commandSandboxOff: branch.commandSandboxOff }
      : {}),
    ...(extras.question ? { question: structuredClone(extras.question) } : {}),
    ...(extras.questionsAsked !== undefined ? { questionsAsked: extras.questionsAsked } : {}),
  };
  return session;
}

/** Usage since the previous report: the session's cumulative counters, differenced. */
export function graphAgentUsageDelta(
  previous: Pick<GraphActivationSession, "tokenCount" | "cacheReadTokens"> | undefined,
  branch: Pick<AgentBranchRecord, "tokenCount" | "cacheReadTokens">,
): { tokens: number; cacheReadTokens?: number } | undefined {
  const tokens = Math.max(0, (branch.tokenCount ?? 0) - (previous?.tokenCount ?? 0));
  const cacheRead = Math.max(0, (branch.cacheReadTokens ?? 0) - (previous?.cacheReadTokens ?? 0));
  if (tokens === 0 && cacheRead === 0) return undefined;
  return { tokens, ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}) };
}
