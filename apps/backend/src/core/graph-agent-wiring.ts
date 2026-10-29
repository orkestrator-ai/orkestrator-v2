/**
 * Installs the graph agent executor (item 204) on a backend: the executor on
 * `graphRuns.executors`, the activation tool host on the agent tools server,
 * the question service the `graph_run_answer` command answers through, and
 * the read-only guard's submit-time check on `graph-output` slots (item 209).
 * Kept apart from `index.ts` so the backend wiring is one call.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  AgentEnforcementHost,
  GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import type { BuildPipelineProvider, ProviderDependencies } from "./build-pipeline-provider.js";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import type { GraphLsRemote } from "./graph-agent-guards.js";
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
import type { WorkflowResultReader, WorkflowResultService } from "./workflow-result-service.js";
import { commandWorkspaceProbe, type WorkspaceSnapshotProbe } from "./workspace-read-only-guard.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";
import { GRAPH_RUN_OBSERVATION_MS } from "./graph-run-pass.js";

/** Immediate probe attempts per guard observation, as the pipeline's guard uses. */
const GRAPH_GUARD_PROBE_ATTEMPTS = 3;

export interface GraphAgentWiringInput {
  graphRuns: GraphRunService;
  artifacts: GraphArtifactStore;
  storage: { getEnvironment(environmentId: string): Promise<Environment | null> };
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  workflowResults?: GraphAgentExecutorDependencies["workflowResults"] &
    WorkflowResultReader &
    Partial<Pick<WorkflowResultService, "addAcceptanceCheck">>;
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
  /** Creates isolated branches' worktrees (item 403). */
  branchWorktrees?: GraphAgentExecutorDependencies["branchWorktrees"];
  /** The guards' worktree probe; default `get_environment_uncommitted_paths` through `invoke`. */
  workspaceProbe?: WorkspaceSnapshotProbe;
  /** `git ls-remote` with the environment's credentials (the remote-ref guard). */
  lsRemote?: GraphLsRemote;
  /** Commits the run's system nodes pushed (their `push:<branch>:<sha>` effects). */
  systemPushes?(runId: string): Promise<ReadonlySet<string>>;
  /** What the enforcement matrix may assume about the host; default the live probe. */
  enforcementHost?(environment: Environment): AgentEnforcementHost;
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
    ...(input.branchWorktrees ? { branchWorktrees: input.branchWorktrees } : {}),
    workspaceProbe:
      input.workspaceProbe ??
      commandWorkspaceProbe(
        (command, args) => input.invoke(command, args),
        GRAPH_GUARD_PROBE_ATTEMPTS,
      ),
    ...(input.lsRemote ? { lsRemote: input.lsRemote } : {}),
    ...(input.systemPushes ? { systemPushes: input.systemPushes } : {}),
    ...(input.enforcementHost ? { enforcementHost: input.enforcementHost } : {}),
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
  // The read-only guard's submit-time check, scoped to graph activations'
  // own result keys: another owner's `graph-output` attempt is let through.
  const unregisterCheck = input.workflowResults?.addAcceptanceCheck?.(
    "graph-output",
    executor.guards.acceptanceCheck(async (attempt) => {
      const found = await input.graphRuns.activationForResultKey(
        attempt.environmentId,
        attempt.resultKey,
      );
      if (!found) return null;
      const { run, activation } = found;
      if (activation.state !== "running" && activation.state !== "awaiting-human") return null;
      const node = run.plan.nodes.find((entry) => entry.id === activation.nodeId);
      if (node?.kind !== "agent") return null;
      return {
        environmentId: attempt.environmentId,
        node,
        baseline: activation.baseline,
        ...(activation.worktree ? { worktree: activation.worktree } : {}),
      };
    }),
  );
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
      unregisterCheck?.();
      tools?.setGraphActivationToolHost?.(null);
      providers.shutdown();
    },
  };
}
