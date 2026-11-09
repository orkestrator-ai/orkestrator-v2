export { coordinatorActionMark, type CoordinatorActionMark } from "./coordinator-actions.js";
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

/**
 * The backend's data directory, which holds the operator credentials, every
 * account's login and the database. A coordinator bridge denies its turns reads
 * below it, except for the conversation's own runtime and the few directories
 * it is meant to read (`coordinatorReadBoundary` in the Claude bridge). Only
 * the launcher's coordinator branch sets it, like the other process authority.
 */
export const COORDINATOR_PROTECTED_DATA_DIR_ENV = "ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR";
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
  /**
   * What started the newest successfully dispatched turn: a prompt the user
   * sent (`user`), or mail and backend notices such as a fired timer or a
   * workflow status wake (`mail`). Incomplete-turn recovery leaves it as it
   * was. A tool that may only act on the user's own instruction (a self-timer
   * carrying permission to switch accounts) checks it.
   */
  lastTurnOrigin?: CoordinatorTurnOrigin;
  lastTurnStartedAt?: string;
  bridgePort?: number;
  bridgePid?: number;
  /**
   * Why this conversation's bridge last failed to start, already sanitized for
   * display. While set, this conversation has no runtime: no credential, no
   * mail, no bridge start. Every other conversation carries on. Cleared by a
   * successful start or an explicit retry. An older backend ignores the field.
   */
  startupError?: string;
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

export type CoordinatorTurnOrigin = "user" | "mail";

/**
 * The per-project setting's name, as Project Settings shows it. The refusal
 * below repeats it, so what a coordinator tells the user is what they will find.
 */
export const COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL =
  "Let the coordinator use environments it did not create";

/** Why a coordinator was refused an environment it did not create, in words it can pass on. */
export const COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL = `Not done: this coordinator did not create that environment, so it may not send it work. Do not retry. Use an environment this coordinator launched, or start a new one. If the user wants this coordinator to work in environments it did not create, tell them to turn on "${COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL}" in this project's settings, under Coordinator.`;

/**
 * The address any agent in a project can mail to reach its coordinator.
 *
 * It resolves to the project's current main conversation, starting one with
 * the default agent if the user closed it. Workers are told this rather than a
 * conversation id, which would go stale the moment the main is replaced.
 */
export const COORDINATOR_MAIL_ADDRESS = "coordinator";

/**
 * The address an agent or coordinator on a node in leaf mode mails to reach the
 * main coordinator for the same repository on the command node that controls
 * it. Its mail waits in the leaf's outbox until that command node collects it.
 * It is the one cross-node action a leaf-mode coordinator has.
 */
export const COMMAND_NODE_COORDINATOR_MAIL_ADDRESS = "command-node-coordinator";

/**
 * The address an agent mails when the user asks for the coordinator on its own
 * machine. On a leaf, `COORDINATOR_MAIL_ADDRESS` usually means the command
 * node's coordinator; this one never leaves the machine.
 */
export const LOCAL_COORDINATOR_MAIL_ADDRESS = "local-coordinator";

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
   * is never sent twice. Also stamped when no wake is owed any more: its
   * coordinator is gone, or delivery was given up on (`wakeFailedAt`).
   */
  wokenAt?: string;
  /**
   * Delivering the wake kept failing, so it was given up on once one notice to
   * the coordinator was stored. A mark on the wake, not on the work: `state`
   * still says how the worker ended.
   */
  wakeFailedAt?: string;
  /** Retirement was selected durably; retry only its notice until receipted. */
  wakeRetirement?: { attempts: number; kind: string };
  /**
   * The worker has been waiting on input or an approval since `since`.
   *
   * Waiting does not close a delegation, but once it has lasted past a short
   * debounce the coordinator gets one status notice for it (`notifiedAt`).
   * Cleared when the worker is seen idle, working or stopped, so a later wait is
   * a new episode with its own notice. An unreadable state does not clear it.
   */
  waiting?: { since: string; notifiedAt?: string };
  /**
   * The coordinator stopped the worker's turn (`stop_worker_turn`) while this
   * delegation was open. The turn end still settles it and wakes the
   * coordinator once; the notice says the coordinator stopped it, and the
   * bounded hold for background work is skipped.
   */
  stopRequestedAt?: string;
  /** The user stopped it from the Work panel, so the notice does not credit the coordinator. */
  stopRequestedBy?: "user";
  /** What was asked and on what, for the Work panel. Absent on older records. */
  request?: CoordinatorDelegationRequest;
}

