import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

export const COORDINATOR_WORKSPACE_VERSION = 1 as const;
export const COORDINATOR_EXECUTION_POLICY = "coordinator-read-only" as const;
export const COORDINATOR_RUNTIME_PREFIX = "coordinator:" as const;

export type AgentSessionOwner =
  | { kind: "environment"; projectId: string; environmentId: string }
  | { kind: "coordinator"; projectId: string; coordinatorId: string };

export type CoordinatorLifecycleState = "ready" | "paused" | "error";

export interface CoordinatorConversation {
  id: string;
  tabId: string;
  logicalSessionKey: string;
  agent: AgentPlatform;
  providerSessionId?: string;
  title: string;
  createdAt: string;
  closedAt?: string;
  mailboxIncarnationId: string;
  /** Repository context included in the newest successfully dispatched turn. */
  repositoryContextRevisionAcknowledged?: number;
  codexBridgePort?: number;
  codexBridgePid?: number;
}

export interface CoordinatorWorkflowAssociation {
  id: string;
  coordinatorId: string;
  projectId: string;
  conversationId?: string;
  kind: "environment" | "build-pipeline" | "multi-review";
  resourceId: string;
  requestId: string;
  payloadHash?: string;
  /** A durable reservation written before a work-creating side effect. */
  pending?: boolean;
  /** Process currently materializing a reservation; never exposed as authority. */
  claimPid?: number;
  baseBranch?: string;
  baseCommit?: string;
  dependsOnResourceId?: string;
  createdAt: string;
  lastNotifiedRevision?: number;
  terminalNotifiedAt?: string;
  adoptedByConversationId?: string;
}

export interface CoordinatorRepositoryContextEvent {
  revision: number;
  branch: string | null;
  headCommit: string | null;
  occurredAt: string;
}

export interface CoordinatorWorkspace {
  version: typeof COORDINATOR_WORKSPACE_VERSION;
  id: string;
  projectId: string;
  executionPolicy: typeof COORDINATOR_EXECUTION_POLICY;
  lifecycleState: CoordinatorLifecycleState;
  conversations: CoordinatorConversation[];
  selectedConversationId: string | null;
  repositoryContextRevision: number;
  repositoryContextEvents?: CoordinatorRepositoryContextEvent[];
  createdAt: string;
  updatedAt: string;
  lastStartupError?: string;
  codexBridgePort?: number;
  codexBridgePid?: number;
  repositoryStatus?: ProjectGitStatus;
}

export interface CoordinatorSnapshot {
  workspace: CoordinatorWorkspace;
  projectPath: string;
  providerAvailability: Partial<Record<AgentPlatform, { available: boolean; reason?: string }>>;
  controlMcp: { enabled: boolean; running: boolean; error: string | null };
  workflows: CoordinatorWorkflowAssociation[];
}

export interface ProjectGitError {
  operation: "status" | "fetch" | "sync" | "switch";
  message: string;
  exitCode?: number;
  stderr?: string;
  occurredAt: string;
  retryable: boolean;
}

export interface ProjectGitBranch {
  ref: string;
  name: string;
  kind: "local" | "remote";
  remote?: string;
  trackingBranch?: string;
  occupiedWorktreePath?: string;
}

export interface ProjectGitStatus {
  projectId: string;
  repositoryRoot: string;
  revision: number;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  headCommit: string | null;
  upstream: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  remoteState: "fresh" | "stale" | "unknown";
  fetchedAt: string | null;
  trackedChanges: number;
  untrackedChanges: number;
  conflicts: number;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  operationState: "idle" | "fetching" | "syncing" | "switching";
  repositoryOperationBlockedReason: string | null;
  branches: ProjectGitBranch[];
  lastError: ProjectGitError | null;
}

export function coordinatorRuntimeId(coordinatorId: string, conversationId?: string): string {
  if (!coordinatorId || coordinatorId.includes("\0") || coordinatorId.includes(":")) {
    throw new Error("Invalid coordinator id");
  }
  if (
    conversationId !== undefined &&
    (!conversationId || conversationId.includes("\0") || conversationId.includes(":"))
  ) {
    throw new Error("Invalid coordinator conversation id");
  }
  return `${COORDINATOR_RUNTIME_PREFIX}${coordinatorId}${conversationId ? `:${conversationId}` : ""}`;
}

