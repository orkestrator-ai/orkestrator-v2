import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  AgentToolConnection,
  StateSignalCredential,
  WorktreeSignalReason,
} from "./agent-tools.js";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { BackendRuntime } from "./backend-runtime.js";
import type { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { JsonRecord, StorageService } from "./storage.js";
import type { LoopedReviewService } from "./looped-review-service.js";
import type { MultiReviewService } from "./multi-review-service.js";
import type { NativeAgentService } from "./native-agent-service.js";
import type { FeaturePlanningService } from "./feature-planning.js";
import type {
  ControlMcpSettings,
  CoordinatorControlConnection,
  CoordinatorControlScope,
} from "./control-mcp-server.js";
import type { CoordinatorService } from "./coordinator-service.js";
import type { ProjectGitService } from "./project-git-service.js";

export type BackendEmit = (event: string, payload: unknown) => void;

export type CommandContext = {
  design?: import("./design/index.js").DesignService;
  previews?: import("./preview-runtime.js").PreviewRuntime;
  mcpManagement?: import("./mcp-management/service.js").McpManagementService;
  webAnnotations?: import("./web-annotation-service.js").WebAnnotationService;
  /** Transcript artifacts: durable revisions, receipts and publications. */
  transcriptArtifacts?: import("./transcript-artifacts/service.js").TranscriptArtifactService;
  /** Backend rollout switch for web annotations (enabled / read-only / disabled). */
  webAnnotationRollout?: import("./web-annotation-rollout.js").WebAnnotationRollout;
  storage: StorageService;
  emit: BackendEmit;
  appRoot: string;
  resourceRoot: string;
  runtimeFlavor?: "production" | "development" | "agent-test";
  worktreeDir?: string;
  dockerImage?: string;
  strictDockerOwner?: boolean;
  credentialSources?: ReadonlySet<AgentPlatform>;
  environmentLifecycleTasks: EnvironmentLifecycleTaskTracker;
  /** State owned by this backend instance; reach it through the context at call time. */
  runtime: BackendRuntime;
  /**
   * Exclusive right to mutate this registry's containers. Held by the backend
   * process; absent only in embedded command fixtures, which own a private
   * data directory.
   */
  registryWriterLease?: import("./registry-writer-lease.js").RegistryWriter;
  toolchainBinDir?: string;
  agentTools?: {
    connection(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      tabId?: string,
    ): AgentToolConnection;
    revokeEnvironment(environmentId: string): void;
    revokeTab?(environmentId: string, tabId: string): void;
    /** Port containers call back to; the network policy allows exactly it. */
    servicePort?(): number | null;
    /** Doorbell credential for the Claude terminal state signal. */
    issueStateSignal?(onSignal: () => void): StateSignalCredential | null;
    /** Doorbell credential for a container worktree watcher (`container-worktree-signal.ts`). */
    issueWorktreeSignal?(
      onSignal: (reason: WorktreeSignalReason) => void,
    ): StateSignalCredential | null;
  };
  /** Container → host agent tools reachability checks (startup, bridges, preflight). */
  containerHostReachability?: import("./container-host-reachability.js").ContainerHostReachabilityService;
  buildPipelines?: BuildPipelineService;
  nativeAgents?: NativeAgentService;
  loopedReviews?: LoopedReviewService;
  multiReviews?: MultiReviewService;
  featurePlanning?: FeaturePlanningService;
  workflowResults?: import("./workflow-result-service.js").WorkflowResultService;
  /** Remote-initiated Orkestrator updates of this host. */
  hostMaintenance?: import("./host-maintenance.js").HostMaintenanceService;
  /** The pinned, managed `gh`, which `host.gh.update` switches back to. */
  pinnedGitHubCli?: string;
  /** Environment deletion: drops the environment's workflow result slots. */
  deleteWorkflowResultsByEnvironment?: (environmentId: string) => Promise<unknown>;
  workflowResultRollout?: import("./workflow-result-rollout.js").WorkflowResultRollout;
  coordinators?: CoordinatorService;
  /** Command-node registry and leaf attachments (docs/architecture/command-nodes.md). */
  nodes?: import("./nodes/node-service.js").NodeService;
  /** Portal read model, routing and workspaces (command node); client grants (leaf). */
  nodePortal?: import("./nodes/node-portal.js").NodePortal;
  /** Leaf mail, the outbox and user-approved action requests. */
  nodeCoordination?: import("./nodes/node-coordination.js").NodeCoordination;
  projectGit?: ProjectGitService;
  controlMcp?: {
    getSettings(): ControlMcpSettings;
    rotateToken(): Promise<ControlMcpSettings>;
    issueCoordinatorCredential(scope: CoordinatorControlScope): CoordinatorControlConnection;
    revokeCoordinatorCredentials(coordinatorId: string, conversationId?: string): void;
  };
  notifyAgentTurnCompleted?: (environmentId: string) => Promise<void>;
  probeAgentCreatedPullRequest?: (environmentId: string) => Promise<void>;
  drainAgentMail?: () => Promise<void>;
  /** Every agent tab in the app and what it is doing; see agent-registry.ts. */
  agentRegistry?: import("./agent-registry.js").AgentRegistry;
};

export type CommandHandler = (
  args: JsonRecord,
  context: CommandContext,
) => Promise<unknown> | unknown;