/**
 * What the Work panel shows about one request: a one-line summary of the ask and
 * the selection it ran with. The coordinator store is rewritten whole and holds
 * up to `MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS` records, so every field is short
 * and bounded by {@link normalizeCoordinatorDelegationRequest}. Never read back
 * as the prompt: it is a display line, cut at the bound.
 */
export interface CoordinatorDelegationRequest {
  summary?: string;
  agent?: AgentPlatform;
  /** Null when no tier pins a model and the agent picks its own. */
  model?: string | null;
  reasoning?: string | null;
  /** `requested` when the coordinator overrode the saved default. */
  source?: "requested" | "default";
}

export const COORDINATOR_DELEGATION_SUMMARY_MAX = 140;
const COORDINATOR_DELEGATION_SELECTION_MAX = 120;

function boundedSelection(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= COORDINATOR_DELEGATION_SELECTION_MAX ? text : undefined;
}

/** One line of at most {@link COORDINATOR_DELEGATION_SUMMARY_MAX} characters, or nothing. */
export function coordinatorDelegationSummaryLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length <= COORDINATOR_DELEGATION_SUMMARY_MAX) return text;
  // Never leave half of a surrogate pair at the cut.
  const cut = text.slice(0, COORDINATOR_DELEGATION_SUMMARY_MAX - 1).replace(/[\ud800-\udbff]$/, "");
  return `${cut}…`;
}

/** A request with every field checked and bounded, or undefined when nothing is left. */
export function normalizeCoordinatorDelegationRequest(
  value: unknown,
): CoordinatorDelegationRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const summary = coordinatorDelegationSummaryLine(source.summary);
  const model = boundedSelection(source.model);
  const reasoning = boundedSelection(source.reasoning);
  const request: CoordinatorDelegationRequest = {
    ...(summary ? { summary } : {}),
    ...(isAgentPlatform(source.agent) ? { agent: source.agent } : {}),
    ...(model ? { model } : source.model === null ? { model: null } : {}),
    ...(reasoning ? { reasoning } : source.reasoning === null ? { reasoning: null } : {}),
    ...(source.source === "requested" || source.source === "default"
      ? { source: source.source }
      : {}),
  };
  return Object.keys(request).length > 0 ? request : undefined;
}

/** What coordinator-started work asks of the user, for the panel and for the agent. */
export type CoordinatorWorkBucket = "needs-you" | "running" | "finished";

/**
 * The bucket one delegation alone puts its worker in. The one definition of
 * "needs you" for a delegation, so the Work panel and `list_workflows` cannot
 * disagree. The panel also joins what only it can read (its prompt mirrors and
 * a worker's live activity), which can move a row but never this answer.
 */
export function coordinatorDelegationBucket(
  delegation: Pick<CoordinatorDelegation, "state" | "waiting">,
): CoordinatorWorkBucket {
  if (delegation.state !== "running") return "finished";
  return delegation.waiting ? "needs-you" : "running";
}

/** A delegation as the agent reads it from `list_workflows`. */
export interface CoordinatorDelegationSummary {
  state: CoordinatorDelegation["state"];
  bucket: CoordinatorWorkBucket;
  workerTabId: string;
  requestedAt: string;
  completedAt?: string;
  /** When the worker began waiting on input or an approval. */
  waitingSince?: string;
  stopRequestedAt?: string;
}

