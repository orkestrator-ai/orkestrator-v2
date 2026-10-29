import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

export const COORDINATOR_WORKSPACE_VERSION = 1 as const;
export const COORDINATOR_EXECUTION_POLICY = "coordinator-read-only" as const;
export const COORDINATOR_RUNTIME_PREFIX = "coordinator:" as const;

/**
 * Launch-time process authority: whether this host can start the coordinator's
 * OS command sandbox, as the backend's qualification probe found it.
 *
 * `required` means the platform was qualified on that sandbox, so a bridge must
 * refuse to run commands without it. `unavailable` means it was qualified
 * without one (Claude on Windows, or on Linux without bubblewrap and socat or
 * whose bubblewrap cannot nest the CLI's user namespace), so a bridge leaves
 * the sandbox off and its own command filter is the boundary. Anything else, including absent, reads as `required`: an older
 * launcher must not turn a missing sandbox into an unsandboxed coordinator.
 */
export const COORDINATOR_COMMAND_SANDBOX_ENV = "ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX";
export type CoordinatorCommandSandbox = "required" | "unavailable";

export function coordinatorCommandSandboxFromEnv(
  env: NodeJS.ProcessEnv,
): CoordinatorCommandSandbox {
  return env[COORDINATOR_COMMAND_SANDBOX_ENV] === "unavailable" ? "unavailable" : "required";
}

/**
 * Launch-time process authority: the skills directory a Claude worker would
 * read for the same account (`$CLAUDE_CONFIG_DIR/skills` of the active
 * account, else `~/.claude/skills`). A coordinator's own `CLAUDE_CONFIG_DIR` is
 * private and holds no skills, so the launcher names the real one here. Only a
 * coordinator bridge reads it; worker launches never inherit it.
 */
export const COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV =
  "ORKESTRATOR_COORDINATOR_CLAUDE_USER_SKILLS_DIR";

/**
 * The same for Codex: `skills` in the active account's `CODEX_HOME`, else the
 * host's. A coordinator's own `CODEX_HOME` holds only an access-only login.
 */
export const COORDINATOR_CODEX_USER_SKILLS_DIR_ENV =
  "ORKESTRATOR_COORDINATOR_CODEX_USER_SKILLS_DIR";

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
  "enforced" | "provider-configured" | "advisory" | "unavailable";

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
  /**
   * `main` is the project's one coordinator: every worker reports to it and it
   * owns all delegation. A `side` agent (Side 1, Side 2…) can read the project
   * and exchange mail with the main coordinator only. Absent on records written
   * before roles existed; `normalizeCoordinatorRoles` assigns one on read.
   */
  role?: CoordinatorConversationRole;
  /** The N in "Side N"; only on side agents. */
  sideOrdinal?: number;
}

export type CoordinatorConversationRole = "main" | "side";

/**
 * The address any agent in a project can mail to reach its coordinator.
 *
 * It resolves to the project's current main conversation, starting one with
 * the default agent if the user closed it. Workers are told this rather than a
 * conversation id, which would go stale the moment the main is replaced.
 */
export const COORDINATOR_MAIL_ADDRESS = "coordinator";

/** The project's open main coordinator conversation, if any. */
export function coordinatorMainConversation(
  workspace: Pick<CoordinatorWorkspace, "conversations">,
): CoordinatorConversation | undefined {
  return workspace.conversations.find((item) => !item.closedAt && item.role === "main");
}

/**
 * Give every open conversation a role, keeping exactly one main.
 *
 * Records from before roles keep their history: the selected conversation (or
 * failing that the oldest one with an agent, or the oldest open one) becomes
 * main and the rest become Side 1, Side 2… in creation order. Nothing is
 * closed. Returns the same object when nothing needs to change.
 */
