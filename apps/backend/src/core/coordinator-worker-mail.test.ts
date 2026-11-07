import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS,
  COORDINATOR_REQUEST_ID_REUSED_ERROR,
  COORDINATOR_ROUTING_RULE,
} from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorRequestFlights } from "./coordinator-request-flights.js";
import { CoordinatorService } from "./coordinator-service.js";
import {
  PROJECT_HOME_REASON_REQUIRED,
  PROJECT_HOME_WARNING,
  projectHomeApprovalRequestId,
} from "./coordinator-worker-mail.js";
import { COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR } from "./coordinator-workflow-retention.js";
import { projectHomeMailAttachmentDir } from "./mail-attachments.js";
import { isNodeRoutingExcludedCommand } from "./nodes/node-routing.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { runCommand } from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let context: CommandContext;
let commands: Map<string, CommandHandler>;
let coordination: NodeCoordination;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let workerId: string;
let homeId: string;

type Result = Record<string, unknown>;

const send = (args: Record<string, unknown>) =>
  commands.get("send_coordinator_agent_mail")!({ ...scope, ...args }, context) as Promise<Result>;

const resolveRequest = (requestId: string, decision: "approve" | "reject") =>
  commands.get("resolve_node_action_request")!({ requestId, decision }, context) as Promise<Result>;

const pendingRequests = async () =>
  (await commands.get("list_node_action_requests")!({ pendingOnly: true }, context)) as Result[];

/** Mail the coordinator sent to an environment, as the mail store holds it. */
async function mailTo(environmentId: string) {
  return (await storage.getAgentMailMailbox(environmentId, "agent-1")).messages;
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
            displayTitle: "Codex 1",
            nativeAgentData: { environmentId, platform: "codex" },
          },
        ],
      },
    } as never,
    (await storage.getPaneLayout(environmentId))?.revision ?? 0,
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-project-home-mail-"));
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
  await storage.patchRepositorySettings(project.id, { coordinatorOtherEnvironments: true });
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
  await coordinator.assignConversationAgent(project.id, scope.conversationId, "codex");
  const worker = createEnvironment(project.id, { name: "auth-fix", environmentType: "local" });
  Object.assign(worker, { status: "running", setupPhase: "ready", setupScriptsComplete: true });
  await storage.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(project.id, { name: "project-home", environmentType: "local" });
  Object.assign(home, {
    status: "running",
    setupPhase: "ready",
    setupScriptsComplete: true,
    projectHome: true,
  });
  await storage.addEnvironment(home);
  homeId = home.id;
  await agentTab(workerId);
  await agentTab(homeId);
  await storage.synchronizeAgentMailboxes();
  commands = createCommandRegistry();
  commands.set("get_node_status", (async () => ({ nodeId: "bk_self" })) as CommandHandler);
  context = {
    storage,
    coordinators: coordinator,
    runtime: { coordinatorRequests: new CoordinatorRequestFlights() },
  } as unknown as CommandContext;
  coordination = new NodeCoordination({
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
});

afterEach(async () => {
  coordination.collector.dispose();
  await rm(root, { recursive: true, force: true });
});

const homeMessage = (overrides: Record<string, unknown> = {}) => ({
  requestId: "home-1",
  toEnvironmentId: homeId,
  subject: "Rebase the checkout",
  body: "Rebase the checkout on origin/main.",
  projectHomeReason: "The user asked for their own checkout to be rebased.",
  ...overrides,
});

