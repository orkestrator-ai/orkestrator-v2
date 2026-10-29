/**
 * The coordinator's graph tools (item 214, D6) over the real Control MCP
 * endpoint and the real coordinator store: list, read launch options, launch
 * (admitted as a durable `graph-run` association before the launch service
 * runs), read and cancel. The launch service and run store are scripted; the
 * service's own behaviour is `graph-run-launch.test.ts`'s. There is no
 * authoring tool, and a scheduled coordinator graph launch runs through the
 * coordinator's own `launch_graph`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  GraphLaunchOptions,
  GraphLaunchOrigin,
  GraphLaunchRequest,
  GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { COORDINATOR_CONTROL_TOOL_NAMES } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import { registerCoordinatorGraphActions } from "./coordinator-graph-actions.js";
import { CoordinatorService } from "./coordinator-service.js";
import { rpc } from "./control-mcp-test-support.js";
import { ControlMcpServer, type ControlMcpInvoker } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { GraphLaunchError, graphLaunchRunId } from "./graph-run-launch.js";
import { graphRunFixture } from "./graph-run-test-support.js";
import { ScheduledJobExecutor } from "./scheduled-jobs/executor.js";
import { ScheduledJobService } from "./scheduled-jobs/service.js";
import { registerScheduledJobCommands } from "./commands-registry-scheduled-jobs.js";
import { runCommand } from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let server: ControlMcpServer;
let coordinator: CoordinatorService;
let scope: {
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  mailboxIncarnationId: string;
};
let workerId: string;
let homeId: string;
let runs: Map<string, GraphRun>;
let launch: ReturnType<
  typeof mock<
    (request: GraphLaunchRequest, origin: GraphLaunchOrigin) => Promise<GraphLaunchResult>
  >
>;
let options: ReturnType<
  typeof mock<(input: Record<string, unknown>) => Promise<GraphLaunchOptions>>
>;
let schedules: ScheduledJobService;
let clock: { now: number };

function launchOptions(launchable: boolean): GraphLaunchOptions {
  const summary = {
    ref: { scope: "user", id: "nightly" },
    scope: "user",
    id: "nightly",
    name: "Nightly review",
    revision: 1,
    digest: "d".repeat(64),
    readOnly: false,
    trust: "trusted",
    launchable,
    compile: {
      ok: true,
      launchable,
      errors: 0,
      warnings: 0,
      infos: 0,
      pendingAcknowledgements: 0,
      planDigest: null,
      cost: null,
    },
  };
  return {
    summary,
    launchable,
    ...(launchable ? {} : { blockedReason: "The template does not compile" }),
    errors: [],
    roles: [
      {
        role: { key: "reviewer", multiplicity: "panel" },
        nodes: ["review"],
        panel: true,
        maxPanel: 4,
        providers: [
          {
            platform: "claude",
            tier: "enforced",
            allowed: true,
            structuredResults: true,
            available: true,
          },
          {
            platform: "grok",
            tier: "advisory",
            allowed: false,
            structuredResults: true,
            available: false,
            unavailableReason: "Holds step review only at advisory",
          },
        ],
        default: [{ platform: "claude" }],
      },
    ],
    parameters: [],
    params: {},
    inputs: [],
    environment: { workspace: "environment", default: "new-worktree" },
    cost: null,
    saved: null,
  } as unknown as GraphLaunchOptions;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-graph-tools-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ])
    await runCommand("git", args, { cwd: checkout });
  await writeFile(path.join(checkout, "README.md"), "fixture\n");
  await runCommand("git", ["add", "."], { cwd: checkout });
  await runCommand("git", ["commit", "-m", "fixture"], { cwd: checkout });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("graphs", checkout));
  coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  const main = snapshot.workspace.conversations[0]!;
  scope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: main.id,
    mailboxIncarnationId: main.mailboxIncarnationId,
  };
  const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
  await storage.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(project.id, { name: "home", environmentType: "local" });
  Object.assign(home, { projectHome: true });
  await storage.addEnvironment(home);
  homeId = home.id;

  runs = new Map();
  launch = mock(async (request: GraphLaunchRequest, _origin: GraphLaunchOrigin) => {
    if (request.ref.scope !== "project" && request.ref.id === "refused") {
      throw new GraphLaunchError("invalid-binding", "grok misses the enforcement floor of review");
    }
    const id = graphLaunchRunId(request.projectId, request.requestId!);
    const existing = runs.get(id);
    const run =
      existing ??
      graphRunFixture({
        id,
        projectId: request.projectId,
        ...(request.environment.kind === "existing"
          ? { environmentId: request.environment.environmentId }
          : {}),
        status: request.environment.kind === "existing" ? "running" : "provisioning",
      });
    if (!run.environmentId) delete run.environmentId;
    runs.set(id, run);
    return {
      runId: run.id,
      projectId: run.projectId,
      ...(run.environmentId ? { environmentId: run.environmentId } : {}),
      status: run.status,
      template: { id: "nightly", revision: 1, name: "Nightly review" },
      repeated: existing !== undefined,
    };
  });
  options = mock(async (input: Record<string, unknown>) => {
    const ref = input.ref as { id?: string };
    return launchOptions(ref.id !== "broken");
  });
  const graphLaunches = { launch, options } as unknown as CommandContext["graphLaunches"];
  const graphRuns = {
    get: async (id: string) => structuredClone(runs.get(id) ?? null),
    cancel: async (id: string) => {
      const run = runs.get(id)!;
      run.status = "cancelling";
      return structuredClone(run);
    },
  } as unknown as CommandContext["graphRuns"];
  const graphTemplates = {
    list: async () => ({
      templates: [launchOptions(true).summary],
      project: null,
      ceiling: { deny: [] },
    }),
  } as unknown as CommandContext["graphTemplates"];
  const context = { storage, graphLaunches, graphRuns, graphTemplates } as CommandContext;
  const commands = new Map<
    string,
    (args: Record<string, unknown>, ctx: CommandContext) => unknown
  >();
  registerCoordinatorGraphActions((name, handler) => commands.set(name, handler as never));
  registerScheduledJobCommands((name, handler) => commands.set(name, handler as never));
  const invoke: ControlMcpInvoker = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    const own = commands.get(command);
    if (own) return (await own(args, context)) as T;
    switch (command) {
      case "get_project_coordinator":
        return (await coordinator.get(String(args.projectId))) as T;
      case "get_environment":
        return (await storage.getEnvironment(String(args.environmentId))) as T;
      case "get_config":
        return (await storage.loadConfig()) as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  };
  server = new ControlMcpServer(path.join(root, "data"), invoke, { port: 0 });
  await server.start();
  clock = { now: Date.parse("2026-10-29T10:00:00Z") };
  schedules = new ScheduledJobService({
    store: storage.scheduledJobStore(),
    now: () => clock.now,
    defaultTimeZone: () => "UTC",
    executor: new ScheduledJobExecutor({
      invoke,
      storage: {
        sendAgentMail: async () => {
          throw new Error("no mail in this test");
        },
        coordinators: storage.coordinators,
      },
      graphs: { launch, options: options as never },
      controlMcp: {
        credentialPolicy: (id) => server.credentialPolicy(id),
        callCoordinatorTool: (toolScope, tool, args) =>
          server.callCoordinatorTool(toolScope, tool, args),
        listCoordinatorTools: (toolScope) => server.listCoordinatorTools(toolScope),
      },
    }),
  });
  context.scheduledJobs = schedules;
});

afterEach(async () => {
  await server.stop();
  storage.close();
  await rm(root, { recursive: true, force: true });
});

function credential(role: "main" | "side" = "main") {
  return server.issueCoordinatorCredential({
    role: "coordinator",
    ...scope,
    capabilities: coordinatorRoleCapabilities(role),
  });
}

async function call(name: string, args: Record<string, unknown>, role: "main" | "side" = "main") {
  const issued = credential(role);
  const { body } = await rpc(issued.url, issued.token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(body.error.message);
  return body.result!;
}

async function associations() {
  return (await storage.coordinators.listCoordinatorWorkflowAssociations(scope.projectId)).filter(
    (item) => item.kind === "graph-run",
  );
}

const launchArgs = (overrides: Record<string, unknown> = {}) => ({
  requestId: "nightly-1",
  template: { scope: "user", id: "nightly" },
  environment: { kind: "existing", environmentId: workerId },
  roles: { reviewer: [{ platform: "claude" }, { platform: "codex", model: "gpt" }] },
  ...overrides,
});

describe("coordinator graph tools", () => {
  test("the coordinator runs saved graphs and has no authoring tool", async () => {
    const issued = credential();
    const listed = await rpc(issued.url, issued.token, "tools/list");
    const names = listed.body.result!.tools!.map((tool) => tool.name);
    const graphTools = names.filter((name) => /graph/.test(name)).toSorted();
    expect(graphTools).toEqual([
      "cancel_graph_run",
      "get_graph_run",
      "launch_graph",
      "list_graph_templates",
    ]);
    // D6: nothing creates, saves, edits, duplicates, imports, deletes or describes a template.
    for (const name of names) {
      expect(name).not.toMatch(
        /(create|save|edit|update|describe|duplicate|import|delete|author|trust).*(graph|template)|(graph|template).*(create|save|edit|update|describe|duplicate|import|delete|author|trust)/,
      );
    }
    for (const name of graphTools) expect(COORDINATOR_CONTROL_TOOL_NAMES).toContain(name as never);

    // A side agent launches nothing, graphs included.
    const side = credential("side");
    const sideNames = (await rpc(side.url, side.token, "tools/list")).body.result!.tools!.map(
      (tool) => tool.name,
    );
    expect(sideNames.filter((name) => /graph/.test(name))).toEqual([]);
  });

  test("list_graph_templates lists templates and reads one template's launch options", async () => {
    const listed = await call("list_graph_templates", {});
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      total: 1,
      templates: [{ id: "nightly", name: "Nightly review", launchable: true, trust: "trusted" }],
    });
    const detail = await call("list_graph_templates", {
      ref: { scope: "user", id: "nightly" },
      environmentId: workerId,
    });
    expect(options).toHaveBeenCalledWith({
      ref: { scope: "user", id: "nightly" },
      projectId: scope.projectId,
      environmentId: workerId,
    });
    const roles = (detail.structuredContent as { template: { roles: unknown[] } }).template.roles;
    expect(roles).toEqual([
      expect.objectContaining({
        key: "reviewer",
        panel: true,
        providers: [
          { platform: "claude", tier: "enforced", available: true },
          {
            platform: "grok",
            tier: "advisory",
            available: false,
            unavailableReason: "Holds step review only at advisory",
          },
        ],
      }),
    ]);
  });

  test("launch_graph admits a graph-run association before launching, as the coordinator, once per requestId", async () => {
    const launched = await call("launch_graph", launchArgs());
    expect(launched.isError).not.toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    const [request, origin] = launch.mock.calls[0]!;
    expect(origin).toEqual({ requestedBy: "coordinator" });
    expect(request).toMatchObject({
      ref: { scope: "user", id: "nightly" },
      projectId: scope.projectId,
      environment: { kind: "existing", environmentId: workerId },
      requestId: `coordinator:${scope.coordinatorId}:nightly-1`,
    });
    const runId = graphLaunchRunId(scope.projectId, request.requestId!);
    expect(launched.structuredContent).toMatchObject({
      runId,
      launch: { runId, status: "running", repeated: false },
      delivery: "async",
    });
    expect(await associations()).toEqual([
      expect.objectContaining({
        kind: "graph-run",
        resourceId: runId,
        requestId: "nightly-1",
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
      }),
    ]);
    expect((await associations())[0]!.pending).toBe(false);

    // The same requestId replays the same run without launching again.
    const again = await call("launch_graph", launchArgs());
    expect(again.structuredContent).toMatchObject({ runId, launch: { repeated: true } });
    expect(launch).toHaveBeenCalledTimes(1);

    // A different request under the same key is refused.
    const reused = await call(
      "launch_graph",
      launchArgs({ roles: { reviewer: [{ platform: "pi" }] } }),
    );
    expect(reused.isError).toBe(true);
    expect(await associations()).toHaveLength(1);
  });

  test("a refused launch keeps its code, leaves no association and frees the requestId", async () => {
    const refused = await call(
      "launch_graph",
      launchArgs({ requestId: "r-1", template: { scope: "user", id: "refused" } }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toContain("invalid-binding:");
    expect(await associations()).toEqual([]);
    const retried = await call("launch_graph", launchArgs({ requestId: "r-1" }));
    expect(retried.isError).not.toBe(true);
    expect(await associations()).toHaveLength(1);
  });

  test("launch_graph refuses the project home and another project's environment", async () => {
    const home = await call(
      "launch_graph",
      launchArgs({ requestId: "home", environment: { kind: "existing", environmentId: homeId } }),
    );
    expect(home.isError).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    const missing = await call(
      "launch_graph",
      launchArgs({ requestId: "new", environment: { kind: "new" } }),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content?.[0]?.text).toContain("environment.create");
    const created = await call(
      "launch_graph",
      launchArgs({ requestId: "new-2", environment: { kind: "new", create: "container" } }),
    );
    expect(created.structuredContent).toMatchObject({ launch: { status: "provisioning" } });
    expect(launch.mock.calls[0]![0].environment).toEqual({ kind: "new", create: "container" });
  });

  test("get_graph_run and cancel_graph_run read and stop this project's runs only, content-free", async () => {
    const launched = await call("launch_graph", launchArgs());
    const runId = (launched.structuredContent as { runId: string }).runId;
    const read = await call("get_graph_run", { runId });
    expect(read.structuredContent).toMatchObject({
      run: { id: runId, status: "running", name: expect.any(String) },
      waitingFor: [],
      failed: [],
      terminal: false,
    });
    expect(JSON.stringify(read.structuredContent)).not.toContain("prompt");
    const cancelled = await call("cancel_graph_run", { runId });
    expect(cancelled.structuredContent).toMatchObject({
      cancelled: true,
      run: { status: "cancelling" },
    });

    runs.set("other", graphRunFixture({ id: "other", projectId: "another-project" }));
    const other = await call("get_graph_run", { runId: "other" });
    expect(other.isError).toBe(true);
    expect(other.content?.[0]?.text).toContain("not-found:");

    const workflows = await call("list_workflows", {});
    expect(workflows.structuredContent).toMatchObject({
      workflows: [expect.objectContaining({ kind: "graph-run", resourceId: runId })],
    });
  });

  test("a coordinator schedules a graph through its own launch_graph", async () => {
    const created = await call("create_schedule", {
      requestId: "nightly-schedule",
      at: "+1h",
      action: {
        type: "tool",
        tool: "launch_graph",
        arguments: launchArgs({ requestId: undefined }),
      },
    });
    expect(created.isError).not.toBe(true);
    const job = schedules.list({ kind: "operator" })[0]!;
    clock.now += 60 * 60 * 1000;
    await schedules.tick();
    await schedules.idle();
    expect(launch).toHaveBeenCalledTimes(1);
    const [request, origin] = launch.mock.calls[0]!;
    expect(origin).toEqual({ requestedBy: "coordinator" });
    expect(request.requestId).toContain(`sched:${job.id}@`);
    expect(schedules.get({ kind: "operator" }, job.id)?.fires.at(-1)).toMatchObject({
      state: "succeeded",
      outcome: { runId: expect.stringMatching(/^launch-/) },
    });
    expect(await associations()).toHaveLength(1);
  });
});