export function normalizeCoordinatorRoles(workspace: CoordinatorWorkspace): CoordinatorWorkspace {
  const open = workspace.conversations.filter((item) => !item.closedAt);
  const mains = open.filter((item) => item.role === "main");
  const settled =
    mains.length <= 1 &&
    open.every(
      (item) =>
        item.role === "main" ||
        (item.role === "side" && Number.isSafeInteger(item.sideOrdinal) && item.sideOrdinal! > 0),
    );
  if (settled) return workspace;
  const main =
    mains[0] ??
    open.find((item) => item.id === workspace.selectedConversationId) ??
    open.find((item) => item.agent) ??
    open[0];
  const used = new Set(
    open
      .filter((item) => item !== main && item.role === "side" && item.sideOrdinal)
      .map((item) => item.sideOrdinal!),
  );
  let next = 1;
  const nextOrdinal = () => {
    while (used.has(next)) next += 1;
    used.add(next);
    return next;
  };
  return {
    ...workspace,
    conversations: workspace.conversations.map((item) => {
      if (item.closedAt) return item;
      if (item === main) {
        const { sideOrdinal: _sideOrdinal, ...rest } = item;
        return { ...rest, role: "main" };
      }
      if (item.role === "side" && item.sideOrdinal && item.sideOrdinal > 0) return item;
      return { ...item, role: "side", sideOrdinal: nextOrdinal() };
    }),
  };
}

/**
 * The native session key of a coordinator conversation.
 *
 * It is the ordinary tab key (`env-<runtime>:<tab>`) — the one the renderer
 * opens, prompts and displays. Any other key names a second provider session
 * on the same bridge, so mail injected into it runs where nobody can see it.
 */
export function coordinatorConversationSessionKey(
  coordinatorId: string,
  conversation: Pick<CoordinatorConversation, "id" | "tabId">,
): string {
  return `env-${coordinatorRuntimeId(coordinatorId, conversation.id)}:${conversation.tabId}`;
}

/**
 * Give every conversation its canonical session key.
 *
 * Records written before keys were unified carry `coordinator-<id>:<conversation>`,
 * which the renderer never used. Returns the same object when nothing needs to
 * change.
 */
export function normalizeCoordinatorSessionKeys(
  workspace: CoordinatorWorkspace,
): CoordinatorWorkspace {
  const settled = workspace.conversations.every(
    (item) => item.logicalSessionKey === coordinatorConversationSessionKey(workspace.id, item),
  );
  if (settled) return workspace;
  return {
    ...workspace,
    conversations: workspace.conversations.map((item) => {
      const logicalSessionKey = coordinatorConversationSessionKey(workspace.id, item);
      return item.logicalSessionKey === logicalSessionKey ? item : { ...item, logicalSessionKey };
    }),
  };
}

/**
 * One outstanding request from a coordinator conversation to a worker tab.
 *
 * A delegation exists so the coordinator can be woken exactly once, when the
 * worker is finished, rather than on every message the worker sends. It opens
 * when the coordinator launches or messages a worker and closes on the worker's
 * turn-end edge; mail the worker sends while it is open is held rather than
 * delivered. A worker that is `waiting` on an approval has not finished — that
 * needs a human, not a coordinator turn — so `waiting` does not close it.
 */
export interface CoordinatorDelegation {
  requestedAt: string;
  /** The worker tab this delegation was sent to, within `resourceId`. */
  workerTabId: string;
  state: "running" | "completed" | "failed" | "stopped";
  completedAt?: string;
  /** Closed after this bounded background wait; retained for wake retries and restart recovery. */
  backgroundWorkTimeoutMs?: number;
  /** Durable wake decision, recorded before mail is released or synthesized. */
  wakeKind?: "report" | "notice";
  /**
   * When the coordinator was actually woken for this delegation.
   *
   * Distinct from `completedAt` so a crash between observing the edge and
   * delivering the wake retries rather than losing it, and so a delivered wake
   * is never sent twice.
   */
  wokenAt?: string;
  /**
   * The worker has been waiting on input or an approval since `since`.
   *
   * Waiting does not close a delegation, but once it has lasted past a short
   * debounce the coordinator gets one status notice for it (`notifiedAt`).
   * Cleared when the worker is seen working again, so a later wait is a new
   * episode with its own notice.
   */
  waiting?: { since: string; notifiedAt?: string };
}

/** The last status a coordinator was sent for one workflow or worker. */
export interface CoordinatorStatusNoticeRecord {
  /** Stable key of the settled state; the same key is never sent twice. */
  key: string;
  notifiedAt: string;
}

