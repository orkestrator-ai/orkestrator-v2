import { isSignInLink } from "@orkestrator/protocol/human-prompts";
import { goalIsRunning, type NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import { createHash, randomUUID } from "node:crypto";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorConversationRole,
  type CoordinatorSnapshot,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { resolveDefaultAgent } from "@orkestrator/protocol/agent-settings";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import {
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { StorageService } from "./storage.js";
import type { Environment } from "./models.js";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { AgentTabState } from "@orkestrator/protocol/agent-registry";
import { resolveProjectGitRoot } from "./project-git-service.js";
import {
  coordinatorProviderQualification,
  coordinatorProviderQualifications,
  type CoordinatorHostCapabilities,
} from "./coordinator-providers.js";
import {
  boundedLine,
  CoordinatorStatusWakes,
  type CoordinatorStatusWakeOptions,
} from "./coordinator-status-wakes.js";
import { agentMessagingEnabled } from "./coordinator-context-reads.js";
import {
  closingDelegationWakeKind,
  reconcileClosedConversations,
  reconcileMainMail,
} from "./coordinator-closed-conversations.js";
import {
  currentOpenDelegation,
  readOpenDelegations,
  type OpenDelegationLookup,
} from "./coordinator-open-delegations.js";
import { CoordinatorNoticeRouter } from "./coordinator-notice-router.js";
import { CoordinatorNodeReleases } from "./coordinator-node-release.js";
import {
  CoordinatorNodeReconnectWakes,
  type CoordinatorNodeAttempt,
} from "./coordinator-node-reconnect-wakes.js";
import {
  decideDelegation,
  type DelegationDecision,
  type DelegationDecisionState,
  type DelegationEnvironment,
  type DelegationObservations,
  type DelegationOutcome,
} from "./coordinator-delegation-decision.js";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import type { CoordinatorRemoteAccess } from "./coordinator-remote.js";
import {
  CoordinatorPullRequestWatches,
  type CoordinatorPullRequestWatchOptions,
} from "./coordinator-pr-watches.js";
import { createLogger, formatLogError, logErrorKind } from "@orkestrator/protocol/logger";

const log = createLogger("coordinator");

const MAX_STARTUP_ERROR_CHARS = 2_000;
const DELEGATION_IDLE_RECONCILE_GRACE_MS = 15_000;
/**
 * How long a delegation stays open after its worker ended a turn without a
 * report while work it started in the background (a shell, sub-agents) is
 * still running. The worker usually resumes when that work reports; past
 * this, it may have left a long-lived process behind and the coordinator is
 * told after all. Raw activity cannot distinguish awaited work from servers
 * or watchers, so keep this fallback short and qualify the timeout notice.
 */
const DELEGATION_BACKGROUND_WORK_HOLD_MS = 2 * 60_000;
/**
 * A delegation whose wake has failed this many passes, over at least
 * {@link DELEGATION_WAKE_RETIRE_MIN_MS}, is retired: it stops being retried and
 * its coordinator gets one notice. Passes also run on turn-end edges, which on a
 * busy host come many times a minute, so the count alone would let a short fault
 * retire every wake owed; the time bound is what makes it mean "keeps failing".
 */
const DELEGATION_WAKE_RETIRE_ATTEMPTS = 10;
const DELEGATION_WAKE_RETIRE_MIN_MS = 10 * 60_000;
const CONVERSATION_LIMIT_MESSAGE = "Coordinator conversation limit reached";

/**
 * A wake failure that is a state the user can change, not a fault of this
 * delegation: messaging turned off, or no room to open a main. Such a wake is
 * held and retried, because the wake is owed again as soon as the state changes.
 */
function wakeHeldByUserState(error: unknown): boolean {
  return error instanceof AgentMailError
    ? error.code === "messaging-disabled"
    : error instanceof Error && error.message === CONVERSATION_LIMIT_MESSAGE;
}

type GatheredDelegationObservations = Pick<
  DelegationObservations,
  "evidence" | "undeliveredRequest" | "goalRunning"
>;

/** Delegation settling knobs beyond the status-wake options. */
export interface CoordinatorDelegationOptions {
  /**
   * Whether a worker tab's turn has ended while background work it started is
   * still running (the raw session state is working, the turn view idle).
   */
  workerBackgroundWork?: (environmentId: string, tabId: string) => Promise<boolean>;
  /** Overrides {@link DELEGATION_BACKGROUND_WORK_HOLD_MS}; for tests. */
  backgroundWorkHoldMs?: number;
  /** Overrides {@link DELEGATION_WAKE_RETIRE_MIN_MS}; for tests. */
  wakeRetireMinMs?: number;
  /**
   * Whether a command in the worker environment is waiting on the user (a
   * sign-in link, a code, a password; see `human-prompt-registry.ts`). Such a
   * turn end is a hand-off to a person, so it is never held for background work.
   */
  workerNeedsHuman?: (environmentId: string) => boolean;
  /**
   * The goal on a worker tab. While one runs the tab reads idle between
   * iterations, and that idle is the loop's, not the worker's answer.
   */
  workerGoal?: (environmentId: string, tabId: string) => Promise<NativeAgentGoal | undefined>;
  /** Overrides `NODE_OFFLINE_NOTICE_MS` (`coordinator-node-release.ts`); for tests. */
  nodeOfflineNoticeMs?: number;
}

export function sanitizeCoordinatorError(value: unknown): string {
  const text = (value instanceof Error ? value.message : String(value))
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{16,}\b/gi, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return text.slice(0, MAX_STARTUP_ERROR_CHARS) || "Coordinator startup failed";
}

/** Whether a saved composer draft holds anything a user wrote or attached. */
function composeDraftHasContent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  if (typeof draft.text === "string" && draft.text.trim().length > 0) return true;
  return ["mentions", "attachments", "annotations"].some(
    (field) => Array.isArray(draft[field]) && (draft[field] as unknown[]).length > 0,
  );
}

/** At most this many conversations are open: the main coordinator and its side agents. */
const MAX_OPEN_COORDINATOR_CONVERSATIONS = 16;

function conversation(
  workspaceId: string,
  role: CoordinatorConversationRole,
  sideOrdinal?: number,
  agent?: AgentPlatform,
): CoordinatorConversation {
  const id = randomUUID();
  const tabId = `coordinator-${id}`;
  return {
    id,
    tabId,
    logicalSessionKey: coordinatorConversationSessionKey(workspaceId, { id, tabId }),
    title: role === "main" ? "Coordinator" : `Side ${sideOrdinal}`,
    createdAt: new Date().toISOString(),
    mailboxIncarnationId: randomUUID(),
    role,
    ...(role === "side" ? { sideOrdinal } : {}),
    ...(agent ? { agent } : {}),
  };
}

function nextSideOrdinal(workspace: CoordinatorWorkspace): number {
  const used = new Set(
    workspace.conversations
      .filter((item) => !item.closedAt && item.role === "side")
      .map((item) => item.sideOrdinal),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

function retainCoordinatorConversations(
  conversations: CoordinatorConversation[],
): CoordinatorConversation[] {
  const open = conversations.filter((item) => !item.closedAt);
  const closed = conversations.filter((item) => item.closedAt);
  const closedBudget = Math.max(0, 64 - open.length);
  const retainedClosed = new Set(
    (closedBudget > 0 ? closed.slice(-closedBudget) : []).map((item) => item.id),
  );
  return conversations.filter((item) => !item.closedAt || retainedClosed.has(item.id));
}

/** Backend authority for one durable, non-disposable project coordinator. */
export class CoordinatorService {
  private readonly projectOperations = new Map<string, Promise<unknown>>();
  private delegationWakeDelivery: Promise<void> | null = null;
  /** A call arrived during the running pass, which read its list before that call's close. */
  private delegationWakeRerun = false;
  /** Status wakes for work this coordinator started; see `coordinator-status-wakes.ts`. */
  readonly statusWakes: CoordinatorStatusWakes;
  /** Pull requests its conversations showed; see `coordinator-pr-watches.ts`. */
  readonly pullRequestWatches: CoordinatorPullRequestWatches;
  /** Who hears a notice for a repository; see `coordinator-notice-router.ts`. */
  readonly noticeRouter: CoordinatorNoticeRouter;
  /** Reads of work on other nodes; absent until the node services exist. */
  private remote: CoordinatorRemoteAccess | null = null;
  /**
   * Remote delegations whose worker was seen working since the coordinator
   * last asked it something. A remote turn end has no edge here, so "idle
   * after working" is the edge; "idle" alone only counts after a grace
   * period, in case the worker never started. Lost on restart, which only
   * falls back to the grace period.
   */
  private readonly remoteSeenWorking = new Set<string>();
  private readonly remoteAskedAt = new Map<string, { at: number }>();
  /**
   * Delegations whose worker ended a turn without a report while its
   * background work kept running, with when that was first seen. Lost on
   * restart, which only restarts the hold.
   */
  private readonly backgroundWorkSince = new Map<string, { since: number; requestedAt: string }>();
  /**
   * Failed wake attempts per delegation since its last success. In memory so a
   * failing sweep writes nothing to a store that is rewritten whole; a restart
   * only restarts the count.
   */
  private readonly delegationWakeFailures = new Map<string, { attempts: number; since: number }>();
  /**
   * Delegations this process closed without announcing, by project. A wake's
   * final write (`wokenAt`) announces it; a wake that did not get that far is
   * announced once after its attempt, so the Work panel still sees the close.
   * Lost on restart, when every client reads afresh anyway.
   */
  private readonly unannouncedCloses = new Map<string, string>();
  /**
   * Work on nodes that left this registry, and the per-node offline clock
   * beside the maps above (`coordinator-node-release.ts`).
   */
  private readonly nodeReleases: CoordinatorNodeReleases;
  /** Who tried a node while it was disconnected (`coordinator-node-reconnect-wakes.ts`). */
  private readonly nodeReconnectWakes: CoordinatorNodeReconnectWakes;

  constructor(
    private readonly storage: StorageService,
    private readonly controlMcp: () => {
      enabled: boolean;
      running: boolean;
      error: string | null;
    },
    private readonly host?: CoordinatorHostCapabilities,
    private readonly workerActivity?: (
      environmentId: string,
      tabId: string,
    ) => Promise<AgentActivityState | "unknown">,
    private readonly options: Omit<CoordinatorStatusWakeOptions, "workerActivity"> &
      CoordinatorDelegationOptions &
      Pick<CoordinatorPullRequestWatchOptions, "gitHubCli"> = {},
  ) {
    this.noticeRouter = new CoordinatorNoticeRouter(storage, (projectId) =>
      this.startMainForNotice(projectId),
    );
    this.statusWakes = new CoordinatorStatusWakes(storage, {
      ...options,
      pullRequestMetadata:
        options.pullRequestMetadata ?? ((url) => this.pullRequestWatches.metadata(url)),
      noticeRouter: this.noticeRouter,
      ...(workerActivity ? { workerActivity } : {}),
    });
    this.pullRequestWatches = new CoordinatorPullRequestWatches({
      storage,
      noticeRouter: this.noticeRouter,
      ...(options.gitHubCli ? { gitHubCli: options.gitHubCli } : {}),
      ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
    });
    const mainAddress = async (coordinatorId: string) => {
      const owner = await storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
      if (!owner) return null;
      const { workspace, main } = await this.ensureMainConversation(owner.projectId);
      return { environmentId: coordinatorRuntimeId(workspace.id, main.id), tabId: main.tabId };
    };
    const nodeName = (nodeId: string) => this.remote?.nodeName(nodeId) ?? Promise.resolve(nodeId);
    this.nodeReleases = new CoordinatorNodeReleases({
      storage,
      mainAddress,
      nodeName,
      ...(options.nodeOfflineNoticeMs !== undefined
        ? { offlineNoticeMs: options.nodeOfflineNoticeMs }
        : {}),
    });
    this.nodeReconnectWakes = new CoordinatorNodeReconnectWakes({ storage, mainAddress, nodeName });
    // Mail to "coordinator", or to a conversation that has since closed, finds
    // the current main through here, which starts one if there is none.
    this.storage.setCoordinatorMailResolver?.((projectId) => this.mainMailAddress(projectId));
  }

  /** Work on other nodes becomes readable once the node services exist. */
  setRemoteAccess(remote: CoordinatorRemoteAccess): void {
    this.remote = remote;
    this.statusWakes.setRemoteAccess(remote);
  }

  /**
   * Nodes this command node no longer controls (`NodeService`'s
   * `onNodesReleased`): forgotten, or handed to another command node. Their
   * open delegations close as `stopped`, their workflows are marked reported,
   * and each coordinator with work there hears one notice, so nothing waits
   * on a node that cannot answer here and its records become clearable.
   */
  async nodesReleased(
    nodes: ReadonlyArray<{ nodeId: string; name?: string }>,
    reason: "forgotten" | "handed-over",
  ): Promise<void> {
    for (const node of nodes) {
      // Never throws: the registry change already happened. The sweep's
      // registry check releases whatever this could not.
      const closed = await this.nodeReleases
        .release(node.nodeId, reason, node.name)
        .catch((error: unknown) => {
          log.warn("node-release.failed", { error: formatLogError(error, { stack: false }) });
          return [];
        });
      for (const id of closed) {
        this.remoteAskedAt.delete(id);
        this.remoteSeenWorking.delete(id);
        this.backgroundWorkSince.delete(id);
      }
    }
  }

  /** A coordinator's call on a disconnected node was refused; woken once it reconnects. */
  noteNodeUnavailable(attempt: CoordinatorNodeAttempt): void {
    this.nodeReconnectWakes.noteRefused(attempt);
  }

  /** A node connected (again): wake the conversations that tried it meanwhile. Never throws. */
  nodeConnected(nodeId: string): Promise<void> {
    return this.nodeReconnectWakes.nodeConnected(nodeId);
  }

  /**
   * The sweep's half of node release: records naming a node the registry no
   * longer holds (forgotten before release existed, or a release interrupted
   * by a restart) are released, and any notice still owed is sent.
   */
  private async reconcileReleasedNodes(): Promise<void> {
    const registered = await this.remote?.registeredNodeIds?.();
    if (registered) await this.nodeReleases.releaseUnregistered(registered);
    else await this.nodeReleases.deliverNotices();
  }

  /**
   * The coordinator asked a remote worker something more (a prompt or a
   * message joining an open delegation): the turn that settles it is one
   * that starts after now.
   */
  noteRemoteRequest(associationId: string): void {
    this.backgroundWorkSince.delete(associationId);
    this.remoteSeenWorking.delete(associationId);
    this.remoteAskedAt.set(associationId, { at: Date.now() });
  }

  /**
   * The current main conversation's mail address, starting one if the user
   * closed it. Null when the project has never had a coordinator: an address
   * nobody asked for is not a reason to create one.
   */
  async mainMailAddress(
    projectId: string,
  ): Promise<{ environmentId: string; tabId: string } | null> {
    if (!(await this.storage.coordinators.getCoordinatorWorkspace(projectId))) return null;
    const { workspace, main } = await this.ensureMainConversation(projectId);
    return { environmentId: coordinatorRuntimeId(workspace.id, main.id), tabId: main.tabId };
  }

  /**
   * A new notice needs a coordinator and none is running. Unlike mail to an
   * address, this creates a project's first one too: a machine with the
   * repository has a coordinator for it, whether or not one was ever opened.
   * Serialized per project, so notices arriving together start only one.
   */
  private async startMainForNotice(
    projectId: string,
  ): Promise<{ workspace: CoordinatorWorkspace; main: CoordinatorConversation }> {
    if (!(await this.storage.coordinators.getCoordinatorWorkspace(projectId))) {
      await this.ensure(projectId);
    }
    return this.ensureMainConversation(projectId);
  }

  /**
   * The project's main coordinator, started with the default agent when there
   * is none open. Closing the main tab is how a user changes its provider; the
   * next mail that needs a coordinator starts a fresh one rather than being
   * lost. Work the closed conversation still owed a report to moves with it.
   *
   * An open main that has never run gets the default agent the same way: with
   * no agent it could neither read this mail nor be woken for it. With no
   * qualified agent it stays unassigned and the mail waits for the user.
   *
   * Every path that opens a main comes through here. `opened` is one the user
   * just opened (`ensure`, `createConversation`): it stays unassigned, and
   * open side conversations keep their own work.
   */
  async ensureMainConversation(
    projectId: string,
    options: { opened?: boolean } = {},
  ): Promise<{ workspace: CoordinatorWorkspace; main: CoordinatorConversation }> {
    const opened = options.opened === true;
    const result = await this.serialize(projectId, async () => {
      const existing = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace was not found");
      const open = coordinatorMainConversation(existing);
      if (open?.agent) return { workspace: existing, main: open };
      if (open) {
        if (opened) return { workspace: existing, main: open };
        const agent = await this.preferredAgent(projectId).catch(() => undefined);
        if (!agent) return { workspace: existing, main: open };
        const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
          projectId,
          (current) => {
            if (!current) throw new Error("Coordinator workspace disappeared");
            return {
              ...current,
              conversations: current.conversations.map((item) =>
                item.id === open.id && !item.agent ? { ...item, agent } : item,
              ),
              updatedAt: new Date().toISOString(),
            };
          },
        );
        if (!workspace) throw new Error("Coordinator workspace disappeared");
        return {
          workspace,
          main: coordinatorMainConversation(workspace) ?? open,
        };
      }
      if (
        existing.conversations.filter((item) => !item.closedAt).length >=
        MAX_OPEN_COORDINATOR_CONVERSATIONS
      ) {
        throw new Error(CONVERSATION_LIMIT_MESSAGE);
      }
      const created = conversation(
        existing.id,
        "main",
        undefined,
        opened ? undefined : await this.preferredAgent(projectId).catch(() => undefined),
      );
      const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
        projectId,
        (current) => {
          if (!current) throw new Error("Coordinator workspace disappeared");
          return {
            ...current,
            conversations: retainCoordinatorConversations([...current.conversations, created]),
            selectedConversationId: current.selectedConversationId ?? created.id,
            updatedAt: new Date().toISOString(),
          };
        },
      );
      if (!workspace) throw new Error("Coordinator workspace disappeared");
      const main = coordinatorMainConversation(workspace) ?? created;
      return { workspace, main };
    });
    // What every path that opens or uses a main does next: the work other
    // conversations still owe moves onto it, and so does the mail waiting in
    // a closed main's inbox. Reads never do this (`snapshot`); the sweep
    // repeats the closed-conversation half for every coordinator at once.
    await reconcileMainMail(this.storage, result.workspace, result.main, { closedOnly: opened });
    return { workspace: result.workspace, main: result.main };
  }

  /** A failure is logged, not thrown: the sweep repeats the repair. */
  private async settleNewMain(
    projectId: string,
    workspace: CoordinatorWorkspace,
  ): Promise<CoordinatorWorkspace> {
    try {
      return (await this.ensureMainConversation(projectId, { opened: true })).workspace;
    } catch (error: unknown) {
      log.warn("mail.reconcile-failed", {
        coordinatorId: workspace.id,
        error: formatLogError(error, { stack: false }),
      });
      return workspace;
    }
  }

  /**
   * The qualification inputs, read fresh.
   *
   * Turning a platform off, or lowering the coordinator safety level, has to
   * affect the next answer rather than the next restart — an assigned
   * conversation on a platform that just became unavailable must stop being
   * offered immediately.
   */
  private async qualificationOptions(): Promise<{
    tierSetting: unknown;
    enabledPlatforms: AgentPlatform[];
    host?: CoordinatorHostCapabilities;
  }> {
    const config = await this.storage.loadConfig();
    return {
      tierSetting: config.global.coordinatorProviderTiers,
      enabledPlatforms: normalizeAgentPlatforms(config.global.enabledAgentPlatforms),
      ...(this.host ? { host: this.host } : {}),
    };
  }

  /** Whether this platform may hold a coordinator conversation right now. */
  async providerAllowed(platform: AgentPlatform): Promise<boolean> {
    return coordinatorProviderQualification(platform, await this.qualificationOptions()).available;
  }

  async providerUnavailableMessage(platform: AgentPlatform): Promise<string> {
    const qualification = coordinatorProviderQualification(
      platform,
      await this.qualificationOptions(),
    );
    return (
      qualification.reason ?? "This agent platform is not available for Coordinator on this host."
    );
  }

  /** The platform a fresh conversation should preselect, when one qualifies. */
  async preferredAgent(projectId: string): Promise<AgentPlatform | undefined> {
    const options = await this.qualificationOptions();
    const configured = await this.configuredAgent(projectId);
    if (coordinatorProviderQualification(configured, options).available) return configured;
    const fallback = options.enabledPlatforms.filter(
      (platform) => coordinatorProviderQualification(platform, options).available,
    );
    if (fallback.length === 0) return undefined;
    return firstEnabledAgentPlatform(fallback, configured);
  }

  private serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectOperations.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.projectOperations.set(projectId, settled);
    void settled.finally(() => {
      if (this.projectOperations.get(projectId) === settled)
        this.projectOperations.delete(projectId);
    });
    return next;
  }

  /**
   * A workspace write that waits its turn behind create, ensure and assign, so
   * it cannot land between their steps. Only the write: the snapshot that follows
   * reconciles mail, and this must not hold the project's queue across that.
   */
  private mutateSerialized(
    projectId: string,
    mutate: Parameters<StorageService["coordinators"]["mutateCoordinatorWorkspace"]>[1],
  ): Promise<CoordinatorWorkspace | null> {
    return this.serialize(projectId, () =>
      this.storage.coordinators.mutateCoordinatorWorkspace(projectId, mutate),
    );
  }

  async canonicalProjectPath(projectId: string): Promise<string> {
    return resolveProjectGitRoot(this.storage, projectId);
  }

  private async configuredAgent(projectId: string): Promise<AgentPlatform> {
    const project = await this.storage.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const config = await this.storage.loadConfig();
    const repository = config.repositories[project.gitUrl] ?? config.repositories[projectId];
    return resolveDefaultAgent({
      repository: repository?.agentSettings,
      global: config.global.agentSettings,
    });
  }

  /**
   * `clearConversationErrors` serves a renderer that predates per-conversation
   * failures: its panel has no Retry for one, and opening the panel is the only
   * recovery it knows (version-compatibility.md).
   */
  async ensure(
    projectId: string,
    options: { clearConversationErrors?: boolean } = {},
  ): Promise<CoordinatorSnapshot> {
    const ensured = await this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const before = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      // A workspace only reaches `error` as a record an older backend stored:
      // startup failures now mark the conversation that failed. Recovering it
      // never rewrites which platform a conversation belongs to.
      const canRecoverError = before?.lifecycleState === "error";
      const clearErrors =
        options.clearConversationErrors === true &&
        before?.conversations.some((item) => item.startupError) === true;
      if (clearErrors)
        compatibilityPathUsage.record("coordinator-ensure.conversation-errors-cleared");
      const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
        projectId,
        (current) => {
          if (current) {
            if ((!canRecoverError && !clearErrors) || current.id !== before?.id) return current;
            return {
              ...current,
              ...(canRecoverError ? { lifecycleState: "ready" as const } : {}),
              lastStartupError: undefined,
              conversations: clearErrors
                ? current.conversations.map((item) => ({ ...item, startupError: undefined }))
                : current.conversations,
              updatedAt: new Date().toISOString(),
            };
          }
          const id = randomUUID();
          const initial = conversation(id, "main");
          const now = new Date().toISOString();
          return {
            version: COORDINATOR_WORKSPACE_VERSION,
            id,
            projectId,
            executionPolicy: COORDINATOR_EXECUTION_POLICY,
            lifecycleState: "ready",
            conversations: [initial],
            selectedConversationId: initial.id,
            repositoryContextRevision: 0,
            createdAt: now,
            updatedAt: now,
          };
        },
      );
      if (!workspace) throw new Error("Coordinator workspace could not be created");
      return { workspace, projectPath, created: !before };
    });
    // A new coordinator's first main is settled now, not on the next sweep.
    const workspace =
      ensured.created && coordinatorMainConversation(ensured.workspace)
        ? await this.settleNewMain(projectId, ensured.workspace)
        : ensured.workspace;
    return this.snapshot(workspace, ensured.projectPath);
  }

  async get(projectId: string): Promise<CoordinatorSnapshot | null> {
    const workspace = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
    if (!workspace) return null;
    return this.snapshot(workspace, await this.canonicalProjectPath(projectId));
  }

  /**
   * What a coordinator looks like now. A read, and nothing more: no adoption,
   * mail move or other write, so the panel's view and every agent's
   * `read_messages` stay cheap. Work and mail closed conversations left behind
   * move when a main opens (`ensureMainConversation`), when a conversation closes,
   * and on the sweep (`reconcileWorkerDelegations`).
   */
  private async snapshot(
    workspace: CoordinatorWorkspace,
    projectPath: string,
  ): Promise<CoordinatorSnapshot> {
    const availability = coordinatorProviderQualifications(await this.qualificationOptions());
    const mcp = this.controlMcp();
    return {
      workspace,
      projectPath,
      providerAvailability: availability,
      controlMcp: { enabled: mcp.enabled, running: mcp.running, error: mcp.error },
      agentMessaging: { enabled: await agentMessagingEnabled(this.storage) },
      workflows: await this.storage.coordinators.listCoordinatorWorkflowAssociations(
        workspace.projectId,
      ),
      workflowStore: await this.storage.coordinators.getCoordinatorWorkflowStoreState(),
    };
  }

  /**
   * Whether an open conversation was never used: an unassigned side agent with
   * no saved draft, no mail and no work. The caller names the candidates (it
   * knows its own unsaved composer text); this is the backend's half, so a
   * draft another window saved, or mail the main already sent, keeps it open.
   */
  private async unusedConversation(
    workspace: CoordinatorWorkspace,
    conversationId: string,
  ): Promise<boolean> {
    const item = workspace.conversations.find((entry) => entry.id === conversationId);
    if (!item || item.closedAt || item.role !== "side" || item.agent || item.providerSessionId) {
      return false;
    }
    const runtimeId = coordinatorRuntimeId(workspace.id, item.id);
    const drafts = await this.storage.listComposeDrafts("environment", runtimeId);
    if (drafts.some((draft) => composeDraftHasContent(draft.value))) return false;
    const mail = await this.storage
      .getAgentMailMailbox(runtimeId, item.tabId, { limit: 1 })
      .catch((error: unknown) => {
        if (error instanceof AgentMailError && error.code === "recipient-not-found") return null;
        return "unavailable" as const;
      });
    if (mail === "unavailable" || (mail && mail.total > 0)) return false;
    const work = await this.storage.coordinators.listCoordinatorWorkflowAssociations(
      workspace.projectId,
    );
    return !work.some(
      (association) =>
        association.coordinatorId === workspace.id && association.conversationId === item.id,
    );
  }

  /**
   * Open a conversation: the main coordinator when none is open, otherwise the
   * next side agent.
   *
   * `closeUnused` names unassigned conversations the caller's composer shows
   * as empty. Each one the backend agrees was never used is closed in the
   * same write, so empty composers cannot fill the open-conversation limit.
   */
  async createConversation(
    projectId: string,
    title?: string,
    options: { closeUnused?: readonly string[] } = {},
  ): Promise<CoordinatorSnapshot> {
    if (!(await this.storage.coordinators.getCoordinatorWorkspace(projectId))) {
      await this.ensure(projectId);
    }
    const created = await this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const existing = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace disappeared");
      const hadMain = coordinatorMainConversation(existing) !== undefined;
      const unused = new Set<string>();
      for (const id of new Set(options.closeUnused ?? [])) {
        if (await this.unusedConversation(existing, id)) unused.add(id);
      }
      // Deliberately unassigned. Inheriting the selected conversation's
      // provider is what made a new conversation look locked: the composer had
      // one platform before the user had said anything.
      //
      // With no main open this starts the main coordinator; otherwise it adds
      // the next side agent. There is never a second main.
      const workspace = await this.storage.coordinators.mutateCoordinatorWorkspaceWithComposeDrafts(
        projectId,
        (current, drafts) => {
          if (!current) throw new Error("Coordinator workspace disappeared");
          const now = new Date().toISOString();
          // Re-checked against the record being written: a conversation
          // assigned since the read above is no longer unused.
          const conversations = current.conversations.map((item) =>
            unused.has(item.id) &&
            !item.closedAt &&
            !item.agent &&
            !item.providerSessionId &&
            item.role === "side" &&
            !drafts.some(
              (draft) =>
                draft.ownerType === "environment" &&
                draft.ownerId === coordinatorRuntimeId(current.id, item.id) &&
                composeDraftHasContent(draft.value),
            )
              ? { ...item, closedAt: now }
              : item,
          );
          if (
            conversations.filter((item) => !item.closedAt).length >=
            MAX_OPEN_COORDINATOR_CONVERSATIONS
          ) {
            throw new Error(CONVERSATION_LIMIT_MESSAGE);
          }
          const remaining = { ...current, conversations };
          const created = coordinatorMainConversation(remaining)
            ? conversation(current.id, "side", nextSideOrdinal(remaining))
            : conversation(current.id, "main");
          if (title?.trim() && created.role === "main") created.title = title.trim();
          return {
            ...current,
            conversations: retainCoordinatorConversations([...conversations, created]),
            selectedConversationId: created.id,
            updatedAt: now,
          };
        },
      );
      if (!workspace) throw new Error("Coordinator workspace disappeared");
      await this.storage.coordinators.pruneCoordinatorAttachmentDirectories(
        workspace.id,
        new Set(workspace.conversations.map((item) => item.id)),
      );
      return { workspace, projectPath, hadMain };
    });
    // With no main open this started one, which takes over closed work.
    let workspace = created.workspace;
    if (!created.hadMain && coordinatorMainConversation(workspace)) {
      workspace = await this.settleNewMain(projectId, workspace);
    } else {
      // Side conversations need a mailbox immediately too; snapshots no longer
      // perform this synchronization as a side effect.
      await this.storage.synchronizeAgentMailboxes();
    }
    return this.snapshot(workspace, created.projectPath);
  }

  /**
   * Bind a conversation to the provider its first prompt chose.
   *
   * One-way for the life of the conversation once a provider session exists.
   * Before that a re-assignment is allowed on purpose: a first send that failed
   * to start a bridge leaves nothing materialized, and stranding the user on the
   * platform that just failed would make the conversation unusable.
   */
  async assignConversationAgent(
    projectId: string,
    conversationId: string,
    agent: AgentPlatform,
  ): Promise<CoordinatorSnapshot> {
    return this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const existing = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace was not found");
      const target = existing.conversations.find((item) => item.id === conversationId);
      if (!target || target.closedAt) throw new Error("Coordinator conversation was not found");
      if (target.agent === agent) return this.snapshot(existing, projectPath);
      if (!(await this.providerAllowed(agent))) {
        throw new Error(await this.providerUnavailableMessage(agent));
      }
      if (target.agent) {
        // Storage, not the absence of a `providerSessionId`, is the authority:
        // the field is a projection and may lag a session that already exists.
        const sessions = await this.storage.listNativeAgentSessions();
        const materialized = sessions.some(
          (session) =>
            session.owner?.kind === "coordinator" &&
            session.owner.coordinatorId === existing.id &&
            session.logicalSessionKey === target.logicalSessionKey,
        );
        if (materialized) {
          throw new Error(
            "This conversation already has a provider session. Start a new conversation to use a different agent.",
          );
        }
      }
      const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
        projectId,
        (current) => {
          if (!current) throw new Error("Coordinator workspace was not found");
          const item = current.conversations.find((entry) => entry.id === conversationId);
          if (!item || item.closedAt) throw new Error("Coordinator conversation was not found");
          return {
            ...current,
            conversations: current.conversations.map((entry) =>
              entry.id === conversationId ? { ...entry, agent } : entry,
            ),
            updatedAt: new Date().toISOString(),
          };
        },
      );
      if (!workspace) throw new Error("Coordinator workspace was not found");
      // The mailbox now has an agent, so mail that arrived while the
      // conversation was unassigned becomes deliverable. Both steps are
      // best-effort: assignment is what the user asked for, and a mail store
      // that cannot be written must not strand the conversation without a
      // provider.
      await this.storage.synchronizeAgentMailboxes().catch(() => undefined);
      await this.storage
        .promoteStoredAgentMailForMailbox(
          coordinatorRuntimeId(workspace.id, conversationId),
          target.tabId,
        )
        .catch(() => undefined);
      return this.snapshot(workspace, projectPath);
    });
  }

  async selectConversation(
    projectId: string,
    conversationId: string | null,
  ): Promise<CoordinatorSnapshot> {
    const projectPath = await this.canonicalProjectPath(projectId);
    const workspace = await this.mutateSerialized(projectId, (current) => {
      if (!current) throw new Error("Coordinator workspace was not found");
      if (
        conversationId !== null &&
        !current.conversations.some((item) => item.id === conversationId && !item.closedAt)
      ) {
        throw new Error("Coordinator conversation was not found");
      }
      return {
        ...current,
        selectedConversationId: conversationId,
        updatedAt: new Date().toISOString(),
      };
    });
    if (!workspace) throw new Error("Coordinator workspace was not found");
    return this.snapshot(workspace, projectPath);
  }

  async closeConversation(projectId: string, conversationId: string): Promise<CoordinatorSnapshot> {
    const projectPath = await this.canonicalProjectPath(projectId);
    const workspace = await this.mutateSerialized(projectId, (current) => {
      if (!current) throw new Error("Coordinator workspace was not found");
      const target = current.conversations.find((item) => item.id === conversationId);
      if (!target || target.closedAt) throw new Error("Coordinator conversation was not found");
      const now = new Date().toISOString();
      const conversations = current.conversations.map((item) =>
        item.id === conversationId ? { ...item, closedAt: now } : item,
      );
      const remaining = conversations.filter((item) => !item.closedAt);
      return {
        ...current,
        conversations,
        selectedConversationId:
          current.selectedConversationId === conversationId
            ? (remaining.at(-1)?.id ?? null)
            : current.selectedConversationId,
        updatedAt: now,
      };
    });
    if (!workspace) throw new Error("Coordinator workspace was not found");
    // The mailbox closes with the conversation, so mail a wake pass places from
    // here on waits to move to the next main rather than being injected here.
    // A side conversation's open work moves to the main now, not on the next
    // sweep; closing the main leaves its work and mail for the next main.
    const main = coordinatorMainConversation(workspace);
    await (
      main
        ? reconcileMainMail(this.storage, workspace, main)
        : this.storage.synchronizeAgentMailboxes()
    ).catch((error: unknown) => {
      log.warn("mail.reconcile-failed", {
        coordinatorId: workspace.id,
        error: formatLogError(error, { stack: false }),
      });
    });
    return this.snapshot(workspace, projectPath);
  }

  async setPaused(projectId: string, paused: boolean): Promise<CoordinatorSnapshot> {
    const projectPath = await this.canonicalProjectPath(projectId);
    const options = await this.qualificationOptions();
    const allowedAgents = new Set(
      options.enabledPlatforms.filter(
        (platform) => coordinatorProviderQualification(platform, options).available,
      ),
    );
    const workspace = await this.mutateSerialized(projectId, (current) => {
      if (!current) throw new Error("Coordinator workspace was not found");
      const selected =
        current.conversations.find((item) => item.id === current.selectedConversationId) ??
        current.conversations.at(-1);
      // An unassigned conversation has nothing to be unavailable: resuming it
      // just returns the user to the composer, which is where the provider
      // gate is applied.
      if (!paused && selected?.agent && !allowedAgents.has(selected.agent)) {
        throw new Error("The configured provider is unavailable for Coordinator");
      }
      return {
        ...current,
        lifecycleState: paused ? "paused" : "ready",
        updatedAt: new Date().toISOString(),
      };
    });
    if (!workspace) throw new Error("Coordinator workspace was not found");
    return this.snapshot(workspace, projectPath);
  }

  /**
   * Retry after this conversation's bridge failed to start: clear its error so
   * the pane connects again, which is what starts the bridge. It starts nothing
   * itself, and a paused coordinator stays paused.
   */
  async retryConversation(projectId: string, conversationId: string): Promise<CoordinatorSnapshot> {
    const projectPath = await this.canonicalProjectPath(projectId);
    const workspace = await this.mutateSerialized(projectId, (current) => {
      if (!current) throw new Error("Coordinator workspace was not found");
      const target = current.conversations.find((item) => item.id === conversationId);
      if (!target || target.closedAt) throw new Error("Coordinator conversation was not found");
      return {
        ...current,
        conversations: current.conversations.map((item) =>
          item.id === conversationId ? { ...item, startupError: undefined } : item,
        ),
        updatedAt: new Date().toISOString(),
      };
    });
    if (!workspace) throw new Error("Coordinator workspace was not found");
    return this.snapshot(workspace, projectPath);
  }

  async removeProject(projectId: string): Promise<void> {
    await this.storage.coordinators.deleteCoordinatorByProject(projectId);
  }

  /**
   * Status wakes for coordinator-owned workflows and waiting workers: settled
   * states, terminal ones included, each reported once to the main
   * coordinator. See `coordinator-status-wakes.ts`.
   */
  reconcileWorkflowNotifications(): Promise<void> {
    return this.statusWakes.reconcile();
  }

  /**
   * Read the pull requests coordinators have shown that are due and tell the
   * main coordinator what changed. See `coordinator-pr-watches.ts`.
   */
  sweepWatchedPullRequests(): Promise<void> {
    return this.pullRequestWatches.sweep();
  }

  /** Observe workflow saves so status wakes arrive within seconds. */
  startStatusWakes(): void {
    this.statusWakes.start();
  }

  stopStatusWakes(): void {
    this.statusWakes.stop();
  }

  /** Working starts a fresh pause budget; waiting feeds the status-wake debounce. */
  async noteWorkerActivity(event: {
    environmentId: string;
    tabId: string;
    state: AgentActivityState | "unknown";
  }): Promise<void> {
    if (event.state === "working") {
      for (const association of await this.storage.coordinators.listOpenCoordinatorDelegations()) {
        if (
          !association.nodeId &&
          association.resourceId === event.environmentId &&
          association.delegation?.workerTabId === event.tabId
        )
          this.backgroundWorkSince.delete(association.id);
      }
    }
    await this.statusWakes.noteWorkerActivity(event);
  }

  /**
   * Close the delegations a finished worker turn settles, and wake their
   * coordinators exactly once.
   *
   * Called from the turn-end edge and again from the periodic reconcile, which
   * is what makes a crash between closing a delegation and delivering its wake
   * recoverable: the close is durable, `wokenAt` is the receipt, and an
   * unstamped closed delegation is retried until one is delivered.
   *
   * `waiting` is deliberately not a completion. A worker blocked on an approval
   * needs a human, and waking the coordinator to say "it is still going" is the
   * unsolicited update this whole design removes.
   */
  async settleWorkerDelegations(worker: {
    environmentId: string;
    tabId?: string;
    state: "completed" | "failed" | "stopped";
  }): Promise<void> {
    await this.storage.withAgentMailWorkerAdmission(worker.environmentId, async () => {
      const open = await this.storage.coordinators.listOpenCoordinatorDelegations();
      for (const association of open) {
        // A worker on another node is settled from its node's state.
        if (association.nodeId || association.resourceId !== worker.environmentId) continue;
        const delegation = association.delegation;
        if (!delegation) continue;
        if (worker.tabId && delegation.workerTabId !== worker.tabId) continue;
        await this.settleWorkerDelegation(association, worker.state)
          .then(() => {
            log.recovered("delegation.reconcile-failed", association.id);
          })
          .catch((error: unknown) => {
            this.noteDelegationReconcileFailure(association.id, error);
          });
      }
    });
    await this.deliverDelegationWakes();
  }

  private async settleWorkerDelegation(
    association: CoordinatorWorkflowAssociation,
    outcome: DelegationOutcome,
  ): Promise<void> {
    const delegation = association.delegation!;
    const decision = await this.decide(association, {
      evidence: { source: "turn-end", outcome },
      // A failed worker closes whatever is pending, so that read can be skipped.
      undeliveredRequest:
        outcome !== "failed" &&
        (await this.storage.hasUndeliveredCoordinatorRequest(
          association.resourceId,
          delegation.workerTabId,
        )),
      goalRunning: false,
    });
    // A close that returns null lost the race to another observer of the same
    // edge. Either way the delegation is now closed, and the wake below is
    // idempotent, so there is nothing to do differently.
    if (decision.action === "close") await this.closeOnDecision(association, decision);
  }

  /** One delegation that could not be settled must not stop the rest of the pass. */
  private noteDelegationReconcileFailure(associationId: string, error: unknown): void {
    log.throttled("warn", "delegation.reconcile-failed", {
      scope: associationId,
      error,
      fields: () => ({ associationId, error: formatLogError(error, { stack: false }) }),
    });
  }

  /** The two inputs of `decideDelegation`, from what a caller has just read. */
  private delegationInputs(
    association: CoordinatorWorkflowAssociation,
    gathered: GatheredDelegationObservations,
    // Remote only: a follow-up restarts the grace period, and seen-working stands in for an edge.
    asked: { at: number; seenWorking: boolean } = {
      at: Date.parse(association.delegation!.requestedAt),
      seenWorking: false,
    },
  ): { state: DelegationDecisionState; observations: DelegationObservations } {
    const delegation = association.delegation!;
    const hold = this.backgroundWorkSince.get(association.id);
    return {
      state: {
        askedAt: asked.at,
        stopRequested: delegation.stopRequestedAt !== undefined,
        seenWorking: asked.seenWorking,
        ...(hold?.requestedAt === delegation.requestedAt
          ? { backgroundHoldSince: hold.since }
          : {}),
      },
      observations: {
        ...gathered,
        now: Date.now(),
        needsHuman: this.options.workerNeedsHuman?.(association.resourceId) === true,
        graceMs: DELEGATION_IDLE_RECONCILE_GRACE_MS,
        backgroundHoldMs: this.options.backgroundWorkHoldMs ?? DELEGATION_BACKGROUND_WORK_HOLD_MS,
      },
    };
  }

  /** Keep the hold clock the decision asks for. */
  private applyBackgroundHold(
    association: CoordinatorWorkflowAssociation,
    decision: DelegationDecision,
  ): void {
    if (decision.action !== "stay-open") return;
    if (decision.backgroundHoldSince !== undefined) {
      this.backgroundWorkSince.set(association.id, {
        since: decision.backgroundHoldSince,
        requestedAt: association.delegation!.requestedAt,
      });
    } else if (decision.resetBackgroundHold) {
      this.backgroundWorkSince.delete(association.id);
    }
  }

  /**
   * Decide, reading background work only when the answer depends on it. A worker
   * that waits on a background shell or on sub-agents ends its turn and resumes
   * when they report, so without a report that turn end is a pause; the hold is
   * what bounds it, because a forgotten long-lived process must not keep the
   * coordinator waiting for ever.
   */
  private async decide(
    association: CoordinatorWorkflowAssociation,
    gathered: GatheredDelegationObservations,
    options: { asked?: { at: number; seenWorking: boolean }; backgroundWorkPending?: boolean } = {},
  ): Promise<DelegationDecision> {
    const { state, observations } = this.delegationInputs(association, gathered, options.asked);
    const first = decideDelegation(state, observations);
    const decision =
      first.action === "check-background"
        ? decideDelegation(state, {
            ...observations,
            backgroundWork: await this.readBackgroundWork(
              association,
              options.backgroundWorkPending,
            ),
          })
        : first;
    this.applyBackgroundHold(association, decision);
    return decision;
  }

  private async readBackgroundWork(
    association: CoordinatorWorkflowAssociation,
    backgroundWorkPending?: boolean,
  ): Promise<{ running: boolean; reportHeld: boolean }> {
    const delegation = association.delegation!;
    const running =
      backgroundWorkPending ??
      (await this.options
        .workerBackgroundWork?.(association.resourceId, delegation.workerTabId)
        .catch(() => false));
    if (!running) return { running: false, reportHeld: false };
    const owner = await this.storage.coordinators.getCoordinatorWorkspaceById(
      association.coordinatorId,
    );
    const main = owner ? coordinatorMainConversation(owner) : undefined;
    const reportHeld = Boolean(
      owner &&
      main &&
      (await this.storage.hasDelegationHeldAgentMail(
        association.id,
        coordinatorRuntimeId(owner.id, main.id),
        main.tabId,
        association.resourceId,
        delegation.workerTabId,
      )),
    );
    return { running: true, reportHeld };
  }

  /** A goal that stops settles the delegation itself (`onGoalReleasedTurnEnd`). */
  private async goalIsDriving(association: CoordinatorWorkflowAssociation): Promise<boolean> {
    const tabId = association.delegation?.workerTabId;
    if (!tabId || !this.options.workerGoal) return false;
    const goal = await this.options
      .workerGoal(association.resourceId, tabId)
      .catch(() => undefined);
    return goal !== undefined && goalIsRunning(goal.status);
  }

  /**
   * Close a delegation and choose its wake in one write, unannounced: the
   * wake that follows (`deliverDelegationWakes`, which every caller runs next)
   * announces once, after its last write.
   */
  private async closeOnDecision(
    association: CoordinatorWorkflowAssociation,
    decision: Extract<DelegationDecision, { action: "close" }>,
  ): Promise<void> {
    const closed = await this.storage.coordinators.closeCoordinatorDelegation(
      association.id,
      decision.state,
      new Date().toISOString(),
      decision.backgroundWorkTimeoutMs,
      {
        wakeKind: (closing, owner) => closingDelegationWakeKind(this.storage, closing, owner),
        announce: false,
      },
    );
    if (closed) this.unannouncedCloses.set(closed.id, closed.projectId);
    this.backgroundWorkSince.delete(association.id);
  }

  /** Announce, once, a close whose wake did not announce it. */
  private announceClose(associationId: string): void {
    const projectId = this.unannouncedCloses.get(associationId);
    if (projectId === undefined) return;
    this.unannouncedCloses.delete(associationId);
    this.storage.coordinators.announceCoordinatorChange(projectId);
  }

  /**
   * Close delegations whose worker can no longer finish.
   *
   * A deleted, stopped or errored environment produces no turn-end edge, so
   * without this the coordinator waits on a worker that will never report and
   * its held mail is never released. Checked on the sweep rather than hooked
   * into every teardown path, because the states that matter are all readable
   * from the environment record and a missed hook is a silent hang.
   */
  async reconcileWorkerDelegations(): Promise<void> {
    await this.reconcileReleasedNodes().catch((error: unknown) => {
      log.throttled("warn", "node-release.reconcile-failed", {
        error,
        fields: () => ({ error: formatLogError(error, { stack: false }) }),
      });
    });
    await reconcileClosedConversations(this.storage).catch((error: unknown) => {
      log.throttled("warn", "mail.reconcile-failed", {
        error,
        fields: () => ({ error: formatLogError(error) }),
      });
    });
    const open = await readOpenDelegations(this.storage.coordinators);
    for (const association of open.list) {
      await this.reconcileWorkerDelegation(association, open.current)
        .then(() => {
          log.recovered("delegation.reconcile-failed", association.id);
        })
        .catch((error: unknown) => {
          this.noteDelegationReconcileFailure(association.id, error);
        });
    }
    await this.deliverDelegationWakes()
      .then(() => {
        log.recovered("delegation.wake-pass-failed");
      })
      .catch((error: unknown) => {
        log.throttled("warn", "delegation.wake-pass-failed", {
          error,
          fields: () => ({ error: formatLogError(error, { stack: false }) }),
        });
      });
    await this.storage.releaseOrphanedDelegationHolds(
      await this.storage.coordinators.listOwedCoordinatorDelegationIds(),
    );
  }

  private async reconcileWorkerDelegation(
    association: CoordinatorWorkflowAssociation,
    currentOpen: OpenDelegationLookup,
  ): Promise<void> {
    if (association.nodeId) {
      await this.reconcileRemoteDelegation(association, currentOpen);
      return;
    }
    await this.storage.withAgentMailWorkerAdmission(association.resourceId, async () => {
      const current = await currentOpen(association.id);
      if (!current) return;
      const delegation = current.delegation!;
      const record = await this.storage.getEnvironment(association.resourceId);
      const environment: DelegationEnvironment = !record
        ? "missing"
        : record.deletionRequestedAt
          ? "deleting"
          : record.status === "error"
            ? "error"
            : record.status === "stopped"
              ? "stopped"
              : "running";
      const turn: AgentTabState =
        environment === "running" && this.workerActivity
          ? await this.workerActivity(association.resourceId, delegation.workerTabId)
          : "unknown";
      const undeliveredRequest =
        (environment === "stopped" || turn === "idle") &&
        (await this.storage.hasUndeliveredCoordinatorRequest(
          association.resourceId,
          delegation.workerTabId,
        ));
      const decision = await this.decide(current, {
        evidence: { source: "sweep", environment, turn },
        undeliveredRequest,
        goalRunning: turn === "idle" && !undeliveredRequest && (await this.goalIsDriving(current)),
      });
      if (decision.action === "close") await this.closeOnDecision(current, decision);
    });
  }

  /**
   * A worker environment on another node changed (its node's event, or the
   * sweep): settle the delegations it answers, and wake their coordinators.
   */
  async settleRemoteWorker(nodeId: string, environmentId: string): Promise<void> {
    const open = (await this.storage.coordinators.listOpenCoordinatorDelegations()).filter(
      (association) => association.nodeId === nodeId && association.resourceId === environmentId,
    );
    for (const association of open) {
      await this.reconcileRemoteDelegation(association)
        .then(() => {
          log.recovered("delegation.reconcile-failed", association.id);
        })
        .catch((error: unknown) => {
          this.noteDelegationReconcileFailure(association.id, error);
        });
    }
    if (open.length > 0) await this.deliverDelegationWakes();
  }

  /**
   * Close one remote delegation when its node shows the worker can no longer
   * be working on it: the environment is gone, failed or stopped, or the
   * worker's turn ended. An unreachable node changes nothing.
   */
  private async reconcileRemoteDelegation(
    association: CoordinatorWorkflowAssociation,
    currentOpen: OpenDelegationLookup = currentOpenDelegation(this.storage.coordinators),
  ): Promise<void> {
    const delegation = association.delegation;
    if (!this.remote || !association.nodeId || delegation?.state !== "running") return;
    const requestGeneration = this.remoteAskedAt.get(association.id);
    const state = await this.remote
      .workerState(association.nodeId, association.resourceId, delegation.workerTabId)
      .catch(() => "unavailable" as const);
    // The delegation stays open however long the node is silent; its clock only decides a notice.
    await this.nodeReleases
      .noteRead(association.nodeId, state !== "unavailable")
      .catch((error: unknown) => {
        log.warn("node-offline.check-failed", { error: formatLogError(error, { stack: false }) });
      });
    if (state === "unavailable" || this.remoteAskedAt.get(association.id) !== requestGeneration)
      return;
    const askedAt = Math.max(Date.parse(delegation.requestedAt) || 0, requestGeneration?.at ?? 0);
    if (state.tab === "working" || state.tab === "waiting") {
      this.remoteSeenWorking.add(association.id);
    }
    const asked = { at: askedAt, seenWorking: this.remoteSeenWorking.has(association.id) };
    const gathered = {
      evidence: { source: "remote" as const, environment: state.environment, turn: state.tab },
      undeliveredRequest: state.requestPending === true,
      goalRunning: state.goalRunning === true,
    };
    // Not `decide` yet: whether a report is held can only be read once the
    // node's mail is collected, below.
    const inputs = this.delegationInputs(association, gathered, asked);
    const first = decideDelegation(inputs.state, inputs.observations);
    this.applyBackgroundHold(association, first);
    if (first.action === "stay-open") return;
    // The worker's report may still be in its node's outbox: collect it first,
    // so it is held for this delegation and released as the wake.
    if (
      this.remote.collectMail &&
      !(await this.remote.collectMail(association.nodeId).catch(() => false))
    )
      return;
    await this.storage.withAgentMailWorkerAdmission(
      `node:${association.nodeId}:${association.resourceId}`,
      async () => {
        // A follow-up admitted during either remote read needs its own turn.
        if (this.remoteAskedAt.get(association.id) !== requestGeneration) return;
        const current = await currentOpen(association.id);
        if (!current) return;
        // Remote observations belong to the request read before collection.
        // A persisted follow-up invalidates them even without a local token.
        if (current.delegation?.requestedAt !== delegation.requestedAt) return;
        const decision = await this.decide(current, gathered, {
          asked,
          backgroundWorkPending: state.backgroundWorkPending === true,
        });
        if (decision.action !== "close") return;
        this.remoteSeenWorking.delete(association.id);
        this.remoteAskedAt.delete(association.id);
        await this.closeOnDecision(current, decision);
      },
    );
  }

  /**
   * Deliver the outstanding wake for every closed-but-unwoken delegation.
   *
   * The worker's own report is the wake when it sent one: releasing it is what
   * makes it injectable, and it carries the substance. Only a worker that
   * reported nothing gets a synthesized notice, so a coordinator is never woken
   * twice for one delegation and never told "finished" by a second message that
   * says less than the first.
   */
  deliverDelegationWakes(): Promise<void> {
    if (this.delegationWakeDelivery) {
      this.delegationWakeRerun = true;
      return this.delegationWakeDelivery;
    }
    const delivery = this.runDelegationWakePasses().finally(() => {
      if (this.delegationWakeDelivery === delivery) this.delegationWakeDelivery = null;
    });
    this.delegationWakeDelivery = delivery;
    return delivery;
  }

  /**
   * One pass, then one more for as long as calls keep arriving during it, so a
   * worker closing during another's wake reports now rather than on the next
   * sweep. Any number of calls in one pass share one extra pass and one promise,
   * which can outlast the pass the caller joined: never await this while holding
   * `withAgentMailWorkerAdmission`, which would hold up that worker's mail for as
   * long as the passes take.
   */
  private async runDelegationWakePasses(): Promise<void> {
    do {
      this.delegationWakeRerun = false;
      await this.deliverDelegationWakesOnce();
    } while (this.delegationWakeRerun);
    // Publish inactivity in the same microtask as the final rerun check.
    // The old promise's finally must not clear a new pass started after this.
    this.delegationWakeDelivery = null;
  }

  private async deliverDelegationWakesOnce(): Promise<void> {
    const unwoken = await this.storage.coordinators.listUnwokenCoordinatorDelegations();
    const owed = new Set(unwoken.map((association) => association.id));
    for (const id of Array.from(this.delegationWakeFailures.keys())) {
      if (!owed.has(id)) this.delegationWakeFailures.delete(id);
    }
    // A failure costs only its own delegation: the rest of the pass still runs.
    for (const association of unwoken) {
      try {
        await this.deliverDelegationWake(association);
        this.delegationWakeFailures.delete(association.id);
        log.recovered("delegation.wake-failed", association.id);
      } catch (error) {
        await this.noteDelegationWakeFailure(association, error).catch((noteError: unknown) => {
          log.warn("delegation.wake-retire-failed", {
            associationId: association.id,
            error: formatLogError(noteError, { stack: false }),
          });
        });
      }
      // A wake that stopped short of its announcing write still shows the close.
      this.announceClose(association.id);
    }
  }

  private async noteDelegationWakeFailure(
    association: CoordinatorWorkflowAssociation,
    error: unknown,
  ): Promise<void> {
    if (wakeHeldByUserState(error)) {
      this.delegationWakeFailures.delete(association.id);
      log.debug("delegation.wake-held", {
        associationId: association.id,
        kind: logErrorKind(error),
      });
      return;
    }
    const now = Date.now();
    const previous = this.delegationWakeFailures.get(association.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const since = previous?.since ?? now;
    this.delegationWakeFailures.set(association.id, { attempts, since });
    log.throttled("warn", "delegation.wake-failed", {
      scope: association.id,
      error,
      fields: () => ({
        associationId: association.id,
        attempts,
        error: formatLogError(error, { stack: false }),
      }),
    });
    const minMs = this.options.wakeRetireMinMs ?? DELEGATION_WAKE_RETIRE_MIN_MS;
    if (attempts < DELEGATION_WAKE_RETIRE_ATTEMPTS || now - since < minMs) return;
    const retirement = { attempts, kind: logErrorKind(error) };
    await this.storage.coordinators.updateCoordinatorWorkflowAssociation(
      association.id,
      (current) => {
        if (!current.delegation || current.delegation.wokenAt || current.delegation.wakeRetirement)
          return false;
        current.delegation = { ...current.delegation, wakeRetirement: retirement };
        return true;
      },
    );
    await this.retireDelegationWake(association, retirement.attempts, retirement.kind);
  }

  /**
   * Stop retrying a wake that keeps failing, and tell the coordinator once.
   *
   * The notice must be stored before retirement, since it can fail for the same
   * reason the wake did. A missing main or failed send leaves the wake owed.
   * Retirement selection is persisted before publication, so a crash before
   * the receipt retries only this idempotent notice, never ordinary delivery.
   * It goes to the open main rather than
   * through `ensureMainConversation`, which may be what keeps failing. The mark
   * makes nothing owed any more, so a report still held for this delegation is
   * released as ordinary mail on the sweep (`releaseOrphanedDelegationHolds`).
   */
  private async retireDelegationWake(
    association: CoordinatorWorkflowAssociation,
    attempts: number,
    kind: string,
  ): Promise<void> {
    const delegation = association.delegation!;
    const owner = await this.storage.coordinators.getCoordinatorWorkspaceById(
      association.coordinatorId,
    );
    const main = owner ? coordinatorMainConversation(owner) : undefined;
    if (!owner || !main) return;
    const tabArgs = `{ ${association.nodeId ? `"nodeId": "${association.nodeId}", ` : ""}"environmentId": "${association.resourceId}", "tabId": "${delegation.workerTabId}" }`;
    try {
      await this.storage.sendAgentMail(
        {
          kind: "system",
          projectId: association.projectId,
          source: "workflow",
          resourceId: association.resourceId,
        },
        {
          requestId: `delegation-wake-failed-${association.id}`,
          toEnvironmentId: coordinatorRuntimeId(owner.id, main.id),
          toTabId: main.tabId,
          subject: `Worker ${association.resourceId} ${delegation.state}: wake failed`,
          body:
            `Worker environment ${association.resourceId} (tab ${delegation.workerTabId}) ended its delegation as ${delegation.state}, but waking you for it failed ${attempts} times (${kind}), so it will not be tried again. ` +
            `A report it sent, if any, is released as ordinary mail. Read its state yourself before relying on it.` +
            `\n\nRead more: \`get_tab_transcript ${tabArgs}\`, \`get_tab_state ${tabArgs}\`.`,
        },
        {
          notice: {
            resource: {
              kind: "agent-tab",
              id: delegation.workerTabId,
              environmentId: association.resourceId,
              tabId: delegation.workerTabId,
              ...(association.nodeId ? { nodeId: association.nodeId } : {}),
              label: association.resourceId,
            },
            state: delegation.state,
            tone: "failure",
          },
        },
      );
    } catch (error) {
      // Messaging was turned off while this was failing: hold, as for the wake.
      if (wakeHeldByUserState(error)) {
        this.delegationWakeFailures.delete(association.id);
        return;
      }
      if (!(error instanceof AgentMailError && error.code === "idempotency-conflict")) {
        log.warn("delegation.wake-retire-notice-failed", {
          associationId: association.id,
          kind: logErrorKind(error),
        });
        return;
      }
    }
    const latest = await this.storage.coordinators.getCoordinatorWorkspaceById(owner.id);
    if (!latest?.conversations.some((item) => item.id === main.id && !item.closedAt)) return;
    await this.storage.coordinators.markCoordinatorDelegationWakeFailed(association.id);
    this.unannouncedCloses.delete(association.id);
    this.delegationWakeFailures.delete(association.id);
    log.warn("delegation.wake-retired", { associationId: association.id, attempts, kind });
  }

  /** Deliver one delegation's wake. Throws when it could not be delivered. */
  private async deliverDelegationWake(association: CoordinatorWorkflowAssociation): Promise<void> {
    const delegation = association.delegation;
    if (!delegation || !association.conversationId) return;
    if (delegation.wakeRetirement) {
      await this.retireDelegationWake(
        association,
        delegation.wakeRetirement.attempts,
        delegation.wakeRetirement.kind,
      );
      return;
    }
    const owner = await this.storage.coordinators.getCoordinatorWorkspaceById(
      association.coordinatorId,
    );
    if (!owner) {
      // The coordinator itself is gone. Retiring the delegation is the only
      // honest outcome: there is nobody left to wake, and leaving it
      // unstamped would retry this lookup on every sweep forever.
      await this.storage.coordinators.markCoordinatorDelegationWoken(association.id);
      this.unannouncedCloses.delete(association.id);
      return;
    }
    // The wake goes to the main coordinator. If the user closed it, a new
    // main starts with the default agent and takes this delegation over.
    const { workspace, main: conversation } = await this.ensureMainConversation(owner.projectId);
    const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
    // Close uses the same project queue. Keep the open-main check, report
    // lookup and durable kind selection together so a close cannot turn a
    // held report into an apparent silent worker between those operations.
    // The delegation's own close usually chose the kind already, in the same
    // write (`closeOnDecision`); it is chosen and written here only when no
    // main was open at that close.
    const wakeKind = await this.serialize(owner.projectId, async () => {
      const latest = await this.storage.coordinators.getCoordinatorWorkspaceById(workspace.id);
      if (!latest?.conversations.some((item) => item.id === conversation.id && !item.closedAt))
        return undefined;
      if (delegation.wakeKind) return delegation.wakeKind;
      const hasReport = await this.storage.hasDelegationHeldAgentMail(
        association.id,
        runtimeId,
        conversation.tabId,
        association.resourceId,
        delegation.workerTabId,
      );
      const prepared = await this.storage.coordinators.prepareCoordinatorDelegationWake(
        association.id,
        hasReport ? "report" : "notice",
      );
      return prepared?.delegation?.wakeKind;
    });
    if (!wakeKind) return;
    if (wakeKind === "report") {
      // A zero count is safe on retry: wakeKind was committed while the
      // report was still held, so zero now means an earlier pass released it.
      await this.storage.releaseDelegationHeldAgentMail(
        association.id,
        runtimeId,
        conversation.tabId,
        association.resourceId,
        delegation.workerTabId,
      );
    } else {
      const remote = association.nodeId ? this.remote : null;
      const remoteState =
        remote && association.nodeId
          ? await remote
              .workerState(association.nodeId, association.resourceId, delegation.workerTabId)
              .catch(() => "unavailable" as const)
          : null;
      const environment = association.nodeId
        ? null
        : await this.storage.getEnvironment(association.resourceId);
      const nodeName =
        remote && association.nodeId
          ? await remote.nodeName(association.nodeId).catch(() => association.nodeId!)
          : null;
      const label =
        (environment?.name ??
          (remoteState && remoteState !== "unavailable" ? remoteState.name : undefined) ??
          association.resourceId) + (nodeName ? ` on ${nodeName}` : "");
      // A turn the coordinator stopped (stop_worker_turn) ends like any
      // other, however its delegation closed (the turn end, or a failed or
      // stopped environment); say who stopped it, so a turn end is not read
      // as the worker finishing. The Work panel's Stop says the user did it.
      const stopRequested = delegation.stopRequestedAt !== undefined;
      const stoppedByUser = delegation.stopRequestedBy === "user";
      const outcome =
        delegation.state === "completed"
          ? stopRequested
            ? "stopped"
            : "finished"
          : delegation.state === "failed"
            ? "failed"
            : "stopped";
      const stoppedWith = stoppedByUser
        ? "the user stopped its turn from the Work panel"
        : "you stopped its turn with stop_worker_turn";
      const stopNote = !stopRequested
        ? `without sending a report.`
        : delegation.state === "completed"
          ? `because ${stoppedWith}, before it sent a report. Its tab is idle and keeps the conversation; send_prompt_to_tab gives it its next instruction.`
          : `after ${stoppedWith}, before it sent a report.`;
      // What the worker last said is the closest thing to a report it left.
      // Only a finished turn has a live session worth reading; best effort.
      const excerpt =
        delegation.state !== "completed"
          ? undefined
          : remote && association.nodeId
            ? await remote
                .lastAssistantExcerpt(
                  association.nodeId,
                  association.resourceId,
                  delegation.workerTabId,
                )
                .catch(() => undefined)
            : await this.options
                .lastAssistantExcerpt?.(association.resourceId, delegation.workerTabId)
                .catch(() => undefined);
      const goal = association.nodeId
        ? undefined
        : await this.options
            .workerGoal?.(association.resourceId, delegation.workerTabId)
            .catch(() => undefined);
      const backgroundWorkTimeoutMs = delegation.backgroundWorkTimeoutMs;
      const backgroundWorkMinutes = Math.round((backgroundWorkTimeoutMs ?? 0) / 60_000);
      const tabArgs = `{ ${association.nodeId ? `"nodeId": "${association.nodeId}", ` : ""}"environmentId": "${association.resourceId}", "tabId": "${delegation.workerTabId}" }`;
      await this.storage
        .sendAgentMail(
          {
            kind: "system",
            projectId: association.projectId,
            source: "workflow",
            resourceId: association.resourceId,
          },
          {
            requestId: `delegation-${association.id}-${delegation.completedAt ?? outcome}`,
            toEnvironmentId: runtimeId,
            toTabId: conversation.tabId,
            subject: `Worker ${label} ${outcome}`,
            body:
              `Worker environment ${association.resourceId}${nodeName ? ` on ${nodeName} (nodeId ${association.nodeId})` : ""} (tab ${delegation.workerTabId}) ${outcome} ` +
              stopNote +
              (backgroundWorkTimeoutMs !== undefined
                ? ` Its turn ended while work it started in the background was still running, and none of it reported for ${backgroundWorkMinutes} ${backgroundWorkMinutes === 1 ? "minute" : "minutes"}; it may resume if that work reports.`
                : "") +
              (association.baseBranch
                ? ` It was started from ${association.baseBranch}${
                    association.baseCommit ? ` at ${association.baseCommit.slice(0, 12)}` : ""
                  }.`
                : "") +
              (goal
                ? ` Its goal is ${goal.status}${goal.statusReason ? ` (${goal.statusReason})` : ""} after ${goal.iterations} of ${goal.maxIterations} iterations.`
                : "") +
              ` Inspect the environment through Orkestrator controls before deciding what to do next.` +
              (excerpt ? `\n\nLast message: ${boundedLine(excerpt)}` : "") +
              `\n\nRead more: ${goal ? `\`get_worker_goal ${tabArgs}\`, ` : ""}\`get_tab_transcript ${tabArgs}\`, \`get_tab_state ${tabArgs}\`.`,
          },
          {
            notice: {
              resource: {
                kind: "agent-tab",
                id: delegation.workerTabId,
                environmentId: association.resourceId,
                tabId: delegation.workerTabId,
                ...(association.nodeId ? { nodeId: association.nodeId } : {}),
                label,
              },
              state: delegation.state,
              tone:
                delegation.state === "failed"
                  ? "failure"
                  : stopRequested
                    ? "info"
                    : delegation.state === "completed"
                      ? "success"
                      : "info",
            },
          },
        )
        .catch((error: unknown) => {
          // Placed by an earlier pass whose woken stamp never landed; the
          // excerpt read this time differs, so the store calls it a
          // conflict. The wake was delivered.
          if (error instanceof AgentMailError && error.code === "idempotency-conflict") return;
          throw error;
        });
    }
    // The send is not under `serialize`, so a slow one cannot block the user's
    // close. If that close landed since `ensureMainConversation`, this stays
    // unwoken: the next pass adopts it onto the next main, and
    // `moveClosedCoordinatorMail` carries over what was just placed here.
    const latest = await this.storage.coordinators.getCoordinatorWorkspaceById(workspace.id);
    if (!latest?.conversations.some((item) => item.id === conversation.id && !item.closedAt))
      return;
    // The second and last write of the wake, and its one announcement: the
    // close and its wake kind were the first (`closeOnDecision`).
    await this.storage.coordinators.markCoordinatorDelegationWoken(association.id);
    this.unannouncedCloses.delete(association.id);
    // A presentation cue only; the id is fixed, so a client hears one per wake.
    this.storage.notifyCoordinatorWake({
      attentionId: `delegation-wake:${association.id}:${delegation.requestedAt}`,
      projectId: association.projectId,
      coordinatorId: association.coordinatorId,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * A command an agent ran in a worker environment is waiting on the user: tell
   * the coordinator that owns the worker, once per prompt, so the person
   * talking to the coordinator sees the link and code without opening the
   * worker. A user's own `!` command is not announced: the user is at that
   * tab, and the coordinator panel already shows it.
   *
   * The notice is a coordinator-route workflow notice, so it wakes the
   * coordinator even while it waits on the delegation; it is idempotent on the
   * prompt, so a redrawn or re-detected prompt is not sent twice.
   */
  async noteWorkerHumanPrompt(entry: HumanPromptEntry): Promise<void> {
    if (entry.source === "user-command" || (entry.prompt.url && !isSignInLink(entry.prompt.url)))
      return;
    const environment = await this.storage.getEnvironment(entry.environmentId).catch(() => null);
    if (!environment) return;
    const associations = (
      await this.storage.coordinators.listCoordinatorWorkflowAssociations(environment.projectId)
    ).filter(
      (association) =>
        association.kind === "environment" &&
        association.resourceId === entry.environmentId &&
        !association.nodeId &&
        !association.pending,
    );
    const owner = associations.at(-1);
    if (!owner) return;
    const workspace = await this.storage.coordinators.getCoordinatorWorkspaceById(
      owner.coordinatorId,
    );
    const main = workspace ? coordinatorMainConversation(workspace) : undefined;
    if (!workspace || !main) return;
    const prompt = entry.prompt;
    const digest = createHash("sha256")
      .update(`${entry.id}\u0000${prompt.key}`)
      .digest("hex")
      .slice(0, 24);
    const what =
      prompt.kind === "host-key"
        ? "an SSH host-key confirmation"
        : prompt.kind === "secret"
          ? "a password or passphrase"
          : prompt.kind === "device-code"
            ? "a sign-in with a code"
            : prompt.kind === "sign-in"
              ? "a sign-in in the browser"
              : "a keypress (ENTER)";
    const label = environment.name ?? entry.environmentId;
    const tabArgs = `{ "environmentId": "${entry.environmentId}", "tabId": "${entry.tabId}" }`;
    const lines = [
      `A command in worker environment ${label} (${entry.environmentId}, tab ${entry.tabId}) is waiting on the user for ${what}.`,
      ...(entry.command ? [`Command: \`${entry.command.replace(/`/g, "'")}\``] : []),
      ...(prompt.url ? [`Open: ${prompt.url}`] : []),
      ...(prompt.code ? [`Code: \`${prompt.code}\``] : []),
      `Prompt: ${prompt.text}`,
      "",
      "Tell the user now, with the link and code above: the command is blocked until they act. " +
        (prompt.kind === "secret" || prompt.kind === "host-key"
          ? "They answer it in the worker's tab; never ask them to send a password through chat."
          : "The worker's tab shows the same prompt."),
      "",
      `Read more: \`get_tab_state ${tabArgs}\`.`,
    ];
    await this.storage
      .sendAgentMail(
        {
          kind: "system",
          projectId: environment.projectId,
          source: "workflow",
          resourceId: entry.environmentId,
        },
        {
          requestId: `human-prompt-${owner.id}-${digest}`,
          toEnvironmentId: coordinatorRuntimeId(workspace.id, main.id),
          toTabId: main.tabId,
          subject: `Worker ${label} needs you: ${prompt.url ? "sign in" : what}`,
          body: lines.join("\n"),
        },
        {
          notice: {
            resource: {
              kind: "agent-tab",
              id: entry.tabId,
              environmentId: entry.environmentId,
              tabId: entry.tabId,
              label,
            },
            state: "waiting",
            tone: "attention",
          },
        },
      )
      .catch((error: unknown) => {
        if (error instanceof AgentMailError && error.code === "idempotency-conflict") return;
        throw error;
      });
  }

  /**
   * Tell the coordinator that launched a worker that its setup was held for
   * the user's approval (`setup-approval.ts`), so it reports a blocked worker
   * instead of waiting for one that will never become ready on its own. A
   * coordinator cannot approve setup itself; it can only tell the user.
   * Idempotent per environment and held setup.
   */
  async noteWorkerSetupApproval(environment: Environment): Promise<void> {
    const associations = (
      await this.storage.coordinators.listCoordinatorWorkflowAssociations(environment.projectId)
    ).filter(
      (association) =>
        association.kind === "environment" &&
        association.resourceId === environment.id &&
        !association.nodeId &&
        !association.pending,
    );
    const owner = associations.at(-1);
    if (!owner) return;
    const workspace = await this.storage.coordinators.getCoordinatorWorkspaceById(
      owner.coordinatorId,
    );
    const main = workspace ? coordinatorMainConversation(workspace) : undefined;
    if (!workspace || !main) return;
    const label = environment.name ?? environment.id;
    await this.storage
      .sendAgentMail(
        {
          kind: "system",
          projectId: environment.projectId,
          source: "workflow",
          resourceId: environment.id,
        },
        {
          requestId: `setup-approval-${owner.id}-${environment.setupCompletedAt ?? "held"}`,
          toEnvironmentId: coordinatorRuntimeId(workspace.id, main.id),
          toTabId: main.tabId,
          subject: `Worker ${label} needs setup approval`,
          body: [
            `Setup did not run in worker environment ${label} (${environment.id}): its branch changes the project's setup commands, and this machine has not approved them.`,
            "",
            "Tell the user: they review the commands in the environment's setup tab and approve or skip them there. You cannot approve them. The worker is not ready until they do.",
          ].join("\n"),
        },
      )
      .catch((error: unknown) => {
        if (error instanceof AgentMailError && error.code === "idempotency-conflict") return;
        throw error;
      });
  }

  static runtimeId(workspace: CoordinatorWorkspace): string {
    return coordinatorRuntimeId(workspace.id);
  }
}
