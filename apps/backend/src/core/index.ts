import { createCodexLoginRefresher } from "./codex-host-login-refresh.js";
import { coordinatorNodeContext } from "./nodes/node-context.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  bridgeRemoteCoordinatorEvents,
  NodeCoordinatorRemote,
} from "./nodes/node-coordinator-remote.js";
import { NodePortal } from "./nodes/node-portal.js";
import type { GatewayNodeHooks } from "../gateway-support-core.js";
import { pickInheritedGlobalSettings } from "@orkestrator/protocol/controller-settings";
import { NodeService, errorCode, type NodeServiceOptions } from "./nodes/node-service.js";
import { createNodeSshFactory } from "./nodes/node-ssh.js";
import type { NodeMode } from "@orkestrator/protocol/command-nodes";
import { stoppedWorkerMailHook } from "./agent-mail-stopped-worker.js";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import { setGitHubCliConfigSource } from "./github-credentials.js";
import { resolveManagedBinary } from "./commands-agent-support.js";
import { closeEnvironmentCleanupStorage } from "./environment-cleanup-ledger.js";
import {
  compatibilityPathUsage,
  type CompatibilityPathUsageSink,
} from "./compatibility-path-usage.js";
import { compatibilityPathUsageDatabaseSink } from "./compatibility-path-usage-store.js";
import { multiReviewNativeFixOptions } from "./multi-review-native-fix.js";
import { cleanupStaleManifestProbes } from "./docker-image.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import { openRegistryWriter } from "./registry-writer-lease.js";
import { shutdownContainerLogService } from "./container-log-service.js";
import { shutdownOomEventWatcher, startOomEventWatcher } from "./container-oom-events.js";
import { reconcileContainerOperations } from "./container-lifecycle-service.js";
import { DesignService } from "./design/index.js";
import { PreviewRuntime } from "./preview-runtime.js";
import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { WorkAdmissionPool } from "./work-admission.js";
import {
  keyedSchedulingEnabled,
  type KeyedWorkflowOwner,
  type WorkflowWakeReason,
} from "./workflow-supervisor.js";
import { BackendActivityJobs, type BackendActivityJob } from "./backend-activity-jobs.js";
import { HostSuspendDetector } from "./host-suspend-detector.js";
import { ContainerClaudeLoginKeeper } from "./container-claude-login-keeper.js";
import { refreshHostClaudeLogin } from "./claude-host-login-refresh.js";
import { setHostClaudeLoginRefresher } from "./agent-accounts-containers.js";
import {
  setLocalClaudeLoginRefresher,
  setLocalCodexLoginRefresher,
} from "./agent-accounts-active.js";
import { recurringDiagnosticsRegistry } from "./recurring-diagnostics.js";

