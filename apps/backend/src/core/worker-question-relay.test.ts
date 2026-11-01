import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator-service.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { CoordinatorRequestFlights } from "./coordinator-request-flights.js";
import { isNodeExcludedCommand, isWorkspaceExcludedCommand } from "./nodes/node-routing.js";
import { NodeActionRequests } from "./nodes/node-action-requests.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { runCommand } from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let context: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let workerId: string;
let homeId: string;
let pending: AgentInteractionRequest[];
let resolve: ReturnType<typeof mock>;

const call = <T = Record<string, unknown>>(command: string, args: Record<string, unknown>) =>
  commands.get(command)!({ scope, ...args }, context) as Promise<T>;

function question(overrides: Partial<AgentInteractionRequest> = {}): AgentInteractionRequest {
  return {
    version: 1,
    id: "q-1",
    provider: "claude",
    kind: "question",
    origin: "interactive-native",
    sessionId: "provider-session",
    state: "pending",
    revision: 2,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Which database?",
      questions: [
        {
          id: "db",
          prompt: "Which database should the service use?",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: true,
          options: [
            { id: "pg", label: "Postgres", providerValue: "postgres" },
            { id: "sqlite", label: "SQLite", providerValue: "sqlite" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

async function agentTab(environmentId: string) {
  await storage.savePaneLayout(
    environmentId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: {
        kind: "leaf",
        id: "left",
        activeTabId: "agent-1",
        tabs: [
          {
            id: "agent-1",
            type: "agent-native",
            displayTitle: "Claude 1",
            nativeAgentData: { platform: "claude" },
          },
        ],
      },
    } as never,
    (await storage.getPaneLayout(environmentId))?.revision ?? 0,
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-worker-answer-"));
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
  const worker = createEnvironment(project.id, { name: "auth-fix", environmentType: "local" });
  Object.assign(worker, { status: "running", setupPhase: "ready", worktreePath: root });
  await storage.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(project.id, { name: "project-home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await storage.addEnvironment(home);
  homeId = home.id;
  await agentTab(workerId);
  await agentTab(homeId);
  pending = [question()];
  resolve = mock(async () => ({
    result: "applied",
    interactionId: "q-1",
    sessionId: "provider-session",
    revision: 3,
  }));
  context = {
    storage,
    coordinators: coordinator,
    runtime: {
      environments: { fence: new EnvironmentMutationFence() },
      coordinatorRequests: new CoordinatorRequestFlights(),
    },
    nativeAgents: { sessionPendingInteractions: async () => pending },
  } as unknown as CommandContext;
  commands = createCommandRegistry();
  commands.set("get_native_agent_projection", (async () => ({
    interactions: pending,
  })) as CommandHandler);
  commands.set("resolve_native_agent_interaction", resolve as unknown as CommandHandler);
  commands.set("get_node_status", (async () => ({ nodeId: "bk_self" })) as CommandHandler);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  requestId: "answer-db",
  environmentId: workerId,
  tabId: "agent-1",
  interactionId: "q-1",
  answers: [{ questionId: "db", optionIds: ["pg"] }],
  reason: "The ticket says Postgres",
  ...overrides,
});

describe("request_coordinator_worker_answer", () => {
  test("creates one user-approved request with the question and the proposal, and answers nothing", async () => {
    const create = mock(async (_args: Record<string, unknown>) => ({ requestId: "approval-1" }));
    commands.set("create_node_action_request", create as unknown as CommandHandler);
    const input = proposal();
    expect(await call("request_coordinator_worker_answer", { input })).toEqual({
      environmentId: workerId,
      tabId: "agent-1",
      interactionId: "q-1",
      approvalRequestId: "approval-1",
      state: "pending",
    });
    const workspace = await storage.coordinators.getCoordinatorWorkspaceById(scope.coordinatorId);
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "answer-worker-question",
      targets: [
        {
          nodeId: "bk_self",
          environmentId: workerId,
          environmentName: "auth-fix",
          projectId: scope.projectId,
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
        coordinatorTabId: workspace!.conversations[0]!.tabId,
        projectId: scope.projectId,
      },
      reason: "The ticket says Postgres",
      workerQuestion: {
        tabId: "agent-1",
        tabName: "Claude 1",
        interactionId: "q-1",
        revision: 2,
        title: "Which database?",
        questions: [
          {
            id: "db",
            prompt: "Which database should the service use?",
            options: [
              { id: "pg", label: "Postgres" },
              { id: "sqlite", label: "SQLite" },
            ],
          },
        ],
        proposed: [{ questionId: "db", optionIds: ["pg"] }],
      },
    });
    // The replay is the stored receipt result: content-free, with neither
    // the question nor the answer in it.
    const replay = await call("request_coordinator_worker_answer", { input });
    expect(replay).toMatchObject({ replayed: true, approvalRequestId: "approval-1" });
    expect(JSON.stringify(replay)).not.toContain("Postgres");
    expect(JSON.stringify(replay)).not.toContain("Which database");
    expect(create).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("refuses approvals, secrets, the project home and answers that do not fit", async () => {
    const create = mock(async () => ({ requestId: "never" }));
    commands.set("create_node_action_request", create as unknown as CommandHandler);
    pending = [question({ kind: "command-approval" })];
    await expect(
      call("request_coordinator_worker_answer", { input: proposal({ requestId: "a" }) }),
    ).rejects.toThrow("Only the user approves or denies it");
    const secret = question();
    secret.presentation.questions[0]!.secret = true;
    pending = [secret];
    await expect(
      call("request_coordinator_worker_answer", { input: proposal({ requestId: "b" }) }),
    ).rejects.toThrow("secret");
    pending = [question()];
    await expect(
      call("request_coordinator_worker_answer", {
        input: proposal({ requestId: "c", environmentId: homeId }),
      }),
    ).rejects.toThrow("project checkout");
    await expect(
      call("request_coordinator_worker_answer", {
        input: proposal({ requestId: "d", answers: [{ questionId: "db", optionIds: ["mongo"] }] }),
      }),
    ).rejects.toThrow("no option");
    pending = [question({ state: "resolved" })];
    await expect(
      call("request_coordinator_worker_answer", { input: proposal({ requestId: "e" }) }),
    ).rejects.toThrow("no pending interaction");
    expect(create).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("answer_project_worker_question", () => {
  const approved = (overrides: Record<string, unknown> = {}) => ({
    projectId: scope.projectId,
    environmentId: workerId,
    tabId: "agent-1",
    interactionId: "q-1",
    revision: 2,
    answers: [{ questionId: "db", freeText: "Postgres 16" }],
    ...overrides,
  });

  test("answers the pending revision through the worker tab's own resolve command", async () => {
    expect(await call("answer_project_worker_question", approved())).toEqual({
      result: "answered",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    const args = resolve.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({
      environmentId: workerId,
      agent: "claude",
      logicalSessionKey: `env-${workerId}:agent-1`,
      interactionId: "q-1",
      resolution: {
        action: "answer",
        interactionId: "q-1",
        sessionId: "provider-session",
        answer: { answers: [{ questionId: "db", freeText: "Postgres 16" }] },
      },
    });
  });

  test("a question that went away, changed or was answered meanwhile is stale and nothing is sent", async () => {
    pending = [];
    expect(await call("answer_project_worker_question", approved())).toMatchObject({
      result: "stale",
    });
    pending = [question({ revision: 5 })];
    expect(await call("answer_project_worker_question", approved())).toMatchObject({
      result: "stale",
    });
    pending = [question({ expiresAt: 2 })];
    expect(await call("answer_project_worker_question", approved())).toMatchObject({
      result: "stale",
    });
    expect(
      await call("answer_project_worker_question", approved({ tabId: "closed-tab" })),
    ).toMatchObject({ result: "stale" });
    expect(resolve).not.toHaveBeenCalled();
    pending = [question()];
    resolve.mockImplementation(async () => ({ result: "already-resolved" }));
    expect(await call("answer_project_worker_question", approved())).toMatchObject({
      result: "stale",
    });
  });

  test("malformed answers, approvals, the project home and an unavailable provider never answer", async () => {
    await expect(
      call("answer_project_worker_question", approved({ answers: [{ questionId: "db" }] })),
    ).rejects.toThrow("needs an answer");
    await expect(
      call("answer_project_worker_question", approved({ answers: "Postgres" })),
    ).rejects.toThrow();
    await expect(
      call("answer_project_worker_question", approved({ revision: undefined })),
    ).rejects.toThrow("revision");
    pending = [question({ kind: "permission" })];
    await expect(call("answer_project_worker_question", approved())).rejects.toThrow(
      "Only the user approves or denies it",
    );
    pending = [question()];
    await expect(
      call("answer_project_worker_question", approved({ environmentId: homeId })),
    ).rejects.toThrow("project checkout");
    expect(resolve).not.toHaveBeenCalled();
    context = {
      ...context,
      nativeAgents: { sessionPendingInteractions: async () => null },
    } as unknown as CommandContext;
    await expect(call("answer_project_worker_question", approved())).rejects.toThrow(
      "nothing was sent",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  test("the approval-only commands are never reachable through a node or workspace grant", () => {
    expect(isNodeExcludedCommand("request_coordinator_worker_answer")).toBe(true);
    expect(isNodeExcludedCommand("answer_project_worker_question")).toBe(true);
    // A command node reaches a worker on this node only over the node link.
    expect(isNodeExcludedCommand("answer_controller_worker_question")).toBe(false);
    expect(isWorkspaceExcludedCommand("answer_controller_worker_question")).toBe(true);
  });
});

test("end to end on this node: only the user's approval, with their edit, answers the worker", async () => {
  const mail = spyOn(storage, "sendAgentMail");
  const coordination = new NodeCoordination({
    storage,
    nodes: {
      listControllers: () => [],
      mostRecentControllerId: () => undefined,
      selfIdentity: async () => "bk_self",
      link: () => null,
      getNode: async () => ({ displayName: "node" }),
      subscribe: () => () => undefined,
      listNodes: async () => ({ nodes: [] }),
    } as never,
    portal: { readModel: { onNodeEvent: () => () => undefined } } as never,
    invoke: (async (command: string, args: Record<string, unknown>) =>
      commands.get(command)!(args, context)) as never,
    emit: () => undefined,
  });
  context = { ...context, nodeCoordination: coordination } as CommandContext;
  try {
    const created = await call<{ approvalRequestId: string }>("request_coordinator_worker_answer", {
      input: proposal(),
    });
    expect(resolve).not.toHaveBeenCalled();
    const [listed] = (await commands.get("list_node_action_requests")!(
      { pendingOnly: true },
      context,
    )) as Array<Record<string, unknown>>;
    expect(listed).toMatchObject({
      requestId: created.approvalRequestId,
      kind: "answer-worker-question",
      state: "pending",
      workerQuestion: { tabName: "Claude 1", proposed: [{ questionId: "db", optionIds: ["pg"] }] },
    });
    // A malformed approval is refused before anything runs.
    await expect(
      commands.get("resolve_node_action_request")!(
        {
          requestId: created.approvalRequestId,
          decision: "approve",
          approval: { answers: [{ questionId: "db", optionIds: "pg" }] },
        },
        context,
      ),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    const resolved = (await commands.get("resolve_node_action_request")!(
      {
        requestId: created.approvalRequestId,
        decision: "approve",
        approval: { answers: [{ questionId: "db", optionIds: ["sqlite"] }] },
      },
      context,
    )) as Record<string, unknown>;
    expect(resolved).toMatchObject({ state: "executed", result: { code: "answered" } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(
      (resolve.mock.calls[0]![0] as { resolution: { answer: { answers: unknown } } }).resolution
        .answer.answers,
    ).toEqual([{ questionId: "db", optionIds: ["sqlite"] }]);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0]![1]).toMatchObject({
      requestId: `node-action:${created.approvalRequestId}:executed`,
    });
    expect(JSON.stringify(mail.mock.calls[0]![1])).not.toContain("SQLite");
  } finally {
    mail.mockRestore();
    coordination.collector.dispose();
  }
});

test("an approved request answers through the executor with the user's edit, and a decline never does", async () => {
  const executed: Array<Record<string, unknown>> = [];
  const requests = new NodeActionRequests({
    load: async () => [],
    save: async () => {},
    emit: () => {},
    executors: {
      "answer-worker-question": async (request, approval) => {
        executed.push({ answers: approval.answers ?? request.workerQuestion?.proposed });
        return { code: "answered", message: "Answered" };
      },
    },
  });
  commands.set("create_node_action_request", (async (args) =>
    requests.create(
      args as unknown as Parameters<NodeActionRequests["create"]>[0],
    )) as CommandHandler);
  const first = await call<{ approvalRequestId: string }>("request_coordinator_worker_answer", {
    input: proposal(),
  });
  const second = await call<{ approvalRequestId: string }>("request_coordinator_worker_answer", {
    input: proposal({ requestId: "declined" }),
  });
  await requests.resolve(second.approvalRequestId, "reject");
  expect(executed).toEqual([]);
  const resolved = await requests.resolve(first.approvalRequestId, "approve", {
    answers: [{ questionId: "db", optionIds: ["sqlite"] }],
  });
  expect(resolved.state).toBe("executed");
  expect(executed).toEqual([{ answers: [{ questionId: "db", optionIds: ["sqlite"] }] }]);
  await expect(requests.resolve(first.approvalRequestId, "approve")).rejects.toThrow("already");
  expect(executed).toHaveLength(1);
  expect(resolve).not.toHaveBeenCalled();
});
