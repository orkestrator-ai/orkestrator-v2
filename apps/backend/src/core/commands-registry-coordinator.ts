import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { localServerStopCommandName } from "./local-server-runtime.js";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { randomUUID } from "node:crypto";
import { isStartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { isStartMultiReviewInput } from "@orkestrator/protocol/multi-review";
import { runCommand } from "./shell.js";
import { registerCoordinatorReviewActions } from "./coordinator-review-actions.js";
import { registerCoordinatorSurfaceActions } from "./coordinator-surface-actions.js";
import { registerCoordinatorGoalActions } from "./coordinator-goal-actions.js";
import { registerCoordinatorGraphActions } from "./coordinator-graph-actions.js";
import { registerAgentsMdCommands } from "./agents-md-commands.js";
import {
  buildPipelineInputWithDefaults,
  multiReviewInputWithDefaults,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import { CoordinatorViewRevisions } from "./coordinator-view-revisions.js";
import {
  coordinatorDeliverNowResult,
  settleCoordinatorDeliverNow,
} from "./coordinator-deliver-now.js";
import { actionHash, requireCoordinatorConversation } from "./coordinator-action-scope.js";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open the delegation that makes a coordinator wait for one worker answer.
 *
 * Every way a coordinator can ask a worker for something funnels through here —
 * a launch, a job, a follow-up message — because the wake contract is per
 * request, not per launch: a coordinator that reads a report and replies has
 * asked a new question and earns exactly one more wake for it.
 *
 * Each request owns its own association. Reusing an environment-wide record
 * would overwrite another tab's outstanding wake; reusing the same request id
 * is still idempotent through the storage layer.
 */
async function openWorkerDelegation(
  context: CommandContext,
  scope: { projectId: string; coordinatorId: string; conversationId: string },
  workerEnvironmentId: string,
  workerTabId: string,
  requestId: string,
): Promise<boolean> {
  const association = await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: workerEnvironmentId,
    requestId: `delegation:${requestId}`,
    createdAt: new Date().toISOString(),
  });
  if (
    association.conversationId !== scope.conversationId ||
    association.resourceId !== workerEnvironmentId
  ) {
    throw new Error("Coordinator request id was reused with a different delegation target");
  }
  const opened = await context.storage.coordinators.openCoordinatorDelegation(
    association.id,
    workerTabId,
  );
  if (!opened) throw new Error("Coordinator delegation association was not found");
  return opened.delegation?.state === "running";
}

async function assertWorkerDelegationAvailable(
  context: CommandContext,
  scope: { projectId: string; coordinatorId: string; conversationId: string },
  workerEnvironmentId: string,
  workerTabId: string,
  requestId: string,
): Promise<void> {
  const idempotencyKey = `delegation:${requestId}`;
  const overlapping = (await context.storage.coordinators.listOpenCoordinatorDelegations()).find(
    (association) =>
      association.coordinatorId === scope.coordinatorId &&
      association.conversationId === scope.conversationId &&
      association.kind === "environment" &&
      association.nodeId === undefined &&
      association.resourceId === workerEnvironmentId &&
      association.delegation?.workerTabId === workerTabId &&
      association.requestId !== idempotencyKey,
  );
  if (overlapping) {
    throw new Error("That worker tab already has an outstanding coordinator delegation");
  }
}

