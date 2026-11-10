/**
 * Mail between a command node's main coordinator and a leaf's main
 * coordinator, over two real mail worlds joined by a fake node link: the
 * command node's coordinator commands route `deliver_node_mail` to the leaf's
 * command handlers, and its mail collector drains the leaf's outbox.
 */
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  renderAgentMailCarrier,
  AGENT_MAIL_MAX_BODY_BYTES,
  DEFAULT_AGENT_MESSAGING_SETTINGS,
} from "@orkestrator/protocol/agent-mail";
import { COMMAND_NODE_COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import { registerCoordinatorCommandNodeMail } from "./coordinator-node-coordinator-mail.js";
import { nodeMailReplyTarget } from "./node-mail-reply-target.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { createProject } from "./storage.js";

const worlds: MailWorld[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const world of worlds.splice(0)) await world.close();
});

const ALL_CAPABILITIES = {
  "node-attachment": 1,
  "node-mail-steer": 1,
  "node-coordinator-mail": 1,
  "node-mail-return": 1,
};

async function setBudget(world: MailWorld, autonomousWakeBudget: number) {
  const config = await world.storage.loadConfig();
  await world.storage.updateGlobalConfig({
    ...config.global,
    agentMessaging: { ...DEFAULT_AGENT_MESSAGING_SETTINGS, autonomousWakeBudget },
  });
}

