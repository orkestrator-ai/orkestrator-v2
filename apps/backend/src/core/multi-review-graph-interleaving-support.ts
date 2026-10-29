/**
 * A graph-engine Multi Review whose reviewer fan-out runs on the real graph
 * agent executor (item 204's shared AgentBranchRunner) against a fake
 * provider, with backend "processes" a test can crash and restart over one
 * store (item 301's interleaving and dispatch-recovery parity).
 *
 * A process is everything one backend owns: a graph run service (with the
 * real agent executor for the `review` node, pass-through executors for the
 * other agent and system nodes, the real gate and merge), its launch service
 * and Multi Review graph engine, and a Multi Review service. A dead process
 * writes nothing more: its run-store and Multi Review-store calls hang, as a
 * dead backend's calls never return. The provider, the agent tools server and
 * the workflow result service outlive processes, as an environment outlives
 * the backend. Test-only; deterministic apart from the agent tools server's
 * loopback HTTP.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type {
  MultiReviewModelSelection,
  MultiReviewWorkflow,
  StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import { AgentToolsServer } from "./agent-tools.js";
import { GraphArtifactStore } from "./graph-artifacts.js";
import {
  FakeAgentProvider,
  FakeGraphRepo,
  type FakeAgentScript,
} from "./graph-agent-test-support.js";
import { installGraphAgentExecutor, type GraphAgentWiring } from "./graph-agent-wiring.js";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import { FakeGraphExecutors } from "./graph-run-executor-test-support.js";
import {
  GraphNodeExecutorRegistry,
  type GraphExecutorContext,
  type GraphNodeExecutor,
} from "./graph-run-executors.js";
import { GraphRunLaunchService } from "./graph-run-launch.js";
import { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import {
  createGraphTemplateFixture,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";
import { GRAPH_REVIEW_HEAD, graphReviewReport } from "./multi-review-graph-test-support.js";
import { MultiReviewGraphEngine } from "./multi-review-graph-engine.js";
import { MultiReviewService } from "./multi-review-service.js";
import { runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const FINGERPRINT = "a".repeat(64);
/** The template node whose activations run on the real agent executor. */
export const REAL_AGENT_NODE = "review";

/** Hooks a test sets to crash a process at a store write. */
export interface MultiReviewInterleavingHooks {
  /** After a graph run save landed; true kills the process there. */
  afterRunSave?: (run: GraphRun) => boolean;
  /** Before (`landed` false) or after a Multi Review save; true kills the process there. */
  workflowSave?: (workflow: MultiReviewWorkflow, landed: boolean) => boolean;
}

/** One backend process. */
export interface MultiReviewTestProcess {
  graphRuns: GraphRunService;
  wiring: GraphAgentWiring;
  engine: MultiReviewGraphEngine;
  service: MultiReviewService;
  alive: boolean;
  /** Resolves when this process dies (a hook killed it). */
  died: Promise<void>;
  /** The run service's `init`; passes wait for it. */
  ready: Promise<void>;
  kill(): void;
}

export interface MultiReviewInterleavingWorld {
  fixture: GraphTemplateFixture;
  storage: StorageService;
  projectId: string;
  environmentId: string;
  provider: FakeAgentProvider;
  repo: FakeGraphRepo;
  fakes: FakeGraphExecutors;
  hooks: MultiReviewInterleavingHooks;
  /** Graph runs created in the store, by id, in order (every process). */
  createdRuns: string[];
  /** Whether the next processes' Multi Review service has a graph runtime. */
  graphRuntimeAvailable: boolean;
  /**
   * Starts a process. Synchronous up to the executor and tool host, so a
   * restart replaces a dead process before any agent tool call can reach it.
   */
  start(): MultiReviewTestProcess;
  /**
   * Kills the current process (if alive), starts another over the same store
   * and provider, then lets the dead process's controller lease run out.
   */
  restart(workflowId?: string): Promise<MultiReviewTestProcess>;
  current(): MultiReviewTestProcess;
  startReview(input?: Partial<StartMultiReviewInput>): Promise<MultiReviewWorkflow>;
  workflow(id: string): Promise<MultiReviewWorkflow>;
  storedRevision(id: string): Promise<number>;
  run(runId: string): Promise<GraphRun | null>;
  cleanup(): Promise<void>;
}

/** Hangs forever: a dead process's calls never return. */
function never(): Promise<never> {
  return new Promise(() => {});
}

/**
 * The agent executor every process registers: the real one for the reviewer
 * fan-out, the pass-through one for the plan, consolidation, Fix and PR
 * description (whose behaviour other suites own).
 */
