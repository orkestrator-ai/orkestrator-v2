import { randomUUID } from "node:crypto";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorSnapshot,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { resolveDefaultAgent } from "@orkestrator/protocol/agent-settings";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { StorageService } from "./storage.js";
import { resolveProjectGitRoot } from "./project-git-service.js";

const MAX_STARTUP_ERROR_CHARS = 2_000;
const SUPPORTED_COORDINATOR_PROVIDERS = new Set<AgentPlatform>(["codex"]);

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

function conversation(
  workspaceId: string,
  agent: AgentPlatform,
  title = "Coordinator",
): CoordinatorConversation {
  const id = randomUUID();
  return {
    id,
    tabId: `coordinator-${id}`,
    logicalSessionKey: `coordinator-${workspaceId}:${id}`,
    agent,
    title,
    createdAt: new Date().toISOString(),
    mailboxIncarnationId: randomUUID(),
  };
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

  constructor(
    private readonly storage: StorageService,
    private readonly controlMcp: () => {
      enabled: boolean;
      running: boolean;
      error: string | null;
    },
  ) {}

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
      const configuredAgent = await this.configuredAgent(projectId);
      const before = await this.storage.getCoordinatorWorkspace(projectId);
      const canRecoverError = Boolean(
        before &&
        before.lifecycleState === "error" &&
        SUPPORTED_COORDINATOR_PROVIDERS.has(configuredAgent),
      );
      const hasMaterializedSession = canRecoverError
        ? (await this.storage.listNativeAgentSessions()).some(
            (session) =>
              session.owner?.kind === "coordinator" && session.owner.coordinatorId === before!.id,
          )
        : false;
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
        if (current) {
          if (!canRecoverError || current.id !== before?.id) return current;
          return {
            ...current,
            lifecycleState: "ready",
            // An unsupported-provider workspace has no materialized provider
            // session, so it is safe to adopt the newly qualified default. A
            // transient bridge startup failure may already have durable
            // sessions and must preserve their provider identity while Retry
            // clears the gate and attempts the same conversation again.
            conversations: hasMaterializedSession
              ? current.conversations
              : current.conversations.map((item) =>
                  item.closedAt ? item : { ...item, agent: configuredAgent },
                ),
            lastStartupError: undefined,
            updatedAt: new Date().toISOString(),
          };
        }
        const id = randomUUID();
        const initial = conversation(id, configuredAgent);
        const now = new Date().toISOString();
        return {
          version: COORDINATOR_WORKSPACE_VERSION,
          id,
          projectId,
          executionPolicy: COORDINATOR_EXECUTION_POLICY,
          lifecycleState: SUPPORTED_COORDINATOR_PROVIDERS.has(configuredAgent) ? "ready" : "error",
          conversations: [initial],
          selectedConversationId: initial.id,
          repositoryContextRevision: 0,
          createdAt: now,
          updatedAt: now,
          ...(!SUPPORTED_COORDINATOR_PROVIDERS.has(configuredAgent)
            ? {
                lastStartupError: `${configuredAgent} is not available for Coordinator because its read-only boundary has not been qualified. Select Codex in project defaults to use Coordinator.`,
              }
            : {}),
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
    const availability = Object.fromEntries(
      (["claude", "codex", "opencode", "cursor", "grok", "pi"] as AgentPlatform[]).map((agent) => [
        agent,
        SUPPORTED_COORDINATOR_PROVIDERS.has(agent)
          ? { available: true }
          : {
              available: false,
              reason:
                "Read-only execution and scoped MCP access are not qualified for this provider.",
            },
      ]),
    );
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
      const currentAgent =
        existing.conversations.find((item) => item.id === existing.selectedConversationId)?.agent ??
        existing.conversations.at(-1)?.agent;
      const configuredAgent = await this.configuredAgent(projectId);
      const activeAgent =
        currentAgent && SUPPORTED_COORDINATOR_PROVIDERS.has(currentAgent)
          ? currentAgent
          : configuredAgent;
      if (!activeAgent) {
        throw new Error("Coordinator provider could not be resolved");
      }
      if (!SUPPORTED_COORDINATOR_PROVIDERS.has(activeAgent)) {
        throw new Error("The configured provider is unavailable for Coordinator");
      }
      const created = conversation(existing.id, activeAgent, title?.trim() || "Coordinator");
      const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
        if (!current) throw new Error("Coordinator workspace disappeared");
        if (current.conversations.filter((item) => !item.closedAt).length >= 16) {
          throw new Error("Coordinator conversation limit reached");
        }
        return {
          ...current,
          conversations: retainCoordinatorConversations([...current.conversations, created]),
          selectedConversationId: created.id,
          updatedAt: new Date().toISOString(),
        };
      });
      if (!workspace) throw new Error("Coordinator workspace disappeared");
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
    const workspace = await this.storage.mutateCoordinatorWorkspace(projectId, (current) => {
      if (!current) throw new Error("Coordinator workspace was not found");
      const selected =
        current.conversations.find((item) => item.id === current.selectedConversationId) ??
        current.conversations.at(-1);
      if (!paused && (!selected || !SUPPORTED_COORDINATOR_PROVIDERS.has(selected.agent))) {
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
        const conversation = workspace.conversations.find(
          (item) => item.id === association.conversationId && !item.closedAt,
        );
        if (!conversation) continue;
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
        await this.storage.sendAgentMail(
          {
            kind: "system",
            projectId: workspace.projectId,
            source: "workflow",
            resourceId: association.resourceId,
          },
          {
            requestId: `workflow-${association.id}-${conversation.id}-${revision}`,
            toEnvironmentId: coordinatorRuntimeId(workspace.id, conversation.id),
            toTabId: conversation.tabId,
            subject: `${association.kind === "build-pipeline" ? "Build pipeline" : "Multi-review"} ${phase}`,
            body: `Authoritative workflow ${association.resourceId} reached ${phase}. Inspect the workflow through Orkestrator controls before deciding what to do next.`,
          },
        );
        await this.storage.markCoordinatorWorkflowNotified(association.id, revision);
      }
    }
  }

  static runtimeId(workspace: CoordinatorWorkspace): string {
    return coordinatorRuntimeId(workspace.id);
  }
}
