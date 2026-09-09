import type {
  AgentPlatform,
  AgentToolConnection,
  BuildPipelineService,
  EnvironmentLifecycleTaskTracker,
  JsonRecord,
  LoopedReviewService,
  MultiReviewService,
  NativeAgentService,
  StorageService,
  FeaturePlanningService,
} from "./commands-dependencies.js";
import type {
  ControlMcpSettings,
  CoordinatorControlConnection,
  CoordinatorControlScope,
} from "./control-mcp-server.js";
import type { CoordinatorService } from "./coordinator-service.js";
import type { ProjectGitService } from "./project-git-service.js";

export type BackendEmit = (event: string, payload: unknown) => void;

export type CommandContext = {
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
  };
  buildPipelines?: BuildPipelineService;
  nativeAgents?: NativeAgentService;
  loopedReviews?: LoopedReviewService;
  multiReviews?: MultiReviewService;
  featurePlanning?: FeaturePlanningService;
  workflowResults?: import("./workflow-result-service.js").WorkflowResultService;
  workflowResultRollout?: import("./workflow-result-rollout.js").WorkflowResultRollout;
  coordinators?: CoordinatorService;
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
};

export type CommandHandler = (
  args: JsonRecord,
  context: CommandContext,
) => Promise<unknown> | unknown;