export function coordinatorDelegationSummary(
  delegation: CoordinatorDelegation,
): CoordinatorDelegationSummary {
  return {
    state: delegation.state,
    bucket: coordinatorDelegationBucket(delegation),
    workerTabId: delegation.workerTabId,
    requestedAt: delegation.requestedAt,
    ...(delegation.completedAt ? { completedAt: delegation.completedAt } : {}),
    ...(delegation.waiting ? { waitingSince: delegation.waiting.since } : {}),
    ...(delegation.stopRequestedAt ? { stopRequestedAt: delegation.stopRequestedAt } : {}),
  };
}

/** The last status a coordinator was sent for one workflow or worker. */
export interface CoordinatorStatusNoticeRecord {
  /** Stable key of the settled state; the same key is never sent twice. */
  key: string;
  notifiedAt: string;
}

/**
 * A worker's pull request a coordinator follows (`pull-request` association).
 *
 * Written when the coordinator raises the PR (`create_pr`), runs
 * `resolve_conflicts` on it, or when a review it launched reports the PR its
 * auto-PR opened. Status wakes report the PR's state changes from it. A PR the
 * user raised in the UI has no such record; on a worker the coordinator owns,
 * only its merge or close reaches it (`CoordinatorWorkerOutcome`).
 */
export interface CoordinatorPullRequestFollow {
  source: "create-pr" | "resolve-conflicts" | "multi-review";
  /** The pull request followed, once seen; another URL on the worker is a different PR. */
  prUrl?: string;
  /** `multi-review`: the review association whose `pr-opened` notice this follows. */
  reviewAssociationId?: string;
  /**
   * How many PR states have been recorded (`statusNotice`), sent or quiet.
   * The next notice is episode `notices + 1`, which makes its mail request
   * id unique, so a state that recurs after a fix (conflicts, quiet,
   * conflicts) is sent again, while a retry of the same episode, after a
   * restart or from a second observer, replays the same message.
   */
  notices?: number;
  /**
   * The worker's last PR reading, captured just before its record is
   * deleted (Merge and Cleanup), so a merge is still reported once the
   * worker is gone.
   */
  final?: {
    prUrl: string | null;
    prState: "open" | "closed" | "merged" | null;
    name?: string;
    at: string;
  };
  /** The PR publication attempt, including turns that end without opening a PR. */
  publication?: { tabId: string; requestedAt: string; seenWorkingAt?: string };
  /** The newest `resolve_conflicts` run, reported once when its tab finishes. */
  resolve?: {
    tabId: string;
    requestedAt: string;
    /** The Resolve tab was seen working, so a later idle is its turn ending. */
    seenWorkingAt?: string;
    /** Its turn ended; the report waits briefly for the PR monitor's refresh. */
    finishedAt?: string;
    notifiedAt?: string;
  };
}

/**
 * How a coordinator-owned worker ended up: its pull request merged or closed,
 * or the environment deleted (`coordinator-worker-outcomes.ts`).
 *
 * Kept on one association per coordinator, worker and node: the earliest
 * `environment` or `build-pipeline` association that names the worker. The
 * coordinator hears one awareness notice when the watch ends on a merge, a
 * close or a deletion; nothing it must act on.
 */
export interface CoordinatorWorkerOutcome {
  /** `build-pipeline`: the pipeline's worker, read once from the pipeline. */
  environmentId?: string;
  /** First observation; an outcome already reached then is old news, recorded without a wake. */
  observedAt?: string;
  /** The worker's last seen pull request and name. */
  prUrl?: string;
  prState?: "open" | "closed" | "merged";
  name?: string;
  /** Captured just before the worker's record was deleted (`deleteEnvironment`). */
  deletedAt?: string;
  /**
   * The watch is over. `key` names what ended it (`merged:<tag>`,
   * `closed:<tag>`, `deleted`, `untracked`); `notified` says whether this
   * watch woke the coordinator for it (a PR follow may have told it instead).
   */
  ended?: { key: string; at: string; notified: boolean };
}

