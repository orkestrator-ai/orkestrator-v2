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
import type { ControlMcpSettings } from "./control-mcp-server.js";

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
  };
  buildPipelines?: BuildPipelineService;
  nativeAgents?: NativeAgentService;
  loopedReviews?: LoopedReviewService;
  multiReviews?: MultiReviewService;
  featurePlanning?: FeaturePlanningService;
  controlMcp?: {
    getSettings(): ControlMcpSettings;
    rotateToken(): Promise<ControlMcpSettings>;
  };
  notifyAgentTurnCompleted?: (environmentId: string) => Promise<void>;
  probeAgentCreatedPullRequest?: (environmentId: string) => Promise<void>;
};

export type CommandHandler = (
  args: JsonRecord,
  context: CommandContext,
) => Promise<unknown> | unknown;
