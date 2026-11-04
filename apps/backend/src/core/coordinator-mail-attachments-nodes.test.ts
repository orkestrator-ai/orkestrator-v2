/**
 * A coordinator's images across a node link: two real mail worlds joined by a
 * fake link, as in `coordinator-node-coordinator-mail.test.ts`, with each
 * node's real file and mail commands behind it, so the bytes really move
 * through the transfer framework from one data directory to the other.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { COMMAND_NODE_COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";

import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { outboxMailAttachmentBatch, mailAttachmentSpoolDir } from "./mail-attachments.js";
import type { Environment } from "./models.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import {
  addPipelineEnvironment,
  pipelineSnapshot,
  pipelineWorkerPort,
  savePipeline,
  ScriptedSteerProvider,
  stageSession,
} from "./pipeline-worker-mail-test-support.js";
import { runCommand } from "./shell.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5, 5, 5]);

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
  "node-mail-attachments": 1,
};

type Result = Record<string, any>;

/** Removal after an acknowledgement is not awaited by the node that asked for it. */
async function spoolEmpties(world: MailWorld) {
  const spool = path.join(world.storage.getDataDir(), "mail-attachment-spool");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await fs.readdir(spool)).length === 0) return;
    await Bun.sleep(10);
  }
  expect(await fs.readdir(spool)).toEqual([]);
}