export function coordinatorIdFromRuntimeId(value: string): string | null {
  if (!value.startsWith(COORDINATOR_RUNTIME_PREFIX)) return null;
  const id = value.slice(COORDINATOR_RUNTIME_PREFIX.length).split(":", 1)[0] ?? "";
  return id && !id.includes("\0") ? id : null;
}

export function coordinatorConversationIdFromRuntimeId(value: string): string | null {
  if (!value.startsWith(COORDINATOR_RUNTIME_PREFIX)) return null;
  const parts = value.slice(COORDINATOR_RUNTIME_PREFIX.length).split(":");
  return parts.length === 2 && parts[1] && !parts[1].includes("\0") ? parts[1] : null;
}

export function agentSessionOwnerKey(owner: AgentSessionOwner): string {
  return owner.kind === "environment"
    ? `environment\0${owner.projectId}\0${owner.environmentId}`
    : `coordinator\0${owner.projectId}\0${owner.coordinatorId}`;
}

export function isAgentSessionOwner(value: unknown): value is AgentSessionOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.projectId !== "string" || !candidate.projectId) return false;
  return candidate.kind === "environment"
    ? typeof candidate.environmentId === "string" && candidate.environmentId.length > 0
    : candidate.kind === "coordinator" &&
        typeof candidate.coordinatorId === "string" &&
        candidate.coordinatorId.length > 0;
}

export function isCoordinatorWorkspace(value: unknown): value is CoordinatorWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workspace = value as Record<string, unknown>;
  return (
    workspace.version === COORDINATOR_WORKSPACE_VERSION &&
    typeof workspace.id === "string" &&
    workspace.id.length > 0 &&
    typeof workspace.projectId === "string" &&
    workspace.projectId.length > 0 &&
    workspace.executionPolicy === COORDINATOR_EXECUTION_POLICY &&
    (workspace.lifecycleState === "ready" ||
      workspace.lifecycleState === "paused" ||
      workspace.lifecycleState === "error") &&
    Array.isArray(workspace.conversations) &&
    workspace.conversations.length <= 64 &&
    workspace.conversations.every((conversation) => {
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
        return false;
      }
      const item = conversation as Record<string, unknown>;
      return (
        typeof item.id === "string" &&
        typeof item.tabId === "string" &&
        typeof item.logicalSessionKey === "string" &&
        isAgentPlatform(item.agent) &&
        typeof item.title === "string" &&
        typeof item.createdAt === "string" &&
        typeof item.mailboxIncarnationId === "string" &&
        (item.repositoryContextRevisionAcknowledged === undefined ||
          (Number.isSafeInteger(item.repositoryContextRevisionAcknowledged) &&
            (item.repositoryContextRevisionAcknowledged as number) >= 0))
      );
    }) &&
    (workspace.selectedConversationId === null ||
      typeof workspace.selectedConversationId === "string") &&
    Number.isSafeInteger(workspace.repositoryContextRevision) &&
    (workspace.repositoryContextRevision as number) >= 0 &&
    (workspace.repositoryContextEvents === undefined ||
      (Array.isArray(workspace.repositoryContextEvents) &&
        workspace.repositoryContextEvents.length <= 32 &&
        workspace.repositoryContextEvents.every((event) => {
          if (!event || typeof event !== "object" || Array.isArray(event)) return false;
          const item = event as Record<string, unknown>;
          return (
            Number.isSafeInteger(item.revision) &&
            (item.revision as number) > 0 &&
            (item.branch === null || typeof item.branch === "string") &&
            (item.headCommit === null || typeof item.headCommit === "string") &&
            typeof item.occurredAt === "string"
          );
        }))) &&
    typeof workspace.createdAt === "string" &&
    typeof workspace.updatedAt === "string"
  );
}
