import { BuildPipelineService } from "../build-pipeline-service.js";
import { FakeProvider } from "../build-pipeline-service-test-support.js";
import { createProject } from "../storage.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";

/**
 * A real `BuildPipelineService` over a public-API harness's real storage and
 * registry, for the `build.*` actions and the CLI round trip. Its environment
 * `env-1` is a running worker with setup done, so a launch there starts with
 * no Docker, worktree or provider: the pipeline's commands go to the real
 * registry (Kanban linking, tabs) and its agents to a `FakeProvider`. The
 * service never advances by itself.
 */
export interface BuildHarness {
  harness: PublicApiHarness;
  service: BuildPipelineService;
  provider: FakeProvider;
  projectId: string;
  ticketId: string;
  /** Backend commands the pipeline invoked, by name. */
  invoked: string[];
  /** A new backend generation over the same data directory, with a new service. */
  restart(): Promise<BuildHarness>;
  cleanup(): Promise<void>;
}

/** Commands a launch into a ready environment may run; anything else is a test failure. */
const PIPELINE_COMMANDS = new Set([
  "get_kanban_tasks",
  "update_kanban_task",
  "add_kanban_comment",
  "update_environment_agent_settings",
]);

async function attach(
  harness: PublicApiHarness,
  ids: { projectId: string; ticketId: string },
): Promise<BuildHarness> {
  const provider = new FakeProvider();
  const invoked: string[] = [];
  const service = new BuildPipelineService(
    harness.storage,
    async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      invoked.push(name);
      // The environment is already running with setup done.
      if (name === "start_environment" || name === "run_environment_setup") {
        return (await harness.storage.getEnvironment(String(args.environmentId))) as T;
      }
      if (!PIPELINE_COMMANDS.has(name)) throw new Error(`Unexpected pipeline command: ${name}`);
      return (await harness.commands.get(name)!(args, harness.context)) as T;
    },
    { autoAdvance: false, provider: async () => provider },
  );
  (harness.context as { buildPipelines?: BuildPipelineService }).buildPipelines = service;
  return {
    harness,
    service,
    provider,
    invoked,
    ...ids,
    async restart() {
      await service.shutdown();
      return attach(await harness.restart(), ids);
    },
    async cleanup() {
      await service.shutdown();
      await harness.cleanup();
    },
  };
}

export async function createBuildHarness(): Promise<BuildHarness> {
  const harness = await createPublicApiHarness();
  const { projectPath, originPath } = await harness.createRepository("site");
  const project = await harness.storage.addProject(createProject(originPath, projectPath));
  await harness.storage.addEnvironment({
    id: "env-1",
    projectId: project.id,
    name: "build",
    branch: "build",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: projectPath,
    setupScriptsComplete: true,
    setupPhase: "ready",
  });
  const ticket = await harness.storage.kanban.addKanbanTask(
    project.id,
    "Add a --verbose flag",
    "The CLI needs a verbose mode.",
    { acceptanceCriteria: "- `--verbose` prints each step" },
  );
  return attach(harness, { projectId: project.id, ticketId: ticket.id });
}