async function link(
  options: {
    capabilities?: Record<string, number>;
    leafExec?: typeof runCommand;
    leafWorkers?: boolean;
  } = {},
) {
  const provider = new ScriptedSteerProvider();
  const command = await MailWorld.create();
  const leaf = await MailWorld.create(
    options.leafWorkers
      ? { pipelineWorkers: (storage) => pipelineWorkerPort(storage, provider).workerMail }
      : {},
  );
  worlds.push(command, leaf);
  for (const world of [command, leaf])
    await world.storage.updateProject(world.projectId, { gitUrl: "git@github.com:acme/site.git" });

  const commandRegistry = createCommandRegistry();
  const leafRegistry = createCommandRegistry({
    containerFileCopy: { runCommand: options.leafExec ?? runCommand },
  });
  const state = {
    available: true,
    /** Commands the link loses, by name, as a node going away would. */
    failing: new Set<string>(),
  };
  const routed: Array<{ command: string; args: Record<string, unknown> }> = [];
  const fence = { beginMutation: () => () => undefined };

  const leafInvoke = (name: string, args: Record<string, unknown> = {}) =>
    leafRegistry.get(name)!(args, leafContext) as Promise<any>;
  const leafCoordination = new NodeCoordination({
    storage: leaf.storage,
    nodes: {
      listControllers: () => [{ controllerId: "bk_cmd", displayName: "Office desktop" }],
      mostRecentControllerId: () => "bk_cmd",
      selfIdentity: async () => "bk_leaf",
      subscribe: () => () => {},
    } as never,
    portal: { readModel: { onNodeEvent: () => () => {} } } as never,
    invoke: leafInvoke as never,
    emit: () => {},
  });
  disposers.push(() => leafCoordination.dispose());
  const leafContext = {
    storage: leaf.storage,
    coordinators: leaf.coordinator,
    nodeCoordination: leafCoordination,
    drainAgentMail: () => leaf.mail.drainInjects(),
    nodePortal: {},
    runtime: {
      coordinatorRequests: leaf.coordinatorRequests,
      environments: { fence },
    },
    nodes: {
      status: async () => ({
        nodeId: "bk_leaf",
        mode: "leaf",
        controllers: [{ displayName: "Office desktop" }],
      }),
    },
  } as unknown as CommandContext;

  const overLink = async (name: string, args: Record<string, unknown> = {}) => {
    routed.push({ command: name, args });
    if (state.failing.has(name)) throw new Error("The connection to Build box was lost.");
    return leafInvoke(name, structuredClone(args));
  };
  const hint = repositoryHint((await leaf.storage.getProject(leaf.projectId))!.gitUrl);
  const portal = {
    readModel: { onNodeEvent: () => () => {} },
    summaries: async () => ({
      selfId: "bk_cmd",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: state.available,
          view: { displayName: "Build box" },
          projects: [{ ref: { projectId: leaf.projectId }, repositoryHint: hint }],
        },
      ],
    }),
    invokeOnNode: async (input: { command: string; args: Record<string, unknown> }) => ({
      outcome: "ok",
      result: await overLink(input.command, input.args),
    }),
  };
  const commandInvoke = (name: string, args: Record<string, unknown> = {}) =>
    commandRegistry.get(name)!(args, commandContext) as Promise<any>;
  const commandCoordination = new NodeCoordination({
    storage: command.storage,
    nodes: {
      listControllers: () => [],
      selfIdentity: async () => "bk_cmd",
      link: (nodeId: string) =>
        nodeId === "bk_leaf"
          ? {
              connected: state.available,
              hello: { capabilities: options.capabilities ?? ALL_CAPABILITIES },
              invoke: overLink,
            }
          : null,
      getNode: async () => ({ displayName: "Build box" }),
      subscribe: () => () => {},
    } as never,
    portal: portal as never,
    invoke: commandInvoke as never,
    emit: () => {},
  });
  disposers.push(() => commandCoordination.dispose());
  const commandContext = {
    storage: command.storage,
    coordinators: command.coordinator,
    nodeCoordination: commandCoordination,
    drainAgentMail: () => command.mail.drainInjects(),
    runtime: {
      coordinatorRequests: command.coordinatorRequests,
      environments: { fence },
    },
    nodes: {
      status: async () => ({ nodeId: "bk_cmd", mode: "command" }),
      link: (nodeId: string) =>
        nodeId === "bk_leaf"
          ? { hello: { capabilities: options.capabilities ?? ALL_CAPABILITIES } }
          : null,
    },
    nodePortal: portal,
  } as unknown as CommandContext;

  const commandMain = await command.main();
  const leafMain = await leaf.main();
  const scopeOf = (world: MailWorld, actor: MailActor) => ({
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: actor.conversationId!,
  });
  const paste = (world: MailWorld, actor: MailActor, data = PNG) =>
    world.storage.coordinators.writeCoordinatorAttachment(
      world.coordinatorId,
      actor.conversationId!,
      "shot.png",
      data.toString("base64"),
    );
  const sendDown = (args: Record<string, unknown>) =>
    commandInvoke("send_coordinator_node_mail", {
      scope: scopeOf(command, commandMain),
      nodeId: "bk_leaf",
      body: "See the image.",
      ...args,
    }) as Promise<Result>;
  const sendUp = (args: Record<string, unknown>) =>
    leafInvoke("send_coordinator_command_node_mail", {
      scope: scopeOf(leaf, leafMain),
      body: "See the image.",
      ...args,
    }) as Promise<Result>;
  const inbox = async (world: MailWorld, actor: { environmentId: string; tabId: string }) =>
    (await world.storage.getAgentMailMailbox(actor.environmentId, actor.tabId)).messages;
  const withWorktree = async (actor: { environmentId: string }) => {
    const worktree = path.join(leaf.root, "leaf-worker");
    await runCommand("git", ["worktree", "add", "-b", "leaf-worker", worktree], {
      cwd: path.join(leaf.root, "checkout"),
    });
    await leaf.storage.updateEnvironment(actor.environmentId, { worktreePath: worktree });
    return worktree;
  };
  const leafWorker = async () => {
    const worker = await leaf.addEnvironment("leaf-worker");
    return { worker, worktree: await withWorktree(worker) };
  };
  const collect = () => commandCoordination.collector.collect("bk_leaf" as never);
  const count = (name: string) => routed.filter((entry) => entry.command === name).length;
  return {
    provider,
    command,
    leaf,
    commandMain,
    leafMain,
    state,
    routed,
    count,
    paste,
    sendDown,
    sendUp,
    inbox,
    withWorktree,
    leafWorker,
    collect,
    leafInvoke,
    commandInvoke,
    scopeOf,
    leafCoordination,
  };
}

