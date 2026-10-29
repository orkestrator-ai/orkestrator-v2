/**
 * Installs the graph agent executor (item 204) on a backend: the executor on
 * `graphRuns.executors`, the activation tool host on the agent tools server,
 * and the question service the `graph_run_answer` command answers through.
 * Kept apart from `index.ts` so the backend wiring is one call.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import type { BuildPipelineProvider, ProviderDependencies } from "./build-pipeline-provider.js";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import { GraphAgentProviders, graphAgentBridgeConnection } from "./graph-agent-providers.js";
import { GraphAgentQuestions } from "./graph-agent-questions.js";
import {
  GraphAgentProgressInbox,
  GraphAgentToolHost,
  type GraphActivationToolHost,
} from "./graph-agent-tools.js";
import { GraphAgentNodeExecutor, type GraphAgentExecutorDependencies } from "./graph-node-agent.js";
import type { GraphRunService } from "./graph-run-service.js";
import type { Environment } from "./models.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";
import type { WorkflowResultReader } from "./workflow-result-service.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";
import { GRAPH_RUN_OBSERVATION_MS } from "./graph-run-pass.js";

export interface GraphAgentWiringInput {
  graphRuns: GraphRunService;
  artifacts: GraphArtifactStore;
  storage: { getEnvironment(environmentId: string): Promise<Environment | null> };
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  workflowResults?: GraphAgentExecutorDependencies["workflowResults"] & WorkflowResultReader;
  providerDependencies?: ProviderDependencies;
  agentTools?: {
    workflowResultConnection?: NonNullable<
      GraphAgentExecutorDependencies["agentTools"]
    >["workflowResultConnection"];
    workflowResultActivationConnection?: NonNullable<
      GraphAgentExecutorDependencies["agentTools"]
    >["workflowResultActivationConnection"];
    setGraphActivationToolHost?(host: GraphActivationToolHost | null): void;
  };
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  toolResultsEnabled?(agent: AgentPlatform): boolean;
  refreshToolResults?(): Promise<void>;
  ceiling?(projectId: string): Promise<GraphCapabilityCeiling | undefined>;
  environmentGit?: EnvironmentGit;
  projectNotes?(projectId: string): Promise<string | undefined>;
  artifactDispatch?: ArtifactTurnDispatch;
  /** Stores activation transcripts for the run view (item 211, `graph-run-transcripts.ts`). */
  captureTranscript?: GraphAgentExecutorDependencies["captureTranscript"];
  /** Tests: provider instances instead of bridges. */
  createProvider?: (
    environment: Environment,
    agent: AgentPlatform,
  ) => Promise<BuildPipelineProvider>;
  /** Tests: how long `ask_human` holds before asking the agent to end its turn. */
  askHumanHoldMs?: number;
}

export interface GraphAgentWiring {
  executor: GraphAgentNodeExecutor;
  questions: GraphAgentQuestions;
  providers: GraphAgentProviders;
  /** Unregisters the executor and the tool host, and retires providers. */
  dispose(): void;
}

export function installGraphAgentExecutor(input: GraphAgentWiringInput): GraphAgentWiring {
  const questions = new GraphAgentQuestions({
    runs: input.graphRuns,
    ...(input.askHumanHoldMs !== undefined ? { holdMs: input.askHumanHoldMs } : {}),
  });
  const progress = new GraphAgentProgressInbox();
  const providers = new GraphAgentProviders({
    ...(input.createProvider ? { create: input.createProvider } : {}),
    connection: (environment, agent) =>
      graphAgentBridgeConnection(input.invoke, agent, environment),
    dependencies: {
      ...input.providerDependencies,
      ...(input.workflowResults ? { workflowResults: input.workflowResults } : {}),
    },
  });
  const tools = input.agentTools;
  const agentTools =
    tools?.workflowResultConnection && tools.workflowResultActivationConnection
      ? {
          workflowResultConnection: tools.workflowResultConnection.bind(tools),
          workflowResultActivationConnection: tools.workflowResultActivationConnection.bind(tools),
        }
      : undefined;
  const executor = new GraphAgentNodeExecutor({
    storage: input.storage,
    providers,
    questions,
    progress,
    ...(input.workflowResults ? { workflowResults: input.workflowResults } : {}),
    ...(agentTools ? { agentTools } : {}),
    ...(input.assertAgentToolsReachable
      ? { assertAgentToolsReachable: input.assertAgentToolsReachable }
      : {}),
    ...(input.toolResultsEnabled ? { toolResultsEnabled: input.toolResultsEnabled } : {}),
    ...(input.refreshToolResults ? { refreshToolResults: input.refreshToolResults } : {}),
    ...(input.ceiling ? { ceiling: input.ceiling } : {}),
    ...(input.environmentGit ? { environmentGit: input.environmentGit } : {}),
    ...(input.projectNotes ? { projectNotes: input.projectNotes } : {}),
    ...(input.artifactDispatch ? { artifactDispatch: input.artifactDispatch } : {}),
    ...(input.captureTranscript ? { captureTranscript: input.captureTranscript } : {}),
    // The idle-result grace is counted on the run's observation cadence.
    pollGate: (() => {
      const gate = new ElapsedPollGate(GRAPH_RUN_OBSERVATION_MS);
      return {
        count: (scope: string) => gate.count(scope, "explicit"),
        exhausted: (scope: string, count: number, limit: number) =>
          gate.exhausted(scope, count, limit),
        clear: (scope: string) => gate.clear(scope),
      };
    })(),
  });
  const unregister = input.graphRuns.executors.register(executor);
  const toolHost = new GraphAgentToolHost({
    runs: input.graphRuns,
    artifacts: input.artifacts,
    questions,
    progress,
  });
  tools?.setGraphActivationToolHost?.(toolHost);
  return {
    executor,
    questions,
    providers,
    dispose: () => {
      unregister();
      tools?.setGraphActivationToolHost?.(null);
      providers.shutdown();
    },
  };
}
