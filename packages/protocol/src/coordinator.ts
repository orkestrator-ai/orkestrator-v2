import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

export const COORDINATOR_WORKSPACE_VERSION = 1 as const;
export const COORDINATOR_EXECUTION_POLICY = "coordinator-read-only" as const;
export const COORDINATOR_RUNTIME_PREFIX = "coordinator:" as const;

export type AgentSessionOwner =
  | { kind: "environment"; projectId: string; environmentId: string }
  | { kind: "coordinator"; projectId: string; coordinatorId: string };

export type CoordinatorLifecycleState = "ready" | "paused" | "error";

/**
 * How strongly a platform can be held to the coordinator's read-only boundary.
 *
 * The distinction is not cosmetic. `enforced` means the provider or the OS
 * blocks a mutation whatever the model does; `provider-configured` means the
 * SDK was told to deny but exposes no way to verify it; `advisory` means
 * enforcement depends on the agent choosing to ask permission first. A user
 * deciding whether to point a coordinator at a real checkout needs that
 * difference, so it is carried in the snapshot rather than flattened to a
 * boolean.
 */
export type CoordinatorProviderTier =
  | "enforced"
  | "provider-configured"
  | "advisory"
  | "unavailable";

/**
 * Weakest tier an installation offers before the user chooses one.
 *
 * `provider-configured` admits every platform that is at least told to deny
 * mutations. Only `advisory`, where nothing but the agent's cooperation holds
 * the boundary, stays opt-in. The web settings form and the backend table both
 * read this so a fresh install and an unsaved form agree on what "default" is.
 */
export const DEFAULT_COORDINATOR_PROVIDER_TIER = "provider-configured" as const;

/**
 * Marks configs that have crossed the one-time default change from `enforced`
 * to `provider-configured`.
 */
export const COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION = 1 as const;

export function normalizeCoordinatorProviderTierDefaultVersion(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION
    ? value
    : COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION;
}

export interface CoordinatorProviderQualification {
  tier: CoordinatorProviderTier;
  /** Whether this host's tier setting admits the platform right now. */
  available: boolean;
  /** Why it is unavailable, or the caveat that comes with a lower tier. */
  reason?: string;
  /** Whether Orkestrator's delegation tools are reachable on this platform. */
  delegation: boolean;
}

export interface CoordinatorConversation {
  id: string;
  tabId: string;
  logicalSessionKey: string;
  /**
   * Absent until the first prompt assigns one.
   *
   * A conversation is created without a provider so the composer can offer the
   * whole qualified catalogue before anything is materialized. Assignment is
   * one-way for the life of the conversation: once a provider session exists,
   * its transcript and rollout belong to that platform.
   */
  agent?: AgentPlatform;
  providerSessionId?: string;
  title: string;
  createdAt: string;
  closedAt?: string;
  mailboxIncarnationId: string;
  /** Repository context included in the newest successfully dispatched turn. */
  repositoryContextRevisionAcknowledged?: number;
  bridgePort?: number;
  bridgePid?: number;
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
  /** Additional idempotency keys that reattached to this same resource. */
  requestAliases?: Array<{ requestId: string; payloadHash: string }>;
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
  bridgePort?: number;
  bridgePid?: number;
  repositoryStatus?: ProjectGitStatus;
}

export interface CoordinatorSnapshot {
  workspace: CoordinatorWorkspace;
  projectPath: string;
  providerAvailability: Partial<Record<AgentPlatform, CoordinatorProviderQualification>>;
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
        (item.agent === undefined || isAgentPlatform(item.agent)) &&
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

export const COORDINATOR_CONTEXT_OPEN_TAG = "<orkestrator-coordinator-context>" as const;
export const COORDINATOR_CONTEXT_CLOSE_TAG = "</orkestrator-coordinator-context>" as const;

/**
 * Removes the server-authored coordinator preamble from a prompt for display.
 *
 * The block is authority the model needs — project and coordinator ids, the
 * read-only role, the delegation rule, the repository revision — so it is
 * prepended to every coordinator turn. It is not something the user typed, and
 * rendering it verbatim above their own message is noise that also puts
 * internal ids on screen. Transcript surfaces strip it; the wire prompt keeps
 * it.
 *
 * Exactly one leading block is removed, and only when it is closed. A later or
 * unterminated occurrence is text inside the user's own prompt and is left
 * exactly as written, so this can never truncate a real message.
 *
 * Removing only the first block is what keeps a forged block visible. The
 * server injects unconditionally — its idempotency marker is a private symbol on
 * the input object, not this prefix — so a prompt whose text opens with a block
 * of the user's own arrives as `injected + forged`. The first close tag ends the
 * injected block, and the forgery renders in the transcript where it can be seen
 * rather than being silently absorbed.
 */
export function stripCoordinatorContext(text: string): string {
  if (!text.startsWith(COORDINATOR_CONTEXT_OPEN_TAG)) return text;
  const end = text.indexOf(COORDINATOR_CONTEXT_CLOSE_TAG);
  if (end === -1) return text;
  return text.slice(end + COORDINATOR_CONTEXT_CLOSE_TAG.length).replace(/^\s+/, "");
}