describe("a command node's coordinator sending to a leaf", () => {
  test("an agent tab there can open the image from the path its own node wrote", async () => {
    const world = await link();
    const { worker, worktree } = await world.leafWorker();
    const source = await world.paste(world.command, world.commandMain);

    const sent = await world.sendDown({
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [source],
    });

    const [message] = await world.inbox(world.leaf, worker);
    expect(message!.attachments).toHaveLength(1);
    const { path: file, bytes, name } = message!.attachments![0]!;
    expect(file.startsWith(`${worktree}/.orkestrator/mail-attachments/`)).toBe(true);
    expect(name).toBe(path.basename(source));
    expect(bytes).toBe(PNG.length);
    expect((await fs.readFile(file)).equals(PNG)).toBe(true);
    expect(sent.attachments).toEqual(message!.attachments);
    // Nothing left in either machine's spool, nothing for the worktree to commit.
    for (const node of [world.command, world.leaf]) {
      expect(
        await fs.readdir(path.join(node.storage.getDataDir(), "mail-attachment-spool")),
      ).toEqual([]);
    }
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: worktree })).stdout).toBe("");
  });

  test("a retry with the same requestId copies nothing and delivers nothing new", async () => {
    const world = await link();
    const { worker } = await world.leafWorker();
    const args = {
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [await world.paste(world.command, world.commandMain)],
    };
    const first = await world.sendDown(args);
    expect(world.count("begin_node_file_write")).toBe(1);

    const second = await world.sendDown(args);

    expect(second.messageId).toBe(first.messageId);
    expect(world.count("begin_node_file_write")).toBe(1);
    expect(await world.inbox(world.leaf, worker)).toHaveLength(1);
  });

  test("a build pipeline worker there gets it by its address", async () => {
    const world = await link({ leafWorkers: true });
    const environmentId = await addPipelineEnvironment(world.leaf);
    const worktree = await world.withWorktree({ environmentId });
    const build = stageSession("build", { key: "build", label: "Build Session" });
    await savePipeline(
      world.leaf.storage,
      pipelineSnapshot(environmentId, world.leaf.projectId, [build]),
    );
    const tabId = pipelineWorkerTabId(build.sessionKey);

    await world.sendDown({
      requestId: "r1",
      toEnvironmentId: environmentId,
      toTabId: tabId,
      attachments: [await world.paste(world.command, world.commandMain)],
    });

    const [message] = await world.inbox(world.leaf, { environmentId, tabId });
    expect(message!.attachments![0]!.path.startsWith(worktree)).toBe(true);
    expect((await fs.readFile(message!.attachments![0]!.path)).equals(PNG)).toBe(true);
  });

  test("a container there gets it inside the container", async () => {
    const writes: string[][] = [];
    const seen = new Map<string, Buffer>();
    const leafExec = (async (
      program: string,
      args: string[],
      runOptions: Parameters<typeof runCommand>[2] = {},
    ) => {
      if (program !== "docker") return runCommand(program, args, runOptions);
      if (args[1] === "-i") {
        writes.push(args);
        seen.set(args.at(-6)!, Buffer.from(String(runOptions.stdin), "base64"));
        return { stdout: "", stderr: "" };
      }
      if (args[1] === "-w") return { stdout: "", stderr: "" };
      throw new Error("No such file");
    }) as typeof runCommand;
    const world = await link({ leafExec });
    const worker = await world.leaf.addEnvironment("boxed");
    await world.leaf.storage.updateEnvironment(worker.environmentId, {
      environmentType: "containerized",
      containerId: "leaf-container",
      status: "running",
    } as Partial<Environment>);

    await world.sendDown({
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [await world.paste(world.command, world.commandMain)],
    });

    const [message] = await world.inbox(world.leaf, worker);
    const attachment = message!.attachments![0]!;
    expect(attachment.path.startsWith("/workspace/.orkestrator/mail-attachments/")).toBe(true);
    expect(writes[0]![2]).toBe("leaf-container");
    expect(seen.get(attachment.name)?.equals(PNG)).toBe(true);
  });

  test("the leaf's coordinator gets it in its own conversation's directory", async () => {
    const world = await link();
    await world.sendDown({
      requestId: "r1",
      toEnvironmentId: "coordinator",
      attachments: [await world.paste(world.command, world.commandMain)],
    });
    const [message] = await world.inbox(world.leaf, world.leafMain);
    const attachment = message!.attachments![0]!;
    expect(path.dirname(attachment.path)).toBe(
      world.leaf.storage.coordinators.coordinatorAttachmentDirectory(
        world.leaf.coordinatorId,
        world.leafMain.conversationId!,
      ),
    );
    expect((await fs.readFile(attachment.path)).equals(PNG)).toBe(true);
  });

  test("a failed transfer means no message, and a retry finishes it", async () => {
    const world = await link();
    const { worker } = await world.leafWorker();
    const args = {
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [await world.paste(world.command, world.commandMain)],
    };
    world.state.failing.add("commit_node_file_write");

    await expect(world.sendDown(args)).rejects.toThrow(/could not be copied to Build box/);
    expect(world.count("deliver_node_mail")).toBe(0);
    expect(await world.inbox(world.leaf, worker)).toEqual([]);

    world.state.failing.clear();
    await world.sendDown(args);
    expect(await world.inbox(world.leaf, worker)).toHaveLength(1);
  });

  test("a file the leaf cannot place means no message, with the leaf's reason", async () => {
    const world = await link();
    const worker = await world.leaf.addEnvironment("boxed");
    await world.leaf.storage.updateEnvironment(worker.environmentId, {
      environmentType: "containerized",
      containerId: "leaf-container",
      status: "stopped",
    } as Partial<Environment>);
    await expect(
      world.sendDown({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await world.paste(world.command, world.commandMain)],
      }),
    ).rejects.toThrow("boxed is not running");
    expect(world.count("begin_node_file_write")).toBe(0);
    expect(world.count("deliver_node_mail")).toBe(0);
    expect(await world.inbox(world.leaf, worker)).toEqual([]);
  });

  test("a disconnected node is refused clearly, before anything moves", async () => {
    const world = await link();
    const { worker } = await world.leafWorker();
    world.state.available = false;
    await expect(
      world.sendDown({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await world.paste(world.command, world.commandMain)],
      }),
    ).rejects.toThrow(/Build box/);
    expect(world.routed).toEqual([]);
    expect(await world.inbox(world.leaf, worker)).toEqual([]);
  });

  test("an older leaf is refused rather than sent a message without its images", async () => {
    const usage = () =>
      compatibilityPathUsage.snapshot().paths["node-mail-attachments.older-node"]?.count ?? 0;
    const before = usage();
    const world = await link({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1, "node-coordinator-mail": 1 },
    });
    const { worker } = await world.leafWorker();
    const attachments = [await world.paste(world.command, world.commandMain)];
    for (const toEnvironmentId of [worker.environmentId, "coordinator"]) {
      await expect(
        world.sendDown({ requestId: `r-${toEnvironmentId}`, toEnvironmentId, attachments }),
      ).rejects.toThrow(/older Orkestrator that cannot receive images/);
    }
    expect(world.count("deliver_node_mail")).toBe(0);
    expect(usage()).toBe(before + 2);
  });

  test("another conversation's attachment is refused before the node hears of it", async () => {
    const world = await link();
    const { worker } = await world.leafWorker();
    const side = await world.command.addSide();
    await expect(
      world.sendDown({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await world.paste(world.command, side)],
      }),
    ).rejects.toThrow(/not one of this conversation's attachments/);
    expect(world.routed).toEqual([]);
  });
});

