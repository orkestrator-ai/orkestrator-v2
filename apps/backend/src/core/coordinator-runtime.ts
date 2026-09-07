import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { normalizeAgentPlatforms, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { Project } from "./models.js";
import type { StorageService } from "./storage.js";
import { coordinatorProviderAllowed } from "./coordinator-providers.js";

export type CoordinatorRuntimeUnavailableReason =
  | "workspace"
  | "workspace-not-ready"
  | "conversation"
  | "unassigned"
  | "unsupported-agent"
  | "checkout";

export type CoordinatorRuntimeResolution =
  | { status: "not-coordinator" }
  | {
      status: "unavailable";
      coordinatorId: string;
      reason: CoordinatorRuntimeUnavailableReason;
    }
  | {
      status: "ready";
      coordinatorId: string;
      conversationId: string;
      workspace: CoordinatorWorkspace;
      conversation: CoordinatorConversation & { agent: AgentPlatform };
      project: Project;
    };

/**
 * Resolve the common durable authority behind a coordinator runtime id.
 * Operation-specific gates, such as an idle repository or a canonical path,
 * are deliberately layered by the caller after this shared eligibility check.
 */
export async function resolveCoordinatorRuntime(
  storage: StorageService,
  runtimeId: string,
): Promise<CoordinatorRuntimeResolution> {
  const coordinatorId = coordinatorIdFromRuntimeId(runtimeId);
  if (!coordinatorId) return { status: "not-coordinator" };

  const workspace = await storage.getCoordinatorWorkspaceById(coordinatorId);
  if (!workspace) return { status: "unavailable", coordinatorId, reason: "workspace" };
  if (workspace.lifecycleState !== "ready") {
    return { status: "unavailable", coordinatorId, reason: "workspace-not-ready" };
  }

  const conversationId = coordinatorConversationIdFromRuntimeId(runtimeId);
  const conversation = workspace.conversations.find(
    (item) => item.id === conversationId && !item.closedAt,
  );
  if (!conversation || !conversationId) {
    return { status: "unavailable", coordinatorId, reason: "conversation" };
  }
  // No provider yet: the conversation exists, but nothing has been
  // materialized for it. Callers that need a runtime must say so distinctly,
  // because "waiting for a first prompt" is not a failure.
  if (!conversation.agent) {
    return { status: "unavailable", coordinatorId, reason: "unassigned" };
  }
  const config = await storage.loadConfig().catch(() => null);
  if (
    !coordinatorProviderAllowed(conversation.agent, {
      tierSetting: config?.global.coordinatorProviderTiers,
      ...(config
        ? { enabledPlatforms: normalizeAgentPlatforms(config.global.enabledAgentPlatforms) }
        : {}),
    })
  ) {
    return { status: "unavailable", coordinatorId, reason: "unsupported-agent" };
  }

  const project = await storage.getProject(workspace.projectId);
  if (!project?.localPath) {
    return { status: "unavailable", coordinatorId, reason: "checkout" };
  }
  return {
    status: "ready",
    coordinatorId,
    conversationId,
    workspace,
    conversation: { ...conversation, agent: conversation.agent },
    project,
  };
}

export function coordinatorRuntimeUnavailableMessage(
  resolution: Extract<CoordinatorRuntimeResolution, { status: "unavailable" }>,
): string {
  switch (resolution.reason) {
    case "workspace-not-ready":
      return "Coordinator workspace is not ready";
    case "conversation":
      return "The coordinator conversation is unavailable";
    case "unassigned":
      return "This coordinator conversation has no agent yet; send its first prompt to choose one";
    case "unsupported-agent":
      return "This agent platform is not qualified for read-only coordination on this host";
    case "checkout":
      return "Native agent coordinator checkout is unavailable";
    case "workspace":
      return "Native agent coordinator is unavailable";
  }
}