export interface CoordinatorWorkflowAssociation {
  id: string;
  coordinatorId: string;
  projectId: string;
  conversationId?: string;
  /** `graph-run`: a graph run the coordinator launched (item 214 records it at launch; resourceId is the run id). */
  kind: "environment" | "build-pipeline" | "multi-review" | "graph-run";
  resourceId: string;
  /**
   * The node that holds the resource, when it is not this one: a worker
   * environment or workflow a command node's coordinator started on a node
   * it controls. Its ID is that node's, and it is read through the node link.
   */
  nodeId?: string;
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
  /** Last status wake sent for this resource; see `coordinator-status-wakes.ts`. */
  statusNotice?: CoordinatorStatusNoticeRecord;
  adoptedByConversationId?: string;
  /** Present on `environment` associations that a coordinator is waiting on. */
  delegation?: CoordinatorDelegation;
}

/**
 * Every Control MCP tool a coordinator credential is offered.
 *
 * Bridges that gate a read-only coordinator's tools by name (Pi) exempt exactly
 * these. They are Orkestrator's own actions, served by the backend under the
 * coordinator's scoped credential, never a write to the checkout. A backend
 * test asserts the server offers no more and no fewer, so a new tool cannot be
 * silently refused on one platform.
 */
export const COORDINATOR_CONTROL_TOOL_NAMES = Object.freeze([
  "ack_message",
  "add_ticket_comment",
  "address_multi_review",
  "adopt_workflow",
  "cancel_build_pipeline",
  "cancel_graph_run",
  "cancel_multi_review",
  "cancel_schedule",
  "compare_project_files",
  "create_pr",
  "create_schedule",
  "create_ticket",
  "custom_fix_multi_review",
  "edit_worker_tab",
  "get_build_pipeline",
  "get_environment",
  "get_feature_plan",
  "get_graph_run",
  "get_launch_options",
  "get_message",
  "get_message_status",
  "get_multi_review",
  "get_repository_context",
  "get_tab_state",
  "get_tab_transcript",
  "get_ticket",
  "launch_environment",
  "launch_feature_plan",
  "launch_graph",
  "launch_job",
  "launch_multi_review",
  "launch_node_environment",
  "launch_terminal",
  "list_agents",
  "list_environments",
  "list_graph_templates",
  "list_mailboxes",
  "list_node_environments",
  "list_nodes",
  "list_projects",
  "list_schedules",
  "list_tabs",
  "list_tickets",
  "list_workflows",
  "open_multi_review",
  "open_multi_review_fix",
  "open_worker_browser",
  "pause_build_pipeline",
  "propose_agents_md_update",
  "read_messages",
  "read_node_environment",
  "request_env_value_reveal",
  "request_environment_deletion",
  "request_project_file_update",
  "request_project_on_node",
  "request_root_changes",
  "resume_build_pipeline",
  "send_message",
  "send_node_message",
  "send_prompt_to_node_tab",
  "send_prompt_to_tab",
  "start_build_pipeline",
  "start_environment",
  "start_multi_review",
  "start_node_environment",
  "stop_environment",
  "stop_node_environment",
  "transfer_files",
  "update_ticket",
] as const);

/**
 * How a coordinator lays out the prompt it sends a worker.
 *
 * The prompt is shown verbatim in the worker's transcript, and coordinators
 * otherwise pack a whole brief into one unbroken paragraph. Shared by the
 * context prompt and every delegation tool's `prompt` field.
 */
export const COORDINATOR_WORKER_PROMPT_FORMAT_RULE =
  "Worker prompts: the user reads them in the worker's transcript, so write Markdown with line breaks, not one long paragraph. Put the task first, then separate paragraphs or short bulleted sections for context, constraints and the expected report, with a blank line between them.";

/**
 * The launch-selection rule every coordinator is told, verbatim.
 *
 * Coordinators otherwise fill every model and effort field `get_launch_options`
 * lists, so each worker silently ran a more expensive selection than the
 * user's configured default. Kept short: it is injected on every turn.
 */