describe("a leaf's coordinator sending to the command node", () => {
  test("waits in the outbox, then reaches the coordinator there, readable", async () => {
    const world = await link();
    const source = await world.paste(world.leaf, world.leafMain);

    const sent = await world.sendUp({ requestId: "up-1", attachments: [source] });

    expect(sent).toMatchObject({
      toEnvironmentId: COMMAND_NODE_COORDINATOR_MAIL_ADDRESS,
      placement: "node-outbox",
      attachments: [path.basename(source)],
    });
    // The pasted original can go; the outbox holds its own copy until collected.
    await fs.rm(source);
    expect(await world.collect()).toBe(true);

    const [message] = await world.inbox(world.command, world.commandMain);
    const attachment = message!.attachments![0]!;
    expect(path.dirname(attachment.path)).toBe(
      world.command.storage.coordinators.coordinatorAttachmentDirectory(
        world.command.coordinatorId,
        world.commandMain.conversationId!,
      ),
    );
    expect((await fs.readFile(attachment.path)).equals(PNG)).toBe(true);
    // Acknowledged: the leaf's spooled copy is gone.
    for (const node of [world.command, world.leaf]) {
      await spoolEmpties(node);
    }
  });

  test("a failed fetch delivers nothing and stays queued for the next attempt", async () => {
    const world = await link();
    await world.sendUp({
      requestId: "up-1",
      attachments: [await world.paste(world.leaf, world.leafMain)],
    });
    world.state.failing.add("read_node_file");

    expect(await world.collect()).toBe(false);
    expect(await world.inbox(world.command, world.commandMain)).toEqual([]);
    expect(await world.leafCoordination.leafMail.pending("bk_cmd" as never)).toBe(1);

    world.state.failing.clear();
    expect(await world.collect()).toBe(true);
    expect(await world.inbox(world.command, world.commandMain)).toHaveLength(1);
    expect(await world.leafCoordination.leafMail.pending("bk_cmd" as never)).toBe(0);
  });

  test("a retry never delivers twice, while queued or after it was delivered", async () => {
    const world = await link();
    const args = {
      requestId: "up-1",
      attachments: [await world.paste(world.leaf, world.leafMain)],
    };
    const first = await world.sendUp(args);
    expect((await world.sendUp(args)).outboxSeq).toBe(first.outboxSeq);
    await world.collect();
    expect(await world.inbox(world.command, world.commandMain)).toHaveLength(1);

    const late = await world.sendUp(args);

    expect(late.outboxSeq).toBe(first.outboxSeq);
    expect(await world.leafCoordination.leafMail.pending("bk_cmd" as never)).toBe(0);
    await spoolEmpties(world.leaf);
    await world.collect();
    expect(await world.inbox(world.command, world.commandMain)).toHaveLength(1);
  });

  test("an older command node leaves it queued rather than dropping the images", async () => {
    const world = await link({
      capabilities: { "node-attachment": 1, "node-mail-steer": 1, "node-coordinator-mail": 1 },
    });
    const sent = await world.sendUp({
      requestId: "up-1",
      attachments: [await world.paste(world.leaf, world.leafMain)],
    });
    await world.sendUp({ requestId: "up-2" });

    expect(await world.collect()).toBe(true);

    const messages = await world.inbox(world.command, world.commandMain);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.attachments).toBeUndefined();
    expect(await world.leafCoordination.leafMail.pending("bk_cmd" as never)).toBe(1);
    expect(sent.outboxSeq).toBe(1);
    const batch = (await world.leafCoordination.leafMail.collect("bk_cmd" as never, 0, true, true))
      .items[0]!.attachments!.batch;
    expect(
      (
        await fs.stat(
          mailAttachmentSpoolDir(world.leaf.storage.getDataDir(), outboxMailAttachmentBatch(batch)),
        )
      ).isDirectory(),
    ).toBe(true);
  });

  test("a send the outbox refuses leaves no copy behind", async () => {
    const world = await link();
    // At the byte limit for images waiting on this command node.
    await world.leaf.storage.nodes.mutateNodeMail(() => ({
      next: {
        version: 1,
        origins: {},
        threads: {},
        outbox: {
          bk_cmd: {
            nextSeq: 2,
            items: [
              {
                seq: 1,
                createdAt: "2026-11-04T00:00:00.000Z",
                requestId: "earlier",
                fromEnvironmentId: "e",
                fromTabId: "t",
                body: "x",
                bytes: 1,
                attachments: {
                  batch: "0".repeat(32),
                  files: Array.from({ length: 33 }, (_, index) => ({
                    name: `${index}.png`,
                    mediaType: "image/png",
                    bytes: 8 * 1024 * 1024,
                    sha256: "a".repeat(64),
                  })),
                },
              },
            ],
          },
        },
      },
      result: undefined,
    }));
    await expect(
      world.sendUp({
        requestId: "up-1",
        attachments: [await world.paste(world.leaf, world.leafMain)],
      }),
    ).rejects.toThrow(/at the limit/);
    await spoolEmpties(world.leaf);
  });

  test("a leaf's side agent still cannot send upward", async () => {
    const world = await link();
    const side = await world.leaf.addSide();
    await expect(
      world.leafInvoke("send_coordinator_command_node_mail", {
        scope: world.scopeOf(world.leaf, side),
        requestId: "up-1",
        body: "x",
        attachments: [await world.paste(world.leaf, side)],
      }),
    ).rejects.toThrow(/side agent/);
  });
});

