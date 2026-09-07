import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { localServerStopCommandName } from "./commands-runtime-state.js";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { createHash, randomUUID } from "node:crypto";
import { isStartBuildPipelineInput, isStartMultiReviewInput } from "./commands-dependencies.js";
import { runCommand } from "./shell.js";

function actionHash(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!record(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .flatMap((key) =>
          item[key] === undefined ? [] : [[key, canonicalize(item[key])] as const],
        ),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function multiReviewInputFromSnapshot(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  return {
    environmentId: value.environmentId,
    projectId: value.projectId,
    targetBranch: value.targetBranch,
    ...(value.reviewInstruction ? { reviewInstruction: value.reviewInstruction } : {}),
    reviewers: Array.isArray(value.reviewers)
      ? value.reviewers.map((reviewer) => {
          if (!record(reviewer)) return reviewer;
          return {
            agent: reviewer.agent,
            model: reviewer.model,
            ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
          };
        })
      : value.reviewers,
    fixModel: value.fixModel,
  };
}

async function requireCoordinatorConversation(
  context: CommandContext,
  projectId: string,
  coordinatorId: string,
  conversationId: string,
): Promise<void> {
  const workspace = await context.storage.getCoordinatorWorkspaceById(coordinatorId);
  if (
    !workspace ||
    workspace.projectId !== projectId ||
    workspace.lifecycleState !== "ready" ||
    !workspace.conversations.some((item) => item.id === conversationId && !item.closedAt)
  ) {
    throw new Error("Coordinator identity is unavailable");
  }
}

async function assertContainerDelegationCommitPublished(
  context: CommandContext,
  projectId: string,
  commit: string,
): Promise<void> {
  const project = await context.storage.getProject(projectId);
  if (!project?.localPath) throw new Error("Coordinator project checkout is unavailable");
  const containing = await runCommand(
    "git",
    ["for-each-ref", `--contains=${commit}`, "--format=%(refname)", "refs/remotes"],
    { cwd: project.localPath, timeoutMs: 10_000 },
  );
  if (!containing.stdout.split("\n").some((ref) => ref && !ref.endsWith("/HEAD"))) {
    throw new Error(
      "Container workers require the delegation commit to be published to a remote branch. Push it or choose a local worker.",
    );
  }
}

export function registerCoordinatorCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const workflowStarts = new Map<string, Promise<unknown>>();
  const runWorkflowStart = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = workflowStarts.get(key);
    if (existing) return existing as Promise<T>;
    const started = operation().finally(() => {
      if (workflowStarts.get(key) === started) workflowStarts.delete(key);
    });
    workflowStarts.set(key, started);
    return started;
  };
  register("ensure_project_coordinator", async ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.ensure(asNonBlankString(projectId, "projectId"));
  });
  register("get_project_coordinator", async ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.get(asNonBlankString(projectId, "projectId"));
  });
  register("create_coordinator_conversation", async ({ projectId, title }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.createConversation(
      asNonBlankString(projectId, "projectId"),
      typeof title === "string" ? title : undefined,
    );
  });
  register(
    "assign_coordinator_conversation_agent",
    async ({ projectId, conversationId, agent }, context) => {
      if (!context.coordinators) throw new Error("Coordinator service is unavailable");
      const platform = asNonBlankString(agent, "agent");
      if (!isAgentPlatform(platform)) throw new Error("Unsupported agent platform");
      return context.coordinators.assignConversationAgent(
        asNonBlankString(projectId, "projectId"),
        asNonBlankString(conversationId, "conversationId"),
        platform,
      );
    },
  );
  register("select_coordinator_conversation", async ({ projectId, conversationId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.selectConversation(
      asNonBlankString(projectId, "projectId"),
      conversationId === null ? null : asNonBlankString(conversationId, "conversationId"),
    );
  });
  register("close_coordinator_conversation", async ({ projectId, conversationId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    const id = asNonBlankString(projectId, "projectId");
    const conversation = asNonBlankString(conversationId, "conversationId");
    const current = await context.coordinators.get(id);
    if (!current) throw new Error("Coordinator workspace was not found");
    const item = current?.workspace.conversations.find((entry) => entry.id === conversation);
    if (!item) throw new Error("Coordinator conversation was not found");
    // An unassigned conversation never reached a provider: there is no session
    // to stop, no bridge to retire and no rollout to invalidate. Only the
    // credential revocation below is unconditional.
    if (item.agent) {
      if (context.nativeAgents) {
        await context.nativeAgents
          .stopProjectionSession({
            environmentId: coordinatorRuntimeId(current.workspace.id, item.id),
            agent: item.agent,
            logicalSessionKey: item.logicalSessionKey,
          })
          .catch(() => undefined);
      }
    }
    context.controlMcp?.revokeCoordinatorCredentials(current.workspace.id, conversation);
    if (item.agent) {
      // A bridge carries one private MCP configuration. Retire it when a tab
      // credential is revoked; another open tab reattaches through a fresh child
      // and freshly scoped credential without losing provider history.
      await Promise.resolve(
        dependencies.commands.get(localServerStopCommandName(item.agent))?.(
          { environmentId: coordinatorRuntimeId(current.workspace.id, item.id) },
          context,
        ),
      ).catch(() => undefined);
      const sessionKey = nativeAgentSessionStorageKey(
        coordinatorRuntimeId(current.workspace.id, item.id),
        item.agent,
        item.logicalSessionKey,
      );
      const session = await context.storage.getNativeAgentSession(sessionKey);
      if (session) {
        await context.storage.invalidateNativeAgentSession(sessionKey, session.providerSessionId);
      }
    }
    const snapshot = await context.coordinators.closeConversation(id, conversation);
    await context.storage.synchronizeAgentMailboxes();
    return snapshot;
  });
  register("pause_project_coordinator", ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.setPaused(asNonBlankString(projectId, "projectId"), true);
  });
  register("resume_project_coordinator", ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.setPaused(asNonBlankString(projectId, "projectId"), false);
  });
  register("get_project_git_status", ({ projectId }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.status(asNonBlankString(projectId, "projectId"));
  });
  register("fetch_project_git", ({ projectId, force }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.fetch(asNonBlankString(projectId, "projectId"), force === true);
  });
  register("sync_project_git", ({ projectId }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.sync(asNonBlankString(projectId, "projectId"));
  });
  register("switch_project_git_branch", ({ projectId, ref }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.switchBranch(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(ref, "ref"),
    );
  });
  register(
    "write_coordinator_attachment",
    async ({ environmentId, filename, base64Data }, context) => {
      const runtimeId = asNonBlankString(environmentId, "environmentId");
      const coordinatorId = coordinatorIdFromRuntimeId(runtimeId);
      const conversationId = coordinatorConversationIdFromRuntimeId(runtimeId);
      if (!coordinatorId || !conversationId) {
        throw new Error("Coordinator runtime identity is required");
      }
      return context.storage.writeCoordinatorAttachment(
        coordinatorId,
        conversationId,
        asNonBlankString(filename, "filename"),
        asNonBlankString(base64Data, "base64Data"),
      );
    },
  );
  register(
    "send_coordinator_agent_mail",
    async (
      {
        projectId,
        coordinatorId,
        conversationId,
        requestId,
        toEnvironmentId,
        toTabId,
        subject,
        body,
        replyToMessageId,
      },
      context,
    ) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      const workspace = await context.storage.getCoordinatorWorkspaceById(coordinator);
      if (!workspace || workspace.projectId !== project || workspace.lifecycleState !== "ready") {
        throw new Error("Coordinator identity is unavailable");
      }
      const tab = workspace.conversations.find(
        (item) => item.id === conversation && !item.closedAt,
      );
      if (!tab) throw new Error("Coordinator conversation is unavailable");
      const destination = await context.storage.getEnvironment(
        asNonBlankString(toEnvironmentId, "toEnvironmentId"),
      );
      if (!destination || destination.projectId !== project) {
        throw new Error("Coordinator messages must stay within their project");
      }
      return context.storage.sendAgentMail(
        {
          kind: "coordinator",
          projectId: project,
          coordinatorId: coordinator,
          conversationId: conversation,
          environmentId: coordinatorRuntimeId(coordinator, conversation),
          tabId: tab.tabId,
        },
        {
          requestId: asNonBlankString(requestId, "requestId"),
          toEnvironmentId: destination.id,
          toTabId: asNonBlankString(toTabId, "toTabId"),
          body: asNonBlankString(body, "body"),
          ...(typeof subject === "string" ? { subject } : {}),
          ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
        },
      );
    },
  );
  register(
    "associate_coordinator_workflow",
    async (
      {
        projectId,
        coordinatorId,
        conversationId,
        kind,
        resourceId,
        requestId,
        baseBranch,
        baseCommit,
      },
      context,
    ) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const workspace = await context.storage.getCoordinatorWorkspaceById(coordinator);
      if (!workspace || workspace.projectId !== project) throw new Error("Coordinator not found");
      if (kind !== "environment" && kind !== "build-pipeline" && kind !== "multi-review") {
        throw new Error("Invalid coordinator workflow kind");
      }
      const association: CoordinatorWorkflowAssociation = {
        id: randomUUID(),
        projectId: project,
        coordinatorId: coordinator,
        ...(typeof conversationId === "string" ? { conversationId } : {}),
        kind,
        resourceId: asNonBlankString(resourceId, "resourceId"),
        requestId: asNonBlankString(requestId, "requestId"),
        ...(typeof baseBranch === "string" ? { baseBranch } : {}),
        ...(typeof baseCommit === "string" ? { baseCommit } : {}),
        createdAt: new Date().toISOString(),
      };
      return context.storage.saveCoordinatorWorkflowAssociation(association);
    },
  );
  register(
    "adopt_coordinator_workflow",
    async ({ projectId, coordinatorId, conversationId, associationId }, context) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      await requireCoordinatorConversation(context, project, coordinator, conversation);
      return context.storage.adoptCoordinatorWorkflowAssociation(
        project,
        coordinator,
        asNonBlankString(associationId, "associationId"),
        conversation,
      );
    },
  );
  register("launch_coordinator_environment", async ({ scope, requestId, input }, context) => {
    if (!record(scope) || !record(input)) throw new Error("Coordinator launch input is invalid");
    const projectId = asNonBlankString(scope.projectId, "projectId");
    const coordinatorId = asNonBlankString(scope.coordinatorId, "coordinatorId");
    const conversationId = asNonBlankString(scope.conversationId, "conversationId");
    await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
    const stableRequestId = asNonBlankString(requestId, "requestId");
    if (
      input.projectId !== projectId ||
      typeof input.delegationBaseBranch !== "string" ||
      typeof input.delegationBaseCommit !== "string" ||
      !/^[0-9a-f]{40}$/i.test(input.delegationBaseCommit)
    ) {
      throw new Error("Coordinator launches require a scoped base branch and commit");
    }
    const delegationBaseBranch = input.delegationBaseBranch;
    const delegationBaseCommit = input.delegationBaseCommit;
    if (input.environmentType !== "local") {
      await assertContainerDelegationCommitPublished(context, projectId, delegationBaseCommit);
    }
    const payloadHash = actionHash(input);
    return runWorkflowStart(`${coordinatorId}\0${stableRequestId}`, async () => {
      const receipt = await context.storage.reserveCoordinatorWorkflowAssociation({
        id: randomUUID(),
        projectId,
        coordinatorId,
        conversationId,
        kind: "environment",
        resourceId: `pending:${stableRequestId}`,
        requestId: stableRequestId,
        payloadHash,
        baseBranch: delegationBaseBranch,
        baseCommit: delegationBaseCommit,
        createdAt: new Date().toISOString(),
      });
      if (!receipt.claimed && !receipt.association.pending) {
        const environment = await context.storage.getEnvironment(receipt.association.resourceId);
        if (!environment) throw new Error("Associated worker environment was not found");
        return { environment };
      }
      if (!receipt.claimed) {
        throw new Error("Environment creation is already in progress; retry this requestId");
      }
      const delegatedPrompt =
        typeof input.initialPrompt === "string"
          ? `<orkestrator-coordinator-delegation>\nProject: ${projectId}\nCoordinator: ${coordinatorId}\nConversation: ${conversationId}\nBase branch: ${input.delegationBaseBranch}\nBase commit: ${input.delegationBaseCommit}\nThis is a server-attested same-project worker delegation. Perform it inside this disposable worker under its normal sandbox and approval policy, then report meaningful completion, failure, or blocking details through Orkestrator mail.\n</orkestrator-coordinator-delegation>\n\n${input.initialPrompt}`
          : input.initialPrompt;
      const environment = await dependencies.commands.get("create_environment")?.(
        { ...input, initialPrompt: delegatedPrompt, controlRequestId: stableRequestId },
        context,
      );
      if (!record(environment) || typeof environment.id !== "string") {
        throw new Error("Environment creation returned no environment");
      }
      await context.storage.completeCoordinatorWorkflowAssociation(
        receipt.association.id,
        environment.id,
      );
      let startError: string | undefined;
      if (environment.status !== "running" && environment.status !== "creating") {
        try {
          await dependencies.commands.get("start_environment_background")?.(
            { environmentId: environment.id },
            context,
          );
        } catch (error) {
          startError = error instanceof Error ? error.message : "Environment start failed";
        }
      }
      return { environment, ...(startError ? { startError } : {}) };
    });
  });
  register("start_coordinator_build_pipeline", async ({ scope, requestId, input }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    const buildPipelines = context.buildPipelines;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw new Error("Coordinator scope is required");
    }
    const identity = scope as Record<string, unknown>;
    const projectId = asNonBlankString(identity.projectId, "projectId");
    const coordinatorId = asNonBlankString(identity.coordinatorId, "coordinatorId");
    const conversationId = asNonBlankString(identity.conversationId, "conversationId");
    await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
    const stableRequestId = asNonBlankString(requestId, "requestId");
    if (!isStartBuildPipelineInput(input) || input.projectId !== projectId) {
      throw new Error("Invalid scoped build pipeline request");
    }
    if (!input.delegationBaseBranch || !input.delegationBaseCommit) {
      throw new Error("Coordinator build pipelines require an explicit base branch and commit");
    }
    if (input.existingEnvironmentId) {
      const environment = await context.storage.getEnvironment(input.existingEnvironmentId);
      if (
        !environment ||
        environment.projectId !== projectId ||
        environment.createdFromCommit?.toLowerCase() !== input.delegationBaseCommit.toLowerCase()
      ) {
        throw new Error(
          "The existing worker environment was not created from the requested delegation commit",
        );
      }
    } else if (input.environmentType === "containerized") {
      await assertContainerDelegationCommitPublished(
        context,
        projectId,
        input.delegationBaseCommit,
      );
    }
    const payloadHash = actionHash(input);
    return runWorkflowStart(`${coordinatorId}\0${stableRequestId}`, async () => {
      const receipt = await context.storage.reserveCoordinatorWorkflowAssociation({
        id: randomUUID(),
        projectId,
        coordinatorId,
        conversationId,
        kind: "build-pipeline",
        resourceId: `pending:${stableRequestId}`,
        requestId: stableRequestId,
        payloadHash,
        baseBranch: input.delegationBaseBranch,
        baseCommit: input.delegationBaseCommit,
        createdAt: new Date().toISOString(),
      });
      if (!receipt.claimed && !receipt.association.pending) {
        const existing = await context.storage.getBuildPipeline(receipt.association.resourceId);
        if (!existing) throw new Error("Associated build pipeline was not found");
        return existing.snapshot;
      }
      if (!receipt.claimed) {
        throw new Error("Build pipeline creation is already in progress; retry this requestId");
      }
      // BuildPipelineService has its own durable admission key, so reclaiming a
      // reservation after a crash returns the already-created workflow.
      const workflow = await buildPipelines.start(input);
      await context.storage.completeCoordinatorWorkflowAssociation(
        receipt.association.id,
        workflow.id,
      );
      return workflow;
    });
  });
  register(
    "start_coordinator_multi_review",
    async ({ scope, requestId, input, buildPipelineId }, context) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      const multiReviews = context.multiReviews;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw new Error("Coordinator scope is required");
      }
      const identity = scope as Record<string, unknown>;
      const projectId = asNonBlankString(identity.projectId, "projectId");
      const coordinatorId = asNonBlankString(identity.coordinatorId, "coordinatorId");
      const conversationId = asNonBlankString(identity.conversationId, "conversationId");
      await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
      const stableRequestId = asNonBlankString(requestId, "requestId");
      if (!isStartMultiReviewInput(input) || input.projectId !== projectId) {
        throw new Error("Invalid scoped multi-review request");
      }
      const requiredBuildPipelineId = asNonBlankString(buildPipelineId, "buildPipelineId");
      const buildRecord = await context.storage.getBuildPipeline(requiredBuildPipelineId);
      const buildSnapshot = buildRecord?.snapshot;
      if (
        !record(buildSnapshot) ||
        buildSnapshot.projectId !== projectId ||
        buildSnapshot.environmentId !== input.environmentId ||
        buildSnapshot.phase !== "complete"
      ) {
        throw new Error(
          "Multi-review can start only after the associated build pipeline completed successfully",
        );
      }
      const payloadHash = actionHash({ input, buildPipelineId: requiredBuildPipelineId });
      return runWorkflowStart(`${coordinatorId}\0${stableRequestId}`, async () => {
        const receipt = await context.storage.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          projectId,
          coordinatorId,
          conversationId,
          kind: "multi-review",
          resourceId: `pending:${stableRequestId}`,
          requestId: stableRequestId,
          payloadHash,
          dependsOnResourceId: requiredBuildPipelineId,
          createdAt: new Date().toISOString(),
        });
        if (!receipt.claimed && !receipt.association.pending) {
          const existing = await context.storage.getMultiReviewWorkflow(
            receipt.association.resourceId,
          );
          if (!existing) throw new Error("Associated multi-review was not found");
          return existing.snapshot;
        }
        if (!receipt.claimed) {
          throw new Error("Multi-review creation is already in progress; retry this requestId");
        }
        // A process may have crashed after the workflow save and before receipt
        // completion. Reconcile that exact persisted input before creating work.
        const recovered = (
          await context.storage.listMultiReviewWorkflows(input.environmentId)
        ).find(
          (item) =>
            record(item.snapshot) &&
            typeof item.snapshot.createdAt === "string" &&
            item.snapshot.createdAt >= receipt.association.createdAt &&
            actionHash({
              input: multiReviewInputFromSnapshot(item.snapshot),
              buildPipelineId: requiredBuildPipelineId,
            }) === payloadHash,
        );
        const workflow = recovered?.snapshot ?? (await multiReviews.start(input));
        if (!record(workflow) || typeof workflow.id !== "string") {
          throw new Error("Multi-review creation returned an invalid workflow");
        }
        await context.storage.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          workflow.id,
        );
        return workflow;
      });
    },
  );
}