export interface CoordinatorWorkflowAssociation {
  id: string;
  coordinatorId: string;
  projectId: string;
  conversationId?: string;
  /**
   * `graph-run`: a graph run the coordinator launched (item 214 records it at launch; resourceId is the run id).
   * `pull-request`: a worker's pull request it follows (resourceId is the environment id; see `pullRequest`).
   * `feature-plan`: one planning exchange it started with `launch_feature_plan` (resourceId is the
   * feature plan id; see `featurePlan`).
   *
   * Readers must skip a kind they do not know rather than fail or treat it as
   * another kind: an older backend sharing the data directory keeps and writes
   * back records of kinds added after it.
   */
  kind:
    | "environment"
    | "build-pipeline"
    | "multi-review"
    | "graph-run"
    | "pull-request"
    | "feature-plan";
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
  requestAliases?: Array<{ requestId: string; payloadHash: string; receivedAt?: string }>;
  /** A durable reservation written before a work-creating side effect. */
  pending?: boolean;
  /** Process currently materializing a reservation; never exposed as authority. */
  claimPid?: number;
  baseBranch?: string;
  baseCommit?: string;
  /** Environment actually created by this workflow, never an existing target.
   * Kept while that environment exists, independently of workflow history. */
  createdEnvironmentId?: string;
  /** This build launch requested a new environment. It is not authority until
   * provisioning publishes its ID; used to repair a reclaimed admission. */
  createsEnvironment?: boolean;
  /** Remote lookup proved no created environment (terminal/missing/foreign admission).
   * Stops repair polling and permits retention after the replay window. */
  environmentCreationSettledAt?: string;
  dependsOnResourceId?: string;
  createdAt: string;
  lastNotifiedRevision?: number;
  terminalNotifiedAt?: string;
  /** Durable restart episode; absent on follows created before the first restart. */
  statusWakeEpisode?: string;
  /** Last status wake sent for this resource; see `coordinator-status-wakes.ts`. */
  statusNotice?: CoordinatorStatusNoticeRecord;
  adoptedByConversationId?: string;
  /** Present on `environment` associations that a coordinator is waiting on. */
  delegation?: CoordinatorDelegation;
  /** Present on `pull-request` associations. */
  pullRequest?: CoordinatorPullRequestFollow;
  /** Present on `feature-plan` associations: the planning exchange this request started. */
  featurePlan?: { operationId: string };
  /** `environment` and `build-pipeline`: the worker's outcome watch (see `CoordinatorWorkerOutcome`). */
  workerOutcome?: CoordinatorWorkerOutcome;
  /**
   * The user cleared this record's finished row from the Work panel. Display
   * only: retention, replay, mail routing and status wakes never read it, and
   * a row that is no longer finished is listed again.
   */
  workHiddenAt?: string;
  /**
   * The record's node is no longer controlled from here: the user forgot it,
   * handed it to another command node, or it was missing from this machine's
   * registry when the record was found (`unregistered`, for nodes removed
   * before this field existed). Its delegation was closed and its workflow
   * marked reported, so retention treats its resources as gone. `notifiedAt`
   * says the coordinator was told. Older backends ignore it and keep the
   * record, as they did before.
   */
  nodeRelease?: CoordinatorNodeRelease;
}

export interface CoordinatorNodeRelease {
  at: string;
  reason: "forgotten" | "handed-over" | "unregistered";
  notifiedAt?: string;
}

/**
 * The end state a followed pull request's recorded notice names. Its key is
 * `<condition>:<url hash>`, so a follow that reported its merge still says so
 * after its environment, and every live reading of the PR, is gone.
 */
