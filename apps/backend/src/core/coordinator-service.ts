import { randomUUID } from "node:crypto";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
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

const MAX_STARTUP_ERROR_CHARS = 2_000;
const DELEGATION_IDLE_RECONCILE_GRACE_MS = 15_000;

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

/** At most this many conversations are open: the main coordinator and its side agents. */
const MAX_OPEN_COORDINATOR_CONVERSATIONS = 16;

function conversation(
  workspaceId: string,
  role: CoordinatorConversationRole,
  sideOrdinal?: number,
  agent?: AgentPlatform,
): CoordinatorConversation {
  const id = randomUUID();
  return {
    id,
    tabId: `coordinator-${id}`,
    logicalSessionKey: `coordinator-${workspaceId}:${id}`,
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
  ) {
    // Mail to "coordinator", or to a conversation that has since closed, finds
    // the current main through here, which starts one if there is none.
    this.storage.setCoordinatorMailResolver?.((projectId) => this.mainMailAddress(projectId));
  }

  /**
   * The current main conversation's mail address, starting one if the user
   * closed it. Null when the project has never had a coordinator: an address
   * nobody asked for is not a reason to create one.
   */
  async mainMailAddress(
    projectId: string,
  ): Promise<{ environmentId: string; tabId: string } | null> {
    if (!(await this.storage.getCoordinatorWorkspace(projectId))) return null;
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
      const existing = await this.storage.getCoordinatorWorkspace(projectId);
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
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
        if (!current) throw new Error("Coordinator workspace disappeared");
        return {
          ...current,
          conversations: retainCoordinatorConversations([...current.conversations, created]),
          selectedConversationId: current.selectedConversationId ?? created.id,
          updatedAt: new Date().toISOString(),
        };
      });
      if (!workspace) throw new Error("Coordinator workspace disappeared");
      const main = coordinatorMainConversation(workspace) ?? created;
      return { workspace, main, created: true };
    });
    await this.adoptLiveWork(result.workspace, result.main);
    if (result.created) {
      await this.storage.synchronizeAgentMailboxes();
      // What was waiting in the closed main's inbox — a held report above
      // all — belongs to the new one.
      const owed = new Set(
        [
          ...(await this.storage.listOpenCoordinatorDelegations()),
          ...(await this.storage.listUnwokenCoordinatorDelegations()),
        ].map((association) => association.id),
      );
      await this.storage
        .moveClosedCoordinatorMail(
          result.workspace.id,
          {
            environmentId: coordinatorRuntimeId(result.workspace.id, result.main.id),
            tabId: result.main.tabId,
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
    return { workspace: result.workspace, main: result.main };
  }

  /** Move delegations and workflows other conversations still owe onto the main. */
  private async adoptLiveWork(
    workspace: CoordinatorWorkspace,
    main: CoordinatorConversation,
  ): Promise<void> {
    for (const association of await this.storage.listCoordinatorWorkflowAssociations(
      workspace.projectId,
    )) {
      if (
        association.coordinatorId !== workspace.id ||
        association.conversationId === main.id ||
        !liveWork(association)
      ) {
        continue;
      }
      await this.storage
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
      const before = await this.storage.getCoordinatorWorkspace(projectId);
      // A workspace only reaches `error` through a real startup failure now
      // that an unqualified default no longer produces one: a fresh
      // conversation has no provider until the user picks one. Retry therefore
      // means "try that same conversation again", and never silently rewrites
      // which platform a conversation belongs to.
      const canRecoverError = before?.lifecycleState === "error";
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
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
      });
      if (!workspace) throw new Error("Coordinator workspace could not be created");
      return this.snapshot(workspace, projectPath);
    });
  }

  async get(projectId: string): Promise<CoordinatorSnapshot | null> {
    const workspace = await this.storage.getCoordinatorWorkspace(projectId);
    if (!workspace) return null;
    return this.snapshot(workspace, await this.canonicalProjectPath(projectId));
  }

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
      workflows: await this.storage.listCoordinatorWorkflowAssociations(workspace.projectId),
    };
  }

  async createConversation(projectId: string, title?: string): Promise<CoordinatorSnapshot> {
    if (!(await this.storage.getCoordinatorWorkspace(projectId))) {
      await this.ensure(projectId);
    }
    return this.serialize(projectId, async () => {
      const projectPath = await this.canonicalProjectPath(projectId);
      const existing = await this.storage.getCoordinatorWorkspace(projectId);
      if (!existing) throw new Error("Coordinator workspace disappeared");
      // Deliberately unassigned. Inheriting the selected conversation's
      // provider is what made a new conversation look locked: the composer had
      // one platform before the user had said anything.
      //
      // With no main open this starts the main coordinator; otherwise it adds
      // the next side agent. There is never a second main.
      const created = coordinatorMainConversation(existing)
        ? conversation(existing.id, "side", nextSideOrdinal(existing))
        : conversation(existing.id, "main");
      if (title?.trim() && created.role === "main") created.title = title.trim();
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
        if (!current) throw new Error("Coordinator workspace disappeared");
        if (
          current.conversations.filter((item) => !item.closedAt).length >=
          MAX_OPEN_COORDINATOR_CONVERSATIONS
        ) {
          throw new Error("Coordinator conversation limit reached");
        }
        if (created.role === "main" && coordinatorMainConversation(current)) {
          throw new Error("This project already has a main coordinator");
        }
        return {
          ...current,
          conversations: retainCoordinatorConversations([...current.conversations, created]),
          selectedConversationId: created.id,
          updatedAt: new Date().toISOString(),
        };
      });
      if (!workspace) throw new Error("Coordinator workspace disappeared");
      await this.storage.pruneCoordinatorAttachmentDirectories(
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
      const existing = await this.storage.getCoordinatorWorkspace(projectId);
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
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
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
      });
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
    const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
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
    const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
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
    const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
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

  async recordStartupError(projectId: string, error: unknown): Promise<void> {
    await this.storage.mutateCoordinatorWorkspace(projectId, (current) =>
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
    await this.storage.deleteCoordinatorByProject(projectId);
  }

  async reconcileWorkflowNotifications(): Promise<void> {
    const state = await this.storage.getCoordinatorReconciliationState();
    for (const workspace of state.workspaces) {
      const associations = state.workflows.filter(
        (association) =>
          association.projectId === workspace.projectId &&
          association.kind !== "environment" &&
          !association.pending &&
          !association.terminalNotifiedAt,
      );
      for (const association of associations) {
        const record =
          association.kind === "build-pipeline"
            ? await this.storage.getBuildPipeline(association.resourceId)
            : association.kind === "multi-review"
              ? await this.storage.getMultiReviewWorkflow(association.resourceId)
              : null;
        if (!record) continue;
        const snapshot = record.snapshot as Record<string, unknown> | undefined;
        const phase = String(snapshot?.phase ?? "");
        const terminal =
          association.kind === "build-pipeline"
            ? phase === "complete" || phase === "failed"
            : ["completed", "failed", "cancelled"].includes(phase);
        if (!terminal) continue;
        const revision =
          typeof record.revision === "number"
            ? record.revision
            : typeof snapshot?.backendRevision === "number"
              ? snapshot.backendRevision
              : 0;
        if ((association.lastNotifiedRevision ?? -1) >= revision) {
          await this.storage.markCoordinatorWorkflowNotified(association.id, revision);
          continue;
        }
        // Reported to the main coordinator, whichever conversation started it.
        // A notice does not start a main on its own: workflows that finished
        // under long-closed conversations were never reported, and waking a
        // fresh coordinator with them would be a surprise turn. It waits for
        // the next main instead.
        const current = workspace;
        const conversation = coordinatorMainConversation(workspace);
        if (!conversation) continue;
        await this.storage.sendAgentMail(
          {
            kind: "system",
            projectId: workspace.projectId,
            source: "workflow",
            resourceId: association.resourceId,
          },
          {
            requestId: `workflow-${association.id}-${conversation.id}-${revision}`,
            toEnvironmentId: coordinatorRuntimeId(current.id, conversation.id),
            toTabId: conversation.tabId,
            subject: `${association.kind === "build-pipeline" ? "Build pipeline" : "Multi-review"} ${phase}`,
            body: `Authoritative workflow ${association.resourceId} reached ${phase}. Inspect the workflow through Orkestrator controls before deciding what to do next.`,
          },
        );
        await this.storage.markCoordinatorWorkflowNotified(association.id, revision);
      }
    }
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
    const open = await this.storage.listOpenCoordinatorDelegations();
    for (const association of open) {
      if (association.resourceId !== worker.environmentId) continue;
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
       * Only for `completed` — a stopped or failed worker is never going to
       * read it, and leaving the coordinator waiting on that would be worse.
       */
      if (
        worker.state === "completed" &&
        (await this.storage.hasUndeliveredCoordinatorRequest(
          association.resourceId,
          delegation.workerTabId,
        ))
      ) {
        continue;
      }
      // A close that returns null lost the race to another observer of the same
      // edge. Either way the delegation is now closed, and the wake below is
      // idempotent, so there is nothing to do differently.
      await this.storage.closeCoordinatorDelegation(association.id, worker.state);
    }
    await this.deliverDelegationWakes();
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
    for (const association of await this.storage.listOpenCoordinatorDelegations()) {
      const environment = await this.storage.getEnvironment(association.resourceId);
      let state: "completed" | "failed" | "stopped" | null =
        !environment || environment.deletionRequestedAt
          ? ("stopped" as const)
          : environment.status === "error"
            ? ("failed" as const)
            : environment.status === "stopped"
              ? ("stopped" as const)
              : null;
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
        if (
          !undelivered &&
          (await this.workerActivity(
            association.resourceId,
            association.delegation!.workerTabId,
          )) === "idle"
        ) {
          state = "completed";
        }
      }
      if (!state) continue;
      await this.storage.closeCoordinatorDelegation(association.id, state);
    }
    await this.deliverDelegationWakes();
    const owed = new Set(
      [
        ...(await this.storage.listOpenCoordinatorDelegations()),
        ...(await this.storage.listUnwokenCoordinatorDelegations()),
      ].map((association) => association.id),
    );
    await this.storage.releaseOrphanedDelegationHolds(owed);
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
    const unwoken = await this.storage.listUnwokenCoordinatorDelegations();
    for (const association of unwoken) {
      const delegation = association.delegation;
      if (!delegation || !association.conversationId) continue;
      const owner = await this.storage.getCoordinatorWorkspaceById(association.coordinatorId);
      if (!owner) {
        // The coordinator itself is gone. Retiring the delegation is the only
        // honest outcome: there is nobody left to wake, and leaving it
        // unstamped would retry this lookup on every sweep forever.
        await this.storage.markCoordinatorDelegationWoken(association.id);
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
        const prepared = await this.storage.prepareCoordinatorDelegationWake(
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
        const environment = await this.storage.getEnvironment(association.resourceId);
        const label = environment?.name ?? association.resourceId;
        const outcome =
          delegation.state === "completed"
            ? "finished"
            : delegation.state === "failed"
              ? "failed"
              : "stopped";
        await this.storage.sendAgentMail(
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
              `Worker environment ${association.resourceId} (tab ${delegation.workerTabId}) ${outcome} ` +
              `without sending a report.` +
              (association.baseBranch
                ? ` It was started from ${association.baseBranch}${
                    association.baseCommit ? ` at ${association.baseCommit.slice(0, 12)}` : ""
                  }.`
                : "") +
              ` Inspect the environment through Orkestrator controls before deciding what to do next.`,
          },
        );
      }
      await this.storage.markCoordinatorDelegationWoken(association.id);
    }
  }

  static runtimeId(workspace: CoordinatorWorkspace): string {
    return coordinatorRuntimeId(workspace.id);
  }
}
