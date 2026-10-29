/**
 * A world for mock run tests (item 213): a temporary store with a project and
 * an environment, the template library, a run service driven by hand, the
 * real gate, merge, agent and system executors behind recording fakes (a
 * fake provider, command invoker, shell and PR monitor that note every call),
 * the mock executors and the mock launcher. A mock run that reached any live
 * side effect or provider shows up in those records. Test-only.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { graphTemplateExamples } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphArtifactStore } from "./graph-artifacts.js";
import { FakeAgentProvider } from "./graph-agent-test-support.js";
import { installGraphAgentExecutor, type GraphAgentWiring } from "./graph-agent-wiring.js";
import { GraphMockRuns, type GraphMockLaunchInput } from "./graph-mock-launch.js";
import { installGraphMockExecutors } from "./graph-mock-provider.js";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import { GraphNodeSystemExecutor } from "./graph-node-system.js";
import { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import type { GraphEnvironmentShell } from "./graph-system-environment.js";
import { GraphTemplateService } from "./graph-template-service.js";
import { ManualTime } from "./recurring-test-support.js";
import { StorageService, createProject } from "./storage.js";

const GRAPH_MOCK_WORLD_EPOCH = Date.parse("2026-10-29T00:00:00.000Z");

/** Every call a live executor made to the outside world. */
export interface GraphMockWorldCalls {
  /** Backend commands (PR, ticket, environment, validation, mail). */
  commands: string[];
  /** Git, remote git, gh and file reads in an environment. */
  shell: string[];
  /** PR monitor reads, subscriptions and watches. */
  monitor: string[];
  /** Provider construction for an agent session. */
  providers: number;
}

export interface GraphMockWorld {
  root: string;
  storage: StorageService;
  projectId: string;
  environmentId: string;
  templates: GraphTemplateService;
  artifacts: GraphArtifactStore;
  service: GraphRunService;
  mock: GraphMockRuns;
  provider: FakeAgentProvider;
  calls: GraphMockWorldCalls;
  time: ManualTime;
  /** Saves a user template (revision 0 creates) and returns its ref. */
  save(template: GraphTemplateV1): Promise<GraphTemplateRef>;
  /** Launches a mock run of a saved template in the world's project. */
  launch(ref: GraphTemplateRef, input?: Partial<GraphMockLaunchInput>): Promise<GraphRun>;
  /** Passes, one observation period apart, until the run is terminal or `done`. */
  finish(runId: string, done?: (run: GraphRun) => boolean, passes?: number): Promise<GraphRun>;
  cleanup(): Promise<void>;
}

/** An object whose every method records its name and refuses. */
function recordingRefusal<T extends object>(log: string[], what: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      return (..._args: unknown[]) => {
        log.push(String(property));
        throw new Error(`A mock run must not use the ${what} (${String(property)})`);
      };
    },
  });
}

