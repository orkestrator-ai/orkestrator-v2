import {
  adoptCoordinatorWorkflowCommand,
  assertCoordinatorDelegationAvailableCommand,
  assignCoordinatorConversationAgentCommand,
  associateCoordinatorWorkflowCommand,
  closeCoordinatorConversationCommand,
  createCoordinatorConversationCommand,
  ensureProjectCoordinatorCommand,
  fetchProjectGitCommand,
  getCoordinatorCheckoutTurnCommand,
  getCoordinatorLaunchEnvironmentCommand,
  getProjectBaseBranchTipCommand,
  getProjectCoordinatorCommand,
  getProjectCoordinatorViewCommand,
  getProjectGitStatusCommand,
  hideCoordinatorWorkCommand,
  launchCoordinatorEnvironmentCommand,
  listCoordinatorActivityCommand,
  listCoordinatorLaunchOverridesCommand,
  openCoordinatorDelegationCommand,
  pauseProjectCoordinatorCommand,
  prepareProjectGitBranchSwitchCommand,
  resumeProjectCoordinatorCommand,
  retryCoordinatorConversationCommand,
  selectCoordinatorConversationCommand,
  startCoordinatorBuildPipelineCommand,
  startCoordinatorMultiReviewCommand,
  switchProjectGitBranchCommand,
  syncProjectGitCommand,
  verifyProjectLaunchBaseCommand,
  watchCoordinatorPullRequestCommand,
  writeCoordinatorAttachmentCommand,
} from "@orkestrator/protocol/contract/domains/coordinator";
import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
  normalizeCoordinatorDelegationRequest,
} from "@orkestrator/protocol/coordinator";
import { launchDelegationRequest } from "./coordinator-delegation-request.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { coordinatorCallerTurnOrigin } from "./coordinator-turn-origin.js";
import type { Environment } from "./models.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import { asNonBlankString } from "./commands-helpers.js";
import { isGitHubPullRequestRef } from "@orkestrator/protocol/github-pull-requests";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { localServerStopCommandName } from "./local-server-runtime.js";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import {
  coordinatorActivityByProject,
  type CoordinatorActivitySnapshot,
  type CoordinatorCheckoutTurn,
} from "@orkestrator/protocol/coordinator-activity";
import {
  coordinatorLaunchOverridesSnapshot,
  type CoordinatorLaunchOverridesSnapshot,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import { randomUUID } from "node:crypto";
import {
  isStartBuildPipelineInput,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  isStartMultiReviewInput,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { findCoordinatorCheckoutTurn } from "./coordinator-checkout-turn.js";
import { runCommand } from "./shell.js";
import { registerCoordinatorReviewActions } from "./coordinator-review-actions.js";
import { registerCoordinatorSurfaceActions } from "./coordinator-surface-actions.js";
import { registerCoordinatorWorkerTurnActions } from "./coordinator-worker-turn-actions.js";
import { registerCoordinatorPipelineStepActions } from "./coordinator-pipeline-step-actions.js";
import { registerCoordinatorGoalActions } from "./coordinator-goal-actions.js";
import { registerCoordinatorSuborkActions } from "./coordinator-subork-actions.js";
import { registerCoordinatorGraphActions } from "./coordinator-graph-actions.js";
import { registerAgentsMdCommands } from "./agents-md-commands.js";
import { registerWorkerQuestionRelayCommands } from "./worker-question-relay.js";
import {
  openWorkerDelegation,
  registerCoordinatorWorkerMailCommands,
} from "./coordinator-worker-mail.js";
import {
  buildPipelineInputWithDefaults,
  multiReviewInputWithDefaults,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import { CoordinatorViewRevisions } from "./coordinator-view-revisions.js";
import { MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS } from "./coordinator-workflow-retention.js";
import {
  actionHash,
  coordinatorLaunchIdentity,
  requireCoordinatorConversation,
} from "./coordinator-action-scope.js";
import { coordinatorBuildTicketSource } from "./build-pipeline-launch.js";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

/** The report contract a worker on this node is given with its delegation. */
export function localReportInstruction(): string {
  return (
    `${COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION}\n` +
    `The coordinator is idle while you work and is woken once, when your turn ends. Send exactly one report with send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed), then end your turn. Do not send progress updates: any message you send before your turn ends is held and delivered together with your final report.`
  );
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
  registerCoordinatorWorkerTurnActions(register, dependencies);
  registerCoordinatorPipelineStepActions(register);
  registerCoordinatorGoalActions(register, dependencies);
  registerCoordinatorSuborkActions(register, dependencies);
  registerCoordinatorGraphActions(register);
  registerAgentsMdCommands(register, dependencies);
  registerWorkerQuestionRelayCommands(register, dependencies);
  registerCoordinatorWorkerMailCommands(register, dependencies);
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
  register(
    ensureProjectCoordinatorCommand,
    async ({ projectId, keepConversationErrors }, context) => {
      if (!context.coordinators) throw new Error("Coordinator service is unavailable");
      return context.coordinators.ensure(asNonBlankString(projectId, "projectId"), {
        clearConversationErrors: keepConversationErrors !== true,
      });
    },
  );
  register(retryCoordinatorConversationCommand, ({ projectId, conversationId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.retryConversation(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(conversationId, "conversationId"),
    );
  });
  register(getProjectCoordinatorCommand, async ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.get(asNonBlankString(projectId, "projectId"));
  });
  // A coordinator conversation rendered or opened a pull request link: watch
  // it for status changes while it is open (`coordinator-pr-watches.ts`).
  // Pull requests of other repositories are answered `watched: false`.
  register(watchCoordinatorPullRequestCommand, async (args, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    const ref = { owner: args.owner, repo: args.repo, number: args.number };
    if (!isGitHubPullRequestRef(ref)) {
      throw new Error("Expected owner, repo and number to identify a GitHub pull request");
    }
    if (args.source !== "rendered" && args.source !== "opened") {
      throw new Error("Expected source to be rendered or opened");
    }
    return context.coordinators.pullRequestWatches.watch(
      asNonBlankString(args.projectId, "projectId"),
      { owner: ref.owner, repo: ref.repo, number: ref.number },
      args.source,
    );
  });
  // Conditional read for the coordinator panel: `{ projectId, knownGeneration,
  // knownRevision }` answers `unchanged` without a body while the snapshot the
  // client holds is still current. See `coordinator-view-revisions.ts`.
  const coordinatorViews = new CoordinatorViewRevisions();
  register(getProjectCoordinatorViewCommand, async (args, context) => {
    const coordinators = context.coordinators;
    if (!coordinators) throw new Error("Coordinator service is unavailable");
    const id = asNonBlankString(args.projectId, "projectId");
    return coordinatorViews.read(id, args, () => coordinators.get(id));
  });
  // Every project's coordinator activity, for the spinner on its icon. Reads
  // only the activity observer's retained answers: no provider read, bridge
  // start, attach or liveness touch, so the sidebar can re-read it freely.
  register(
    listCoordinatorActivityCommand,
    async (_args, context): Promise<CoordinatorActivitySnapshot> => {
      const nativeAgents = context.nativeAgents;
      if (!nativeAgents) return { projects: {} };
      const workspaces = await context.storage.coordinators.listCoordinatorWorkspaces();
      return {
        projects: coordinatorActivityByProject(workspaces, (workspace, session) =>
          nativeAgents.sessionActivitySnapshot(
            coordinatorRuntimeId(workspace.id, session.conversationId),
            session.agent,
            session.logicalSessionKey,
          ),
        ),
      };
    },
  );
  // The worker tabs whose launch overrode the default, for the marker on the
  // tab. Reads only the coordinator store, across every project, so one read
  // answers every tab and a project with no coordinator costs nothing and cannot
  // fail. Bounded by the store's own association limit. Workers this node's
  // coordinators launched on other nodes come back apart, by node, for their
  // tabs on those nodes' scopes in the same window (docs/architecture/coordinator.md, "Launch defaults").
  register(
    listCoordinatorLaunchOverridesCommand,
    async (_args, context): Promise<CoordinatorLaunchOverridesSnapshot> =>
      coordinatorLaunchOverridesSnapshot(
        await context.storage.coordinators.listAllCoordinatorWorkflowAssociations(),
      ),
  );
  // Which turn is holding the project's checkout, for the panel's Git controls.
  // The panel's own projections only cover the tabs it has mounted, so it has
  // to ask. No liveness touch or hydration, so it can re-read on activity hints.
  register(
    getCoordinatorCheckoutTurnCommand,
    async ({ projectId }, context): Promise<CoordinatorCheckoutTurn | null> => {
      const nativeAgents = context.nativeAgents;
      if (!nativeAgents) return null;
      return findCoordinatorCheckoutTurn(asNonBlankString(projectId, "projectId"), {
        storage: context.storage,
        nativeAgents,
        confirmWithProjections: false,
      });
    },
    // A missing project id is still a rejection, as before the definition.
    ASYNC_HANDLER,
  );
  register(
    createCoordinatorConversationCommand,
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
    assignCoordinatorConversationAgentCommand,
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
  register(selectCoordinatorConversationCommand, async ({ projectId, conversationId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.selectConversation(
      asNonBlankString(projectId, "projectId"),
      conversationId === null ? null : asNonBlankString(conversationId, "conversationId"),
    );
  });
  register(closeCoordinatorConversationCommand, async ({ projectId, conversationId }, context) => {
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
      // Retire queued prompts before anything stops the turn. A drain already
      // in progress dispatches as soon as it reads the stopped turn as idle,
      // and only a queue that is gone by then refuses it the reservation.
      await context.storage.deletePromptQueuesByEnvironment(runtimeId);
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
        // Its suborks stop with it: their answers would otherwise be redirected
        // to whichever conversation now holds the coordinator's address.
        await context.suborks?.stopForSession(sessionKey).catch(() => undefined);
        const session = await context.storage.getNativeAgentSession(sessionKey);
        if (session) {
          await context.storage.invalidateNativeAgentSession(sessionKey, session.providerSessionId);
        }
      }
      const snapshot = await context.coordinators.closeConversation(id, conversation);
      // Again, for anything queued while the close was stopping the session.
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
  // The Work panel's "Clear finished": hides rows, never removes the records.
  // Retired (plan item 7009): the panel left in v2.36.5-beta; older renderers
  // in the window still send it, so it stays until its register row retires.
  register(hideCoordinatorWorkCommand, async (args, context) => {
    compatibilityPathUsage.record("retired-command.hide-coordinator-work");
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    const id = asNonBlankString(args.projectId, "projectId");
    const ids = args.associationIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS ||
      !ids.every((item) => typeof item === "string")
    ) {
      throw new Error("Expected associationIds to be a bounded list of record ids");
    }
    await context.storage.coordinators.hideCoordinatorWork(id, new Set<string>(ids));
    return context.coordinators.get(id);
  });
  register(pauseProjectCoordinatorCommand, ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.setPaused(asNonBlankString(projectId, "projectId"), true);
  });
  register(resumeProjectCoordinatorCommand, ({ projectId }, context) => {
    if (!context.coordinators) throw new Error("Coordinator service is unavailable");
    return context.coordinators.setPaused(asNonBlankString(projectId, "projectId"), false);
  });
  register(getProjectGitStatusCommand, ({ projectId }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.status(asNonBlankString(projectId, "projectId"));
  });
  register(fetchProjectGitCommand, ({ projectId, force }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.fetch(asNonBlankString(projectId, "projectId"), force === true);
  });
  register(getProjectBaseBranchTipCommand, async ({ projectId, branch }, context) => {
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
  register(verifyProjectLaunchBaseCommand, ({ projectId, branch, commit }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.branchContainsCommit(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(branch, "branch"),
      asNonBlankString(commit, "commit"),
    );
  });
  register(syncProjectGitCommand, ({ projectId }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.sync(asNonBlankString(projectId, "projectId"));
  });
  register(prepareProjectGitBranchSwitchCommand, ({ projectId, ref }, context) => {
    if (!context.projectGit) throw new Error("Project Git service is unavailable");
    return context.projectGit.prepareSwitchBranch(
      asNonBlankString(projectId, "projectId"),
      asNonBlankString(ref, "ref"),
    );
  });
  register(
    switchProjectGitBranchCommand,
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
    writeCoordinatorAttachmentCommand,
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
    associateCoordinatorWorkflowCommand,
    // Retired (plan item 7009): no release calls it; launches record their own
    // associations. Kept, counted, until its register row retires.
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
      compatibilityPathUsage.record("retired-command.associate-coordinator-workflow");
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
    adoptCoordinatorWorkflowCommand,
    async ({ projectId, coordinatorId, conversationId, associationId }, context) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      await requireCoordinatorConversation(context, project, coordinator, conversation);
      // Backend takeover (`force`) calls the store directly and is unaffected.
      const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinator);
      if (workspace?.conversations.find((item) => item.id === conversation)?.role === "side") {
        throw new Error(
          "A side agent cannot adopt workflows: every worker reports to the main coordinator. Ask the main coordinator to adopt it.",
        );
      }
      return context.storage.coordinators.adoptCoordinatorWorkflowAssociation(
        project,
        coordinator,
        asNonBlankString(associationId, "associationId"),
        conversation,
      );
    },
  );
  register(
    launchCoordinatorEnvironmentCommand,
    async ({ scope, requestId, input, agentDefaulted }, context) => {
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
      const payloadHash = actionHash(coordinatorLaunchIdentity(input, agentDefaulted));
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
            replayed: true,
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
                  instruction: localReportInstruction(),
                  turnOrigin: await coordinatorCallerTurnOrigin(
                    context,
                    { coordinatorId, conversationId },
                    scope,
                  ),
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
          : (createdEnvironment as unknown as Environment);
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
              context.runtime.coordinatorRequests.workerTabs,
              receipt.association.id,
              STARTUP_AGENT_TAB_ID,
              undefined,
              launchDelegationRequest(input, environment),
            ),
          );
        }
        return {
          environment,
          coordinatorDelegationOpened,
          ...(startError ? { startError } : {}),
        };
      });
    },
  );
  register(getCoordinatorLaunchEnvironmentCommand, async ({ scope, requestId }, context) => {
    if (!record(scope)) throw new Error("Coordinator scope is required");
    const projectId = asNonBlankString(scope.projectId, "projectId");
    const coordinatorId = asNonBlankString(scope.coordinatorId, "coordinatorId");
    const conversationId = asNonBlankString(scope.conversationId, "conversationId");
    await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
    const association = (
      await context.storage.coordinators.listCoordinatorWorkflowAssociations(projectId)
    ).find(
      (item) =>
        item.coordinatorId === coordinatorId &&
        item.conversationId === conversationId &&
        item.requestId === requestId &&
        item.nodeId === undefined &&
        item.kind === "environment" &&
        !item.pending,
    );
    if (!association) return null;
    return context.storage.getEnvironment(association.resourceId);
  });
  register(
    assertCoordinatorDelegationAvailableCommand,
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
    openCoordinatorDelegationCommand,
    async ({ scope, environmentId, tabId, requestId, request }, context) => {
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
        normalizeCoordinatorDelegationRequest(request),
      );
      return { opened };
    },
  );
  register(startCoordinatorBuildPipelineCommand, async ({ scope, requestId, input }, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    const buildPipelines = context.buildPipelines;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      throw new Error("Coordinator scope is required");
    }
    const identity = scope as Record<string, unknown>;
    const projectId = asNonBlankString(identity.projectId, "projectId");
    const coordinatorId = asNonBlankString(identity.coordinatorId, "coordinatorId");
    const conversationId = asNonBlankString(identity.conversationId, "conversationId");
    const stableRequestId = asNonBlankString(requestId, "requestId");
    if (!record(input) || input.projectId !== projectId) {
      throw new Error("Invalid scoped build pipeline request");
    }
    const requestedInput = input;
    return runWorkflowStart(
      `${projectId}\0${coordinatorId}\0${conversationId}\0build\0${stableRequestId}\0${actionHash(input)}`,
      async () => {
        await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
        // Choices the coordinator left out run the Build button's saved defaults.
        // The request hash below stays over the caller's payload, so a retry after
        // the user edits their defaults still replays the original pipeline.
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
        // Linked like a Build button launch, so the run reports back to its ticket.
        const source = await coordinatorBuildTicketSource(context.storage, projectId, input.taskId);
        if (input.existingEnvironmentId) {
          const environment = await context.storage.getEnvironment(input.existingEnvironmentId);
          if (
            !environment ||
            environment.projectId !== projectId ||
            environment.createdFromCommit?.toLowerCase() !==
              input.delegationBaseCommit.toLowerCase()
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

        const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          projectId,
          coordinatorId,
          conversationId,
          kind: "build-pipeline",
          resourceId: `pending:${stableRequestId}`,
          createsEnvironment: !input.existingEnvironmentId,
          requestId: stableRequestId,
          payloadHash,
          baseBranch: input.delegationBaseBranch,
          baseCommit: input.delegationBaseCommit,
          createdAt: new Date().toISOString(),
        });
        if (!receipt.claimed && !receipt.association.pending) {
          const existing = await context.storage.getBuildPipeline(receipt.association.resourceId);
          if (!existing) throw new Error("Associated build pipeline was not found");
          return { ...(existing.snapshot as BuildPipeline), replayed: true };
        }
        if (!receipt.claimed) {
          throw new Error("Build pipeline creation is already in progress; retry this requestId");
        }
        // BuildPipelineService has its own durable admission key, so reclaiming a
        // reservation after a crash returns the already-created workflow.
        const workflow = await buildPipelines.start({ ...input, source }, receipt.association.id);
        if (
          !input.existingEnvironmentId &&
          workflow.coordinatorLaunchId !== receipt.association.id
        ) {
          await context.storage.coordinators.releasePendingCoordinatorWorkflowAssociation(
            receipt.association.id,
          );
          throw new Error(
            "Build admission belongs to another caller; no creation authority granted",
          );
        }
        await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          workflow.id,
          input.existingEnvironmentId ? undefined : workflow.environmentId,
        );
        return workflow;
      },
    );
  });
  register(
    startCoordinatorMultiReviewCommand,
    // Retired (plan item 7009): Control MCP's `launch_multi_review` moved to
    // `launch_coordinator_multi_review_action` in v2.36.4-beta. Kept, counted,
    // until its register row retires.
    async ({ scope, requestId, input, buildPipelineId }, context) => {
      compatibilityPathUsage.record("retired-command.start-coordinator-multi-review");
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
          return existing.snapshot as MultiReviewWorkflow;
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
          return recovered.snapshot as MultiReviewWorkflow;
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
        return workflow as MultiReviewWorkflow;
      });
    },
  );
}