async function link(
  options: {
    capabilities?: Record<string, number>;
    budget?: number;
    /** A leaf project that has no coordinator, as the command node's copy. */
    leafWithoutCoordinator?: boolean;
  } = {},
) {
  const command = await MailWorld.create();
  const leaf = await MailWorld.create();
  worlds.push(command, leaf);
  // The same repository on both nodes, which is how each finds its copy.
  for (const world of [command, leaf])
    await world.storage.updateProject(world.projectId, { gitUrl: "git@github.com:acme/site.git" });
  if (options.budget) {
    await setBudget(command, options.budget);
    await setBudget(leaf, options.budget);
  }
  let leafProjectId = leaf.projectId;
  if (options.leafWithoutCoordinator) {
    const checkout = path.join(leaf.root, "bare-copy");
    await fs.mkdir(checkout);
    leafProjectId = (
      await leaf.storage.addProject(
        createProject("https://example.invalid/bare-copy.git", checkout),
      )
    ).id;
  }
  const commands = new Map<string, CommandHandler>();
  const register = registrarFrom((name, handler) => commands.set(name, handler));
  registerCoordinatorNodeCommands(register);
  registerNodeCommands(register);
  registerCoordinatorCommandNodeMail(register);

  let attached = true;
  const leafCoordination = new NodeCoordination({
    storage: leaf.storage,
    nodes: {
      listControllers: () =>
        attached ? [{ controllerId: "bk_cmd", displayName: "Office desktop" }] : [],
      mostRecentControllerId: () => (attached ? "bk_cmd" : undefined),
      subscribe: () => () => {},
    } as never,
    portal: { readModel: { onNodeEvent: () => () => {} } } as never,
    invoke: async () => undefined as never,
    emit: () => {},
  });
  disposers.push(() => leafCoordination.dispose());
  const leafContext = {
    storage: leaf.storage,
    coordinators: leaf.coordinator,
    nodeCoordination: leafCoordination,
    drainAgentMail: () => leaf.mail.drainInjects(),
    nodePortal: {},
    nodes: {
      status: async () => ({
        nodeId: "bk_leaf",
        mode: "leaf",
        controllers: [{ displayName: "Office desktop" }],
      }),
    },
  } as unknown as CommandContext;
  const leafCall = (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, leafContext) as Promise<Record<string, unknown>>;

  const routed: Array<{ command: string; args: Record<string, unknown> }> = [];
  const hint = repositoryHint((await leaf.storage.getProject(leaf.projectId))!.gitUrl);
  const commandContext = {
    storage: command.storage,
    coordinators: command.coordinator,
    nodes: {
      status: async () => ({ nodeId: "bk_cmd", mode: "command" }),
      link: (nodeId: string) =>
        nodeId === "bk_leaf"
          ? { hello: { capabilities: options.capabilities ?? ALL_CAPABILITIES } }
          : null,
    },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_cmd",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: true,
            view: { displayName: "Build box" },
            projects: [{ ref: { projectId: leafProjectId }, repositoryHint: hint }],
          },
        ],
      }),
      invokeOnNode: async (input: { command: string; args: Record<string, unknown> }) => {
        routed.push(input);
        return { outcome: "ok", result: await leafCall(input.command, input.args) };
      },
    },
  } as unknown as CommandContext;
  const run = (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, commandContext) as Promise<Record<string, unknown>>;

  // The command node's side of the link: collects the leaf's outbox.
  const commandCoordination = new NodeCoordination({
    storage: command.storage,
    nodes: {
      listControllers: () => [],
      selfIdentity: async () => "bk_cmd",
      link: (nodeId: string) =>
        nodeId === "bk_leaf"
          ? {
              connected: true,
              hello: { capabilities: ALL_CAPABILITIES },
              invoke: (name: string, args: Record<string, unknown>) => leafCall(name, args),
            }
          : null,
      getNode: async () => ({ displayName: "Build box" }),
      subscribe: () => () => {},
    } as never,
    portal: { readModel: { onNodeEvent: () => () => {} } } as never,
    invoke: async () => undefined as never,
    emit: () => {},
  });
  disposers.push(() => commandCoordination.dispose());

  const commandMain = await command.main();
  const leafMain = await leaf.main();
  const scopeOf = (world: MailWorld, actor: MailActor) => ({
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: actor.conversationId!,
  });
  let counter = 0;
  /** The command node's main coordinator asks the leaf's coordinator something. */
  const ask = (body: string, from: MailActor = commandMain, replyTo?: string) =>
    run("send_coordinator_node_mail", {
      scope: scopeOf(command, from),
      nodeId: "bk_leaf",
      toEnvironmentId: "coordinator",
      requestId: `ask-${++counter}`,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      body,
    });
  /** The leaf's coordinator answers a message, or starts one when `replyTo` is absent. */
  const tell = (body: string, replyTo?: string, from: MailActor = leafMain) =>
    leafCall("send_coordinator_command_node_mail", {
      scope: scopeOf(leaf, from),
      requestId: `tell-${++counter}`,
      body,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
    });
  const collect = () => commandCoordination.collector.collect("bk_leaf" as never);
  /** Mail from the leaf's coordinator that reached the command node's main. */
  const fromLeaf = () =>
    command
      .carriers(commandMain)
      .flat()
      .filter((carrier) => carrier.from.kind === "node");
  return {
    command,
    leaf,
    commandMain,
    leafMain,
    leafProjectId,
    run,
    leafCall,
    routed,
    ask,
    tell,
    collect,
    fromLeaf,
    scopeOf,
    detach: () => {
      attached = false;
    },
  };
}

/**
 * Each coordinator answers whatever woke it with a new question, forever,
 * until the command node's budget holds the leaf coordinator's mail. Returns
 * how many answers woke the command node's coordinator.
 */
async function loopUntilHeld(world: Awaited<ReturnType<typeof link>>): Promise<number> {
  let leafWakes = world.leaf.wakes(world.leafMain);
  let question = (await world.ask("Q0")).messageId as string;
  // A storage event can deliver the question before the send's caller resumes.
  // Drive that ordering explicitly rather than relying on scheduler timing.
  await world.leaf.deliver();
  let rounds = 0;
  for (; rounds < 12; rounds += 1) {
    await world.leaf.deliver();
    if (world.leaf.wakes(world.leafMain) === leafWakes) break;
    // Compare with the count before sending, since event-driven delivery can
    // already have happened by the time ask() resolves.
    leafWakes = world.leaf.wakes(world.leafMain);
    await world.tell(`A${rounds}`, question);
    await world.leaf.finishTurn(world.leafMain, { deliver: false });
    const answers = world.fromLeaf().length;
    expect(await world.collect()).toBe(true);
    await world.command.deliver();
    if (world.fromLeaf().length === answers) break;
    await world.command.finishTurn(world.commandMain, { deliver: false });
    question = (await world.ask(`Q${rounds + 1}`)).messageId as string;
  }
  return rounds;
}