export async function graphMockWorld(
  options: { humanExecutor?: boolean } = {},
): Promise<GraphMockWorld> {
  const root = await mkdtemp(path.join(tmpdir(), "orkestrator-graph-mock-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const projectId = (
    await storage.addProject(createProject("https://example.invalid/repo.git", checkout))
  ).id;
  await storage.addEnvironment(graphEnvironmentFixture({ projectId, worktreePath: checkout }));
  const templates = new GraphTemplateService({
    storage,
    host: () => ({ claudeSandbox: true }),
    startWatch: null,
  });
  const artifacts = new GraphArtifactStore({
    storage,
    fence: { beginMutation: () => () => undefined },
  });
  const time = new ManualTime(0);
  const service = new GraphRunService(storage, {
    artifacts,
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    // Record and executor time follow the manual clock too (`stepMs`).
    clock: () => new Date(GRAPH_MOCK_WORLD_EPOCH + time.now()),
  });
  await service.init();
  const calls: GraphMockWorldCalls = { commands: [], shell: [], monitor: [], providers: 0 };

  // The live executors a real run would use, each behind a recording fake.
  service.executors.register(createGraphGateExecutor());
  service.executors.register(createGraphMergeExecutor());
  const provider = new FakeAgentProvider("claude", async () => "idle");
  const agents: GraphAgentWiring = installGraphAgentExecutor({
    graphRuns: service,
    artifacts,
    storage,
    invoke: async (command) => {
      calls.commands.push(command);
      throw new Error("A mock run must not invoke commands");
    },
    createProvider: async () => {
      calls.providers += 1;
      return provider.asProvider();
    },
  });
  const system = new GraphNodeSystemExecutor({
    storage,
    invoke: async (command) => {
      calls.commands.push(command);
      throw new Error("A mock run must not invoke commands");
    },
    shell: recordingRefusal<GraphEnvironmentShell>(calls.shell, "environment shell"),
    prMonitor: recordingRefusal(calls.monitor, "PR monitor"),
    requestObservation: () => undefined,
    owner: "live-system",
    inlineWaitMs: 0,
  });
  service.executors.register(system);
  if (options.humanExecutor) {
    // A stand-in for item 208's executor: waits until the test answers.
    service.executors.register({
      kind: "human",
      start: async () => ({ state: "awaiting-human", observeAfterMs: null }),
      observe: async () => ({ state: "unchanged", observeAfterMs: null }),
      cancel: async () => ({ state: "cancelled" }),
    });
  }
  installGraphMockExecutors(service.executors, { storage, owner: "mock-test" });
  const mock = new GraphMockRuns({ templates, runs: service, storage });

  const world: GraphMockWorld = {
    root,
    storage,
    projectId,
    environmentId: "e1",
    templates,
    artifacts,
    service,
    mock,
    provider,
    calls,
    time,
    async save(template) {
      const detail = await templates.save(template, { projectId });
      return detail.summary.ref;
    },
    async launch(ref, input = {}) {
      const result = await mock.launch({ ref, projectId, ...input });
      const run = await storage.graphRuns.getGraphRun(result.run.id);
      if (!run) throw new Error("the mock run was not stored");
      return run;
    },
    async finish(runId, done, passes = 120) {
      for (let index = 0; index < passes; index++) {
        time.jump(3_000);
        const run = await service.advanceNow(runId);
        if (!run) throw new Error("the run disappeared");
        if (done?.(run)) return run;
        if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
          return run;
        }
      }
      throw new Error("the run did not finish");
    },
    async cleanup() {
      mock.dispose();
      system.shutdown();
      agents.dispose();
      await service.shutdown();
      templates.shutdown();
      storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return world;
}

/** Report §9.3 without the sub-graph (Phase 4): build feeds describe-pr and the PR directly. */
export function designBakeOffWithoutSubgraph(template: GraphTemplateV1): GraphTemplateV1 {
  const next = structuredClone(template);
  next.nodes = next.nodes.filter((node) => node.id !== "review");
  next.edges = next.edges.filter(
    (edge) => !["build-review", "review-describe", "review-pr"].includes(edge.id),
  );
  next.edges.push(
    {
      id: "build-describe",
      from: { node: "build", port: "code" },
      to: { node: "describe-pr", port: "code" },
    },
    { id: "build-pr", from: { node: "build", port: "code" }, to: { node: "pr", port: "code" } },
  );
  next.roles = next.roles.filter(
    (role) => !["preparer", "reviewer", "consolidator"].includes(role.key),
  );
  if (next.layout) delete next.layout.review;
  return next;
}

/**
 * The examples as the runtime runs them, under user-template ids: §9.3
 * without its sub-graph (item 402); §9.4 as written, with its `items`
 * fan-out (item 401).
 */
export function phase2Examples(): { section: string; template: GraphTemplateV1 }[] {
  return graphTemplateExamples().map((example) => {
    let template = example.template;
    if (example.key === "design-bake-off") template = designBakeOffWithoutSubgraph(template);
    return {
      section: example.reportSection,
      template: { ...template, id: `mock-${template.id}`, revision: 0 },
    };
  });
}