describe("coordinator messages to the project home", () => {
  test("a conversation that failed to start cannot send; nothing is sent", async () => {
    await storage.coordinators.mutateCoordinatorWorkspace(scope.projectId, (current) => ({
      ...current!,
      conversations: current!.conversations.map((item) =>
        item.id === scope.conversationId ? { ...item, startupError: "bridge failed" } : item,
      ),
    }));
    await expect(
      send({ requestId: "failed-sender", toEnvironmentId: workerId, body: "Hello" }),
    ).rejects.toThrow("unavailable");
    expect(await mailTo(workerId)).toHaveLength(0);
  });

  test("ordinary workers are messaged exactly as before: no approval, no warning", async () => {
    const sent = await send({ requestId: "worker-1", toEnvironmentId: workerId, body: "Go." });
    expect(sent).toMatchObject({ placement: "pending-inject", coordinatorDelegationOpened: true });
    expect(sent).not.toHaveProperty("projectHome");
    expect(sent).not.toHaveProperty("projectHomeWarning");
    expect(await pendingRequests()).toEqual([]);
    expect(await mailTo(workerId)).toHaveLength(1);
    expect(
      (await storage.coordinators.listOpenCoordinatorDelegations())[0]?.delegation?.request,
    ).toMatchObject({ summary: "Go." });
  });

  test("a message without a reason is refused and nothing is sent or held", async () => {
    await expect(send(homeMessage({ projectHomeReason: undefined }))).rejects.toThrow(
      PROJECT_HOME_REASON_REQUIRED,
    );
    await expect(send(homeMessage({ projectHomeReason: "   " }))).rejects.toThrow(
      "projectHomeReason",
    );
    expect(PROJECT_HOME_REASON_REQUIRED).toContain("isolated environment");
    expect(await pendingRequests()).toEqual([]);
    expect(await mailTo(homeId)).toEqual([]);
  });

  test("outside the window the message waits for approval, and a retry replays the same request", async () => {
    const held = await send(homeMessage());
    const approvalRequestId = projectHomeApprovalRequestId(scope.coordinatorId, "home-1");
    expect(held).toMatchObject({
      projectHome: true,
      sent: false,
      state: "pending",
      approvalRequestId,
      toEnvironmentId: homeId,
    });
    expect(await mailTo(homeId)).toEqual([]);
    const [request] = await pendingRequests();
    // The dialog shows the message and the coordinator's reason.
    expect(request).toMatchObject({
      requestId: approvalRequestId,
      kind: "message-project-home",
      reason: "The user asked for their own checkout to be rebased.",
      targets: [{ nodeId: "bk_self", environmentId: homeId, environmentName: "project-home" }],
      projectHomeMessage: {
        mailRequestId: "home-1",
        subject: "Rebase the checkout",
        body: "Rebase the checkout on origin/main.",
      },
    });

    const replay = await send(homeMessage());
    expect(replay).toMatchObject({ approvalRequestId, state: "pending", sent: false });
    expect(await pendingRequests()).toHaveLength(1);
    // The same requestId with another message is a conflict, not a second request.
    await expect(send(homeMessage({ body: "Something else." }))).rejects.toThrow(
      "different payload",
    );
    expect(await mailTo(homeId)).toEqual([]);
  });

  test("approving sends the held message and opens a 3-hour window that sends with a warning", async () => {
    const mail = spyOn(storage, "sendAgentMail");
    try {
      const held = await send(homeMessage());
      const resolved = await resolveRequest(String(held.approvalRequestId), "approve");
      expect(resolved).toMatchObject({ state: "executed", result: { code: "sent" } });
      const [delivered] = await mailTo(homeId);
      expect(delivered).toMatchObject({
        requestId: "home-1",
        bodyBytes: "Rebase the checkout on origin/main.".length,
        subject: "Rebase the checkout",
        placement: "pending-inject",
        from: { kind: "coordinator", coordinatorId: scope.coordinatorId },
      });
      // The coordinator is told, without the message content.
      const notice = mail.mock.calls.find(
        ([, input]) => input.requestId === `node-action:${held.approvalRequestId}:executed`,
      );
      expect(notice?.[1].body).toContain("For the next 3 hours");
      expect(notice?.[1].body).not.toContain("origin/main");

      // A retry of the approved message replays the sent mail.
      const replay = await send(homeMessage());
      expect(replay).toMatchObject({ id: delivered!.id, projectHomeWarning: PROJECT_HOME_WARNING });
      expect(await mailTo(homeId)).toHaveLength(1);

      // Within the window a new message is sent at once, with the warning.
      const next = await send(homeMessage({ requestId: "home-2", body: "Also run the tests." }));
      expect(next).toMatchObject({
        projectHome: true,
        projectHomeWarning: PROJECT_HOME_WARNING,
        requestId: "home-2",
      });
      expect(await pendingRequests()).toEqual([]);
      expect(await mailTo(homeId)).toHaveLength(2);
      // The window still needs a reason.
      await expect(
        send(homeMessage({ requestId: "home-3", projectHomeReason: undefined })),
      ).rejects.toThrow(PROJECT_HOME_REASON_REQUIRED);

      // Once 3 hours have passed since the last sent message, approval is needed again.
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(
        now + COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS + 60_000,
      );
      try {
        expect(await send(homeMessage({ requestId: "home-4" }))).toMatchObject({
          sent: false,
          state: "pending",
        });
      } finally {
        clock.mockRestore();
      }
      expect(await mailTo(homeId)).toHaveLength(2);
    } finally {
      mail.mockRestore();
    }
  });

  test("direct mail replays after expiry and conflicting content is refused", async () => {
    const held = await send(homeMessage());
    await resolveRequest(String(held.approvalRequestId), "approve");
    const direct = homeMessage({ requestId: "direct" });
    const sent = await send(direct);
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.now() + COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS + 1000,
    );
    try {
      expect(await send(direct)).toMatchObject({ id: sent.id });
      await expect(send({ ...direct, body: "changed" })).rejects.toThrow("different content");
      expect(await pendingRequests()).toEqual([]);
      expect(await mailTo(homeId)).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("muted home approval fails without a sent notice or an open window", async () => {
    await storage.updateAgentMailboxPolicy(homeId, "agent-1", { mutedInbound: true });
    const mail = spyOn(storage, "sendAgentMail");
    try {
      const held = await send(homeMessage());
      expect(await resolveRequest(String(held.approvalRequestId), "approve")).toMatchObject({
        state: "failed",
        result: { code: "failed" },
      });
      expect(await mailTo(homeId)).toEqual([]);
      expect(await storage.latestCoordinatorMailTo(homeId, scope.coordinatorId)).toBeNull();
      const notice = mail.mock.calls.find(
        ([, input]) => input.requestId === `node-action:${held.approvalRequestId}:failed`,
      );
      expect(notice).toBeDefined();
      expect(notice![1].body).not.toContain("For the next 3 hours");
      expect(await send(homeMessage({ requestId: "next" }))).toMatchObject({
        state: "pending",
        sent: false,
      });
    } finally {
      mail.mockRestore();
    }
  });

  for (const scenario of ["closed", "removed", "paused"] as const) {
    test(`approval after coordinator/home becomes ${scenario} sends no mail and reports the outcome`, async () => {
      const held = await send(homeMessage());
      if (scenario === "closed")
        await context.coordinators!.closeConversation(scope.projectId, scope.conversationId);
      if (scenario === "removed") await storage.removeEnvironment(homeId);
      if (scenario === "paused") await context.coordinators!.setPaused(scope.projectId, true);
      const mail = spyOn(storage, "sendAgentMail");
      try {
        const state = scenario === "paused" ? "failed" : "stale";
        expect(await resolveRequest(String(held.approvalRequestId), "approve")).toMatchObject({
          state,
          result: { code: state },
        });
        expect(await mailTo(homeId)).toEqual([]);
        const notice = mail.mock.calls.find(
          ([, input]) => input.requestId === `node-action:${held.approvalRequestId}:${state}`,
        );
        expect(notice).toBeDefined();
        expect(notice![1].body).not.toContain("For the next 3 hours");
      } finally {
        mail.mockRestore();
      }
    });
  }

  test("user home activity and undeliverable coordinator mail do not open the window", async () => {
    await storage.sendAgentMail(
      { kind: "user" },
      {
        requestId: "user-home",
        toEnvironmentId: homeId,
        toTabId: "agent-1",
        body: "User activity",
      },
    );
    expect(await storage.latestCoordinatorMailTo(homeId, scope.coordinatorId)).toBeNull();
    const held = await send(homeMessage());
    await resolveRequest(String(held.approvalRequestId), "approve");
    await storage.removeEnvironment(homeId);
    await storage.synchronizeAgentMailboxes();
    expect(await storage.latestCoordinatorMailTo(homeId, scope.coordinatorId)).toBeNull();
  });

  test("approved and unknown outcomes replay existing mail without another approval", async () => {
    const held = await send(homeMessage());
    await resolveRequest(String(held.approvalRequestId), "approve");
    const [message] = await mailTo(homeId);
    const create = commands.get("create_node_action_request")!;
    try {
      for (const state of ["approved", "outcome-unknown"] as const) {
        commands.set("create_node_action_request", async (args, ctx) => ({
          ...((await create(args, ctx)) as Result),
          state,
        }));
        expect(await send(homeMessage())).toMatchObject({ id: message!.id });
        expect(await mailTo(homeId)).toHaveLength(1);
      }
    } finally {
      commands.set("create_node_action_request", create);
    }
  });

  test("approved deliverNow settles mail into the running turn and replay does not drain again", async () => {
    let drains = 0;
    context.drainAgentMail = async () => {
      drains++;
      const mailbox = await storage.getAgentMailMailbox(homeId, "agent-1");
      const message = mailbox.messages.find((m) => m.requestId === "home-1")!;
      await storage.beginAgentMailInject(
        mailbox.descriptor.mailboxId,
        message.id,
        mailbox.descriptor.incarnationId,
      );
      await storage.finishAgentMailInject(mailbox.descriptor.mailboxId, message.id, {
        outcome: "accepted",
        via: "steer",
      });
    };
    const held = await send(homeMessage({ deliverNow: true }));
    expect(await resolveRequest(String(held.approvalRequestId), "approve")).toMatchObject({
      state: "executed",
    });
    expect((await mailTo(homeId))[0]).toMatchObject({
      placement: "injected",
      injectedVia: "steer",
    });
    expect(await send(homeMessage({ deliverNow: true }))).toMatchObject({ deliverNow: "steered" });
    expect(drains).toBe(1);
  });

  test("declining sends nothing, tells the coordinator, and a retry reports the decline", async () => {
    const mail = spyOn(storage, "sendAgentMail");
    try {
      const held = await send(homeMessage());
      expect(await resolveRequest(String(held.approvalRequestId), "reject")).toMatchObject({
        state: "rejected",
      });
      expect(await mailTo(homeId)).toEqual([]);
      const notice = mail.mock.calls.find(
        ([, input]) => input.requestId === `node-action:${held.approvalRequestId}:rejected`,
      );
      expect(notice?.[1].body).toContain("The message was not sent");

      const retry = await send(homeMessage());
      expect(retry).toMatchObject({ sent: false, state: "rejected" });
      expect(String(retry.note)).toContain("declined");
      expect(await mailTo(homeId)).toEqual([]);
      // A declined message opens no window.
      expect(await send(homeMessage({ requestId: "home-2" }))).toMatchObject({
        sent: false,
        state: "pending",
      });
    } finally {
      mail.mockRestore();
    }
  });

  test("an image waits with a held message and is copied only once approved", async () => {
    const checkout = (await storage.getProject(scope.projectId))!.localPath!;
    await storage.updateEnvironment(homeId, { worktreePath: checkout });
    Object.assign(context.runtime, {
      environments: { fence: { beginMutation: () => () => undefined } },
    });
    const source = await storage.coordinators.writeCoordinatorAttachment(
      scope.coordinatorId,
      scope.conversationId,
      "shot.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64"),
    );
    // Approval of text opens the three-hour window, but cannot authorize
    // a later image writing to the user's checkout.
    const first = await send(homeMessage({ requestId: "text-before-image" }));
    await resolveRequest(String(first.approvalRequestId), "approve");
    expect(await send(homeMessage({ requestId: "text-in-window" }))).toMatchObject({
      projectHome: true,
    });
    const priorMail = await mailTo(homeId);
    const message = homeMessage({ attachments: [source] });
    const homeImages = projectHomeMailAttachmentDir(storage.getDataDir(), homeId);
    const copies = async () => readdir(homeImages).catch(() => []);

    const held = await send(message);
    expect(held).toMatchObject({ sent: false, state: "pending" });
    const [request] = await pendingRequests();
    expect(request!.projectHomeMessage).toMatchObject({ attachments: [path.basename(source)] });
    expect(await copies()).toEqual([]);
    expect(await mailTo(homeId)).toEqual(priorMail);

    await resolveRequest(String(held.approvalRequestId), "approve");

    const delivered = (await mailTo(homeId)).find((mail) => mail.requestId === "home-1");
    const file = delivered!.attachments![0]!.path;
    // Outside the user's checkout, which nothing ever cleans up.
    expect(file.startsWith(homeImages + path.sep)).toBe(true);
    expect((await readFile(file)).length).toBe(9);
    await expect(readdir(path.join(checkout, ".orkestrator"))).rejects.toThrow();
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: checkout })).stdout).toBe("");
    expect(
      (await runCommand("git", ["status", "--porcelain", "--ignored"], { cwd: checkout })).stdout,
    ).toBe("");

    // A retry finds what the approval sent, with the same image.
    const again = await send(message);
    expect(again).toMatchObject({ id: delivered!.id, projectHome: true });
    expect(await mailTo(homeId)).toHaveLength(priorMail.length + 1);

    // Maintenance reads the effective setting rather than the 14-day default.
    const config = await storage.loadConfig();
    const configured = spyOn(storage, "loadConfig").mockResolvedValue({
      ...config,
      global: {
        ...config.global,
        agentMessaging: { ...config.global.agentMessaging!, retentionDays: 30 },
      },
    });
    const age = new Date(Date.now() - 15 * 86_400_000);
    await utimes(path.dirname(file), age, age);
    try {
      await coordination.files.sweepMailAttachments();
      expect((await readFile(file)).length).toBe(9);
    } finally {
      configured.mockRestore();
      const now = new Date();
      await utimes(path.dirname(file), now, now);
    }

    // The maintenance pass keeps a live project home's images, and removes
    // them once its record is gone (a removed project, an interrupted delete).
    await coordination.files.sweepMailAttachments();
    expect((await readFile(file)).length).toBe(9);
    await storage.removeEnvironment(homeId);
    await coordination.files.sweepMailAttachments();
    await expect(readdir(homeImages)).rejects.toThrow();
  });

  test("an image gone by the time of approval sends nothing, and says why", async () => {
    const checkout = (await storage.getProject(scope.projectId))!.localPath!;
    await storage.updateEnvironment(homeId, { worktreePath: checkout });
    Object.assign(context.runtime, {
      environments: { fence: { beginMutation: () => () => undefined } },
    });
    const source = await storage.coordinators.writeCoordinatorAttachment(
      scope.coordinatorId,
      scope.conversationId,
      "shot.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64"),
    );
    const held = await send(homeMessage({ attachments: [source] }));
    await rm(source);
    const resolved = await resolveRequest(String(held.approvalRequestId), "approve");
    expect(resolved.state).toBe("failed");
    expect((resolved.result as { message: string }).message).toContain("attachments");
    expect(await mailTo(homeId)).toEqual([]);
  });

  test("the window closes exactly three hours after the last sent message", async () => {
    const held = await send(homeMessage());
    await resolveRequest(String(held.approvalRequestId), "approve");
    const sentAt = await storage.latestCoordinatorMailTo(homeId, scope.coordinatorId);
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.parse(sentAt!) + COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS,
    );
    try {
      expect(await send(homeMessage({ requestId: "boundary" }))).toMatchObject({
        sent: false,
        state: "pending",
      });
      expect(await mailTo(homeId)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("concurrent retries create one approval and send no mail", async () => {
    const results = await Promise.all([send(homeMessage()), send(homeMessage())]);
    expect(results[0]).toEqual(results[1]);
    expect(await pendingRequests()).toHaveLength(1);
    expect(await mailTo(homeId)).toEqual([]);
  });

  test("malformed held message fields are refused instead of changing the recipient", async () => {
    for (const overrides of [{ toTabId: "x".repeat(257) }, { subject: "x".repeat(201) }]) {
      await expect(send(homeMessage(overrides))).rejects.toThrow("cannot be held");
    }
    expect(await pendingRequests()).toEqual([]);
    expect(await mailTo(homeId)).toEqual([]);
  });

  test("the approval-only send refuses anything but an approved request", async () => {
    const held = await send(homeMessage());
    await expect(
      commands.get("send_approved_project_home_message")!(
        { approvalRequestId: held.approvalRequestId },
        context,
      ),
    ).rejects.toThrow("Only an approved project home message");
    expect(await mailTo(homeId)).toEqual([]);
    expect(isNodeRoutingExcludedCommand("send_approved_project_home_message")).toBe(true);
  });

  test("the routing rule names both routes, isolation and the project home rule", () => {
    expect(COORDINATOR_ROUTING_RULE).toContain("create_ticket");
    expect(COORDINATOR_ROUTING_RULE).toContain("start_build_pipeline");
    expect(COORDINATOR_ROUTING_RULE).toContain("send_prompt_to_tab or launch_job");
    expect(COORDINATOR_ROUTING_RULE).toContain("launch_environment with a prompt");
    expect(COORDINATOR_ROUTING_RULE).toContain("isolated environment");
    expect(COORDINATOR_ROUTING_RULE).toContain("exceptional circumstances");
    expect(COORDINATOR_ROUTING_RULE).toContain("why an environment will not do");
    expect(COORDINATOR_ROUTING_RULE).toContain("projectHomeReason");
  });
});

describe("coordinator request ids on worker mail", () => {
  test("a request id used to ask one worker is refused for another, before anything is sent", async () => {
    const other = createEnvironment(scope.projectId, { name: "other", environmentType: "local" });
    Object.assign(other, { status: "running", setupPhase: "ready", setupScriptsComplete: true });
    await storage.addEnvironment(other);
    await agentTab(other.id);
    await storage.synchronizeAgentMailboxes();
    const first = await send({ requestId: "ask-1", toEnvironmentId: workerId, body: "Go." });
    expect(first).toMatchObject({ coordinatorDelegationOpened: true });
    // Retrying the same message is still idempotent.
    await expect(
      send({ requestId: "ask-1", toEnvironmentId: workerId, body: "Go." }),
    ).resolves.toMatchObject({ id: first.id });
    // Reusing the id for a different worker used to send the mail and silently
    // open no delegation, so no wake ever came back.
    await expect(
      send({ requestId: "ask-1", toEnvironmentId: other.id, body: "Go too." }),
    ).rejects.toThrow(COORDINATOR_REQUEST_ID_REUSED_ERROR);
    expect(await mailTo(other.id)).toHaveLength(0);
  });
  test("stored mail reports delegation failure without inviting a duplicate delivery", async () => {
    const opening = spyOn(storage.coordinators, "openCoordinatorDelegation").mockRejectedValue(
      new Error(COORDINATOR_REQUEST_ID_REUSED_ERROR),
    );
    try {
      const result = await send({
        requestId: "delegation-fails",
        toEnvironmentId: workerId,
        body: "Go.",
      });
      expect(result.delegationNote).toContain("The message was sent");
      expect(result.delegationNote).toContain("Do not resend");
      expect(result.delegationNote).not.toContain("Nothing was");
      expect(await mailTo(workerId)).toHaveLength(1);
    } finally {
      opening.mockRestore();
    }
  });
  test("a full workflow store still sends the mail, and says no wake will come and why", async () => {
    const opening = spyOn(storage.coordinators, "openCoordinatorDelegation").mockRejectedValue(
      new Error(COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR),
    );
    try {
      const result = await send({
        requestId: "store-full",
        toEnvironmentId: workerId,
        body: "Go.",
      });
      expect(result).toMatchObject({ coordinatorDelegationOpened: false });
      expect(result.delegationNote).toContain("you will not be woken when the worker answers");
      expect(result.delegationNote).toContain("the coordinator workflow store is full");
      expect(result.delegationNote).toContain("Delete finished worker environments");
      expect(await mailTo(workerId)).toHaveLength(1);
    } finally {
      opening.mockRestore();
    }
  });
});