describe("transfer_coordinator_attachments", () => {
  test("copies to an environment on a node, with a normal receipt and no message", async () => {
    const world = await link();
    const { worker, worktree } = await world.leafWorker();
    const source = await world.paste(world.command, world.commandMain);

    const receipt = await world.commandInvoke("transfer_coordinator_attachments", {
      scope: world.scopeOf(world.command, world.commandMain),
      to: { nodeId: "bk_leaf", scope: { environmentId: worker.environmentId } },
      files: [source],
    });

    expect(receipt).toMatchObject({
      status: "completed",
      bytes: PNG.length,
      from: { nodeId: "bk_cmd", attachments: true },
      to: { nodeId: "bk_leaf", scope: { environmentId: worker.environmentId } },
      actor: `coordinator ${world.command.coordinatorId}`,
    });
    const [file] = receipt.files;
    expect(file.path).toBe(path.basename(source));
    expect(file.bytes).toBe(PNG.length);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.destination.startsWith(`${worktree}/.orkestrator/mail-attachments/`)).toBe(true);
    expect((await fs.readFile(file.destination)).equals(PNG)).toBe(true);
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: worktree })).stdout).toBe("");
    expect(await world.inbox(world.leaf, worker)).toEqual([]);
  });

  test("copies to an environment on this node the same way", async () => {
    const world = await link();
    const worker = await world.command.addEnvironment("here");
    const worktree = path.join(world.command.root, "here");
    await runCommand("git", ["worktree", "add", "-b", "here", worktree], {
      cwd: path.join(world.command.root, "checkout"),
    });
    await world.command.storage.updateEnvironment(worker.environmentId, { worktreePath: worktree });

    const receipt = await world.commandInvoke("transfer_coordinator_attachments", {
      scope: world.scopeOf(world.command, world.commandMain),
      to: { nodeId: "bk_cmd", scope: { environmentId: worker.environmentId } },
      files: [await world.paste(world.command, world.commandMain)],
    });

    expect(receipt.status).toBe("completed");
    expect(receipt.files[0].destination.startsWith(worktree)).toBe(true);
    expect((await fs.readFile(receipt.files[0].destination)).equals(PNG)).toBe(true);
    expect(world.routed).toEqual([]);
  });

  test("refuses what mail refuses, and an environment of another project", async () => {
    const world = await link();
    const worker = await world.command.addEnvironment("here");
    const side = await world.command.addSide();
    const scope = world.scopeOf(world.command, world.commandMain);
    await expect(
      world.commandInvoke("transfer_coordinator_attachments", {
        scope,
        to: { nodeId: "bk_cmd", scope: { environmentId: worker.environmentId } },
        files: [await world.paste(world.command, side)],
      }),
    ).rejects.toThrow(/not one of this conversation's attachments/);
    await expect(
      world.commandInvoke("transfer_coordinator_attachments", {
        scope,
        to: { nodeId: "bk_cmd", scope: { environmentId: "nowhere" } },
        files: [await world.paste(world.command, world.commandMain)],
      }),
    ).rejects.toThrow(/does not belong to this project/);
  });
});