/** Former activity-bundle cadence, per named job. */
const ACTIVITY_JOB_MS = 2_000;
/** Elapsed maintenance deadline (coordinator repair, retention, tab cleanup). */
const MAINTENANCE_JOB_MS = 60_000;
/** Safety cadence for rename intent when none is pending. */
const RENAME_SAFETY_MS = 30_000;
import { WebAnnotationService } from "./web-annotation-service.js";
import { WebAnnotationRollout } from "./web-annotation-rollout.js";
import { WebAnnotationDispatchAdapter } from "./web-annotation-dispatch.js";
import {
  compileWebAnnotationBrief,
  composeWebAnnotationDispatchText,
} from "./web-annotation-brief.js";
import type { WebAnnotationToolHost } from "./web-annotation-contracts.js";
import type { ProvisionalFindingSink } from "./review-provisional-findings.js";
import {
  createMcpRuntimeProbe,
  mcpRolloutLoader,
  mcpContainerOptions,
} from "./commands-registry-mcp.js";
import { McpManagementService } from "./mcp-management/service.js";
import {
  createCommandRegistry,
  shutdownPrMonitorTracking,
  type BackendEmit,
  type CommandContext,
} from "./commands.js";
import { reapOrphanedClaudeTmuxRuntimes, reapOrphanedLocalServers } from "./local-server-reaper.js";
import {
  coordinatorBridgeEnvironmentFields,
  coordinatorBridgeIdentityFromEnvironment,
} from "./commands-local-server-lifecycle.js";
import { claudeTmuxRuntimeRootPrefix } from "./tmux.js";
import { StorageService } from "./storage.js";
import { BackendRuntime } from "./backend-runtime.js";
import { containerWorktreeSignalInstaller } from "./container-worktree-signal-install.js";
import { AgentToolsServer } from "./agent-tools.js";
import type { TranscriptArtifactService } from "./transcript-artifacts/service.js";
import type { TranscriptArtifactRuntime } from "./transcript-artifacts/runtime.js";
import {
  attachTranscriptArtifactRuntime,
  createTranscriptArtifactService,
} from "./transcript-artifacts/runtime-wiring.js";
import type { TranscriptArtifactToolHost } from "./transcript-artifacts/tools.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";
import { ContainerHostReachabilityService } from "./container-host-reachability.js";
import {
  ensureContainerAgentToolsHost,
  ensureContainerHostServicePorts,
} from "./commands-environment.js";
import { APP_VERSION, DOCKER_IMAGE } from "./constants.js";
import type { BackendProfile } from "@orkestrator/protocol/backend-profile";
import { WorkflowResultService } from "./workflow-result-service.js";
import { HostMaintenanceService } from "./host-maintenance.js";
import { readImageStatus, readRestartImpact, readToolStatus } from "./host-maintenance-readers.js";
import { applyGhChannel, fetchReleasePins } from "./host-maintenance-tasks.js";
import { WorkflowResultRollout } from "./workflow-result-rollout.js";
import {
  ControlMcpServer,
  type ControlMcpInfo,
  type ControlMcpSettings,
} from "./control-mcp-server.js";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { FRONTEND_AGENT_ACTIVITY_LEASE_MS } from "@orkestrator/protocol/agent-activity";
import { BuildPipelineService } from "./build-pipeline-service.js";
import {
  isAgentTurnEndTransition,
  nativeAgentSessionStorageKey,
  NativeAgentService,
} from "./native-agent-service.js";
import { LoopedReviewService } from "./looped-review-service.js";
import {
  dispatchMultiReviewAddressPrompt,
  recoverMissingMultiReviewFixSession,
} from "./multi-review-address-dispatch.js";
import { MultiReviewService } from "./multi-review-service.js";
import { FeaturePlanningService } from "./feature-planning.js";
import { PromptQueueDrainer } from "./prompt-queue-drainer.js";
import { AgentRegistry } from "./agent-registry.js";
import { tmuxManager } from "./tmux-session-manager.js";
import { AgentMailService } from "./agent-mail-service.js";
import { CoordinatorService } from "./coordinator-service.js";
import { lastAssistantText } from "./coordinator-status-wakes.js";
import { coordinatorProviderQualification } from "./coordinator-providers.js";
import { ProjectGitService } from "./project-git-service.js";
import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { Environment } from "./models.js";
import {
  ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";
import { recoverInterruptedEnvironmentMoves } from "./environment-move.js";
import { createBackendChangeTracking } from "./change-tracking/backend-wiring.js";
import {
  configureTerminalHistoryRetention,
  flushTerminalHistories,
  pruneTerminalHistoryStorage,
} from "./terminal-history.js";
import {
  cancelScheduledEnvironmentCleanup,
  runStartupEnvironmentCleanup,
} from "./environment-cleanup-reconciler.js";

/**
 * One observed attempt of an activity-sweep step that has no overlap guard of
 * its own. A synchronous throw still escapes exactly as it did unobserved.
 */
function observeSweepStep(kind: RecurringJobKind, run: () => unknown): Promise<unknown> {
  recurringWorkMetrics.requested(kind);
  return recurringWorkMetrics.observe(kind, () => Promise.resolve(run()));
}

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private readonly buildPipelines: BuildPipelineService;
  private readonly nativeAgents: NativeAgentService;
  private readonly loopedReviews: LoopedReviewService;
  private readonly multiReviews: MultiReviewService;
  private readonly featurePlanning: FeaturePlanningService;
  private readonly coordinators: CoordinatorService;
  /** Command-node registry and leaf attachments. */
  readonly nodes: NodeService;
  readonly nodePortal: NodePortal;
  readonly nodeCoordination: NodeCoordination;
  /** Origins clients load this node's UI from; registered on attached leaves. */
  private portalOriginsSource: () => string[] = () => [];
  /** How another node reaches this one, for handing it to a new command node. */
  private selfAccessSource: () => Promise<{ token: string | null; origins: string[] }> =
    async () => ({ token: null, origins: [] });
  private readonly projectGit: ProjectGitService;
  private readonly promptQueues: PromptQueueDrainer;
  private readonly agentMail: AgentMailService;
  private readonly environmentLifecycleTasks: EnvironmentLifecycleTaskTracker;
  private readonly runtime: BackendRuntime;
  private readonly environmentLifecycleDrainTimeoutMs: number;
  private readonly workflowResults: WorkflowResultService;
  /** Remote-initiated updates of this host; see host-maintenance.ts. */
  readonly hostMaintenance: HostMaintenanceService;
  /** Persists compatibility-path usage; see compatibility-path-usage.ts. */
  private readonly compatibilityPathSink: CompatibilityPathUsageSink;
  /** Absent in `bun test` backends unless injected: probing runs real Docker commands. */
  private readonly containerHostReachability: ContainerHostReachabilityService | undefined;
  private readonly workflowResultRollout: WorkflowResultRollout;
  /**
   * Bounded `workflow-provider` admission shared by every keyed workflow
   * owner (step 08): a pass holds one slot for its environment while it
   * reads providers, so many active workflows cannot all hit providers at once.
   */
  private readonly workflowAdmission = new WorkAdmissionPool({ name: "workflow-provider" });
  private readonly webAnnotations: WebAnnotationService;
  private readonly webAnnotationRollout: WebAnnotationRollout;
  /** Durable transcript artifacts (revisions, receipts, publications). */
  readonly transcriptArtifacts: TranscriptArtifactService;
  private transcriptArtifactRuntime: TranscriptArtifactRuntime | null = null;
  private readonly transcriptArtifactRuntimeEnabled: boolean;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activityLeaseSweep: ReturnType<typeof setInterval> | null = null;
  private hostSuspendDetector: HostSuspendDetector | null = null;
  private claudeLoginKeeper: ContainerClaudeLoginKeeper | null = null;
  private nativeActivitySweep: ReturnType<typeof setInterval> | null = null;
  private tabResourceSweep: ReturnType<typeof setInterval> | null = null;
  /** Step 08 named due jobs; `null` on the rollback bundle. Never both. */
  private activityJobs: BackendActivityJobs | null = null;
  private readonly keyedActivityJobs: boolean;
  private readonly activityJobClock:
    | { now: () => number; timers: import("./recurring-scheduler.js").RecurringTimerFactory }
    | undefined;
  private setupStartupReconciled = false;
  private terminalStartupReconciled = false;
  private readonly reapPidServers: typeof reapOrphanedLocalServers;
  private readonly reapTmuxRuntimes: typeof reapOrphanedClaudeTmuxRuntimes;
  private readonly agentTools: Pick<
    AgentToolsServer,
    "connection" | "revokeEnvironment" | "start" | "stop"
  > &
    Partial<
      Pick<
        AgentToolsServer,
        | "revokeTab"
        | "workflowResultConnection"
        | "servicePort"
        | "issueStateSignal"
        | "issueWorktreeSignal"
      >
    >;
  private readonly controlMcp: Pick<
    ControlMcpServer,
    | "getInfo"
    | "getSettings"
    | "rotateToken"
    | "createCredential"
    | "rotateCredential"
    | "revokeCredential"
    | "issueCoordinatorCredential"
    | "revokeCoordinatorCredentials"
    | "start"
    | "stop"
  >;

  constructor(options: {
    dataDir: string;
    toolchainBinDir: string;
    appRoot: string;
    resourceRoot: string;
    runtimeFlavor?: "production" | "development" | "agent-test";
    worktreeDir?: string;
    dockerImage?: string;
    strictDockerOwner?: boolean;
    credentialSources?: import("@orkestrator/protocol/agent-platforms").AgentPlatform[];
    emit: BackendEmit;
    /** What applies remote update requests on this host (default: nothing). */
    hostUpdater?: import("@orkestrator/protocol/host-maintenance").HostUpdaterKind;
    /** The standalone launcher's record of a release it rolled back. */
    hostRollbackEvidence?: () => import("./host-maintenance.js").HostRollbackEvidence | null;
    startupReapers?: {
      localServers?: typeof reapOrphanedLocalServers;
      claudeTmuxRuntimes?: typeof reapOrphanedClaudeTmuxRuntimes;
    };
    agentTools?: Pick<AgentToolsServer, "connection" | "revokeEnvironment" | "start" | "stop"> &
      Partial<
        Pick<
          AgentToolsServer,
          | "revokeTab"
          | "workflowResultConnection"
          | "servicePort"
          | "issueStateSignal"
          | "issueWorktreeSignal"
        >
      >;
    controlMcp?: Pick<
      ControlMcpServer,
      | "getInfo"
      | "getSettings"
      | "rotateToken"
      | "createCredential"
      | "rotateCredential"
      | "revokeCredential"
      | "issueCoordinatorCredential"
      | "revokeCoordinatorCredentials"
      | "start"
      | "stop"
    >;
    environmentLifecycleTasks?: EnvironmentLifecycleTaskTracker;
    /** Test seam: process state owned by this backend instance. */
    runtime?: BackendRuntime;
    environmentLifecycleDrainTimeoutMs?: number;
    /**
     * Step 08 named due jobs for the activity bundle and maintenance. `false`
     * selects the previous 2 s bundle and 60 s timer (never both); defaults
     * to `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK` not naming `backend-activity`.
     */
    keyedActivityJobs?: boolean;
    /** Test seam: the activity jobs' monotonic clock and timers. */
    activityJobClock?: {
      now: () => number;
      timers: import("./recurring-scheduler.js").RecurringTimerFactory;
    };
    /** Test seam; defaults to a Docker-backed checker outside `bun test`. */
    containerHostReachability?: ContainerHostReachabilityService;
    /**
     * Start the artifact preview runtime (headless browser runner, content
     * listener). Defaults to on outside `bun test`.
     */
    transcriptArtifactRuntime?: boolean;
    /** `--command-node`: command-node registration is always enabled. */
    commandNode?: boolean;
    /** Test seam: node links (fetch, SSH, timers). */
    nodeLinks?: Pick<NodeServiceOptions, "fetchImpl" | "createSsh" | "timers" | "heartbeatMs">;
  }) {
    this.keyedActivityJobs =
      options.keyedActivityJobs ?? keyedSchedulingEnabled("backend-activity");
    this.activityJobClock = options.activityJobClock;
    const storage = new StorageService(options.dataDir);
    this.compatibilityPathSink = compatibilityPathUsageDatabaseSink(options.dataDir);
    compatibilityPathUsage.attach(this.compatibilityPathSink);
    this.workflowResults = new WorkflowResultService(options.dataDir);
    this.hostMaintenance = new HostMaintenanceService({
      dataDir: options.dataDir,
      updater: options.hostUpdater ?? "none",
      version: APP_VERSION,
      emit: (event, payload) => options.emit(event, payload),
      rollbackEvidence: options.hostRollbackEvidence,
      onCheck: (latestVersion, isCurrent) => {
        if (!latestVersion || latestVersion === APP_VERSION) return;
        void fetchReleasePins(latestVersion).then((pins) => {
          if (pins && isCurrent()) this.hostMaintenance.setNextRelease(pins);
        });
      },
    });
    this.workflowResultRollout = new WorkflowResultRollout(
      async () => (await storage.loadConfig()).global.workflowResultTools,
    );
    const design = new DesignService(options.dataDir, options.emit);
    const previews = new PreviewRuntime({
      storage,
      emit: options.emit,
      strictDockerOwner: options.strictDockerOwner ?? false,
    });
    this.agentTools =
      options.agentTools ?? new AgentToolsServer(storage, "0.0.0.0", this.workflowResults, design);
    this.containerHostReachability =
      options.containerHostReachability ??
      (process.env.NODE_ENV === "test"
        ? undefined
        : new ContainerHostReachabilityService({
            servicePort: () => this.agentTools.servicePort?.() ?? null,
            ownerNamespace: dockerOwnerNamespace(options.dataDir),
            fallbackImage: () => options.dockerImage ?? DOCKER_IMAGE,
            // Read lazily: the gateway that receives events is created after init.
            emit: (event, payload) => options.emit(event, payload),
            prepareContainer: async (containerId) => {
              await ensureContainerAgentToolsHost(containerId);
              await ensureContainerHostServicePorts(
                containerId,
                this.agentTools.servicePort?.() ?? null,
              );
            },
            loadEnvironment: (environmentId) => storage.getEnvironment(environmentId),
          }));
    const assertAgentToolsReachable = this.containerHostReachability
      ? (environmentId: string, stage: string) =>
          this.containerHostReachability!.assertEnvironmentReachable(environmentId, stage)
      : undefined;
    const resolveAgentToolConnection = this.agentTools.workflowResultConnection
      ? (
          environmentId: string,
          projectId: string,
          target: "host" | "container",
          resultKey: string,
          provider?: import("@orkestrator/protocol/structured-output").StructuredOutputProvider,
        ) =>
          this.agentTools.workflowResultConnection!(
            environmentId,
            projectId,
            target,
            resultKey,
            provider,
          )
      : undefined;
    this.controlMcp =
      options.controlMcp ??
      new ControlMcpServer(options.dataDir, (command, args) => this.invoke(command, args), {
        // Fixed in the application, ephemeral in the test runner so concurrently
        // executing backend fixtures cannot contend for the user-facing port.
        port: process.env.NODE_ENV === "test" ? 0 : undefined,
      });
    this.environmentLifecycleTasks =
      options.environmentLifecycleTasks ?? new EnvironmentLifecycleTaskTracker();
    this.runtime =
      options.runtime ??
      new BackendRuntime({
        emit: (event, payload) => options.emit(event, payload),
        // Docker-backed, so unit tests keep the unwatched bounds unless they inject one.
        worktreeSignal:
          process.env.NODE_ENV === "test" ? undefined : containerWorktreeSignalInstaller,
      });
    this.environmentLifecycleDrainTimeoutMs =
      options.environmentLifecycleDrainTimeoutMs ?? ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS;
    // Backend-owned file-change tracking (docs/architecture/change-tracking.md):
    // one service per backend, fed by the environment scan owner, native
    // dispatch and bridge evidence. Started in init(), closed in shutdown().
    if (!this.runtime.changeTracking) {
      this.runtime.attachChangeTracking(
        createBackendChangeTracking({
          dataDir: options.dataDir,
          storage,
          emit: (event, payload) => options.emit(event, payload),
          refreshEnvironment: (environmentId) =>
            this.runtime.diffStats.service.refresh(environmentId),
        }),
      );
    }
    // Every committed mutation fans out to all connected clients, so a second
    // window or browser converges without polling. `emit` is read lazily by the
    // caller's closure, which is how this survives the gateway not existing yet.
    storage.setResourceChangeListener((change) => {
      options.emit(RESOURCE_CHANGED_EVENT, change);
      // Created below; a change before then has no self summary to refresh.
      this.nodePortal?.readModel.noteLocalEvent(RESOURCE_CHANGED_EVENT, change);
    });
    const context = {
      storage,
      design,
      previews,
      toolchainBinDir: options.toolchainBinDir,
      appRoot: options.appRoot,
      resourceRoot: options.resourceRoot,
      runtimeFlavor: options.runtimeFlavor ?? "production",
      worktreeDir: options.worktreeDir,
      dockerImage: options.dockerImage,
      strictDockerOwner: options.strictDockerOwner ?? false,
      credentialSources: new Set(options.credentialSources ?? []),
      emit: options.emit,
      agentTools: this.agentTools,
      containerHostReachability: this.containerHostReachability,
      controlMcp: this.controlMcp,
      environmentLifecycleTasks: this.environmentLifecycleTasks,
      runtime: this.runtime,
      hostMaintenance: this.hostMaintenance,
    } as CommandContext;
    context.notifyAgentTurnCompleted = async (environmentId: string) => {
      const handler = this.commands.get("pr_monitor_agent_turn_completed");
      if (!handler) return;
      await handler({ environmentId }, context);
    };
    context.probeAgentCreatedPullRequest = async (environmentId: string) => {
      const handler = this.commands.get("pr_monitor_probe_environment");
      if (!handler) return;
      await handler({ environmentId }, context);
    };
    context.deleteWorkflowResultsByEnvironment = (environmentId: string) =>
      this.workflowResults.deleteByEnvironment(environmentId);
    this.context = context;
    context.pinnedGitHubCli = resolveManagedBinary(context, "gh");
    setManagedGitHubCli(context.pinnedGitHubCli);
    setGitHubCliConfigSource(async () => (await storage.loadConfig()).global);
    this.hostMaintenance.setReaders({
      impact: () => readRestartImpact(context),
      tools: () => readToolStatus(context, this.hostMaintenance.ghChannel()),
      image: () => readImageStatus(context),
    });
    this.coordinators = new CoordinatorService(
      storage,
      () => this.controlMcp.getSettings(),
      undefined,
      async (environmentId, tabId) => {
        const logicalSessionKey = `env-${environmentId}:${tabId}`;
        const session = (await storage.listNativeAgentSessions()).find(
          (candidate) =>
            candidate.environmentId === environmentId &&
            candidate.logicalSessionKey === logicalSessionKey,
        );
        if (!session) return "unknown";
        // The turn view: a worker whose turn ended but whose background tasks
        // still run has answered, and its report must not wait for them. The
        // raw state stays `working` until every task finishes, which held a
        // report indefinitely when the turn-end edge itself was missed.
        return this.nativeAgents.sessionTurnActivitySnapshot(
          environmentId,
          session.agent,
          logicalSessionKey,
        );
      },
      {
        lastAssistantExcerpt: (environmentId, tabId) =>
          this.lastAssistantExcerpt(environmentId, tabId),
      },
    );
    context.coordinators = this.coordinators;
    this.nodes = new NodeService({
      storage,
      emit: (event, payload) => options.emit(event, payload),
      forceRegistration: options.commandNode === true,
      portalOrigins: () => normalizePortalOrigins(this.portalOriginsSource()),
      selfAccess: () => this.selfAccessSource(),
      ...(options.nodeLinks?.fetchImpl ? { fetchImpl: options.nodeLinks.fetchImpl } : {}),
      ...(options.nodeLinks?.timers ? { timers: options.nodeLinks.timers } : {}),
      ...(options.nodeLinks?.heartbeatMs ? { heartbeatMs: options.nodeLinks.heartbeatMs } : {}),
      ...((options.nodeLinks?.createSsh ?? createNodeSshFactory(options.dataDir))
        ? { createSsh: options.nodeLinks?.createSsh ?? createNodeSshFactory(options.dataDir)! }
        : {}),
      inheritableSettings: async () =>
        pickInheritedGlobalSettings((await storage.loadConfig()).global),
      onInheritedSettingsChanged: () => storage.announceInheritedSettingsChanged(),
    });
    context.nodes = this.nodes;
    // While a leaf, this node works with its command node's settings.
    storage.inheritedGlobalSettings = () => this.nodes.inheritedSettings.current();
    this.nodePortal = new NodePortal({
      nodes: this.nodes,
      emit: (event, payload) => options.emit(event, payload),
      local: { invoke: (command, args = {}) => this.invoke(command, args) },
      summaries: {
        load: () => storage.loadNodeSummariesCache(),
        save: (value) => storage.saveNodeSummariesCache(value),
      },
      outcomes: {
        load: () => storage.loadNodeOutcomes(),
        save: (value) => storage.saveNodeOutcomes(value),
      },
      ...(options.nodeLinks?.fetchImpl ? { fetchImpl: options.nodeLinks.fetchImpl } : {}),
    });
    context.nodePortal = this.nodePortal;
    this.nodeCoordination = new NodeCoordination({
      storage,
      nodes: this.nodes,
      portal: this.nodePortal,
      invoke: (command, args = {}) => this.invoke(command, args),
      emit: (event, payload) => options.emit(event, payload),
    });
    context.nodeCoordination = this.nodeCoordination;
    // Coordinator work on the nodes this one controls is read through the
    // node link, and their relayed changes settle it promptly.
    this.coordinators.setRemoteAccess(
      new NodeCoordinatorRemote({
        invokeOnNode: (input) => this.nodePortal.invokeOnNode(input),
        summaries: (nodeIds) => this.nodePortal.summaries(nodeIds),
        collectMail: (nodeId) => this.nodeCoordination.collector.collect(nodeId as BackendId),
      }),
    );
    bridgeRemoteCoordinatorEvents({
      onNodeEvent: (listener) => this.nodePortal.readModel.onNodeEvent(listener),
      settleRemoteWorker: (nodeId, environmentId) =>
        this.coordinators.settleRemoteWorker(nodeId, environmentId),
      noteRemoteWorkflowChange: (nodeId, kind, id) =>
        this.coordinators.statusWakes.noteRemoteWorkflowChange(nodeId, kind, id),
    });
    const interactionMonitorMode =
      process.env.ORKESTRATOR_AGENT_INTERACTION_OBSERVE_ONLY === "1"
        ? ("observe-only" as const)
        : ("disabled" as const);
    // Per-turn transcript-artifact bookkeeping, shared by native turns and the
    // workflows that drive providers directly (workflow-artifact-turns.ts).
    // The artifact service is constructed after this; resolve it lazily.
    const artifactDispatch: ArtifactTurnDispatch = {
      beginTurn: (turn) => {
        const artifacts = this.transcriptArtifacts;
        if (!artifacts) return {};
        artifacts.noteDispatchedTurn(turn.environmentId, turn.conversationKey, turn.turnId);
        if (!turn.needsGrant) return {};
        return {
          grant: artifacts.mintArtifactGrant({
            environmentId: turn.environmentId,
            projectId: turn.projectId,
            conversationKey: turn.conversationKey,
            turnId: turn.turnId,
            providerSessionId: turn.providerSessionId,
          }).grant,
        };
      },
      settleTurn: (environmentId, conversationKey, turnId) => {
        const artifacts = this.transcriptArtifacts;
        if (!artifacts) return;
        artifacts.clearDispatchedTurn(environmentId, conversationKey, turnId);
        artifacts.revokeArtifactGrantsForTurn(environmentId, turnId);
      },
      toolsEnabled: () => this.transcriptArtifacts?.toolsEnabled() === true,
    };
    const artifactLedger = () => this.transcriptArtifacts ?? null;
    this.nativeAgents = new NativeAgentService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        changeTracking: () => this.runtime.changeTracking?.nativeAgentHooks() ?? null,
        localBridgeAccountId: (key) => this.runtime.localServers.launchedAccountId(key),
        interactionMonitorMode,
        // Rollback for step 07's observation sharing; fences stay either way.
        observationSharing: process.env.ORKESTRATOR_NATIVE_OBSERVATION_SHARING !== "0",
        interactionMonitorAdoptionEnabled:
          process.env.ORKESTRATOR_AGENT_INTERACTION_MONITOR_KILL_SWITCH !== "1",
        // A view-only invalidation for an idle session whose content changed:
        // same channel and stamp sequence as transitions, so a client re-reads
        // that view (or every view after a gap). Deliberately nothing else
        // hangs off it; it is not a turn edge.
        onObservationInvalidation: (event) => {
          options.emit("native-agent-session-activity", {
            environment_id: event.environmentId,
            previous_state: event.state,
            state: event.state,
            reason: "content",
            agent: event.agent,
            logical_session_key: event.logicalSessionKey,
            generation: event.observation.generation,
            revision: event.observation.revision,
          });
        },
        onActivityTransition: (event) => {
          options.emit("native-agent-session-activity", {
            environment_id: event.environmentId,
            previous_state: event.previousState,
            state: event.state,
            // Additive (step 07): which session, and the observer's stamp so a
            // client can invalidate exactly that view and detect a missed
            // transition as a revision gap. Older clients ignore these.
            ...(event.agent ? { agent: event.agent } : {}),
            ...(event.logicalSessionKey ? { logical_session_key: event.logicalSessionKey } : {}),
            ...(event.observation
              ? {
                  generation: event.observation.generation,
                  revision: event.observation.revision,
                }
              : {}),
          });
          // An agent that just ended a turn may have run `gh pr create` itself,
          // and an environment with no stored PR carries no polling timer that
          // would ever notice. Probe once here rather than standing one up.
          //
          // This deliberately hangs off the *transition*, not the observation:
          // the activity sweep reports idle every two seconds, so probing every
          // idle reading would be a `gh` call per idle environment per sweep.
          // A first observation (`previousState === undefined`) is a backend
          // restart or a newly adopted session, not a turn that ended here.
          // A provider transition in an environment is a hint for the
          // workflows running there; it pulls their next pass forward and is
          // dropped while one is already running.
          if (event.owner !== "coordinator") {
            this.wakeWorkflows(event.environmentId, "provider-transition");
          }
          // A delegated tab blocked on input or an approval, or working again:
          // the edges a coordinator's waiting-worker status wake hangs off.
          if (
            event.owner !== "coordinator" &&
            (event.state === "waiting" || event.state === "working") &&
            event.logicalSessionKey?.startsWith(`env-${event.environmentId}:`)
          ) {
            void this.coordinators
              .noteWorkerActivity({
                environmentId: event.environmentId,
                tabId: event.logicalSessionKey.slice(`env-${event.environmentId}:`.length),
                state: event.state,
              })
              .catch((error: unknown) => {
                console.warn(
                  "[backend] Failed to note worker activity for status wakes:",
                  error instanceof Error ? error.message : error,
                );
              });
          }
          if (isAgentTurnEndTransition(event)) {
            // Capture the turn's end state and publish turn-net/thread-net.
            let changesFinalized: Promise<unknown> = Promise.resolve();
            if (event.owner !== "coordinator" && event.logicalSessionKey) {
              changesFinalized =
                this.runtime.changeTracking?.finalizeTurn({
                  environmentId: event.environmentId,
                  logicalSessionKey: event.logicalSessionKey,
                }) ?? Promise.resolve();
            }
            // A coordinator has no environment row and no PR to probe for.
            if (event.owner !== "coordinator") {
              this.probeForAgentCreatedPullRequest(event.environmentId, context);
            }
            // Web annotation requests sent to this session read their turn
            // outcome now, while the bridge that ran the turn is still up,
            // rather than on a later reconcile pass that may find it gone.
            let annotationsObserved: Promise<unknown> = Promise.resolve();
            if (event.owner !== "coordinator" && event.agent && event.logicalSessionKey) {
              annotationsObserved =
                context.webAnnotations
                  ?.noteTurnEnded({
                    environmentId: event.environmentId,
                    agent: event.agent,
                    logicalSessionKey: event.logicalSessionKey,
                  })
                  .catch(() => undefined) ?? Promise.resolve();
            }
            /*
             * The turn that was holding this session's work just ended, so the
             * things that were waiting for it can run now rather than on the
             * next two-second sweep. Both drains coalesce internally, so the
             * extra call costs nothing when a sweep is already in flight — and
             * this is what turns a worker's report into a wake within the
             * dispatch latency instead of the mail backoff, which for a
             * coordinator could previously reach thirty seconds.
             */
            void Promise.all([changesFinalized, annotationsObserved])
              .then(() => this.nativeAgents.drainPromptQueueForSession(event))
              .catch((error: unknown) => {
                console.warn(
                  "[backend] Failed to drain the prompt queue after a turn ended:",
                  error instanceof Error ? error.message : error,
                );
              });
            /*
             * Settle first, drain second, in that order.
             *
             * Settling is what releases the mail a finished worker was holding,
             * so a drain started before it would run against the old pending
             * set and the worker's report would wait for the next sweep — the
             * exact latency this edge exists to remove.
             *
             * A coordinator's own turn ending settles nothing: it is the party
             * being woken, not a worker reporting. Its `logicalSessionKey` is
             * only a tab address when it has the environment form; a workflow
             * session's key means something else entirely and must not be
             * mistaken for one.
             */
            const workerTabId =
              event.owner !== "coordinator" &&
              event.logicalSessionKey?.startsWith(`env-${event.environmentId}:`)
                ? event.logicalSessionKey.slice(`env-${event.environmentId}:`.length)
                : undefined;
            void (
              workerTabId
                ? this.coordinators.settleWorkerDelegations({
                    environmentId: event.environmentId,
                    tabId: workerTabId,
                    state: "completed",
                  })
                : Promise.resolve()
            )
              .catch((error: unknown) => {
                console.warn(
                  "[backend] Failed to settle worker delegations after a turn ended:",
                  error instanceof Error ? error.message : error,
                );
              })
              .then(() => this.agentMail.drainInjects())
              .catch((error: unknown) => {
                console.warn(
                  "[backend] Failed to drain agent mail after a turn ended:",
                  error instanceof Error ? error.message : error,
                );
              });
          }
        },
        onAsyncQuestionAttention: (event) => {
          options.emit("native-agent-async-question", {
            environment_id: event.environmentId,
            session_key: event.sessionKey,
          });
        },
        beginCoordinatorTurn: (projectId) => {
          const projectGit = context.projectGit;
          if (!projectGit) throw new Error("Project Git service is unavailable");
          return projectGit.beginCoordinatorTurn(projectId);
        },
        resolveAgentToolConnection: (environmentId, projectId, tabId, target) =>
          this.agentTools.connection(environmentId, projectId, target, tabId),
        artifactLedger,
        artifactDispatch,
        coordinatorNodeContext: async () => {
          const status = await this.nodes.status();
          const list = await this.nodes.listNodes();
          return coordinatorNodeContext(
            status,
            list.nodes.filter((node) => node.connection.state === "connected").length,
          );
        },
        coordinatorDelegationAvailable: (platform) =>
          this.controlMcp.getSettings().running &&
          coordinatorProviderQualification(platform).delegation,
      },
    );
    context.nativeAgents = this.nativeAgents;
    context.agentRegistry = new AgentRegistry(storage, {
      native: (environmentId, agent, logicalSessionKey) =>
        this.nativeAgents.sessionTurnActivitySnapshot(environmentId, agent, logicalSessionKey),
      tmux: (environmentId, tabId) => tmuxManager.get(environmentId, tabId)?.activityState(),
    });
    context.mcpManagement = new McpManagementService({
      dataDir: options.dataDir,
      storage,
      emit: options.emit,
      probe: createMcpRuntimeProbe(context),
      ...mcpContainerOptions(context),
      loadRollout: mcpRolloutLoader(context),
    });
    // Web annotations: backend-owned threads and requests. Execution goes
    // through the native queue via the dispatch adapter; the tool host is
    // installed on the agent tools server when it supports annotation tools.
    const annotationTools = this.agentTools as {
      setWebAnnotationToolHost?: (host: WebAnnotationToolHost | null) => void;
      hasWebAnnotationTools?: () => boolean;
    };
    // Rollout switch: `config.global.webAnnotations.mode`, overridden by
    // ORKESTRATOR_WEB_ANNOTATIONS_MODE. Defaults to enabled.
    this.webAnnotationRollout = new WebAnnotationRollout(
      async () => (await storage.loadConfig()).global.webAnnotations,
    );
    this.webAnnotations = new WebAnnotationService({
      dataDir: options.dataDir,
      emit: options.emit,
      rolloutMode: () => this.webAnnotationRollout.mode,
      storage,
      dispatch: new WebAnnotationDispatchAdapter({
        storage,
        nativeAgents: this.nativeAgents,
        invoke: (command, args) => this.invoke(command, args),
        resultToolsAvailable: () => annotationTools.hasWebAnnotationTools?.() ?? false,
      }),
      compileBrief: compileWebAnnotationBrief,
      composeText: composeWebAnnotationDispatchText,
      invoke: (command, args) => this.invoke(command, args),
      resultTools: typeof annotationTools.setWebAnnotationToolHost === "function",
    });
    annotationTools.setWebAnnotationToolHost?.(this.webAnnotations.toolHost());
    context.webAnnotations = this.webAnnotations;
    context.webAnnotationRollout = this.webAnnotationRollout;
    // Transcript artifacts: ordinary agent tools on the common server plus
    // renderer commands. Preview infrastructure attaches during init().
    this.transcriptArtifacts = createTranscriptArtifactService(storage, {
      dataDir: options.dataDir,
      // Live hints after committed draft/operation/ledger changes.
      announce: (_environmentId, conversationKey) =>
        storage.announceTranscriptArtifact(conversationKey),
      // Asset imports: only uploads staged by the same conversation through
      // `transcript_artifact_stage_asset`; never a path or URL.
      assetResolver: (owner, assetRef) =>
        this.transcriptArtifacts.resolveStagedAsset(owner, assetRef),
    });
    this.transcriptArtifactRuntimeEnabled =
      options.transcriptArtifactRuntime ?? process.env.NODE_ENV !== "test";
    (
      this.agentTools as {
        setTranscriptArtifactToolHost?: (host: TranscriptArtifactToolHost | null) => void;
      }
    ).setTranscriptArtifactToolHost?.(this.transcriptArtifacts);
    context.transcriptArtifacts = this.transcriptArtifacts;
    // A publication changes its conversation's projected transcript (the
    // artifact part beside its call): views of that environment re-read.
    this.transcriptArtifacts.onLedgerChange((change) =>
      storage.announceNativeAgentSessionProjection(change.environmentId),
    );
    this.projectGit = new ProjectGitService(storage, async (projectId) => {
      for (const home of await storage.getEnvironmentsByProject(projectId)) {
        if (home.projectHome && (await this.nativeAgents.hasActiveCheckoutWork(home.id)))
          return true;
      }
      const workspace = await storage.getCoordinatorWorkspace(projectId);
      if (!workspace) return false;
      for (const conversation of workspace.conversations) {
        if (conversation.closedAt || !conversation.agent) continue;
        const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
        // The turn view, not the indicator view: a coordinator conversation
        // whose composer is free is not holding this project's git, even when
        // a background task it launched keeps the environment pulsing.
        const observed = this.nativeAgents.sessionTurnActivitySnapshot(
          runtimeId,
          conversation.agent,
          conversation.logicalSessionKey,
        );
        if (observed === "working" || observed === "waiting") return true;
        const projection = await this.nativeAgents
          .getProjection({
            environmentId: runtimeId,
            agent: conversation.agent,
            logicalSessionKey: conversation.logicalSessionKey,
            messageLimit: 1,
          })
          .catch(() => null);
        if (
          projection &&
          ["running", "blocked", "cancelling", "recovering"].includes(projection.turn.phase)
        ) {
          return true;
        }
      }
      return false;
    });
    context.projectGit = this.projectGit;
    this.buildPipelines = new BuildPipelineService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        workflowResults: this.workflowResults,
        workflowResultRollout: this.workflowResultRollout,
        resolveAgentToolConnection,
        assertAgentToolsReachable,
        onInteractionObservation: (event) => {
          this.nativeAgents.recordProviderInteractionObservation(event);
        },
        workflowAdmission: this.workflowAdmission,
        artifactDispatch,
        artifactLedger,
      },
    );
    context.buildPipelines = this.buildPipelines;
    this.loopedReviews = new LoopedReviewService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        workflowResults: this.workflowResults,
        workflowResultRollout: this.workflowResultRollout,
        resolveAgentToolConnection,
        assertAgentToolsReachable,
        onInteractionObservation: (event) => {
          this.nativeAgents.recordProviderInteractionObservation(event);
        },
        workflowAdmission: this.workflowAdmission,
      },
    );
    context.loopedReviews = this.loopedReviews;
    this.multiReviews = new MultiReviewService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        workflowResults: this.workflowResults,
        workflowResultRollout: this.workflowResultRollout,
        resolveAgentToolConnection,
        assertAgentToolsReachable,
        artifactDispatch,
        artifactLedger,
        dispatchAddressPrompt: (workflow, presentation) =>
          dispatchMultiReviewAddressPrompt(
            this.nativeAgents,
            workflow,
            storage,
            presentation.activateTab,
          ),
        recoverAddressSession: (workflow, replacement) =>
          recoverMissingMultiReviewFixSession(this.nativeAgents, workflow, replacement),
        ...multiReviewNativeFixOptions(this.nativeAgents),
        workflowAdmission: this.workflowAdmission,
        invalidateAddressSession: async (workflow, session) => {
          await storage.invalidateNativeAgentSession(
            nativeAgentSessionStorageKey(workflow.environmentId, session.agent, session.sessionKey),
            session.providerSessionId,
          );
        },
      },
    );
    context.multiReviews = this.multiReviews;
    // Live reviewers' `report_finding` calls reach the review through the
    // agent tools server, which lists the tool only for a reviewer it accepts.
    (
      this.agentTools as {
        setProvisionalFindingSink?: (sink: ProvisionalFindingSink | null) => void;
      }
    ).setProvisionalFindingSink?.(this.multiReviews.provisionalFindingSink());
    this.featurePlanning = new FeaturePlanningService(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
      {
        workflowResults: this.workflowResults,
        workflowResultRollout: this.workflowResultRollout,
        resolveAgentToolConnection,
        assertAgentToolsReachable,
        workflowAdmission: this.workflowAdmission,
        artifactDispatch,
      },
    );
    context.featurePlanning = this.featurePlanning;
    // Native agent queues are drained by NativeAgentService; this covers the
    // claude-tmux queues, whose dispatch types into a pane rather than calling
    // a bridge and so had no server-side drainer at all.
    this.promptQueues = new PromptQueueDrainer(
      storage,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        const handler = this.commands.get(command);
        if (!handler) throw new Error(`Unknown backend command: ${command}`);
        return (await handler(args, context)) as T;
      },
    );
    this.agentMail = new AgentMailService(storage, this.nativeAgents, this.promptQueues, {
      coordinatorMailForStoppedEnvironment: stoppedWorkerMailHook(
        storage,
        async (environmentId) => {
          const handler = this.commands.get("start_environment_background");
          if (handler) await handler({ environmentId }, context);
        },
      ),
    });
    context.drainAgentMail = () => this.agentMail.drainInjects();
    // Scoped workflow wakeups (step 08), subscribed before any owner's first
    // discovery so nothing that commits during startup is missed. Each wake
    // reaches only the indexed keys of one environment; a durable record the
    // index does not hold yet is found by that owner's discovery instead.
    this.workflowResults.onAccepted(({ environmentId }) => {
      this.wakeWorkflows(environmentId, "result-accepted");
    });
    storage.addResourceChangeListener((change) => {
      // Readiness and execution identity (status, setup, bridge port/token)
      // all live on the environment record.
      if (change.resource === "environment" && !change.deleted) {
        this.wakeWorkflows(change.id, "environment-change");
        // A rename intent is recorded on the environment.
        this.activityJobs?.wake("pending-renames");
      }
      if (change.resource === "prompt-queue") this.activityJobs?.wake("tmux-queues");
      // Leaves follow this node's settings.
      if (change.resource === "config") this.nodes.syncSettingsToLeaves();
    });
    this.reapPidServers = options.startupReapers?.localServers ?? reapOrphanedLocalServers;
    this.reapTmuxRuntimes =
      options.startupReapers?.claudeTmuxRuntimes ?? reapOrphanedClaudeTmuxRuntimes;
  }

  /** Owners driven by a keyed supervisor; an owner on its rollback driver ignores wakes. */
  private keyedWorkflowOwners(): KeyedWorkflowOwner[] {
    // Read lazily: a storage change can be announced while the constructor is
    // still building the owners.
    const owners: (KeyedWorkflowOwner | undefined)[] = [
      this.featurePlanning,
      this.buildPipelines,
      this.loopedReviews,
      this.multiReviews,
    ];
    return owners.filter((owner): owner is KeyedWorkflowOwner => owner !== undefined);
  }

  private wakeWorkflows(environmentId: string, reason: WorkflowWakeReason): void {
    for (const owner of this.keyedWorkflowOwners()) {
      try {
        owner.wakeEnvironment(environmentId, reason);
      } catch (error) {
        console.warn(
          "[backend] Failed to wake workflow work:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  /**
   * Fire-and-forget one-shot PR discovery after an agent turn ended.
   *
   * Deliberately not awaited: the activity sweep that produced this edge must
   * not slow down, or fail, because GitHub is slow. The probe itself is
   * idempotent — an environment already being monitored just gets its next
   * check brought forward.
   */
  /**
   * What a worker tab last said, for a coordinator status notice.
   *
   * Best effort and bounded: a short projection read with a deadline, so a
   * slow bridge delays the notice by at most a few seconds and never fails it.
   */
  private async lastAssistantExcerpt(
    environmentId: string,
    tabId: string,
  ): Promise<string | undefined> {
    const logicalSessionKey = `env-${environmentId}:${tabId}`;
    const session = (await this.context.storage.listNativeAgentSessions()).find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.logicalSessionKey === logicalSessionKey,
    );
    if (!session) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 5_000);
      timer.unref?.();
    });
    try {
      const projection = await Promise.race([
        this.nativeAgents
          .getProjection({
            environmentId,
            agent: session.agent,
            logicalSessionKey,
            messageLimit: 6,
          })
          .catch(() => null),
        deadline,
      ]);
      return lastAssistantText(projection?.messages);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The single PR-monitor call site for a native turn-end edge.
   *
   * Called once per `isAgentTurnEndTransition` edge from `onActivityTransition`
   * — never per idle observation, and never for a fenced pre-dispatch idle,
   * which the observer refuses to apply (step 07). It reaches the PR monitor's
   * completion wakeup via `pr_monitor_probe_environment` →
   * `wakePrMonitorForCompletion` (step 05).
   */
  private probeForAgentCreatedPullRequest(environmentId: string, context: CommandContext): void {
    void Promise.resolve(context.probeAgentCreatedPullRequest?.(environmentId)).catch(
      (error: unknown) => {
        console.warn(
          `[backend] Failed to probe for an agent-created PR in ${environmentId}:`,
          error instanceof Error ? error.message : error,
        );
      },
    );
  }

  async init(): Promise<void> {
    await this.context.storage.init();
    try {
      this.runtime.changeTracking?.start();
    } catch (error) {
      console.warn(
        "[backend] Failed to start change tracking:",
        error instanceof Error ? error.message : error,
      );
    }
    // Settles an update the previous process was applying; installing one is
    // what restarted this backend.
    try {
      this.hostMaintenance.init();
      await applyGhChannel(
        this.context,
        this.hostMaintenance.ghChannel(),
        this.context.pinnedGitHubCli,
      );
    } catch (error) {
      console.warn(
        "[backend] Failed to settle the host update record:",
        error instanceof Error ? error.message : error,
      );
    }
    // Design startup recovery (interrupted operations, migrations, exports)
    // degrades the design feature on failure, never the backend; every design
    // command retries initialization lazily.
    await this.context.design?.initialize().catch((error: unknown) => {
      console.warn(
        "[backend] Design storage failed to initialize:",
        (error as NodeJS.ErrnoException)?.code ?? "error",
      );
    });
    await this.webAnnotationRollout.refresh();
    // Unreadable annotation storage degrades that feature, not the backend.
    await this.webAnnotations.initialize().catch((error: unknown) => {
      console.warn(
        "[backend] Failed to initialize web annotations:",
        error instanceof Error ? error.name : "unknown",
      );
    });
    // Interrupts verification left unfinished by a previous process (never
    // re-run), then cleans up hourly. The preview runtime is optional.
    try {
      this.transcriptArtifacts.initialize();
    } catch (error) {
      console.warn(
        "[backend] Failed to initialize transcript artifacts:",
        error instanceof Error ? error.name : "unknown",
      );
    }
    if (this.transcriptArtifactRuntimeEnabled) {
      this.transcriptArtifactRuntime = await attachTranscriptArtifactRuntime(
        this.transcriptArtifacts,
        {
          dataDir: this.context.storage.getDataDir(),
        },
      );
    }
    // Preview definitions load before the gateway accepts commands; resolving
    // targets happens in the background so a slow Docker daemon cannot delay
    // startup. A registry that fails to load disables previews, not the backend.
    await this.context.previews?.init().catch((error: unknown) => {
      console.warn(
        "[backend] Failed to initialize preview services:",
        error instanceof Error ? error.message : error,
      );
    });
    // Recovers interrupted MCP configuration operations. A failure disables
    // management, not the backend.
    await this.context.mcpManagement?.init().catch((error: unknown) => {
      console.warn(
        "[backend] Failed to initialize MCP configuration management:",
        error instanceof Error ? error.message : error,
      );
    });
    const terminalHistoryConfig = (await this.context.storage.loadConfig()).global;
    configureTerminalHistoryRetention({
      enabled: terminalHistoryConfig.terminalHistoryEnabled,
      sessionMb: terminalHistoryConfig.terminalHistoryRetentionMb,
      globalMb: terminalHistoryConfig.terminalHistoryGlobalRetentionMb,
      days: terminalHistoryConfig.terminalHistoryRetentionDays,
    });
    await pruneTerminalHistoryStorage(this.context.storage.getDataDir());
    if (!this.terminalStartupReconciled) {
      // A terminal session id names state owned by this backend process. On a
      // renderer-only reload the backend stays alive and the id remains valid;
      // on backend startup no previous id can be honoured, so invalidate them
      // before the gateway can serve a pane snapshot.
      await this.context.storage.clearBackendTerminalSessionIds();
      this.terminalStartupReconciled = true;
    }
    // Do not accept commands while durable state claims work is still running
    // from a previous process. If this write fails, startup fails closed rather
    // than exposing progress that this backend can never complete.
    // Exclusive container mutation for this data directory. A second backend,
    // or one older than the directory's schema marker, keeps serving reads
    // while every container mutation is refused.
    this.context.registryWriterLease ??= await openRegistryWriter(
      this.context.storage.getDataDir(),
    );
    const lifecycleRecovery = await reconcileInterruptedEnvironmentLifecycleTasks(
      this.context.storage,
    );
    // Before any bridge or terminal can start in a half-moved worktree.
    await recoverInterruptedEnvironmentMoves(this.context);
    // Before background launch or cleanup can act on their resources:
    // operations a previous process left unresolved are settled by exact
    // Docker identity. An unreachable daemon leaves them for the next attempt.
    if (this.context.registryWriterLease.isHeld()) {
      await reconcileContainerOperations(this.context).catch((error: unknown) => {
        console.warn(
          "[backend] Container operation reconciliation failed:",
          error instanceof Error ? error.message : error,
        );
      });
      // Probe containers are never started; one left by an interrupted
      // manifest read is removed in the background.
      void cleanupStaleManifestProbes(this.context).catch(() => undefined);
    }
    // Counts out-of-memory kills of this installation's containers for the
    // usage view; a read-only observer, stopped at shutdown.
    startOomEventWatcher(dockerOwnerNamespace(this.context.storage.getDataDir()));
    await this.agentTools.start();
    this.reserveOwnedPreviewPorts();
    // No renderer can be alive yet, so every persisted `frontend` activity
    // snapshot belongs to a process that is gone. They cannot be retracted
    // later — the aggregate is a max — so a renderer that quit mid-turn would
    // otherwise leave its environment showing "working" forever.
    await this.context.storage.clearFrontendAgentActivity().catch((error) => {
      console.warn("[backend] Failed to clear stale agent activity:", error);
    });
    this.activityLeaseSweep ??= setInterval(() => {
      recurringWorkMetrics.requested("activity-lease-expiry");
      void recurringWorkMetrics
        .observe("activity-lease-expiry", () =>
          this.context.storage.expireFrontendAgentActivityLeases(),
        )
        .catch((error) => {
          console.warn("[backend] Failed to expire agent activity leases:", error);
        });
    }, FRONTEND_AGENT_ACTIVITY_LEASE_MS / 2);
    this.activityLeaseSweep.unref?.();
    // Monotonic deadlines do not count time the host spent asleep; on resume
    // every scheduler runs its overdue keys once instead of waiting it out.
    this.hostSuspendDetector ??= new HostSuspendDetector({
      onSuspend: (suspendedMs) => recurringDiagnosticsRegistry.notifySuspension(suspendedMs),
    });
    this.hostSuspendDetector.start();
    // Containers hold Claude logins access-only; this hands them each host
    // renewal and renews the host login before it lapses.
    this.claudeLoginKeeper ??= new ContainerClaudeLoginKeeper(this.context, {
      refreshHostLogin: (account) => refreshHostClaudeLogin(this.context, account),
    });
    const keeper = this.claudeLoginKeeper;
    setHostClaudeLoginRefresher(() => keeper.refreshHostIfDue());
    setLocalClaudeLoginRefresher(() => keeper.refreshLocalLoginIfDue());
    keeper.start();
    setLocalCodexLoginRefresher(createCodexLoginRefresher(this.context));
    // Before the gateway can accept a start command: bridges left behind by a
    // backend that died without draining must be reaped first, or the codex
    // pidfile they still hold blocks this instance's app-server ownership.
    const reaperStorage = {
      loadEnvironments: async (): Promise<Environment[]> => {
        const [environments, workspaces] = await Promise.all([
          this.context.storage.loadEnvironments(),
          this.context.storage.listCoordinatorWorkspaces(),
        ]);
        const coordinatorRuntimes = workspaces.flatMap((workspace) =>
          workspace.conversations.flatMap((conversation): Environment[] =>
            conversation.bridgePid === undefined || !conversation.agent
              ? []
              : [
                  {
                    id: coordinatorRuntimeId(workspace.id, conversation.id),
                    projectId: workspace.projectId,
                    name: "Coordinator",
                    branch: workspace.repositoryStatus?.branch ?? "",
                    containerId: null,
                    status: "stopped",
                    prUrl: null,
                    prState: null,
                    hasMergeConflicts: null,
                    createdAt: conversation.createdAt,
                    networkAccessMode: "restricted",
                    order: 0,
                    environmentType: "local",
                    ...coordinatorBridgeEnvironmentFields(conversation),
                    setupPhase: "ready",
                    setupScriptsComplete: true,
                  } as Environment,
                ],
          ),
        );
        return [...environments, ...coordinatorRuntimes];
      },
      updateEnvironment: async (environmentId: string, fields: Partial<Environment>) => {
        const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
        const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
        if (!coordinatorId || !conversationId) {
          return this.context.storage.updateEnvironment(environmentId, fields);
        }
        const workspace = await this.context.storage.getCoordinatorWorkspaceById(coordinatorId);
        if (!workspace) return null;
        return this.context.storage.mutateCoordinatorWorkspace(workspace.projectId, (current) =>
          current && current.id === coordinatorId
            ? {
                ...current,
                conversations: current.conversations.map((conversation) =>
                  conversation.id === conversationId
                    ? {
                        ...conversation,
                        ...coordinatorBridgeIdentityFromEnvironment(conversation.agent, fields),
                      }
                    : conversation,
                ),
                updatedAt: new Date().toISOString(),
              }
            : current,
        );
      },
    };
    await this.reapPidServers({ storage: reaperStorage }).catch((error) => {
      console.warn("[backend] Failed to reap orphaned local servers:", error);
    });
    // claude-tmux leaves no PID behind — its sessions belong to a tmux server
    // we do not own — so its orphans are found by their runtime roots instead.
    await this.reapTmuxRuntimes({
      storage: this.context.storage,
      runtimeRootPrefix: claudeTmuxRuntimeRootPrefix(this.context.storage.getDataDir()),
    }).catch((error) => {
      console.warn("[backend] Failed to reap orphaned claude-tmux runtimes:", error);
    });
    // The durable deletion tombstone stays in place across a crash so queues,
    // pipelines, and starts remain blocked. Once orphaned processes have been
    // reaped, re-admit the ordinary idempotent delete path; it owns every child
    // cleanup and removes the tombstone only by removing the environment.
    const deleteEnvironment = this.commands.get("delete_environment");
    if (!deleteEnvironment && lifecycleRecovery.deletionRecoveryEnvironmentIds.length > 0) {
      throw new Error("Delete command is unavailable during lifecycle recovery");
    }
    for (const environmentId of lifecycleRecovery.deletionRecoveryEnvironmentIds) {
      const recovery = Promise.resolve(deleteEnvironment?.({ environmentId }, this.context));
      void recovery.catch(() => {
        // Detailed subprocess failures are logged at their owning boundary.
        // Keep this coordination log free of paths, command output, or secrets.
        console.warn(`[backend] Interrupted deletion remains pending for ${environmentId}`);
      });
    }
    // Finishes cleanup that earlier deletions could not, and removes bridge
    // state and design canvases whose environment is gone. Background work: it never blocks the
    // gateway and never rejects.
    void runStartupEnvironmentCleanup(this.context);
    const reconcileTabTeardowns = this.commands.get("reconcile_tab_teardowns");
    if (reconcileTabTeardowns) {
      await Promise.resolve(reconcileTabTeardowns({}, this.context)).catch((error: unknown) => {
        console.warn("[backend] Failed to reconcile tab teardowns:", error);
      });
    }

    // Start durable pipelines only after stale bridge ownership and interrupted
    // environment deletion have been reconciled. A doomed pipeline is skipped
    // without preventing the gateway from becoming available.
    await this.buildPipelines.init().catch((error) => {
      console.warn("[backend] Failed to restore build pipelines:", error);
    });
    await this.loopedReviews.init().catch((error) => {
      console.warn("[backend] Failed to restore looped reviews:", error);
    });
    await this.multiReviews.init().catch((error) => {
      console.warn("[backend] Failed to restore multi reviews:", error);
    });
    const reconcilePendingEnvironmentRenames = this.commands.get(
      "reconcile_pending_environment_renames",
    );
    if (reconcilePendingEnvironmentRenames) {
      // Naming intent is durable backend work. Complete startup reconciliation
      // before native launch recovery, even when no renderer has mounted the
      // environment. First-prompt preparation itself only schedules this work:
      // it may be called while environment start already owns the lifecycle queue.
      await Promise.resolve(reconcilePendingEnvironmentRenames({}, this.context)).catch(
        (error: unknown) => {
          console.warn("[backend] Failed to reconcile pending environment renames:", error);
        },
      );
    }
    await this.nativeAgents.init().catch((error) => {
      console.warn("[backend] Failed to restore native agent launches:", error);
    });
    await this.agentMail.init().catch((error) => {
      console.warn("[backend] Failed to restore agent mail:", error);
    });
    const reconcileOrphanedTabResources = this.commands.get("reconcile_orphaned_tab_resources");
    if (reconcileOrphanedTabResources) {
      await Promise.resolve(reconcileOrphanedTabResources({}, this.context)).catch(
        (error: unknown) => {
          console.warn("[backend] Failed to reconcile orphaned tab resources:", error);
        },
      );
    }
    if (!this.setupStartupReconciled) {
      const environments = await this.context.storage.loadEnvironments();
      // Mark before starting any pending setup. If init is retried on this same
      // backend instance, a live setup task must not be mistaken for work left
      // by a dead process or admitted a second time.
      this.setupStartupReconciled = true;
      const ensureEnvironmentSetup = this.commands.get("ensure_environment_setup");
      for (const environment of environments) {
        if (
          environment.status !== "running" ||
          environment.setupScriptsComplete ||
          environment.setupOverride
        )
          continue;
        if (environment.setupPhase === "running") {
          // A persisted `running` phase belongs to the process that owned its
          // PTY. Repository-controlled setup may not be idempotent, so fence
          // that interrupted attempt and require an explicit retry or override.
          await this.context.storage
            .updateEnvironment(environment.id, {
              setupPhase: "failed",
              setupCompletedAt: new Date().toISOString(),
              lifecycleError: "Environment setup was interrupted. Retry setup to continue.",
            })
            .catch((error: unknown) => {
              console.warn(
                `[backend] Failed to fence interrupted setup for ${environment.id}:`,
                error,
              );
            });
          continue;
        }
        if (environment.setupPhase !== "pending" || !ensureEnvironmentSetup) continue;
        // Pending means no setup attempt was published, so there is no side
        // effect to replay. Adopt it once now that setup no longer depends on a
        // mounted terminal component.
        void Promise.resolve(
          ensureEnvironmentSetup({ environmentId: environment.id }, this.context),
        ).catch((error: unknown) => {
          console.warn(`[backend] Failed to adopt pending setup for ${environment.id}:`, error);
        });
      }
    }
    // Adopts planning conversations the previous renderer-driven controller
    // left in flight, then advances every durable record on its own timer.
    await this.featurePlanning.init().catch((error) => {
      console.warn("[backend] Failed to restore feature planning:", error);
    });
    // Hydrate the sidebar from bridge-owned session snapshots before the
    // gateway accepts a renderer. A refresh therefore sees active environments
    // immediately, without mounting each tab to recreate client state.
    await this.nativeAgents.reconcileAgentActivity().catch((error) => {
      console.warn("[backend] Failed to restore native agent activity:", error);
    });
    // Annotation requests reconcile against native dispatch state, so start
    // only once native sessions are restored. Runs with no renderer mounted.
    this.webAnnotations.startReconciler();
    const reconcileClaudeState = this.commands.get("reconcile_claude_state_polling");
    if (reconcileClaudeState) {
      await Promise.resolve(reconcileClaudeState({}, this.context)).catch((error: unknown) => {
        console.warn("[backend] Failed to restore Claude terminal activity:", error);
      });
    }
    await this.agentMail.refreshPresence().catch((error) => {
      console.warn("[backend] Failed to refresh agent mail presence:", error);
    });
    // Queued tmux prompts left behind by a quit or crash drain from here, with
    // no renderer involved. NativeAgentService drains its own queues on its own
    // sweep; this one shares the activity sweep rather than adding a third
    // interval over the same store.
    await this.promptQueues.drainAll().catch((error) => {
      console.warn("[backend] Failed to drain tmux prompt queues:", error);
    });
    await this.agentMail.drainInjects().catch((error) => {
      console.warn("[backend] Failed to drain agent mail:", error);
    });
    let tabTeardownReconcileInFlight: Promise<void> | null = null;
    const reconcileTabTeardownsOnce = (): void => {
      if (!reconcileTabTeardowns) return;
      recurringWorkMetrics.requested("tab-cleanup");
      if (tabTeardownReconcileInFlight) {
        recurringWorkMetrics.coalesced("tab-cleanup");
        return;
      }
      tabTeardownReconcileInFlight = recurringWorkMetrics
        .observe("tab-cleanup", () => Promise.resolve(reconcileTabTeardowns({}, this.context)))
        .then(() => undefined)
        .catch((error: unknown) => {
          console.warn("[backend] Failed to reconcile tab teardowns:", error);
        })
        .finally(() => {
          tabTeardownReconcileInFlight = null;
        });
    };
    let orphanReconcileInFlight: Promise<void> | null = null;
    const reconcileOrphanedTabResourcesOnce = (): void => {
      if (!reconcileOrphanedTabResources) return;
      recurringWorkMetrics.requested("tab-cleanup");
      if (orphanReconcileInFlight) {
        recurringWorkMetrics.coalesced("tab-cleanup");
        return;
      }
      orphanReconcileInFlight = recurringWorkMetrics
        .observe("tab-cleanup", () =>
          Promise.resolve(reconcileOrphanedTabResources({}, this.context)),
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          console.warn("[backend] Failed to reconcile orphaned tab resources:", error);
        })
        .finally(() => {
          orphanReconcileInFlight = null;
        });
    };
    let mailRetentionTick = 0;
    let coordinatorWorkflowTick = 0;
    let coordinatorWorkflowReconcileInFlight: Promise<void> | null = null;
    const reconcileCoordinatorWorkflows = () => {
      recurringWorkMetrics.requested("coordinator-repair");
      if (coordinatorWorkflowReconcileInFlight) {
        recurringWorkMetrics.coalesced("coordinator-repair");
        return;
      }
      coordinatorWorkflowReconcileInFlight = recurringWorkMetrics
        .observe("coordinator-repair", () =>
          this.coordinators
            .reconcileWorkflowNotifications()
            // A delegation closed by an edge whose wake never reached the mail
            // store — a crash, a storage fault — is finished here. The wake is
            // idempotent on `wokenAt`, so a delivered one is not repeated.
            .then(() => this.coordinators.reconcileWorkerDelegations()),
        )
        .catch((error) => {
          console.warn(
            "[backend] Failed to reconcile coordinator workflow notifications:",
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => {
          coordinatorWorkflowReconcileInFlight = null;
        });
    };
    if (this.keyedActivityJobs && !this.activityJobs) {
      // Step 08: every part of the former 2 s bundle and the 60 s maintenance
      // is its own named due job (see backend-activity-jobs.ts).
      const warn = (label: string) => (error: unknown) => {
        console.warn(
          `[backend] Failed to ${label}:`,
          error instanceof Error ? error.message : error,
        );
      };
      const jobs: BackendActivityJob[] = [
        {
          name: "activity",
          kind: "native-activity-sweep",
          priority: "progress",
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          run: () => this.nativeAgents.reconcileAgentActivity(),
          onError: warn("reconcile native agent activity"),
        },
        {
          name: "tmux-queues",
          kind: "tmux-queue-drain",
          priority: "progress",
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          run: () => this.promptQueues.drainAll(),
          onError: warn("drain tmux prompt queues"),
        },
        {
          name: "mail-presence",
          kind: "mail-presence",
          priority: "progress",
          // Presence entries expire after 4 s; a 2 s refresh keeps them live.
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          run: () => this.agentMail.refreshPresence(),
          onError: warn("refresh agent mail presence"),
        },
        {
          name: "mail-injection",
          kind: "mail-injection",
          priority: "progress",
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          run: () => this.agentMail.drainInjects(),
          onError: warn("drain agent mail"),
        },
        {
          name: "coordinator-repair",
          kind: "coordinator-repair",
          priority: "recovery",
          intervalMs: MAINTENANCE_JOB_MS,
          run: async () => {
            reconcileCoordinatorWorkflows();
            await coordinatorWorkflowReconcileInFlight;
          },
          onError: warn("reconcile coordinator workflow notifications"),
        },
        {
          name: "mail-retention",
          kind: "mail-retention",
          priority: "maintenance",
          intervalMs: MAINTENANCE_JOB_MS,
          run: async () => {
            await observeSweepStep("mail-retention", () =>
              this.context.storage
                .loadConfig()
                .then((config) =>
                  this.context.storage.pruneAgentMail(
                    config.global.agentMessaging?.retentionDays ?? 14,
                  ),
                ),
            );
          },
          onError: warn("prune agent mail"),
        },
        {
          name: "tab-teardowns",
          kind: "tab-cleanup",
          priority: "maintenance",
          intervalMs: MAINTENANCE_JOB_MS,
          run: async () => {
            reconcileTabTeardownsOnce();
            await tabTeardownReconcileInFlight;
          },
          onError: warn("reconcile tab teardowns"),
        },
        {
          name: "tab-orphans",
          kind: "tab-cleanup",
          priority: "maintenance",
          intervalMs: MAINTENANCE_JOB_MS,
          run: async () => {
            reconcileOrphanedTabResourcesOnce();
            await orphanReconcileInFlight;
          },
          onError: warn("reconcile orphaned tab resources"),
        },
      ];
      if (reconcileClaudeState) {
        jobs.push({
          name: "claude-state",
          kind: "claude-state-reconcile",
          priority: "recovery",
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          run: async () => {
            await observeSweepStep("claude-state-reconcile", () =>
              reconcileClaudeState({}, this.context),
            );
          },
          onError: warn("reconcile Claude terminal activity"),
        });
      }
      if (reconcilePendingEnvironmentRenames) {
        jobs.push({
          name: "pending-renames",
          kind: "pending-rename-reconcile",
          priority: "recovery",
          intervalMs: ACTIVITY_JOB_MS,
          fixedRate: true,
          // Rename intent (task 9): every 2 s while an environment carries
          // one, else a 30 s safety pass; an environment change wakes it.
          run: async () => {
            const result = (await observeSweepStep("pending-rename-reconcile", () =>
              reconcilePendingEnvironmentRenames({}, this.context),
            )) as { pending?: unknown } | undefined;
            return typeof result?.pending === "number" && result.pending === 0
              ? RENAME_SAFETY_MS
              : undefined;
          },
          onError: warn("reconcile pending environment renames"),
        });
      }
      this.activityJobs = new BackendActivityJobs(
        jobs,
        this.activityJobClock
          ? { now: this.activityJobClock.now, timers: this.activityJobClock.timers }
          : {},
      );
      this.activityJobs.start();
    } else if (!this.keyedActivityJobs) {
      this.nativeActivitySweep ??= setInterval(() => {
        void this.nativeAgents.reconcileAgentActivity().catch((error) => {
          console.warn("[backend] Failed to reconcile native agent activity:", error);
        });
        if (reconcileClaudeState) {
          void observeSweepStep("claude-state-reconcile", () =>
            reconcileClaudeState({}, this.context),
          ).catch((error: unknown) => {
            console.warn("[backend] Failed to reconcile Claude terminal activity:", error);
          });
        }
        void this.promptQueues.drainAll().catch((error) => {
          console.warn("[backend] Failed to drain tmux prompt queues:", error);
        });
        void this.agentMail.refreshPresence().catch((error) => {
          console.warn("[backend] Failed to refresh agent mail presence:", error);
        });
        void this.agentMail.drainInjects().catch((error) => {
          console.warn("[backend] Failed to drain agent mail:", error);
        });
        coordinatorWorkflowTick += 1;
        if (coordinatorWorkflowTick % 30 === 0) reconcileCoordinatorWorkflows();
        mailRetentionTick += 1;
        if (mailRetentionTick % 30 === 0) {
          void observeSweepStep("mail-retention", () =>
            this.context.storage
              .loadConfig()
              .then((config) =>
                this.context.storage.pruneAgentMail(
                  config.global.agentMessaging?.retentionDays ?? 14,
                ),
              ),
          ).catch((error) => {
            console.warn("[backend] Failed to prune agent mail:", error);
          });
        }
        if (reconcilePendingEnvironmentRenames) {
          void observeSweepStep("pending-rename-reconcile", () =>
            reconcilePendingEnvironmentRenames({}, this.context),
          ).catch((error: unknown) => {
            console.warn("[backend] Failed to reconcile pending environment renames:", error);
          });
        }
      }, 2_000);
      this.nativeActivitySweep.unref?.();
      // Interrupted tab cleanup is durable and orphan reaping has a one-hour
      // grace period. A one-minute, coalesced sweep is responsive enough without
      // repeatedly parsing layouts or overlapping destructive work.
      this.tabResourceSweep ??= setInterval(() => {
        reconcileTabTeardownsOnce();
        reconcileOrphanedTabResourcesOnce();
      }, 60_000);
      this.tabResourceSweep.unref?.();
    }
    // This credential persists across restarts, so an already configured MCP
    // client can reconnect the instant the listener binds. Publish it only
    // after every authoritative recovery and service initializer above has
    // completed; accepting mutations earlier would race stale backend state.
    await this.controlMcp.start().catch((error) => {
      // MCP is an optional local control surface. A port conflict should be
      // visible in Settings, but must not prevent the rest of Orkestrator from
      // opening so the user can diagnose it.
      console.warn("[backend] Failed to start control MCP:", error);
    });
    this.reserveOwnedPreviewPorts();
    // Node links reach other machines; they start after local recovery and
    // never block it.
    await this.nodes.start().catch((error) => {
      console.warn("[backend] Command-node links did not start:", errorCode(error));
    });
    await this.nodePortal.start().catch((error) => {
      console.warn("[backend] The command-node portal did not start:", errorCode(error));
    });
    this.coordinators.startStatusWakes();
    reconcileCoordinatorWorkflows();
    // Tell the user now, not when a review stage silently fails to submit its
    // result: can agents in containers reach the agent tools server? Runs in
    // the background (a blocked probe takes seconds) and never rejects.
    void this.containerHostReachability?.check("boot");
  }

  /**
   * Whether `command` is registered, independent of whether it can run now.
   *
   * The gateway gates metric labels on this so a name it rejects is never
   * retained, including when `invoke` refuses for an unrelated reason such as
   * shutdown and so never reaches the registry lookup below.
   */
  hasCommand(command: string): boolean {
    return this.commands.has(command);
  }

  /** Orkestrator's own listeners can never be registered as preview targets. */
  private reserveOwnedPreviewPorts(): void {
    const ports: number[] = [];
    const agentToolsPort = (
      this.agentTools as { listeningPort?: () => number | null }
    ).listeningPort?.();
    if (agentToolsPort) ports.push(agentToolsPort);
    const controlUrl = this.controlMcp.getInfo()?.url;
    if (controlUrl) {
      const port = Number(new URL(controlUrl).port);
      if (port > 0) ports.push(port);
    }
    this.context.previews?.reservePorts("backend", ports);
  }

  /**
   * Safe identity for the gateway's authenticated hello handshake: the
   * installation identity, this process's resource generation, the version
   * and the canonical machine profile. No paths or credentials.
   */
  async backendHelloIdentity(): Promise<{
    installationId: string;
    generation: string;
    appVersion: string;
    profile: BackendProfile;
    nodeMode: NodeMode;
  }> {
    const storage = this.context.storage;
    const [identity, profile] = await Promise.all([
      storage.getPreviewBackendIdentity(),
      storage.getBackendProfile(),
    ]);
    return {
      installationId: identity.instanceId,
      generation: storage.getResourceGeneration(),
      appVersion: APP_VERSION,
      profile,
      nodeMode: this.nodes.mode(),
    };
  }

  /**
   * The gateway's view of command-node state: attached command nodes'
   * portal origins are allowed, and their requests record the last contact.
   */
  nodeGateway(): GatewayNodeHooks {
    return {
      isPortalOriginAllowed: (origin) => this.nodes.isPortalOriginAllowed(origin),
      noteControllerContact: (id) => this.nodes.noteControllerContact(id),
      authenticateGrant: (token) => this.nodePortal.grants.authenticate(token)?.expiresAt ?? null,
      relayTarget: (nodeId) => this.nodePortal.relayTarget(nodeId),
    };
  }

  /** Set once the gateway has bound: the origins clients use for this node, read on each attach. */
  setPortalOriginsSource(source: () => string[]): void {
    this.portalOriginsSource = source;
  }

  /**
   * Set once the gateway has bound: its durable token and the origins that
   * serve this backend, read only on a command handover.
   */
  setSelfAccessSource(source: () => Promise<{ token: string | null; origins: string[] }>): void {
    this.selfAccessSource = source;
  }

  /** Backend-owned preview services, for gateway transport adapters. */
  get previews(): PreviewRuntime | undefined {
    return this.context.previews;
  }

  /**
   * The application's real page origins, known only once the gateway has
   * bound: they become the artifact content server's `frame-ancestors`, and
   * the content origin is re-chosen so it never shares a site with them.
   */
  setTranscriptArtifactApplicationOrigins(input: {
    application: string[];
    development?: string[];
  }): void {
    const status = this.transcriptArtifactRuntime?.setApplicationOrigins(input);
    if (status && !status.available)
      console.warn("[backend] Live interactive artifacts are unavailable:", status.reason);
  }

  getControlMcpInfo(): ControlMcpInfo | null {
    return this.controlMcp.getInfo();
  }

  getControlMcpSettings(): ControlMcpSettings {
    return this.controlMcp.getSettings();
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.shuttingDown) throw new Error("Backend is shutting down");
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`Unknown backend command: ${command}`);
    return (await handler(args, this.context)) as T;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    // Stop new annotation reconciliation; pending requests stay as persisted
    // (never marked failed) and resume on the next start.
    this.webAnnotations.stopReconciler();
    // Closes node links and owned SSH tunnels only; nothing on any node stops.
    this.nodeCoordination.collector.dispose();
    this.nodePortal.stop();
    const nodesStopped = this.nodes.stop().catch(() => undefined);
    if (this.activityLeaseSweep) {
      clearInterval(this.activityLeaseSweep);
      this.activityLeaseSweep = null;
    }
    this.hostSuspendDetector?.stop();
    this.hostSuspendDetector = null;
    this.claudeLoginKeeper?.stop();
    this.claudeLoginKeeper = null;
    setHostClaudeLoginRefresher(undefined);
    setLocalClaudeLoginRefresher(undefined);
    setLocalCodexLoginRefresher(undefined);
    // Log followers are observers; stopping them never touches containers.
    shutdownContainerLogService();
    shutdownOomEventWatcher();
    if (this.nativeActivitySweep) {
      clearInterval(this.nativeActivitySweep);
      this.nativeActivitySweep = null;
    }
    if (this.tabResourceSweep) {
      clearInterval(this.tabResourceSweep);
      this.tabResourceSweep = null;
    }
    this.activityJobs?.stop();
    this.activityJobs = null;
    this.coordinators.stopStatusWakes();
    // Synchronous and cannot fail, so it runs before the awaited drain rather
    // than racing it: every watcher holds a file descriptor and a debounce timer.
    this.runtime.shutdown();
    shutdownPrMonitorTracking();
    cancelScheduledEnvironmentCleanup(this.context.storage.getDataDir());
    const attempt = (async () => {
      try {
        const lifecycleDeadline = Date.now() + this.environmentLifecycleDrainTimeoutMs;
        // Close both admission gates before waiting on any in-flight work.
        // Starting the pipeline drain immediately also prevents its scheduler
        // from admitting more backend-owned work during shutdown.
        this.runtime.localServers.closeAdmission();
        const lifecycleDrain = this.environmentLifecycleTasks.beginShutdown(
          this.environmentLifecycleDrainTimeoutMs,
        );
        // Pipeline passes may still be writing snapshots or using a bridge.
        // Drain them before terminating backend-owned local servers — but never
        // let a failed drain skip that teardown, or every backend-owned bridge
        // process outlives the backend as an orphan.
        try {
          await this.nativeAgents.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain native agent work:", error);
        }
        await nodesStopped;
        try {
          await this.buildPipelines.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain build pipelines:", error);
        }
        try {
          await this.loopedReviews.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain looped reviews:", error);
        }
        try {
          await this.multiReviews.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain multi reviews:", error);
        }
        try {
          await this.featurePlanning.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain feature planning:", error);
        }
        try {
          await this.promptQueues.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain tmux prompt queues:", error);
        }
        try {
          await this.agentMail.shutdown();
        } catch (error) {
          console.warn("[backend] Failed to drain agent mail:", error);
        }
        this.workflowAdmission.close();
        await lifecycleDrain;
        await flushTerminalHistories(true);
        await this.runtime.localServers.shutdown({
          operationDrainTimeoutMs: Math.max(0, lifecycleDeadline - Date.now()),
        });
      } finally {
        await this.context.registryWriterLease?.release().catch(() => undefined);
        this.context.previews?.dispose();
        this.context.mcpManagement?.dispose();
        await this.controlMcp.stop();
        await this.agentTools.stop();
        await Promise.race([
          this.webAnnotations.close().catch((error: unknown) => {
            console.warn(
              "[backend] Failed to flush web annotations:",
              error instanceof Error ? error.name : "unknown",
            );
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref?.()),
        ]);
        await this.transcriptArtifactRuntime?.close().catch(() => undefined);
        await this.transcriptArtifacts.close().catch(() => undefined);
        const closeLifecycleStorage = async () => {
          await this.context.design?.close();
          // Last: closing checkpoints the WAL into the database file.
          this.workflowResults.closeStorage();
          this.hostMaintenance.close();
          compatibilityPathUsage.detach(this.compatibilityPathSink);
          closeEnvironmentCleanupStorage();
          this.context.storage.close();
        };
        if (this.environmentLifecycleTasks.pendingCount() > 0) {
          // The quit deadline bounds waiting, not already-admitted deletion.
          // Keep its design coordination and stores usable until it finishes;
          // closing them now would strand the durable deletion tombstone.
          void this.environmentLifecycleTasks
            .whenDrained()
            .then(closeLifecycleStorage)
            .catch((error: unknown) => {
              console.warn("[backend] Failed to close lifecycle storage:", error);
            });
        } else {
          await closeLifecycleStorage();
        }
      }
    })();
    this.shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      throw error;
    }
  }
}

/** Exact `http(s)` origins only (wildcard allow rules are not portal origins), deduplicated. */
function normalizePortalOrigins(values: string[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.hostname.includes("*")) {
        origins.add(url.origin);
      }
    } catch {
      // Not an origin.
    }
  }
  return [...origins].slice(0, 16);
}