export const COORDINATOR_LAUNCH_DEFAULTS_RULE =
  "Defaults: omit modelId, reasoningId, Multi Review model rows, Multi Review autoFix and autoPr, and build agentType, steps and reviewers so environments, jobs, builds and Multi Reviews run the user's saved defaults. Override one only when the user asks for a specific model, agent, effort, reviewers or auto-fix/auto-PR, or agrees to one the task needs.";

/**
 * Who raises a pull request, told to every main coordinator verbatim.
 *
 * Coordinators otherwise ended build instructions with "prepare commit + PR",
 * so the build worker opened a pull request before any review ran. A pull
 * request comes only from a PR tab: the Multi Review's auto-PR, a build
 * pipeline's own PR step, or `create_pr` once the review is settled.
 */
export const COORDINATOR_PR_RULE =
  "Pull requests: workers never raise them. When you launch a worker or send it a prompt, ask it to commit its work and report back, and tell it not to open a pull request. A prompt environment runs build, then review or Multi Review, then fix, then PR, then resolve conflicts: a Multi Review with auto-fix and auto-PR raises the PR itself; otherwise raise it with create_pr, which opens the worker's PR tab, only after you are told the review and its fix have finished. A build pipeline (start_build_pipeline, including feature builds) has its own PR step, so never raise one for it.";

/** The mail-store hold reason that keeps worker progress from waking anyone. */
export const COORDINATOR_DELEGATION_HOLD_REASON = "delegation-running";

/**
 * The asynchronous contract every delegating coordinator is told, verbatim.
 *
 * One constant because three surfaces have to agree: the coordinator's own
 * context prompt, the delegation tool results, and the polling guard's refusal.
 * A model that reads two different descriptions of when it will be woken has
 * been given a reason to poll.
 */
export const COORDINATOR_ASYNC_CONTRACT =
  "Delegation is asynchronous. After launching a worker, sending it a message, or starting a workflow, finish this turn with a short summary of what was delegated and what you expect back. Do not wait, sleep, poll the mailbox, or repeatedly check message status: you will be woken with a new message when the worker has finished, and that message starts a new turn. Workers do not send progress updates, so silence means the work is still running.";

/**
 * What a workflow-starting tool tells a coordinator about being woken.
 *
 * Carried on the result for the same reason as the delegation contract: the
 * model's question right after starting a review or a build is "how will I
 * know?", and without an answer the obvious move is to poll its status.
 */
export const COORDINATOR_WORKFLOW_STATUS_WAKE =
  "This conversation will be woken with a status update when this workflow settles: a Multi Review ready to address, its fix done or failed, its automatic PR session started, opened or failed, a build paused on an error, a stall, and any workflow completing, failing or being cancelled. With auto-fix and auto-PR the review advances on its own, and you hear the outcome rather than each step. Updates that land together arrive in one wake. Do not poll its status.";

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
  /**
   * Commit the upstream tracking ref points at, as of the last fetch. Absent
   * from statuses written by backends that predate it.
   */
  upstreamCommit?: string | null;
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
  sequencerInProgress: boolean;
  operationState: "idle" | "fetching" | "syncing" | "switching";
  repositoryOperationBlockedReason: string | null;
  branches: ProjectGitBranch[];
  lastError: ProjectGitError | null;
}

/** One-time authorization to discard the checkout state shown at prepare time. */
export interface ProjectGitSwitchConfirmation {
  token: string;
  projectId: string;
  ref: string;
  expiresAt: string;
  trackedChanges: number;
  untrackedFiles: number;
  nestedRepositories: string[];
  dirtySubmodules: string[];
  requiresEnhancedConfirmation: boolean;
}

export interface ProjectGitSwitchOptions {
  confirmationToken?: string;
  includeNestedRepositories?: boolean;
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
            (item.repositoryContextRevisionAcknowledged as number) >= 0)) &&
        (item.role === undefined || item.role === "main" || item.role === "side") &&
        (item.sideOrdinal === undefined ||
          (Number.isSafeInteger(item.sideOrdinal) && (item.sideOrdinal as number) > 0))
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