export async function assertContainerDelegationCommitPublished(
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
  registerCoordinatorReviewActions(register, dependencies);
  registerCoordinatorSurfaceActions(register, dependencies);
  registerCoordinatorGoalActions(register, dependencies);
  registerCoordinatorGraphActions(register);
  registerAgentsMdCommands(register, dependencies);
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
  // Conditional read for the coordinator panel: `{ projectId, knownGeneration,
  // knownRevision }` answers `unchanged` without a body while the snapshot the
  // client holds is still current. See `coordinator-view-revisions.ts`.
  const coordinatorViews = new CoordinatorViewRevisions();
  register("get_project_coordinator_view", async (args, context) => {
    const coordinators = context.coordinators;
    if (!coordinators) throw new Error("Coordinator service is unavailable");
    const id = asNonBlankString(args.projectId, "projectId");
    return coordinatorViews.read(id, args, () => coordinators.get(id));
  });
  register(
    "create_coordinator_conversation",
    async ({ projectId, title, closeUnused }, context) => {
      if (!context.coordinators) throw new Error("Coordinator service is unavailable");
      return context.coordinators.createConversation(
        asNonBlankString(projectId, "projectId"),
        typeof title === "string" ? title : undefined,
        {
          closeUnused: Array.isArray(closeUnused)
            ? closeUnused
                .filter((id): id is string => typeof id === "string" && id.length > 0)
                .slice(0, 64)
            : [],
        },
      );
    },
  );
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
    const runtimeId = coordinatorRuntimeId(current.workspace.id, item.id);
    const releaseOwner = context.userCommands?.beginOwnerClose?.(runtimeId);
    try {
      await context.userCommands?.terminateForEnvironment(runtimeId);
      context.humanPrompts?.clearEnvironment(runtimeId);
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
      await context.storage.deletePromptQueuesByEnvironment(runtimeId);
      await context.storage.synchronizeAgentMailboxes();
      // A side agent's schedules end with it; the main's move to the next main.
      if (item.role === "side") {
        context.scheduledJobs?.coordinatorConversationClosed(current.workspace.id, conversation);
      }
      context.humanPrompts?.clearEnvironment(runtimeId);
      return snapshot;
    } finally {
      releaseOwner?.();
    }
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
  register("get_project_base_branch_tip", async ({ projectId, branch }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    const project = asNonBlankString(projectId, "projectId");
    // A named branch (a scheduled launch resolving its base at fire time), else
    // the same default a normal environment launch branches from.
    if (typeof branch === "string" && branch.trim()) {
      return context.projectGit.baseBranchTip(project, branch.trim());
    }
    const { defaultBranch } = await context.storage.getRepositoryConfig(project);
    return context.projectGit.baseBranchTip(project, defaultBranch?.trim() || "main");
  });
  register("verify_project_launch_base", ({ projectId, branch, commit }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.branchContainsCommit(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(branch, "branch"),
      asNonBlankString(commit, "commit"),
    );
  });
  register("sync_project_git", ({ projectId }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.sync(asNonBlankString(projectId, "projectId"));
  });
  register("prepare_project_git_branch_switch", ({ projectId, ref }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.prepareSwitchBranch(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(ref, "ref"),
    );
  });
  register(
    "switch_project_git_branch",
    ({ projectId, ref, confirmationToken, includeNestedRepositories }, context) => {
      if (!context.projectGit) throw new Error("Project Git service is unavailable");
      return context.projectGit.switchBranch(
        asNonBlankString(projectId, "projectId"),
        asNonBlankString(ref, "ref"),
        {
          ...(typeof confirmationToken === "string" && confirmationToken
            ? { confirmationToken }
            : {}),
          includeNestedRepositories: includeNestedRepositories === true,
        },
      );
    },
  );
  register(
    "write_coordinator_attachment",
    async ({ environmentId, filename, base64Data }, context) => {
      const runtimeId = asNonBlankString(environmentId, "environmentId");
      const coordinatorId = coordinatorIdFromRuntimeId(runtimeId);
      const conversationId = coordinatorConversationIdFromRuntimeId(runtimeId);
      if (!coordinatorId || !conversationId) {
        throw new Error("Coordinator runtime identity is required");
      }
      return context.storage.coordinators.writeCoordinatorAttachment(
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
        deliverNow,
      },
      context,
    ) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      const steer = deliverNow === true;
      const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinator);
      if (!workspace || workspace.projectId !== project || workspace.lifecycleState !== "ready") {
        throw new Error("Coordinator identity is unavailable");
      }
      const tab = workspace.conversations.find(
        (item) => item.id === conversation && !item.closedAt,
      );
      if (!tab) throw new Error("Coordinator conversation is unavailable");
      const sender = {
        kind: "coordinator" as const,
        projectId: project,
        coordinatorId: coordinator,
        conversationId: conversation,
        environmentId: coordinatorRuntimeId(coordinator, conversation),
        tabId: tab.tabId,
      };
      const stableRequestId = asNonBlankString(requestId, "requestId");
      const target = asNonBlankString(toEnvironmentId, "toEnvironmentId");
      // Main ↔ side agent mail. Not a delegation: nothing to wait on, and the
      // mail store decides which of the two may talk to which.
      if (
        target === COORDINATOR_MAIL_ADDRESS ||
        coordinatorIdFromRuntimeId(target) === coordinator
      ) {
        const message = await context.storage.sendAgentMail(sender, {
          requestId: stableRequestId,
          toEnvironmentId: target,
          toTabId: typeof toTabId === "string" ? toTabId : "",
          body: asNonBlankString(body, "body"),
          ...(typeof subject === "string" ? { subject } : {}),
          ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
        });
        return {
          ...message,
          coordinatorDelegationOpened: false,
          // A coordinator conversation is never steered: a side agent must not
          // cut into the main's turn with the user, nor the main into a side's.
          ...(steer ? coordinatorDeliverNowResult(message) : {}),
        };
      }
      if (tab.role === "side") {
        throw new Error(
          'A side agent can only message the main coordinator. Send to "coordinator".',
        );
      }
      const destination = await context.storage.getEnvironment(target);
      if (!destination || destination.projectId !== project) {
        throw new Error("Coordinator messages must stay within their project");
      }
      const requestedTabId = typeof toTabId === "string" ? toTabId.trim() : "";
      const admit = <T>(work: () => Promise<T>) =>
        context.storage.withAgentMailWorkerAdmission(destination.id, work);
      const admitted = await admit(async () => {
        // A follow-up to a worker that is still on an earlier request joins
        // that delegation rather than opening a second one. The open delegation
        // does not close while this message is undelivered, so the worker reads
        // it in its next turn and the coordinator is woken once, after both.
        const joining = (await context.storage.coordinators.listOpenCoordinatorDelegations()).find(
          (association) =>
            association.coordinatorId === coordinator &&
            association.kind === "environment" &&
            association.nodeId === undefined &&
            association.resourceId === destination.id &&
            (!requestedTabId || association.delegation?.workerTabId === requestedTabId) &&
            association.requestId !== `delegation:${stableRequestId}`,
        );
        const message = await context.storage.sendAgentMail(
          sender,
          {
            requestId: stableRequestId,
            toEnvironmentId: destination.id,
            toTabId: requestedTabId,
            body: asNonBlankString(body, "body"),
            ...(typeof subject === "string" ? { subject } : {}),
            ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
          },
          { newDelegation: !joining, steer },
        );
        const destinationTabId = message.toTabId;
        // Asking a worker something is a delegation, so the coordinator is woken
        // once when that worker's turn ends rather than on whatever it says
        // along the way. A message the recipient bounced or that was never
        // scheduled for delivery has asked nothing and opens nothing.
        let coordinatorDelegationOpened = false;
        if (message.placement === "pending-inject" && joining) {
          coordinatorDelegationOpened = true;
        } else if (message.placement === "pending-inject") {
          try {
            coordinatorDelegationOpened = await openWorkerDelegation(
              context,
              { projectId: project, coordinatorId: coordinator, conversationId: conversation },
              destination.id,
              destinationTabId,
              stableRequestId,
            );
          } catch (error) {
            console.warn(
              "[coordinator] Failed to open a delegation for an outbound message:",
              error instanceof Error ? error.message : error,
            );
          }
        }
        // Say plainly when the worker cannot read it yet: "pending" alone reads
        // as delivered to a coordinator deciding whether to wait.
        const recipientMailbox =
          destination.status === "stopped"
            ? await context.storage.getAgentMailMailbox(destination.id, destinationTabId)
            : null;
        const autoStarts =
          destination.environmentType === "local" &&
          recipientMailbox?.descriptor.coordinatorOrigin === sender.environmentId;
        const deliveryNote =
          destination.status !== "stopped"
            ? undefined
            : autoStarts
              ? "The worker's environment is stopped. Orkestrator will attempt to start it once; the message is delivered once it is running."
              : "The recipient environment is stopped and is not started automatically. Call start_environment to deliver this message, or ask the user.";
        return {
          ...message,
          coordinatorDelegationOpened,
          ...(deliveryNote ? { deliveryNote } : {}),
        };
      });
      // Outside the admission lock: the delivery pass may need it.
      if (!steer) return admitted;
      return {
        ...(await settleCoordinatorDeliverNow(context, admitted)),
        coordinatorDelegationOpened: admitted.coordinatorDelegationOpened,
        ...(admitted.deliveryNote ? { deliveryNote: admitted.deliveryNote } : {}),
      };
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
      const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinator);
      if (!workspace || workspace.projectId !== project) throw new Error("Coordinator not found");
      if (
        kind !== "environment" &&
        kind !== "build-pipeline" &&
        kind !== "multi-review" &&
        kind !== "graph-run"
      ) {
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
      return context.storage.coordinators.saveCoordinatorWorkflowAssociation(association);
    },
  );
  register(
    "adopt_coordinator_workflow",
    async ({ projectId, coordinatorId, conversationId, associationId }, context) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      await requireCoordinatorConversation(context, project, coordinator, conversation);
      return context.storage.coordinators.adoptCoordinatorWorkflowAssociation(
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
      const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
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
        return {
          environment,
          coordinatorDelegationOpened: receipt.association.delegation?.state === "running",
        };
      }
      if (!receipt.claimed) {
        throw new Error("Environment creation is already in progress; retry this requestId");
      }
      const delegation =
        typeof input.initialPrompt === "string"
          ? createCoordinatorDelegatedPrompt(
              {
                projectId,
                coordinatorId,
                conversationId,
                baseBranch: delegationBaseBranch,
                baseCommit: delegationBaseCommit,
                instruction:
                  `${COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION}\n` +
                  `The coordinator is idle while you work and is woken once, when your turn ends. Send exactly one report with send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed), then end your turn. Do not send progress updates: any message you send before your turn ends is held and delivered together with your final report.`,
              },
              input.initialPrompt,
            )
          : null;
      const createdEnvironment = await dependencies.commands.get("create_environment")?.(
        {
          ...input,
          initialPrompt: delegation?.source ?? input.initialPrompt,
          controlRequestId: stableRequestId,
        },
        context,
      );
      if (!record(createdEnvironment) || typeof createdEnvironment.id !== "string") {
        throw new Error("Environment creation returned no environment");
      }
      const environmentId = createdEnvironment.id;
      const environment = delegation
        ? await context.storage.updateEnvironment(environmentId, {
            initialPromptPresentation: {
              kind: COORDINATOR_DELEGATION_PRESENTATION,
              frame: delegation.frame,
            },
          })
        : createdEnvironment;
      await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
        receipt.association.id,
        environmentId,
      );
      let startError: string | undefined;
      if (environment.status !== "running" && environment.status !== "creating") {
        try {
          await dependencies.commands.get("start_environment_background")?.(
            { environmentId },
            context,
          );
        } catch (error) {
          startError = error instanceof Error ? error.message : "Environment start failed";
        }
      }
      let coordinatorDelegationOpened = false;
      if (!startError) {
        // The worker owes this conversation exactly one answer only after it
        // was successfully started. A failed start must not promise a wake.
        coordinatorDelegationOpened = Boolean(
          await context.storage.coordinators.openCoordinatorDelegation(
            receipt.association.id,
            "startup-agent",
          ),
        );
      }
      return {
        environment,
        coordinatorDelegationOpened,
        ...(startError ? { startError } : {}),
      };
    });
  });
  register(
    "assert_coordinator_delegation_available",
    async ({ scope, environmentId, tabId, requestId }, context) => {
      if (!record(scope)) throw new Error("Coordinator scope is required");
      const projectId = asNonBlankString(scope.projectId, "projectId");
      const coordinatorId = asNonBlankString(scope.coordinatorId, "coordinatorId");
      const conversationId = asNonBlankString(scope.conversationId, "conversationId");
      await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
      const worker = asNonBlankString(environmentId, "environmentId");
      const environment = await context.storage.getEnvironment(worker);
      if (!environment || environment.projectId !== projectId) {
        throw new Error("Coordinator delegations must stay within their project");
      }
      await assertWorkerDelegationAvailable(
        context,
        { projectId, coordinatorId, conversationId },
        worker,
        asNonBlankString(tabId, "tabId"),
        asNonBlankString(requestId, "requestId"),
      );
      return { available: true };
    },
  );
  register(
    "open_coordinator_delegation",
    async ({ scope, environmentId, tabId, requestId }, context) => {
      if (!record(scope)) throw new Error("Coordinator scope is required");
      const projectId = asNonBlankString(scope.projectId, "projectId");
      const coordinatorId = asNonBlankString(scope.coordinatorId, "coordinatorId");
      const conversationId = asNonBlankString(scope.conversationId, "conversationId");
      await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
      const worker = asNonBlankString(environmentId, "environmentId");
      const environment = await context.storage.getEnvironment(worker);
      if (!environment || environment.projectId !== projectId) {
        throw new Error("Coordinator delegations must stay within their project");
      }
      const opened = await openWorkerDelegation(
        context,
        { projectId, coordinatorId, conversationId },
        worker,
        asNonBlankString(tabId, "tabId"),
        asNonBlankString(requestId, "requestId"),
      );
      return { opened };
    },
  );
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
    if (!record(input) || input.projectId !== projectId) {
      throw new Error("Invalid scoped build pipeline request");
    }
    // Choices the coordinator left out run the Build button's saved defaults.
    // The request hash below stays over the caller's payload, so a retry after
    // the user edits their defaults still replays the original pipeline.
    const requestedInput = input;
    input = buildPipelineInputWithDefaults(
      requestedInput,
      savedLaunchSettings(await context.storage.loadConfig(), projectId),
    );
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
    const payloadHash = actionHash(requestedInput);
    return runWorkflowStart(`${coordinatorId}\0${stableRequestId}`, async () => {
      const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
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
      await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
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
      if (!record(input) || input.projectId !== projectId) {
        throw new Error("Invalid scoped multi-review request");
      }
      // Omitted model rows and auto-actions run the saved Multi Review defaults.
      const requestedInput = input;
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
      const payloadHash = actionHash({
        input: requestedInput,
        buildPipelineId: requiredBuildPipelineId,
      });
      return runWorkflowStart(`${coordinatorId}\0${stableRequestId}`, async () => {
        const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          projectId,
          coordinatorId,
          conversationId,
          kind: "multi-review",
          resourceId: randomUUID(),
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
        // The pending receipt reserves the workflow identity before any launch I/O.
        // Recover by that identity even when defaults changed or the workflow finished.
        if (receipt.association.resourceId.startsWith("pending:")) {
          throw new Error(
            "Legacy Multi Review reservation has no workflow identity; reconcile the existing review before starting more work",
          );
        }
        const recovered = await context.storage.getMultiReviewWorkflow(
          receipt.association.resourceId,
        );
        if (recovered) {
          await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
            receipt.association.id,
            receipt.association.resourceId,
          );
          return recovered.snapshot;
        }
        const environment =
          typeof requestedInput.environmentId === "string"
            ? await context.storage.getEnvironment(requestedInput.environmentId)
            : null;
        input = await multiReviewInputWithDefaults(
          requestedInput,
          savedLaunchSettings(
            await context.storage.loadConfig(),
            projectId,
            environment?.projectId === projectId ? environment : undefined,
          ),
          () =>
            readLaunchModelCatalog(
              dependencies.commands.get("get_native_agent_model_catalog"),
              String(requestedInput.environmentId),
              context,
            ),
        );
        if (!isStartMultiReviewInput(input) || input.projectId !== projectId) {
          throw new Error("Invalid scoped multi-review request");
        }
        const workflow = await multiReviews.start(input, receipt.association.resourceId);
        if (!record(workflow) || typeof workflow.id !== "string") {
          throw new Error("Multi-review creation returned an invalid workflow");
        }
        await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          workflow.id,
        );
        return workflow;
      });
    },
  );
}