export function pullRequestStateFromNotice(
  key: string | undefined,
): "merged" | "closed" | undefined {
  if (key?.startsWith("merged:")) return "merged";
  if (key?.startsWith("closed:")) return "closed";
  return undefined;
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
  "mark_topic",
  "mark_question",
  "ack_message",
  "add_ticket_comment",
  "address_multi_review",
  "adopt_workflow",
  "answer_worker_question",
  "ask_agents",
  "cancel_build_pipeline",
  "cancel_graph_run",
  "cancel_multi_review",
  "cancel_schedule",
  "clear_worker_goal",
  "compare_project_files",
  "create_pr",
  "create_schedule",
  "create_ticket",
  "create_ticket_label",
  "custom_fix_multi_review",
  "edit_worker_tab",
  "fork_worker",
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
  "get_usage_limits",
  "get_worker_changes",
  "get_worker_goal",
  "launch_environment",
  "launch_feature_plan",
  "launch_graph",
  "launch_job",
  "launch_multi_review",
  "launch_terminal",
  "list_agents",
  "list_environments",
  "list_graph_templates",
  "list_mailboxes",
  "list_nodes",
  "list_projects",
  "list_provider_accounts",
  "list_schedules",
  "list_tabs",
  "list_ticket_labels",
  "list_tickets",
  "list_worker_commands",
  "list_workflows",
  "open_multi_review",
  "open_multi_review_fix",
  "open_worker_browser",
  "pause_build_pipeline",
  "pause_schedule",
  "pause_worker_goal",
  "propose_agents_md_update",
  "read_messages",
  "read_node_environment",
  "request_env_value_reveal",
  "request_environment_deletion",
  "request_project_file_update",
  "request_project_on_node",
  "request_root_changes",
  "resolve_conflicts",
  "restart_build_pipeline_step",
  "resume_build_pipeline",
  "resume_schedule",
  "run_worker_command",
  "send_message",
  "send_prompt_to_tab",
  "set_ticket_label",
  "set_worker_goal",
  "start_build_pipeline",
  "start_environment",
  "stop_environment",
  "stop_worker_turn",
  "switch_provider_account",
  "set_account_auto_switch",
  "transfer_files",
  "update_schedule",
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
 * The request-id rule every coordinator is told, in the operator's wording.
 *
 * Request ids are namespaced by coordinator, across its conversations, so a
 * fresh main that was only told to "reuse requestId on retry" picks `launch-1`
 * again and collides with an earlier conversation's request.
 */
export const COORDINATOR_REQUEST_ID_RULE =
  "Every mutation needs a new unique requestId; reuse one only to retry the same call after an ambiguous response.";

/**
 * What every coordinator request-id collision says: the id named another
 * request (another payload, worker or tab), possibly an earlier
 * conversation's, nothing was done, and a new id is the way out.
 */
export const COORDINATOR_REQUEST_ID_REUSED_ERROR =
  "This requestId was already used for a different request (a different payload or target), possibly by an earlier conversation, so nothing was done. Use a new unique requestId for each new action; reuse one only to retry the same call.";

/**
 * Carried beside `replayed: true` when a request id named a request that had
 * already run, so a replay never reads as fresh work.
 */
export const COORDINATOR_REPLAYED_NOTE =
  "This requestId was already used, so this is the earlier request's result and nothing new was started. If you meant a new action, call again with a new unique requestId.";

/**
 * The launch-selection rule every coordinator is told, verbatim.
 *
 * Coordinators otherwise fill every model and effort field `get_launch_options`
 * lists, so each worker silently ran a more expensive selection than the
 * user's configured default. Kept short: it is injected on every turn.
 */
export const COORDINATOR_LAUNCH_DEFAULTS_RULE =
  "Defaults: omit agent, modelId, reasoningId, Multi Review model rows, Multi Review autoFix and autoPr, and build agentType, steps and reviewers so environments, jobs, builds and Multi Reviews run the user's saved defaults. Override one only when the user asks for a specific model, agent, effort, reviewers or auto-fix/auto-PR, or agrees to one the task needs.";

/**
 * How long after a coordinator's last sent message to a project home the next
 * one is sent without the user's approval (still with a warning).
 */
export const COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS = 3 * 60 * 60_000;

/**
 * Where work runs, told to every main coordinator verbatim.
 *
 * Coordinators otherwise reached for `launch_environment` for everything, and
 * nothing stopped one prompting the project home, the user's own writable
 * checkout. `send_message` enforces the project-home half (reason, approval).
 */
export const COORDINATOR_ROUTING_RULE =
  "Routing: run all work in an isolated environment with its own worktree or container. Fully specified work, which can be written up as a ticket with acceptance criteria: create the ticket with create_ticket, then start_build_pipeline for it. Smaller or interactive work: when an idle worker already fits, reuse it with send_prompt_to_tab or launch_job; otherwise launch_environment with a prompt, then work with that worker back and forth. The project home is the user's own checkout, and an agent working there conflicts with the user's own work in it, so use it only in exceptional circumstances and first tell the user why an environment will not do. send_message to the project home needs projectHomeReason, and waits for the user's approval unless you messaged it in the last 3 hours.";
/**
 * Which kind of worker environment to use, told to every main coordinator
 * verbatim.
 *
 * Coordinators otherwise launched a prompt environment for every piece of
 * work and then hand-ran review, fix and PR for a ticket a build pipeline
 * would have taken end to end. The PR mechanics stay in `COORDINATOR_PR_RULE`.
 */
export const COORDINATOR_ENVIRONMENT_CHOICE_RULE =
  "Environments: a pipeline environment is the default. Start one with start_build_pipeline whenever the whole spec is known (a ticket, or what is being built has been settled with the user); it builds, reviews, fixes, verifies, opens the PR and resolves conflicts on its own. Use a prompt environment (launch_environment) for investigation, or for interactive work that may stop, raise many questions or need back-and-forth with the user. With a prompt environment the rest of the lifecycle is yours: when you judge the work ready, launch Multi Review, then see it through its fix, the pull request and conflict resolution. Investigation with no code change ends with the worker's report.";

/**
 * Who raises a pull request, told to every main coordinator verbatim.
 *
 * Coordinators otherwise ended build instructions with "prepare commit + PR",
 * so the build worker opened a pull request before any review ran. A pull
 * request comes only from a PR tab: the Multi Review's auto-PR, a build
 * pipeline's own PR step, or `create_pr` once the review is settled. The rule
 * also says which PR changes wake the coordinator and that `resolve_conflicts`
 * is the next step for a conflicting one.
 */
export const COORDINATOR_PR_RULE =
  "Pull requests: workers never raise them. When you launch a worker or send it a prompt, ask it to commit its work and report back, and tell it not to open a pull request. For a prompt environment, a Multi Review with auto-fix and auto-PR raises the PR itself; otherwise raise it with create_pr, which opens the worker's PR tab, only after you are told the review and its fix have finished. You are woken when a pull request you raised opens, conflicts with its base branch, fails its checks, becomes ready to merge, or is merged or closed; when it conflicts, call resolve_conflicts, which opens the worker's Resolve tab and wakes you once it finishes. Never merge a pull request: the user does. A pipeline environment (one a build pipeline runs, from start_build_pipeline or a Build button) has its own PR step, so never raise one for it.";

/**
 * Who runs full validation, told to every main coordinator verbatim.
 *
 * Coordinators otherwise closed a worker's brief with "run the full suite once
 * and report", then started a Multi Review whose first step runs the same suite
 * against the same commit. Build pipelines already avoid this through
 * `IMPLEMENTATION_VALIDATION_HANDOFF`; this is the coordinator's equivalent.
 */
export const COORDINATOR_VALIDATION_RULE =
  "Validation: Multi Review and build pipelines start by running the project's full validation once against the committed branch, so when review comes next never ask a worker for a full test suite, typecheck, lint or build pass, including in a last message before you start the review. Ask for the focused checks that cover its changes and for those results in its report. State in every worker prompt whether review follows. When no review follows, explicitly ask the worker to run all validation required by the repository before handoff. When review follows, ask for a full run only if the user asks for one or that run's result is what you need to learn, such as when diagnosing a suite failure.";

/**
 * How a coordinator closes finished work, sent verbatim as the last line of a
 * terminal build pipeline or Multi Review status wake
 * (`renderCoordinatorStatusNotice`).
 *
 * A finished task otherwise ended with whatever the coordinator happened to
 * write. It rides on the wake rather than in the context block because it
 * applies only then, and the block is paid for on every turn. The facts it
 * asks for are in the same notice (a completed or failed build names each
 * criterion's result and the commit Verify judged,
 * `coordinator-build-pipeline-status.ts`) and in `get_build_pipeline`, so the
 * model reports rather than guesses.
 */
export const COORDINATOR_HANDOFF_RULE =
  'This work has ended. Close it for the user in one message: Delivered (what changed and where: commits kept, branch pushed, or the PR link); Criteria (for a build: passed, failed and not checked, with the commit Verify judged them on, from this notice or get_build_pipeline; say "commit not recorded" when it was not); Open (failed or unchecked criteria, findings, errors); Needs you (what the user must review, merge or decide). Ready for review, all criteria verified and merged are different claims: never state one for another.';

/**
 * Self-timers and provider accounts, told to every main coordinator verbatim.
 *
 * "Check the workers in 2 hours and switch accounts if they hit a usage
 * limit" needs three tools in order, and a coordinator that does not know
 * the timer can carry the user's permission would either ask the user again
 * when it fires (nobody may be there) or switch without asking.
 */
export const COORDINATOR_TIMERS_AND_ACCOUNTS_RULE =
  'Timers and accounts: for "in 2 hours" or "at 14:30" call create_schedule with action type remind_me (times are the user\'s local time) and put the whole instruction in its body; it wakes you with that text, queued until you are idle. If the user\'s own message asks you to switch accounts then, add authorizeAccountSwitch. When woken: get_usage_limits, list_provider_accounts, then switch_provider_account with the timer\'s scheduleId; without one the user approves the switch, unless Settings lets coordinators switch without asking: then it runs at once (state switched), so tell the user what you switched and never ask them to approve it. After switching, resume each limitedTabs tab (after approval, read get_usage_limits) with a short send_prompt_to_tab, e.g. "continue"; they do not restart themselves. Never switch accounts on your own initiative. Automatic switching is separate: when the user asks, set_account_auto_switch turns it on, the backend then moves accounts by itself and you get a notice each time, and your own switch would pin the account and turn it off.';

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
 * What a coordinator is told instead of `COORDINATOR_ASYNC_CONTRACT` while agent
 * messaging is off, on the same surfaces. Every wake is mail, and a wake held
 * while messaging is off goes out only when it is turned back on, so promising
 * one would leave the coordinator waiting on the user's setting.
 */
export const COORDINATOR_MESSAGING_OFF_NOTE =
  "Agent messaging is off, so nothing wakes this conversation and no worker can report back until the user turns it on in Settings. Do not launch workers or wait for a wake: tell the user. Read a worker's state with list_workflows or get_environment when asked.";

/**
 * What `create_pr` and `resolve_conflicts` tell a coordinator about being woken.
 *
 * Their pull request is followed by status wakes (a `pull-request`
 * association), so the model is told what it will hear rather than left to
 * poll `get_environment` for `prUrl`.
 */
export const COORDINATOR_PR_STATUS_WAKE =
  "This conversation will be woken with a status update when this pull request opens (with its URL), starts conflicting with its base branch, fails its checks, becomes ready to merge, or is merged or closed, and once when a Resolve tab finishes, with the refreshed state. Updates that land together arrive in one wake. Read its state with get_environment; never merge it. Do not poll.";

/**
 * What a workflow-starting tool tells a coordinator about being woken.
 *
 * Carried on the result for the same reason as the delegation contract: the
 * model's question right after starting a review or a build is "how will I
 * know?", and without an answer the obvious move is to poll its status.
 */
export const COORDINATOR_WORKFLOW_STATUS_WAKE =
  "This conversation will be woken with a status update when this workflow settles: a Multi Review ready to address, its fix done or failed, its automatic PR session started, opened or failed (after which the pull request's own changes wake you: conflicts, failing checks, ready to merge, merged or closed), a build paused on an error, a stall, and any workflow completing, failing or being cancelled. With auto-fix and auto-PR the review advances on its own, and you hear the outcome rather than each step. Updates that land together arrive in one wake. Do not poll its status.";

/**
 * What moved the checkout's HEAD: a fast-forward to its upstream
 * (`syncProjectGit`, the pre-message and pre-mail checks, a merge follow), a
 * branch switch from the toolbar, or anything observed afterwards that
 * Orkestrator did not do itself (a Git command in a terminal).
 */
export type CoordinatorRepositoryContextSource = "upstream" | "switch" | "external";

export interface CoordinatorRepositoryContextEvent {
  revision: number;
  branch: string | null;
  headCommit: string | null;
  occurredAt: string;
  /** Where HEAD was before this change. Absent on events from older releases. */
  previousBranch?: string | null;
  previousHeadCommit?: string | null;
  /** Absent on events from older releases. */
  source?: CoordinatorRepositoryContextSource;
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
  /**
   * Written only by backends before `CoordinatorConversation.startupError`,
   * which also set `lifecycleState: "error"`. Read for such a backend, and for
   * a record it stored (version-compatibility.md).
   */
  lastStartupError?: string;
  bridgePort?: number;
  bridgePid?: number;
  repositoryStatus?: ProjectGitStatus;
  /**
   * The IANA zone of the device that sent the newest prompt the user typed to
   * any of this coordinator's conversations. A self-timer's absolute time
   * (`at: "14:30"`) is read in it, so a coordinator on a machine in another
   * zone still means the user's 14:30. Absent until a renderer that reports
   * its zone sends a prompt; until then the backend host's zone is used. An
   * older backend ignores it.
   */
  userTimeZone?: string;
}

export interface CoordinatorSnapshot {
  workspace: CoordinatorWorkspace;
  projectPath: string;
  providerAvailability: Partial<Record<AgentPlatform, CoordinatorProviderQualification>>;
  controlMcp: { enabled: boolean; running: boolean; error: string | null };
  /** Absent from a backend older than this field, which says nothing about the setting. */
  agentMessaging?: { enabled: boolean };
  workflows: CoordinatorWorkflowAssociation[];
  /**
   * How close the shared workflow store is to refusing new records
   * (`coordinator-workflow-retention.ts`). Absent from a backend older than
   * this field, which says nothing about the store.
   */
  workflowStore?: CoordinatorWorkflowStoreState;
}

/**
 * `near-limit`: fewer than one cleanup batch of records is left before the
 * store refuses; `full`: every record is still in use, so new work is refused.
 */
export type CoordinatorWorkflowStoreState = "ok" | "near-limit" | "full";

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

/**
 * Whether this conversation may run: hold a credential, receive mail, start a
 * bridge. Every "is this coordinator up?" question goes through this, because
 * `lifecycleState` alone no longer answers it for one conversation.
 */
export function coordinatorConversationRunnable(
  workspace: Pick<CoordinatorWorkspace, "lifecycleState">,
  conversation: Pick<CoordinatorConversation, "startupError">,
): boolean {
  return workspace.lifecycleState === "ready" && !conversation.startupError;
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
        (item.lastTurnOrigin === undefined ||
          item.lastTurnOrigin === "user" ||
          item.lastTurnOrigin === "mail") &&
        (item.lastTurnStartedAt === undefined || typeof item.lastTurnStartedAt === "string") &&
        (item.startupError === undefined || typeof item.startupError === "string") &&
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
            typeof item.occurredAt === "string" &&
            (item.previousBranch === undefined ||
              item.previousBranch === null ||
              typeof item.previousBranch === "string") &&
            (item.previousHeadCommit === undefined ||
              item.previousHeadCommit === null ||
              typeof item.previousHeadCommit === "string") &&
            (item.source === undefined ||
              item.source === "upstream" ||
              item.source === "switch" ||
              item.source === "external")
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
