import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_DELEGATION_PRESENTATION } from "@orkestrator/protocol/review-evidence-frames";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { parseForkWorkerLaunch } from "./coordinator-fork-worker.js";
import { CoordinatorService } from "./coordinator-service.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { CoordinatorRequestFlights } from "./coordinator-request-flights.js";
import { runCommand } from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

/**
 * `fork_worker`'s backend command against a real Git checkout (slow tier):
 * the fork starts from the worker's committed HEAD, becomes a coordinator
 * worker with a durable association and, with a prompt, one delegation.
 */

let root: string;
let checkout: string;
let storage: StorageService;
let context: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let workerId: string;
let homeId: string;
let head: string;
let started: string[];

const fork = (input: Record<string, unknown>) =>
  commands.get("fork_coordinator_worker")!({ scope, input }, context) as Promise<
    Record<string, unknown>
  >;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-fork-worker-"));
  checkout = path.join(root, "checkout");
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
  head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
  // Uncommitted work in the worker is not part of a fork.
  await writeFile(path.join(checkout, "draft.txt"), "uncommitted\n");
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("remote", checkout));
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  scope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };
  const worker = createEnvironment(project.id, {
    name: "worker",
    environmentType: "local",
    buildPipelineId: "pipeline-1",
  });
  Object.assign(worker, {
    status: "running",
    setupPhase: "ready",
    worktreePath: checkout,
    branch: "main",
    agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
  });
  await storage.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(project.id, { name: "project-home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await storage.addEnvironment(home);
  homeId = home.id;
  context = {
    storage,
    coordinators: coordinator,
    runtime: {
      environments: { fence: new EnvironmentMutationFence() },
      coordinatorRequests: new CoordinatorRequestFlights(),
    },
  } as CommandContext;
  commands = createCommandRegistry();
  started = [];
  commands.set("start_environment_background", async (args) => {
    started.push(args.environmentId as string);
    return {};
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fork_coordinator_worker", () => {
  test("a prompted fork is a delegated coordinator worker from the worker's last commit", async () => {
    const prompt = "Try the other approach.\n\nCommit and report back.";
    const result = await fork({ requestId: "alt-1", environmentId: workerId, prompt });
    expect(result).toMatchObject({
      forkedFromEnvironmentId: workerId,
      environmentType: "local",
      baseBranch: "main",
      baseCommit: head,
      status: "accepted",
      tabId: "startup-agent",
      // Omitted, the agent is the worker's own.
      agent: "codex",
      coordinatorDelegationOpened: true,
    });
    // Receipts and results are content-free.
    expect(JSON.stringify(result)).not.toContain("other approach");
    const forkId = result.environmentId as string;
    expect(forkId).not.toBe(workerId);
    expect(started).toEqual([forkId]);

    const environment = (await storage.getEnvironment(forkId))!;
    expect(environment.branch).not.toBe("main");
    expect(environment.delegationBaseCommit).toBe(head);
    // The fork never appears to own the worker's build pipeline.
    expect(environment.buildPipelineId).toBeUndefined();
    // The startup prompt is undelivered until the provider accepts it.
    expect(environment.pendingAgentLaunch).toBe(true);
    expect(environment.initialAgentPlatform).toBe("codex");
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialPrompt?.endsWith(prompt)).toBe(true);
    expect(environment.initialPrompt).toContain(`Base commit: ${head}`);
    expect(environment.initialPromptPresentation?.kind).toBe(COORDINATOR_DELEGATION_PRESENTATION);
    expect(environment.agentSettings?.platforms?.codex?.mode).toBe("native");

    const association = (
      await storage.coordinators.listCoordinatorWorkflowAssociations(scope.projectId)
    ).find((item) => item.resourceId === forkId);
    expect(association).toMatchObject({
      kind: "environment",
      conversationId: scope.conversationId,
      requestId: "fork:alt-1",
      baseBranch: "main",
      baseCommit: head,
      delegation: { workerTabId: "startup-agent", state: "running" },
    });

    // A retry replays; the same requestId with another payload is refused.
    const replay = await fork({ requestId: "alt-1", environmentId: workerId, prompt });
    expect(replay).toMatchObject({ environmentId: forkId, replayed: true });
    expect(started).toHaveLength(1);
    await expect(
      fork({ requestId: "alt-1", environmentId: workerId, prompt: "Something else" }),
    ).rejects.toThrow("different payload");
  });

  test("an unprompted fork starts without an agent turn or a delegation", async () => {
    const result = await fork({ requestId: "plain", environmentId: workerId });
    expect(result).toMatchObject({ status: "accepted", coordinatorDelegationOpened: false });
    expect(result.tabId).toBeUndefined();
    const environment = (await storage.getEnvironment(result.environmentId as string))!;
    expect(environment.pendingAgentLaunch).toBe(false);
    expect(environment.initialPrompt).toBeUndefined();
    const association = (
      await storage.coordinators.listCoordinatorWorkflowAssociations(scope.projectId)
    ).find((item) => item.resourceId === environment.id);
    expect(association?.delegation).toBeUndefined();
    expect(association?.baseCommit).toBe(head);
  });

  test("never forks the project home or another project's environment", async () => {
    await expect(fork({ requestId: "home", environmentId: homeId })).rejects.toThrow(
      "project checkout",
    );
    const other = await storage.addProject(createProject("other", root));
    const stranger = createEnvironment(other.id, { name: "stranger", environmentType: "local" });
    await storage.addEnvironment(stranger);
    await expect(fork({ requestId: "other", environmentId: stranger.id })).rejects.toThrow(
      "not found in this project",
    );
    expect(started).toEqual([]);
  });
});

describe("parseForkWorkerLaunch", () => {
  test("agent, model and effort need a prompt, and effort needs a model", () => {
    expect(() => parseForkWorkerLaunch({ agent: "codex" })).toThrow("need a prompt");
    expect(() => parseForkWorkerLaunch({ prompt: "p", reasoningId: "high" })).toThrow(
      "reasoningId requires modelId",
    );
    expect(() => parseForkWorkerLaunch({ prompt: "p", agent: "nope" })).toThrow("agent platform");
    expect(parseForkWorkerLaunch({ prompt: " p ", agent: "claude" })).toEqual({
      prompt: "p",
      agent: "claude",
    });
  });
});

test("a lost remote fork response recovers project mapping, origin, association and delegation", async () => {
  await storage.updateProject(scope.projectId, { gitUrl: "https://github.com/acme/site.git" });
  const commandStorage = new StorageService(path.join(root, "command-data"));
  await commandStorage.init();
  const project = await commandStorage.addProject(
    createProject("https://github.com/acme/site.git", checkout),
  );
  const coordinator = new CoordinatorService(commandStorage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  const remoteScope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };
  const leafCoordination = new NodeCoordination({
    storage,
    nodes: {
      listControllers: () => [{ controllerId: "bk_command", displayName: "Command node" }],
      mostRecentControllerId: () => "bk_command",
      subscribe: () => () => undefined,
      listNodes: async () => ({ nodes: [] }),
      selfIdentity: async () => "bk_leaf",
      link: () => null,
    } as never,
    portal: { readModel: { onNodeEvent: () => () => undefined } } as never,
    invoke: async () => undefined as never,
    emit: () => undefined,
  });
  context.nodeCoordination = leafCoordination;
  let loseAnswer = true;
  const routed: Array<{ command: string; args: Record<string, unknown> }> = [];
  const commandContext = {
    storage: commandStorage,
    coordinators: coordinator,
    nodes: { status: async () => ({ nodeId: "bk_command", mode: "command" }) },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_command",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: true,
            view: { displayName: "Build node" },
            projects: [
              { ref: { projectId: scope.projectId }, repositoryHint: "github.com/acme/site" },
            ],
          },
        ],
      }),
      invokeOnNode: async ({
        command,
        args,
      }: {
        command: string;
        args: Record<string, unknown>;
      }) => {
        routed.push({ command, args });
        const result = await commands.get(command)!(args, context);
        if (command === "fork_controller_environment" && loseAnswer) {
          loseAnswer = false;
          return { outcome: "unknown" };
        }
        return { outcome: "ok", result };
      },
    },
    runtime: { coordinatorRequests: new CoordinatorRequestFlights() },
  } as unknown as CommandContext;
  try {
    const input = {
      requestId: "remote-fork",
      environmentId: workerId,
      nodeId: "bk_leaf",
      prompt: "Try an alternative",
    };
    const invoke = () =>
      commands.get("fork_coordinator_worker")!({ scope: remoteScope, input }, commandContext);
    await expect(invoke()).rejects.toThrow("outcome is unknown");
    const result = (await invoke()) as Record<string, unknown>;
    expect(result).toMatchObject({
      nodeId: "bk_leaf",
      baseCommit: head,
      coordinatorDelegationOpened: true,
      status: "accepted",
    });
    const forkId = result.environmentId as string;
    expect(started).toEqual([forkId]);
    expect(
      (await storage.getEnvironmentsByProject(scope.projectId)).filter(
        (item) => item.controlRequestId,
      ),
    ).toHaveLength(1);
    expect((await storage.getEnvironment(forkId))?.projectId).toBe(scope.projectId);
    expect(await commandStorage.getEnvironment(forkId)).toBeNull();
    expect(
      routed
        .filter((call) => call.command === "fork_controller_environment")
        .every((call) => call.args.projectId === scope.projectId),
    ).toBe(true);
    expect(
      await storage.nodeMailRouter!.route({
        fromEnvironmentId: forkId,
        toEnvironmentId: "coordinator",
      }),
    ).toMatchObject({ controllerId: "bk_command" });
    const associations = await commandStorage.coordinators.listCoordinatorWorkflowAssociations(
      project.id,
    );
    expect(associations).toEqual([
      expect.objectContaining({
        resourceId: forkId,
        nodeId: "bk_leaf",
        baseCommit: head,
        delegation: expect.objectContaining({ state: "running", workerTabId: "startup-agent" }),
      }),
    ]);
    expect(await invoke()).toMatchObject({ environmentId: forkId, replayed: true });
    expect(started).toHaveLength(1);
  } finally {
    leafCoordination.dispose();
    coordinator.stopStatusWakes();
    commandStorage.close();
  }
});
