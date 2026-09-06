import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { Project } from "./models.js";
import type { StorageService } from "./storage.js";

export type CoordinatorRuntimeUnavailableReason =
  | "workspace"
  | "workspace-not-ready"
  | "conversation"
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
      conversation: CoordinatorConversation;
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
  if (conversation.agent !== "codex") {
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
    conversation,
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
    case "unsupported-agent":
      return "Only Codex is qualified for read-only coordination";
    case "checkout":
      return "Native agent coordinator checkout is unavailable";
    case "workspace":
      return "Native agent coordinator is unavailable";
  }
}
