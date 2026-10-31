import { isSignInLink } from "@orkestrator/protocol/human-prompts";
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
import {
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { StorageService } from "./storage.js";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
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
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import type { CoordinatorRemoteAccess } from "./coordinator-remote.js";

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

/** Delegation settling knobs beyond the status-wake options. */
export interface CoordinatorDelegationOptions {
  /**
   * Whether a worker tab's turn has ended while background work it started is
   * still running (the raw session state is working, the turn view idle).
   */
  workerBackgroundWork?: (environmentId: string, tabId: string) => Promise<boolean>;
  /** Overrides {@link DELEGATION_BACKGROUND_WORK_HOLD_MS}; for tests. */
  backgroundWorkHoldMs?: number;
  /**
   * Whether a command in the worker environment is waiting on the user (a
   * sign-in link, a code, a password; see `human-prompt-registry.ts`). Such a
   * turn end is a hand-off to a person, so it is never held for background work.
   */
  workerNeedsHuman?: (environmentId: string) => boolean;
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

/**
 * Work the main coordinator should own but a different conversation still
 * holds: delegations not yet woken, and workflows not yet reported. Finished
 * history is left where it is, because adopting re-arms its notification.
 */
function liveWork(association: CoordinatorWorkflowAssociation): boolean {
  if (association.pending) return false;
  if (association.kind === "environment") {
    return Boolean(
      association.delegation &&
      (association.delegation.state === "running" || !association.delegation.wokenAt),
    );
  }
  return !association.terminalNotifiedAt;
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
  /** Status wakes for work this coordinator started; see `coordinator-status-wakes.ts`. */
  readonly statusWakes: CoordinatorStatusWakes;
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
      CoordinatorDelegationOptions = {},
  ) {
    this.statusWakes = new CoordinatorStatusWakes(storage, {
      ...options,
      ...(workerActivity ? { workerActivity } : {}),
    });
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
   * The project's main coordinator, started with the default agent when there
   * is none open. Closing the main tab is how a user changes its provider; the
   * next mail that needs a coordinator starts a fresh one rather than being
   * lost. Work the closed conversation still owed a report to moves with it.
   */
  async ensureMainConversation(
    projectId: string,
  ): Promise<{ workspace: CoordinatorWorkspace; main: CoordinatorConversation }> {
    const result = await this.serialize(projectId, async () => {
      const existing = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace was not found");
      const open = coordinatorMainConversation(existing);
      if (open) return { workspace: existing, main: open, created: false };
      if (
        existing.conversations.filter((item) => !item.closedAt).length >=
        MAX_OPEN_COORDINATOR_CONVERSATIONS
      ) {
        throw new Error("Coordinator conversation limit reached");
      }
      const created = conversation(
        existing.id,
        "main",
        undefined,
        await this.preferredAgent(projectId).catch(() => undefined),
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
      return { workspace, main, created: true };
    });
    await this.adoptLiveWork(result.workspace, result.main);
    await this.reconcileMainMail(result.workspace, result.main);
    return { workspace: result.workspace, main: result.main };
  }

  private async reconcileMainMail(
    workspace: CoordinatorWorkspace,
    main: CoordinatorConversation,
  ): Promise<void> {
    await this.adoptLiveWork(workspace, main, true);
    await this.storage.synchronizeAgentMailboxes();
    // What was waiting in the closed main's inbox — a held report above
    // all — belongs to the new one.
    const owed = new Set(
      [
        ...(await this.storage.coordinators.listOpenCoordinatorDelegations()),
        ...(await this.storage.coordinators.listUnwokenCoordinatorDelegations()),
      ].map((association) => association.id),
    );
    await this.storage
      .moveClosedCoordinatorMail(
        workspace.id,
        {
          environmentId: coordinatorRuntimeId(workspace.id, main.id),
          tabId: main.tabId,
        },
        owed,
      )
      .catch((error) => {
        console.warn(
          "[coordinator] Could not move mail to the new main coordinator:",
          error instanceof Error ? error.message : error,
        );
      });
  }

  /** Move delegations and workflows other conversations still owe onto the main. */
  private async adoptLiveWork(
    workspace: CoordinatorWorkspace,
    main: CoordinatorConversation,
    closedOnly = false,
  ): Promise<void> {
    for (const association of await this.storage.coordinators.listCoordinatorWorkflowAssociations(
      workspace.projectId,
    )) {
      if (
        association.coordinatorId !== workspace.id ||
        association.conversationId === main.id ||
        !liveWork(association) ||
        (closedOnly &&
          workspace.conversations.some(
            (item) => item.id === association.conversationId && !item.closedAt,
          ))
      ) {
        continue;
      }
      await this.storage.coordinators
        .adoptCoordinatorWorkflowAssociation(
          workspace.projectId,
          workspace.id,
          association.id,
          main.id,
          { force: true },
        )
        .catch((error) => {
          console.warn(
            "[coordinator] Could not move work to the main coordinator:",
            error instanceof Error ? error.message : error,
          );
        });
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

  async ensure(projectId: string): Promise<CoordinatorSnapshot> {
    return this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const before = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      // A workspace only reaches `error` through a real startup failure now
      // that an unqualified default no longer produces one: a fresh
      // conversation has no provider until the user picks one. Retry therefore
      // means "try that same conversation again", and never silently rewrites
      // which platform a conversation belongs to.
      const canRecoverError = before?.lifecycleState === "error";
      const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
        projectId,
        (current) => {
          if (current) {
            if (!canRecoverError || current.id !== before?.id) return current;
            return {
              ...current,
              lifecycleState: "ready",
              lastStartupError: undefined,
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
      return this.snapshot(workspace, projectPath);
    });
  }

  async get(projectId: string): Promise<CoordinatorSnapshot | null> {
    const workspace = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
    if (!workspace) return null;
    return this.snapshot(workspace, await this.canonicalProjectPath(projectId));
  }

  private async snapshot(
    workspace: CoordinatorWorkspace,
    projectPath: string,
  ): Promise<CoordinatorSnapshot> {
    const main = coordinatorMainConversation(workspace);
    if (main) await this.reconcileMainMail(workspace, main);
    const availability = coordinatorProviderQualifications(await this.qualificationOptions());
    const mcp = this.controlMcp();
    return {
      workspace,
      projectPath,
      providerAvailability: availability,
      controlMcp: { enabled: mcp.enabled, running: mcp.running, error: mcp.error },
      workflows: await this.storage.coordinators.listCoordinatorWorkflowAssociations(
        workspace.projectId,
      ),
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
    return this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const existing = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace disappeared");
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
            throw new Error("Coordinator conversation limit reached");
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
      return this.snapshot(workspace, projectPath);
    });
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
    const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
      projectId,
      (current) => {
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
      },
    );
    if (!workspace) throw new Error("Coordinator workspace was not found");
    return this.snapshot(workspace, projectPath);
  }

  async closeConversation(projectId: string, conversationId: string): Promise<CoordinatorSnapshot> {
    const projectPath = await this.canonicalProjectPath(projectId);
    const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
      projectId,
      (current) => {
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
      },
    );
    if (!workspace) throw new Error("Coordinator workspace was not found");
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
    const workspace = await this.storage.coordinators.mutateCoordinatorWorkspace(
      projectId,
      (current) => {
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
      },
    );
    if (!workspace) throw new Error("Coordinator workspace was not found");
    return this.snapshot(workspace, projectPath);
  }

  async recordStartupError(projectId: string, error: unknown): Promise<void> {
    await this.storage.coordinators.mutateCoordinatorWorkspace(projectId, (current) =>
      current
        ? {
            ...current,
            lifecycleState: "error",
            lastStartupError: sanitizeCoordinatorError(error),
            updatedAt: new Date().toISOString(),
          }
        : null,
    );
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
        /*
         * The turn that just ended cannot be the answer to a request the worker
         * has not received yet. That happens when the coordinator messages a
         * worker already mid-turn: the delegation opens, the in-flight turn ends
         * moments later, and closing here would report "finished" for work that
         * has not started. The request stays open; the turn that actually reads
         * it is the one that settles it.
         *
         * A stopped worker with pending mail may still start and read it. A
         * failed worker releases the coordinator through the failure path.
         */
        if (
          worker.state !== "failed" &&
          (await this.storage.hasUndeliveredCoordinatorRequest(
            association.resourceId,
            delegation.workerTabId,
          ))
        ) {
          continue;
        }
        const background =
          worker.state === "completed"
            ? await this.backgroundWorkDisposition(association)
            : { held: false };
        if (background.held) continue;
        // A close that returns null lost the race to another observer of the same
        // edge. Either way the delegation is now closed, and the wake below is
        // idempotent, so there is nothing to do differently.
        await this.closeWorkerDelegation(association.id, worker.state, background.timeoutMs);
      }
    });
    await this.deliverDelegationWakes();
  }

  /**
   * Whether a worker whose turn just read as ended should keep its delegation
   * open because work it started in the background is still running.
   *
   * A worker that waits on a background shell or on sub-agents ends its turn
   * and resumes when they report. Without a report that turn end is a pause,
   * and "finished without sending a report" would be false. A worker that did
   * report has answered, so its report is never held for background work, and
   * the hold is bounded so a forgotten long-lived process cannot keep the
   * coordinator waiting forever.
   */
  private async backgroundWorkDisposition(
    association: CoordinatorWorkflowAssociation,
    backgroundWorkPending?: boolean,
  ): Promise<{ held: boolean; timeoutMs?: number }> {
    const delegation = association.delegation;
    const probe = this.options.workerBackgroundWork;
    if (
      !delegation ||
      // The coordinator stopped this turn itself: the end is the answer.
      delegation.stopRequestedAt ||
      // Waiting on the user: the coordinator has to hear now, not in minutes.
      this.options.workerNeedsHuman?.(association.resourceId) ||
      !(
        backgroundWorkPending ??
        (await probe?.(association.resourceId, delegation.workerTabId).catch(() => false))
      )
    ) {
      this.backgroundWorkSince.delete(association.id);
      return { held: false };
    }
    const owner = await this.storage.coordinators.getCoordinatorWorkspaceById(
      association.coordinatorId,
    );
    const main = owner ? coordinatorMainConversation(owner) : undefined;
    if (
      owner &&
      main &&
      (await this.storage.hasDelegationHeldAgentMail(
        association.id,
        coordinatorRuntimeId(owner.id, main.id),
        main.tabId,
        association.resourceId,
        delegation.workerTabId,
      ))
    ) {
      this.backgroundWorkSince.delete(association.id);
      return { held: false };
    }
    const now = Date.now();
    const previous = this.backgroundWorkSince.get(association.id);
    const since = previous?.requestedAt === delegation.requestedAt ? previous.since : now;
    this.backgroundWorkSince.set(association.id, { since, requestedAt: delegation.requestedAt });
    const timeoutMs = this.options.backgroundWorkHoldMs ?? DELEGATION_BACKGROUND_WORK_HOLD_MS;
    return now - since < timeoutMs ? { held: true } : { held: false, timeoutMs };
  }

  private async closeWorkerDelegation(
    id: string,
    state: "completed" | "failed" | "stopped",
    backgroundWorkTimeoutMs?: number,
  ): Promise<void> {
    await this.storage.coordinators.closeCoordinatorDelegation(
      id,
      state,
      new Date().toISOString(),
      backgroundWorkTimeoutMs,
    );
    this.backgroundWorkSince.delete(id);
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
    for (const workspace of await this.storage.coordinators.listCoordinatorWorkspaces()) {
      const main = coordinatorMainConversation(workspace);
      if (main) await this.reconcileMainMail(workspace, main);
    }
    for (const association of await this.storage.coordinators.listOpenCoordinatorDelegations()) {
      if (association.nodeId) {
        await this.reconcileRemoteDelegation(association);
        continue;
      }
      await this.storage.withAgentMailWorkerAdmission(association.resourceId, async () => {
        const current = (await this.storage.coordinators.listOpenCoordinatorDelegations()).find(
          (item) => item.id === association.id,
        );
        if (!current) return;
        const environment = await this.storage.getEnvironment(association.resourceId);
        if (
          environment?.status === "stopped" &&
          !environment.deletionRequestedAt &&
          (await this.storage.hasUndeliveredCoordinatorRequest(
            association.resourceId,
            association.delegation!.workerTabId,
          ))
        )
          return;
        let state: "completed" | "failed" | "stopped" | null =
          !environment || environment.deletionRequestedAt
            ? ("stopped" as const)
            : environment.status === "error"
              ? ("failed" as const)
              : environment.status === "stopped"
                ? ("stopped" as const)
                : null;
        const activity =
          !state && this.workerActivity
            ? await this.workerActivity(association.resourceId, association.delegation!.workerTabId)
            : "unknown";
        if (activity === "working") this.backgroundWorkSince.delete(association.id);
        let timeoutMs: number | undefined;
        if (
          !state &&
          this.workerActivity &&
          Date.now() - Date.parse(association.delegation!.requestedAt) >=
            DELEGATION_IDLE_RECONCILE_GRACE_MS
        ) {
          const undelivered = await this.storage.hasUndeliveredCoordinatorRequest(
            association.resourceId,
            association.delegation!.workerTabId,
          );
          if (!undelivered && activity === "idle") {
            const background = await this.backgroundWorkDisposition(current);
            if (!background.held) {
              state = "completed";
              timeoutMs = background.timeoutMs;
            }
          }
        }
        if (!state) return;
        await this.closeWorkerDelegation(association.id, state, timeoutMs);
      });
    }
    await this.deliverDelegationWakes();
    const owed = new Set(
      [
        ...(await this.storage.coordinators.listOpenCoordinatorDelegations()),
        ...(await this.storage.coordinators.listUnwokenCoordinatorDelegations()),
      ].map((association) => association.id),
    );
    await this.storage.releaseOrphanedDelegationHolds(owed);
  }

  /**
   * A worker environment on another node changed (its node's event, or the
   * sweep): settle the delegations it answers, and wake their coordinators.
   */
  async settleRemoteWorker(nodeId: string, environmentId: string): Promise<void> {
    const open = (await this.storage.coordinators.listOpenCoordinatorDelegations()).filter(
      (association) => association.nodeId === nodeId && association.resourceId === environmentId,
    );
    for (const association of open) await this.reconcileRemoteDelegation(association);
    if (open.length > 0) await this.deliverDelegationWakes();
  }

  /**
   * Close one remote delegation when its node shows the worker can no longer
   * be working on it: the environment is gone, failed or stopped, or the
   * worker's turn ended. An unreachable node changes nothing.
   */
  private async reconcileRemoteDelegation(
    association: CoordinatorWorkflowAssociation,
  ): Promise<void> {
    const delegation = association.delegation;
    if (!this.remote || !association.nodeId || delegation?.state !== "running") return;
    const requestGeneration = this.remoteAskedAt.get(association.id);
    const state = await this.remote
      .workerState(association.nodeId, association.resourceId, delegation.workerTabId)
      .catch(() => "unavailable" as const);
    if (state === "unavailable" || this.remoteAskedAt.get(association.id) !== requestGeneration)
      return;
    const askedAt = Math.max(Date.parse(delegation.requestedAt) || 0, requestGeneration?.at ?? 0);
    const graceOver = Date.now() - askedAt >= DELEGATION_IDLE_RECONCILE_GRACE_MS;
    if (state.tab === "working" || state.tab === "waiting") {
      this.remoteSeenWorking.add(association.id);
    }
    if (state.tab === "working") this.backgroundWorkSince.delete(association.id);
    const seenWorking = this.remoteSeenWorking.has(association.id);
    // As here: a turn that ends before the worker has read the request is not
    // its answer, and a stopped worker with the request waiting may still start.
    const waiting = state.requestPending === true;
    const outcome: "completed" | "failed" | "stopped" | null =
      state.environment === "missing" || state.environment === "deleting"
        ? "stopped"
        : state.environment === "error"
          ? "failed"
          : // A worker launched moments ago may still read as stopped.
            state.environment === "stopped" && !waiting && (seenWorking || graceOver)
            ? "stopped"
            : state.environment === "running" &&
                state.tab === "idle" &&
                !waiting &&
                (seenWorking || graceOver)
              ? "completed"
              : null;
    if (!outcome) return;
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
        const current = (await this.storage.coordinators.listOpenCoordinatorDelegations()).find(
          (item) => item.id === association.id,
        );
        if (!current) return;
        const background =
          outcome === "completed"
            ? await this.backgroundWorkDisposition(current, state.backgroundWorkPending === true)
            : { held: false };
        if (background.held) return;
        this.remoteSeenWorking.delete(association.id);
        this.remoteAskedAt.delete(association.id);
        await this.closeWorkerDelegation(association.id, outcome, background.timeoutMs);
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
    if (this.delegationWakeDelivery) return this.delegationWakeDelivery;
    const delivery = this.deliverDelegationWakesOnce().finally(() => {
      if (this.delegationWakeDelivery === delivery) this.delegationWakeDelivery = null;
    });
    this.delegationWakeDelivery = delivery;
    return delivery;
  }

  private async deliverDelegationWakesOnce(): Promise<void> {
    const unwoken = await this.storage.coordinators.listUnwokenCoordinatorDelegations();
    for (const association of unwoken) {
      const delegation = association.delegation;
      if (!delegation || !association.conversationId) continue;
      const owner = await this.storage.coordinators.getCoordinatorWorkspaceById(
        association.coordinatorId,
      );
      if (!owner) {
        // The coordinator itself is gone. Retiring the delegation is the only
        // honest outcome: there is nobody left to wake, and leaving it
        // unstamped would retry this lookup on every sweep forever.
        await this.storage.coordinators.markCoordinatorDelegationWoken(association.id);
        continue;
      }
      // The wake goes to the main coordinator. If the user closed it, a new
      // main starts with the default agent and takes this delegation over.
      const { workspace, main: conversation } = await this.ensureMainConversation(owner.projectId);
      const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
      let wakeKind = delegation.wakeKind;
      if (!wakeKind) {
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
        wakeKind = prepared?.delegation?.wakeKind;
      }
      if (!wakeKind) continue;
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
        // other; say who ended it, so it is not read as the worker finishing.
        const stoppedByCoordinator =
          delegation.state === "completed" && delegation.stopRequestedAt !== undefined;
        const outcome = stoppedByCoordinator
          ? "stopped"
          : delegation.state === "completed"
            ? "finished"
            : delegation.state === "failed"
              ? "failed"
              : "stopped";
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
                (stoppedByCoordinator
                  ? `because you stopped its turn with stop_worker_turn, before it sent a report. Its tab is idle and keeps the conversation; send_prompt_to_tab gives it its next instruction.`
                  : `without sending a report.`) +
                (backgroundWorkTimeoutMs !== undefined
                  ? ` Its turn ended while work it started in the background was still running, and none of it reported for ${backgroundWorkMinutes} ${backgroundWorkMinutes === 1 ? "minute" : "minutes"}; it may resume if that work reports.`
                  : "") +
                (association.baseBranch
                  ? ` It was started from ${association.baseBranch}${
                      association.baseCommit ? ` at ${association.baseCommit.slice(0, 12)}` : ""
                    }.`
                  : "") +
                ` Inspect the environment through Orkestrator controls before deciding what to do next.` +
                (excerpt ? `\n\nLast message: ${boundedLine(excerpt)}` : "") +
                `\n\nRead more: \`get_tab_transcript ${tabArgs}\`, \`get_tab_state ${tabArgs}\`.`,
            },
            {
              notice: {
                resource: {
                  kind: "agent-tab",
                  id: delegation.workerTabId,
                  environmentId: association.resourceId,
                  tabId: delegation.workerTabId,
                  label,
                },
                state: delegation.state,
                tone: stoppedByCoordinator
                  ? "info"
                  : delegation.state === "completed"
                    ? "success"
                    : delegation.state === "failed"
                      ? "failure"
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
      await this.storage.coordinators.markCoordinatorDelegationWoken(association.id);
    }
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

  static runtimeId(workspace: CoordinatorWorkspace): string {
    return coordinatorRuntimeId(workspace.id);
  }
}