describe("command node coordinator ↔ leaf coordinator", () => {
  for (const char of ["a", "😀"])
    test(`boundary payloads deliver and drain (${char})`, async () => {
      const world = await link();
      const body = char.repeat(AGENT_MAIL_MAX_BODY_BYTES / Buffer.byteLength(char));
      const asked = await world.ask(body);
      const question = await world.leaf.storage.getAgentMailMessage(
        world.leafMain.environmentId,
        world.leafMain.tabId,
        asked.messageId as string,
      );
      expect(question.body.endsWith(body)).toBe(true);
      await world.tell(body, question.id);
      expect(await world.collect()).toBe(true);
      const inbox = await world.command.storage.getAgentMailMailbox(
        world.commandMain.environmentId,
        world.commandMain.tabId,
      );
      const answer = await world.command.storage.getAgentMailMessage(
        world.commandMain.environmentId,
        world.commandMain.tabId,
        inbox.messages.find((m) => m.from.kind === "node")!.id,
      );
      expect(answer.body.endsWith(body)).toBe(true);
      const outbox = await world.leafCall("collect_node_outbox", {
        controllerId: "bk_cmd",
        after: 0,
        coordinatorMail: true,
      });
      expect(outbox.items).toEqual([]);
    });

  test("an older command collector cannot consume coordinator mail as worker mail", async () => {
    const world = await link();
    await world.tell("Keep this until the command node is updated");
    const old = await world.leafCall("collect_node_outbox", { controllerId: "bk_cmd", after: 0 });
    expect(old.items).toEqual([]);
    await world.leafCall("ack_node_outbox", { controllerId: "bk_cmd", upTo: 999 });
    const modern = await world.leafCall("collect_node_outbox", {
      controllerId: "bk_cmd",
      after: 0,
      coordinatorMail: true,
    });
    expect(modern.items).toHaveLength(1);
    expect(await world.collect()).toBe(true);
  });

  test("cross-node hop limits refuse before a reply is queued", async () => {
    const world = await link({ budget: 50 });
    let question = (await world.ask("Q0")).messageId as string;
    for (let round = 0; round < 4; round++) {
      await world.tell(`A${round}`, question);
      expect(await world.collect()).toBe(true);
      const inbox = await world.command.storage.getAgentMailMailbox(
        world.commandMain.environmentId,
        world.commandMain.tabId,
      );
      const answer = inbox.messages
        .filter((m) => m.from.kind === "node")
        .sort((a, b) => (b.hopCount ?? 0) - (a.hopCount ?? 0))[0]!;
      expect(answer.hopCount).toBe(round * 2 + 1);
      question = (await world.ask(`Q${round + 1}`, world.commandMain, answer.id))
        .messageId as string;
    }
    await expect(world.tell("Too many hops", question)).rejects.toThrow("Thread hop limit");
    const outbox = await world.leafCall("collect_node_outbox", {
      controllerId: "bk_cmd",
      after: 0,
      coordinatorMail: true,
    });
    expect(outbox.items).toEqual([]);
  });

  test("upward new mail reopens the command main", async () => {
    const world = await link();
    await world.command.closeMain();
    await world.tell("Status from the leaf");
    expect(await world.collect()).toBe(true);
    const reopened = await world.command.main();
    expect(reopened.conversationId).not.toBe(world.commandMain.conversationId);
    await world.command.deliver();
    expect(world.command.received(reopened).join("\n")).toContain("Status from the leaf");
  });

  describe("an agent on the leaf that no coordinator has contacted", () => {
    async function agentOnLeaf(world: Awaited<ReturnType<typeof link>>) {
      const agent = await world.leaf.addEnvironment("component-reuse-review");
      const router = world.leaf.storage.nodeMailRouter!;
      const destination = await router.route({
        fromEnvironmentId: agent.environmentId,
        fromTabId: agent.tabId,
        toEnvironmentId: "coordinator",
      });
      await router.enqueue(destination!, {
        requestId: "handoff",
        fromEnvironmentId: agent.environmentId,
        fromTabId: agent.tabId,
        body: "Create build environments for these items.",
      });
      return agent;
    }
    const inboxOf = async (world: MailWorld, actor: MailActor) =>
      (await world.storage.getAgentMailMailbox(actor.environmentId, actor.tabId)).messages;

    // What the user saw: the leaf's coordinator got the request it could not act on.
    test("reaches the command node's coordinator, not the leaf's", async () => {
      const world = await link();
      await agentOnLeaf(world);
      expect(await world.collect()).toBe(true);
      await world.command.deliver();
      expect(world.command.received(world.commandMain).join("\n")).toContain(
        "Create build environments for these items.",
      );
      expect(await inboxOf(world.leaf, world.leafMain)).toEqual([]);
    });

    test("reopens a closed main on the command node instead of waiting in the outbox", async () => {
      const world = await link();
      await world.command.closeMain();
      await agentOnLeaf(world);
      expect(await world.collect()).toBe(true);
      const reopened = await world.command.main();
      expect(reopened.conversationId).not.toBe(world.commandMain.conversationId);
      await world.command.deliver();
      expect(world.command.received(reopened).join("\n")).toContain(
        "Create build environments for these items.",
      );
    });

    test("falls back to the leaf's coordinator when the command node has none for the repository", async () => {
      const world = await link();
      await world.command.storage.updateProject(world.command.projectId, {
        gitUrl: "git@github.com:acme/other.git",
      });
      await agentOnLeaf(world);
      expect(await world.collect()).toBe(true);
      expect(await inboxOf(world.command, world.commandMain)).toEqual([]);
      const [returned] = await inboxOf(world.leaf, world.leafMain);
      const message = await world.leaf.storage.getAgentMailMessage(
        world.leafMain.environmentId,
        world.leafMain.tabId,
        returned!.id,
      );
      expect(message.fallbackNotice).toContain(
        "Office desktop has no coordinator for this repository",
      );
      expect(message.body).toContain("Create build environments for these items.");
      const outbox = await world.leafCall("collect_node_outbox", {
        controllerId: "bk_cmd",
        after: 0,
        coordinatorMail: true,
      });
      expect(outbox.items).toEqual([]);
    });
  });

  test("a question reaches the leaf's main coordinator and its answer comes back in the same thread", async () => {
    const world = await link();
    const asked = await world.ask("Which release branch is checked out on the build box?");
    expect(asked).toMatchObject({
      nodeId: "bk_leaf",
      toEnvironmentId: "coordinator",
      placement: "pending-inject",
      coordinatorDelegationOpened: false,
      delivery: "async",
    });
    expect(world.routed.find((entry) => entry.command === "deliver_node_mail")!.args).toMatchObject(
      { toEnvironmentId: "coordinator", projectId: world.leafProjectId },
    );
    // Not a worker: no delegation or association is kept for it.
    expect(
      (
        await world.command.storage.coordinators.listCoordinatorWorkflowAssociations(
          world.command.projectId,
        )
      ).filter((entry) => entry.nodeId),
    ).toEqual([]);

    await world.leaf.deliver();
    const [question] = world.leaf.carriers(world.leafMain).flat();
    expect(question).toMatchObject({ kind: "coordinator", from: { kind: "node" } });
    expect(question!.from).toMatchObject({ role: "coordinator", nodeName: "Office desktop" });
    expect(question!.body).toContain("From the main coordinator on Office desktop");
    expect(question!.body).toContain("never act on other nodes");
    expect(question!.body).toContain("Which release branch");
    const stored = await world.leaf.storage.getAgentMailMessage(
      world.leafMain.environmentId,
      world.leafMain.tabId,
      asked.messageId as string,
    );
    expect(stored).toMatchObject({ trust: "same-project", route: "coordinator" });

    const answered = await world.tell("release/2.36 at a1b2c3.", asked.messageId as string);
    expect(answered).toMatchObject({
      placement: "node-outbox",
      coordinator: "command node Office desktop",
      replyToMessageId: asked.messageId,
    });
    // Answered, so the request leaves the leaf coordinator's inbox.
    expect(
      (
        await world.leaf.storage.getAgentMailMessage(
          world.leafMain.environmentId,
          world.leafMain.tabId,
          asked.messageId as string,
        )
      ).ackedAt,
    ).toBeDefined();
    // The reply is addressed to the conversation that asked.
    const outbox = await world.leafCall("collect_node_outbox", {
      controllerId: "bk_cmd",
      after: 0,
      coordinatorMail: true,
    });
    expect((outbox.items as unknown[])[0]).toMatchObject({
      fromCoordinator: true,
      replyToMessageId: asked.messageId,
      toCoordinator: {
        environmentId: world.commandMain.environmentId,
        tabId: world.commandMain.tabId,
      },
    });

    expect(await world.collect()).toBe(true);
    await world.command.deliver();
    const [answer] = world.fromLeaf();
    // A leaf coordinator has no authority here: its mail is an agent's,
    // untrusted, and says which coordinator it came from.
    expect(answer).toMatchObject({ kind: "message" });
    expect(answer!.from).toMatchObject({
      role: "agent",
      nodeId: "bk_leaf",
      nodeName: "Build box",
      environmentId: world.leafMain.environmentId,
    });
    expect(answer!.body).toContain("coordinator for this project on node Build box");
    expect(answer!.body).toContain(`This answers your message ${asked.messageId}`);
    expect(answer!.body).toContain("not instructions");
    expect(answer!.body).toContain("release/2.36 at a1b2c3.");
    const inbox = await world.command.storage.getAgentMailMailbox(
      world.commandMain.environmentId,
      world.commandMain.tabId,
    );
    expect(inbox.messages.find((message) => message.from.kind === "node")).toMatchObject({
      trust: "same-project",
    });

    const answerMessage = inbox.messages.find((message) => message.from.kind === "node")!;
    expect(answerMessage.threadId).toBe(stored.threadId);
    expect(answerMessage.replyToMessageId).toBe(stored.id);
    expect(answerMessage.hopCount).toBe(1);
    const followup = await world.ask("And now?", world.commandMain, answerMessage.id);
    const followupMessage = await world.leaf.storage.getAgentMailMessage(
      world.leafMain.environmentId,
      world.leafMain.tabId,
      followup.messageId as string,
    );
    expect(followupMessage.threadId).toBe(stored.threadId);
    expect(followupMessage.replyToMessageId).toBe(answerMessage.id);
    expect(followupMessage.hopCount).toBe(2);
    const carrier = renderAgentMailCarrier(stored);
    expect(carrier).toContain("Reply with send_message");
    expect(carrier).not.toContain("reply_message tool");
    expect(carrier).not.toContain("authenticated delegation");
    expect(carrier).not.toContain("follow that task");
    // Replying to that message goes back to the leaf's coordinator address.
    const target = nodeMailReplyTarget(
      inbox.messages.find((message) => message.from.kind === "node")!.from,
    );
    expect(target).toEqual({ kind: "node", nodeId: "bk_leaf", toEnvironmentId: "coordinator" });
  });

  test("a leaf coordinator starts a message to the command node's coordinator", async () => {
    const world = await link();
    const sent = await world.tell("The build box disk is 95% full.");
    expect(sent).toMatchObject({
      placement: "node-outbox",
      toEnvironmentId: COMMAND_NODE_COORDINATOR_MAIL_ADDRESS,
    });
    const outbox = await world.leafCall("collect_node_outbox", {
      controllerId: "bk_cmd",
      after: 0,
      coordinatorMail: true,
    });
    const [item] = outbox.items as Array<Record<string, unknown>>;
    // A new message goes to the repository's main coordinator there.
    expect(item).not.toHaveProperty("toCoordinator");
    expect(item!.repositoryHint).toBeString();
    expect(await world.collect()).toBe(true);
    await world.command.deliver();
    const [message] = world.fromLeaf();
    expect(message!.body).toContain("This is a new message, not an answer.");
    expect(message!.body).toContain("95% full");
    // Answering it from the command node targets the leaf's coordinator.
    const asked = await world.ask("Clean the build cache.");
    expect(asked.placement).toBe("pending-inject");
  });

  test("a reply on a leaf goes up through the outbox, not the node tools", () => {
    expect(
      nodeMailReplyTarget({
        kind: "node",
        nodeId: "bk_cmd",
        role: "coordinator",
        environmentId: "coordinator:c1:main",
        tabId: "t",
      }),
    ).toEqual({ kind: "command-node" });
    expect(
      nodeMailReplyTarget({
        kind: "node",
        nodeId: "bk_leaf",
        role: "agent",
        environmentId: "worker-env",
        tabId: "startup-agent",
      }),
    ).toEqual({
      kind: "node",
      nodeId: "bk_leaf",
      toEnvironmentId: "worker-env",
      toTabId: "startup-agent",
    });
    expect(nodeMailReplyTarget({ kind: "tab", environmentId: "e", tabId: "t" })).toBeNull();
  });

  test("side agents stay limited to their own main coordinator on both nodes", async () => {
    const world = await link();
    const commandSide = await world.command.addSide();
    await expect(world.ask("Status?", commandSide)).rejects.toThrow(
      "A side agent can only message the main coordinator",
    );
    const leafSide = await world.leaf.addSide();
    await expect(world.tell("Hello upstairs.", undefined, leafSide)).rejects.toThrow(
      "A side agent can only message the main coordinator",
    );
    // The command node's mail reaches the leaf's main, never a side agent.
    await world.ask("Status?");
    await world.leaf.deliver();
    expect(world.leaf.wakes(leafSide)).toBe(0);
    expect(world.leaf.wakes(world.leafMain)).toBe(1);
    expect(world.routed.filter((entry) => entry.command === "deliver_node_mail")).toHaveLength(1);
  });

  test("an older leaf gets a clear update refusal and nothing is sent", async () => {
    const world = await link({ capabilities: { "node-attachment": 1, "node-mail-steer": 1 } });
    const counted = () =>
      compatibilityPathUsage.snapshot().paths["node-coordinator-mail.older-node"]?.count ?? 0;
    const before = counted();
    await expect(world.ask("Status?")).rejects.toThrow(
      "Build box runs an older Orkestrator whose coordinator cannot take mail from this one; update that machine",
    );
    expect(world.routed.some((entry) => entry.command === "deliver_node_mail")).toBe(false);
    const reach = await world.run("get_coordinator_node_mailbox", {
      scope: world.scopeOf(world.command, world.commandMain),
      nodeId: "bk_leaf",
    });
    expect(reach.coordinator).toMatchObject({ reachable: false });
    expect((reach.coordinator as { reason: string }).reason).toContain("update that machine");
    expect(world.routed.some((entry) => entry.command === "get_node_project_coordinator")).toBe(
      false,
    );
    expect(counted()).toBe(before + 2);
  });

  test("discovery says whether a node's project has a coordinator", async () => {
    const world = await link();
    const reach = await world.run("get_coordinator_node_mailbox", {
      scope: world.scopeOf(world.command, world.commandMain),
      nodeId: "bk_leaf",
    });
    expect(reach).toMatchObject({
      nodeId: "bk_leaf",
      node: "Build box",
      coordinator: { reachable: true, address: "coordinator", agent: "codex" },
    });

    const bare = await link({ leafWithoutCoordinator: true });
    const none = await bare.run("get_coordinator_node_mailbox", {
      scope: bare.scopeOf(bare.command, bare.commandMain),
      nodeId: "bk_leaf",
    });
    expect(none.coordinator).toMatchObject({ reachable: false });
    await expect(bare.ask("Status?")).rejects.toThrow("This node has no coordinator for");
  });

  test("a closed leaf main is reopened with the default agent, as local mail does", async () => {
    const world = await link();
    await world.leaf.closeMain();
    const asked = await world.ask("Status?");
    const reopened = await world.leaf.main();
    expect(reopened.conversationId).not.toBe(world.leafMain.conversationId);
    expect(asked.placement).toBe("pending-inject");
    await world.leaf.deliver();
    expect(world.leaf.received(reopened).join("\n")).toContain("Status?");
  });

  test("every other leaf-mode refusal is unchanged", async () => {
    const world = await link();
    const leafScope = world.scopeOf(world.leaf, world.leafMain);
    for (const toEnvironmentId of ["coordinator", "some-worker"]) {
      await expect(
        world.leafCall("send_coordinator_node_mail", {
          scope: leafScope,
          nodeId: "bk_cmd",
          toEnvironmentId,
          requestId: `leaf-${toEnvironmentId}`,
          body: "Across nodes?",
        }),
      ).rejects.toThrow("This node is in leaf mode");
    }
    await expect(
      world.leafCall("get_coordinator_node_mailbox", { scope: leafScope, nodeId: "bk_cmd" }),
    ).rejects.toThrow("This node is in leaf mode");
    // Only a command node's coordinator's mail can be answered upward.
    const local = await world.leaf.send(
      await world.leaf.addEnvironment("local-worker"),
      "coordinator",
      "Local report.",
    );
    await expect(world.tell("Answer.", local.id)).rejects.toThrow(
      "That message did not come from a command node's coordinator.",
    );
    // A node no command node controls has no one to write to.
    world.detach();
    await expect(world.tell("Anyone there?")).rejects.toThrow(
      "This node is not controlled by a command node",
    );
  });

  test("budgets stop two coordinators from waking each other endlessly", async () => {
    const world = await link({ budget: 3 });
    const rounds = await loopUntilHeld(world);
    const notices = await world.command.storage.getAgentMailMailbox(
      world.commandMain.environmentId,
      world.commandMain.tabId,
    );
    const noticeSummary = notices.messages.find(
      (m) => m.from.kind === "system" && m.subject?.includes("loop budget"),
    );
    const notice = noticeSummary
      ? await world.command.storage.getAgentMailMessage(
          world.commandMain.environmentId,
          world.commandMain.tabId,
          noticeSummary.id,
        )
      : null;
    expect(notice?.body).toContain("Sending another request does not reset this budget");
    expect(notice?.body).toContain("Ask the user");
    // The command node's budget for the leaf coordinator's mail stopped it:
    // three answers woke the command node's coordinator, the fourth is held.
    expect(rounds).toBe(3);
    expect(world.fromLeaf().map((carrier) => carrier.body.split("\n\n").at(-1))).toEqual([
      "A0",
      "A1",
      "A2",
    ]);
    const held = (await world.command.undelivered(world.commandMain)).filter(
      (message) => message.from.kind === "node",
    );
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      placement: "inject-held",
      placementReason: "loop-budget-exhausted",
    });
    // Each new question is a new request to the leaf, as to a worker.
    expect(world.leaf.wakes(world.leafMain)).toBe(4);
  });

  test("a held answer stays held when the user replaces the command node's main", async () => {
    // Found by the two-profile run (to-do 2900): closing the main and opening
    // a new one released the budget-held answer, which woke the new main with
    // no prompt or Resume from the user.
    const world = await link({ budget: 3 });
    expect(await loopUntilHeld(world)).toBe(3);
    await world.command.closeMain();
    const snapshot = await world.command.coordinator.createConversation(world.command.projectId);
    const opened = snapshot.workspace.conversations.find(
      (item) => item.role === "main" && !item.closedAt,
    )!;
    await world.command.coordinator.assignConversationAgent(
      world.command.projectId,
      opened.id,
      "codex",
    );
    await world.command.storage.synchronizeAgentMailboxes();
    const next = await world.command.main();
    expect(next.conversationId).not.toBe(world.commandMain.conversationId);
    await world.command.deliver();

    // Moved across with the closed main's inbox, still held by the budget.
    expect(world.command.wakes(next)).toBe(0);
    const held = (await world.command.undelivered(next)).filter(
      (message) => message.from.kind === "node",
    );
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      placement: "inject-held",
      placementReason: "loop-budget-exhausted",
    });

    // The user's Resume releases it, as on the main it was held for.
    await world.command.storage.retryAgentMailInject(next.environmentId, next.tabId, held[0]!.id);
    await world.command.deliver();
    expect(world.command.wakes(next)).toBe(1);
    expect(await world.command.undelivered(next)).toEqual([]);
  });
  test("hourly history survives main replacement until the hour expires", async () => {
    const world = await link({ budget: 10 });
    const config = await world.command.storage.loadConfig();
    await world.command.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, hourlyWakeLimit: 2 },
    });
    for (let i = 0; i < 3; i++) {
      await world.tell(`answer ${i}`);
      await world.collect();
      await world.command.deliver();
      await world.command.finishTurn(world.commandMain, { deliver: false });
    }
    expect(
      (await world.command.undelivered(world.commandMain)).filter((m) => m.from.kind === "node"),
    ).toMatchObject([{ placementReason: "hourly-limit" }]);
    await world.command.closeMain();
    expect(await world.command.storage.releaseHourlyHeldAgentMail()).toBe(0);
    const snapshot = await world.command.coordinator.createConversation(world.command.projectId);
    const opened = snapshot.workspace.conversations.find(
      (item) => item.role === "main" && !item.closedAt,
    )!;
    await world.command.coordinator.assignConversationAgent(
      world.command.projectId,
      opened.id,
      "codex",
    );
    await world.command.storage.synchronizeAgentMailboxes();
    const next = await world.command.main();
    expect(await world.command.storage.releaseHourlyHeldAgentMail()).toBe(0);
    await world.command.deliver();
    expect(world.command.wakes(next)).toBe(0);
    expect(
      (await world.command.undelivered(next)).filter((m) => m.from.kind === "node"),
    ).toMatchObject([{ placement: "inject-held", placementReason: "hourly-limit" }]);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
    try {
      expect(await world.command.storage.releaseHourlyHeldAgentMail()).toBe(1);
      await world.command.deliver();
      expect(world.command.wakes(next)).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("closing a side conversation makes its budget-held mail undeliverable", async () => {
    const world = await link({ budget: 1 });
    const side = await world.command.addSide();
    await world.command.send(world.commandMain, side, "first");
    const held = await world.command.send(world.commandMain, side, "held");
    expect(held).toMatchObject({
      placement: "inject-held",
      placementReason: "loop-budget-exhausted",
    });
    await world.command.coordinator.closeConversation(
      world.command.projectId,
      side.conversationId!,
    );
    await world.command.storage.synchronizeAgentMailboxes();
    expect(
      await world.command.storage.getAgentMailMessage(side.environmentId, side.tabId, held.id),
    ).toMatchObject({ placement: "undeliverable", placementReason: "tab-closed" });
  });
});
