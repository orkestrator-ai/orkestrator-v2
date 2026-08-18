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
    ): AgentToolConnection;
    revokeEnvironment(environmentId: string): void;
  };
  buildPipelines?: BuildPipelineService;
  nativeAgents?: NativeAgentService;
  loopedReviews?: LoopedReviewService;
  multiReviews?: MultiReviewService;
  featurePlanning?: FeaturePlanningService;
  notifyAgentTurnCompleted?: (environmentId: string) => Promise<void>;
  probeAgentCreatedPullRequest?: (environmentId: string) => Promise<void>;
};

export type CommandHandler = (
  args: JsonRecord,
  context: CommandContext,
) => Promise<unknown> | unknown;
