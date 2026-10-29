import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { GraphArtifactStore } from "../graph-artifacts.js";
import { GraphRunLaunchService } from "../graph-run-launch.js";
import { GraphRunService } from "../graph-run-service.js";
import { GraphTemplateService } from "../graph-template-service.js";
import { createProject } from "../storage.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * Real graph services over a public-API harness's real storage and registry,
 * for the `graph.*` actions and the CLI round trip: the template library, the
 * run service (driven by hand, so no run advances by itself) and the launch
 * service every surface uses. Environment `env-1` is a running local worker;
 * the user template `ticket-loop` (the §9.2 loop) takes a `ticket@1` input
 * and fills its `workspace@1` input from the environment's HEAD.
 */
export interface GraphHarness {
  harness: PublicApiHarness;
  templates: GraphTemplateService;
  runs: GraphRunService;
  launches: GraphRunLaunchService;
  projectId: string;
  ticketId: string;
  /** Ticket links the launch made, as `[taskId, environmentId]`. */
  linked: Array<[string, string]>;
  /** A new backend generation over the same data directory, with new services. */
  restart(): Promise<GraphHarness>;
  cleanup(): Promise<void>;
}

export const GRAPH_TEST_HEAD = "c".repeat(40);

/** The §9.2 loop as a user template: a ticket input, roles with action-key defaults. */
export function ticketLoopTemplate(id = "ticket-loop"): GraphTemplateV1 {
  return {
    ...graphTemplateExample("build-pipeline-loop"),
    id,
    name: `Ticket loop ${id}`,
    revision: 0,
  };
}

async function attach(
  harness: PublicApiHarness,
  ids: { projectId: string; ticketId: string },
): Promise<GraphHarness> {
  const storage = harness.storage;
  const linked: Array<[string, string]> = [];
  const templates = new GraphTemplateService({
    storage,
    builtins: () => [],
    host: () => ({ claudeSandbox: true }),
    startWatch: null,
  });
  const artifacts = new GraphArtifactStore({ storage, fence: { beginMutation: () => () => {} } });
  const runs = new GraphRunService(storage, { artifacts, autoAdvance: false });
  await runs.init();
  const launches = new GraphRunLaunchService({
    storage,
    templates,
    runs,
    settingsTiers: async () => ({}),
    workspaceHead: async (environment) => ({
      branch: environment.branch,
      headRef: GRAPH_TEST_HEAD,
    }),
    linkTicket: async (taskId, environmentId) => {
      linked.push([taskId, environmentId]);
      await harness.commands.get("update_kanban_task")!({ taskId, environmentId }, harness.context);
    },
    host: () => ({ claudeSandbox: true }),
  });
  Object.assign(harness.context, {
    graphTemplates: templates,
    graphRuns: runs,
    graphLaunches: launches,
  });
  return {
    harness,
    templates,
    runs,
    launches,
    linked,
    ...ids,
    async restart() {
      await runs.shutdown();
      templates.shutdown();
      return attach(await harness.restart(), ids);
    },
    async cleanup() {
      await runs.shutdown();
      templates.shutdown();
      await harness.cleanup();
    },
  };
}

export async function createGraphHarness(): Promise<GraphHarness> {
  const harness = await createPublicApiHarness();
  const { projectPath, originPath } = await harness.createRepository("graphs");
  const project = await harness.storage.addProject(createProject(originPath, projectPath));
  await harness.storage.addEnvironment({
    id: "env-1",
    projectId: project.id,
    name: "graphs",
    branch: "graphs",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: projectPath,
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  const ticket = await harness.storage.kanban.addKanbanTask(
    project.id,
    "Add a --verbose flag",
    "SECRET-TICKET-BODY: the CLI needs a verbose mode.",
    { acceptanceCriteria: "- `--verbose` prints each step" },
  );
  // Every provider enabled, so the pickers judge Grok against floors too.
  const config = await harness.storage.loadConfig();
  await harness.storage.saveConfig({
    ...config,
    global: { ...config.global, enabledAgentPlatforms: [...AGENT_PLATFORMS] },
  });
  const graph = await attach(harness, { projectId: project.id, ticketId: ticket.id });
  await graph.templates.save(ticketLoopTemplate());
  return graph;
}
