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
import type { MultiReviewService } from "./multi-review-service.js";
import type { NativeAgentSuborkService } from "./native-agent-suborks.js";
import type { NativeAgentService } from "./native-agent-service.js";
import type { FeaturePlanningService } from "./feature-planning.js";
import type {
  ControlMcpSettings,
  CoordinatorControlConnection,
  CoordinatorControlScope,
} from "./control-mcp/index.js";
import type { CoordinatorService } from "./coordinator-service.js";
import type { ProjectGitService } from "./project-git-service.js";

export type { BackendEmit, BackendEventSink } from "./backend-emit.js";
import type { BackendEmit } from "./backend-emit.js";

export type CommandContext = {
  design?: import("./design/index.js").DesignService;
  previews?: import("./preview-runtime.js").PreviewRuntime;
  mcpManagement?: import("./mcp-management/index.js").McpManagementService;
  webAnnotations?: import("./web-annotations/index.js").WebAnnotationService;
  /** Transcript artifacts: durable revisions, receipts and publications. */
  transcriptArtifacts?: import("./transcript-artifacts/index.js").TranscriptArtifactService;
  /** Backend rollout switch for web annotations (enabled / read-only / disabled). */
  webAnnotationRollout?: import("./web-annotations/index.js").WebAnnotationRollout;
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
    workflowResultConnection?(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      resultKey: string,
      provider?: AgentPlatform,
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
    /** Doorbell credential for a container's claude-tmux hook script (`tmux-hook-signal.ts`). */
    issueTmuxHookSignal?(onSignal: () => void): StateSignalCredential | null;
  };
  /** Container → host agent tools reachability checks (startup, bridges, preflight). */
  containerHostReachability?: import("./container-host-reachability.js").ContainerHostReachabilityService;
  buildPipelines?: BuildPipelineService;
  nativeAgents?: NativeAgentService;
  suborks?: NativeAgentSuborkService;
  multiReviews?: MultiReviewService;
  /** Auto-merge of ready pull requests (`pr-auto-merge.ts`); absent in fixtures. */
  prAutoMerge?: import("./pr-auto-merge.js").PrAutoMergeController;
  featurePlanning?: FeaturePlanningService;
  workflowResults?: import("./workflow-result-service.js").WorkflowResultService;
  /** Remote-initiated Orkestrator updates of this host. */
  hostMaintenance?: import("./host-maintenance.js").HostMaintenanceService;
  /** Environment deletion: drops the environment's workflow result slots. */
  deleteWorkflowResultsByEnvironment?: (environmentId: string) => Promise<unknown>;
  workflowResultRollout?: import("./workflow-result-rollout.js").WorkflowResultRollout;
  coordinators?: CoordinatorService;
  /** User `!` commands run from agent composers (user-commands.ts). */
  userCommands?: import("./user-commands.js").UserCommandService;
  /** Shell prompts waiting on the user, from every detector (human-prompt-registry.ts). */
  humanPrompts?: import("./human-prompt-registry.js").HumanPromptRegistry;
  /** This machine's rolling CPU and RAM averages, read through `get_machine_load`. */
  machineLoad?: import("./machine-load.js").MachineLoadSampler;
  /** Health, database and metrics figures for the Debug settings and the bundle. */
  diagnostics?: import("./backend-diagnostics.js").BackendDiagnostics;
  /** Command-node registry and leaf attachments (docs/architecture/command-nodes.md). */
  nodes?: import("./nodes/index.js").NodeService;
  /** Portal read model, routing and workspaces (command node); client grants (leaf). */
  nodePortal?: import("./nodes/index.js").NodePortal;
  /** Leaf mail, the outbox and user-approved action requests. */
  nodeCoordination?: import("./nodes/index.js").NodeCoordination;
  /** Shared usage readings with the nodes this one controls; see `nodes/node-usage-sync.ts`. */
  usageSync?: { noteLocalChange(): void };
  /** Automatic account switching; see `agent-accounts-auto-switch.ts`. */
  accountAutoSwitch?: import("./agent-accounts-auto-switch.js").AgentAccountAutoSwitcher;
  projectGit?: ProjectGitService;
  controlMcp?: {
    getSettings(): ControlMcpSettings;
    rotateToken(): Promise<ControlMcpSettings>;
    createCredential(
      input: import("./control-mcp/index.js").CreateControlMcpCredentialInput,
    ): Promise<ControlMcpSettings>;
    rotateCredential(credentialId: string): Promise<ControlMcpSettings>;
    revokeCredential(credentialId: string): Promise<ControlMcpSettings>;
    issueCoordinatorCredential(scope: CoordinatorControlScope): CoordinatorControlConnection;
    revokeCoordinatorCredentials(coordinatorId: string, conversationId?: string): void;
  };
  notifyAgentTurnCompleted?: (environmentId: string) => Promise<void>;
  probeAgentCreatedPullRequest?: (environmentId: string) => Promise<void>;
  drainAgentMail?: () => Promise<void>;
  /** Durable, backend-timed scheduled jobs (docs/architecture/scheduled-jobs.md). */
  scheduledJobs?: import("./scheduled-jobs/index.js").ScheduledJobService;
  /** Experimental self-improvement runs (docs/architecture/self-improvement.md). */
  selfImprovement?: import("./self-improvement/index.js").SelfImprovementService;
  /** Every agent tab in the app and what it is doing; see agent-registry.ts. */
  agentRegistry?: import("./agent-registry.js").AgentRegistry;
  /** The graph template library: scopes, trust and per-project ceilings (item 109). */
  graphTemplates?: import("./graph-template-service.js").GraphTemplateService;
  /** Graph runs: launch, read, cancel, pause and resume (items 202, 203; launch surfaces 214). */
  graphRuns?: import("./graph-run-service.js").GraphRunService;
  /** Launches a saved graph template from every surface (item 214). */
  graphLaunches?: import("./graph-run-launch.js").GraphRunLaunchService;
  /** Agent `ask_human` questions and their answers (item 204; `graph_run_answer`). */
  graphQuestions?: import("./graph-agent-questions.js").GraphAgentQuestions;
  /** "Describe a graph" jobs, one per environment (item 215). */
  graphDescribe?: import("./graph-describe-service.js").GraphDescribeService;
  /** Mock run launches and their retention (item 213; `graph_run_mock`). */
  graphMock?: import("./graph-mock-launch.js").GraphMockRuns;
  /** Human node answers (item 208; `graph_run_answer`'s human-node form). */
  graphHumanAnswers?: import("./graph-node-human.js").GraphHumanAnswers;
};

/**
 * The contract fields of one call's invoke envelope (`{ command, args,
 * domain?, version?, critical? }`, docs/reports/unified-federation.md §11.2
 * "Must-understand"), as a transport decoded them. Absent for an older client
 * that sends only `command` and `args`, and for in-process calls.
 *
 * `signal` is not an envelope field: it is the call's own cancellation, set by
 * the gateway when the client that sent the call goes away and by in-process
 * callers that bound their wait (`ControlMcpInvoker`'s `options.signal`). A
 * handler may honour it; most do not, and a call without one runs as before.
 */
export type CommandInvocation = {
  readonly domain?: string;
  readonly version?: number;
  readonly critical?: readonly string[];
  readonly signal?: AbortSignal;
};

/**
 * A registered command's handler. `invocation` reaches the registry's own
 * wrapper (which checks the version range and the critical fields); handlers
 * and wrapping registrars may ignore it, or read its `signal` to stop work the
 * caller no longer waits for. A wrapper must pass it on unchanged.
 */
export type CommandHandler = (
  args: JsonRecord,
  context: CommandContext,
  invocation?: CommandInvocation,
) => Promise<unknown> | unknown;