function routedAgentExecutor(real: GraphNodeExecutor, fake: GraphNodeExecutor): GraphNodeExecutor {
  // Reviewers run the template's own built-in `discovery-review` prompt on the
  // sealed package.
  const route = (context: GraphExecutorContext): [GraphNodeExecutor, GraphExecutorContext] =>
    context.node.id === REAL_AGENT_NODE ? [real, context] : [fake, context];
  return {
    kind: "agent",
    start: (context) => {
      const [executor, routed] = route(context);
      return executor.start(routed);
    },
    observe: (context) => {
      const [executor, routed] = route(context);
      return executor.observe(routed);
    },
    cancel: (context, reason) => {
      const [executor, routed] = route(context);
      return executor.cancel(routed, reason);
    },
    recover: (context) => {
      const [executor, routed] = route(context);
      return executor.recover ? executor.recover(routed) : executor.observe(routed);
    },
  };
}

export async function multiReviewInterleavingWorld(
  options: {
    script?: FakeAgentScript;
    /**
     * One executor call at a time within a pass (default): reviewers still run
     * side by side at the provider, but the order in which they reach each
     * step is fixed, so a seed replays exactly. Off, their calls overlap.
     */
    serialCalls?: boolean;
  } = {},
): Promise<MultiReviewInterleavingWorld> {
  const fixture = await createGraphTemplateFixture();
  const storage = fixture.storage;
  const projectId = fixture.projectId;
  const dataDir = path.join(fixture.root, "data");
  const worktree = path.join(fixture.root, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  const environmentId = "review-env";
  await storage.addEnvironment(
    graphEnvironmentFixture({
      id: environmentId,
      projectId,
      branch: "change",
      worktreePath: worktree,
      networkAccessMode: "full",
    }),
  );
  const artifacts = new GraphArtifactStore({
    storage,
    fence: { beginMutation: () => () => undefined },
  });
  const workflowResults = new WorkflowResultService(dataDir);
  const agentTools = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
  await agentTools.start();
  const provider = new FakeAgentProvider("claude", options.script ?? (async () => "idle"));
  const repo = new FakeGraphRepo(GRAPH_REVIEW_HEAD);
  const fakes = new FakeGraphExecutors();
  fakes.withSessions = true;
  fakes.withProviderSessions = true;
  fakes.skipKinds.add("gate");
  fakes.skipKinds.add("merge");
  const fakeRegistry = new GraphNodeExecutorRegistry();
  fakes.register(fakeRegistry);
  const processes: MultiReviewTestProcess[] = [];
  const opus: MultiReviewModelSelection = { agent: "claude", model: "opus" };

  const world: MultiReviewInterleavingWorld = {
    fixture,
    storage,
    projectId,
    environmentId,
    provider,
    repo,
    fakes,
    hooks: {},
    createdRuns: [],
    graphRuntimeAvailable: true,
    start() {
      let resolveDied!: () => void;
      const died = new Promise<void>((resolve) => {
        resolveDied = resolve;
      });
      const process: MultiReviewTestProcess = {
        graphRuns: undefined as never,
        wiring: undefined as never,
        engine: undefined as never,
        service: undefined as never,
        alive: true,
        died,
        ready: Promise.resolve(),
        kill() {
          if (!process.alive) return;
          process.alive = false;
          resolveDied();
        },
      };
      // The run store as this process sees it: dead, it hangs.
      const graphRunStore = new Proxy(storage.graphRuns, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!process.alive) await never();
            const result = await (value as (...inner: unknown[]) => unknown).apply(target, args);
            if (property === "createGraphRun") world.createdRuns.push((args[0] as GraphRun).id);
            if (!process.alive) await never();
            if (property === "saveGraphRun" && world.hooks.afterRunSave?.(result as GraphRun)) {
              process.kill();
              await never();
            }
            return result;
          };
        },
      });
      const registry = new GraphNodeExecutorRegistry();
      const graphRuns = new GraphRunService(
        { graphRuns: graphRunStore },
        {
          artifacts,
          executors: registry,
          autoAdvance: false,
          observationIntervalMs: 0,
          progressIntervalMs: 0,
          ...(options.serialCalls === false
            ? {}
            : { concurrency: { admission: 1, observation: 1, provider: 1 } }),
        },
      );
      process.graphRuns = graphRuns;
      // The real agent executor registers on a registry of its own; the
      // router in front of it is what the run service resolves.
      const captured = new GraphNodeExecutorRegistry();
      const wiringRuns = new Proxy(graphRuns, {
        get(target, property) {
          if (property === "executors") return captured;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const wiring = installGraphAgentExecutor({
        graphRuns: wiringRuns,
        artifacts,
        storage,
        invoke: async () => {
          throw new Error("no commands in tests");
        },
        workflowResults,
        agentTools,
        toolResultsEnabled: () => true,
        environmentGit: repo.git,
        workspaceProbe: repo.probe,
        lsRemote: repo.lsRemote,
        enforcementHost: () => ({ claudeSandbox: true }),
        createProvider: async () => provider.asProvider(() => process.alive),
        askHumanHoldMs: 50,
      });
      process.wiring = wiring;
      registry.register(
        routedAgentExecutor(captured.resolve("agent")!, fakeRegistry.resolve("agent")!),
      );
      registry.register(fakeRegistry.resolve("system")!);
      registry.register(fakeRegistry.resolve("human")!);
      registry.register(createGraphGateExecutor());
      registry.register(createGraphMergeExecutor());
      const launches = new GraphRunLaunchService({
        storage,
        templates: fixture.service,
        runs: graphRuns,
        settingsTiers: async () => ({}),
        workspaceHead: async (environment) => ({
          branch: environment.branch,
          headRef: GRAPH_REVIEW_HEAD,
        }),
        linkTicket: async () => undefined,
        host: () => ({ claudeSandbox: true }),
      });
      const engine = new MultiReviewGraphEngine({
        launches,
        runs: graphRuns,
        storage: { graphRuns: storage.graphRuns },
      });
      process.engine = engine;
      // The Multi Review store as this process sees it: dead, it hangs.
      const reviewStore = new Proxy(storage, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          const saving = property === "saveMultiReviewWorkflow";
          return (...args: unknown[]) => {
            if (!process.alive) return never();
            const crashes = (landed: boolean) =>
              saving && world.hooks.workflowSave?.(args[3] as MultiReviewWorkflow, landed) === true;
            if (crashes(false)) {
              process.kill();
              return never();
            }
            const result = (value as (...inner: unknown[]) => unknown).apply(target, args);
            if (!(result instanceof Promise)) return result;
            return result.then(async (settled: unknown) => {
              if (!process.alive) await never();
              if (crashes(true)) {
                process.kill();
                await never();
              }
              return settled;
            });
          };
        },
      }) as StorageService;
      const runtimeAvailable = world.graphRuntimeAvailable;
      process.service = new MultiReviewService(
        reviewStore,
        async <T>(command: string): Promise<T> => {
          if (command === "get_environment_uncommitted_paths") {
            return { head: GRAPH_REVIEW_HEAD, paths: [], fingerprint: FINGERPRINT } as T;
          }
          throw new Error(`unexpected command ${command}`);
        },
        {
          autoAdvance: false,
          graph: {
            engine: async () => "graph",
            runtime: () => (runtimeAvailable ? engine : null),
          },
        },
      );
      process.ready = graphRuns.init();
      processes.push(process);
      return process;
    },
    async restart(workflowId) {
      const previous = processes.at(-1);
      // The old process is dead: its pending calls never finish, and nothing
      // of it is shut down (its locks would wait for them forever).
      if (previous) {
        previous.kill();
        previous.wiring.dispose();
      }
      const next = world.start();
      if (workflowId) {
        // The dead process's controller lease runs out.
        const record = await storage.getMultiReviewWorkflow(workflowId);
        const lease = record?.controllerLease;
        if (lease) {
          await storage.releaseMultiReviewController(workflowId, lease.ownerId, lease.token);
        }
      }
      await next.ready;
      return next;
    },
    current() {
      const process = processes.at(-1);
      if (!process) throw new Error("no process started");
      return process;
    },
    startReview(input = {}) {
      return world.current().service.start({
        environmentId,
        projectId,
        targetBranch: "main",
        reviewers: [opus, { agent: "claude", model: "sonnet" }],
        fixModel: opus,
        ...input,
      });
    },
    async workflow(id) {
      return (await storage.getMultiReviewWorkflow(id))?.snapshot as MultiReviewWorkflow;
    },
    async storedRevision(id) {
      return (await storage.getMultiReviewWorkflow(id))?.revision ?? -1;
    },
    run(runId) {
      return storage.graphRuns.getGraphRun(runId);
    },
    async cleanup() {
      await provider.settle().catch(() => undefined);
      for (const process of processes.splice(0)) {
        if (process.alive) {
          process.wiring.dispose();
          await process.service.shutdown().catch(() => undefined);
          await process.graphRuns.shutdown().catch(() => undefined);
        }
      }
      await agentTools.stop();
      workflowResults.closeStorage();
      await fixture.close();
    },
  };
  return world;
}

/** A clean reviewer report, submitted through the activation's port tool. */
export const INTERLEAVING_REPORT = graphReviewReport({ reviewSummary: "Reviewed" });
