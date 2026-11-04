/**
 * A coordinator's pasted images, through the real send commands, the real mail
 * store and real Git worktrees. A container is a temporary directory behind a
 * fake `docker exec` that runs the real writer script against it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { renderAgentMailCarrier } from "@orkestrator/protocol/agent-mail";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";

import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import type { CommandContext } from "./commands-context.js";
import { CONTAINER_PINNED_ATTACHMENT_WRITE } from "./commands-files.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { Environment } from "./models.js";
import {
  addPipelineEnvironment,
  pipelineSnapshot,
  pipelineWorkerPort,
  savePipeline,
  ScriptedSteerProvider,
  stageSession,
} from "./pipeline-worker-mail-test-support.js";
import { coordinatorPromptWithAttachmentPaths } from "./native-agent-handoffs.js";
import { extractMarkedAttachmentReferences } from "@orkestrator/protocol/initial-prompt-attachments";
import { runCommand } from "./shell.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);

const worlds: MailWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

type Result = Record<string, any>;

/** `docker exec` against a directory standing in for a container's `/workspace`. */
function fakeContainer(workspace: string, stopped = false) {
  const writes: string[] = [];
  const exec = (async (
    program: string,
    args: string[],
    options: Parameters<typeof runCommand>[2] = {},
  ) => {
    if (program !== "docker") return runCommand(program, args, options);
    if (stopped) throw new Error("container is not running");
    const local = (value: string) => value.replace("/workspace", workspace);
    if (args[1] === "-i") {
      const [, , , node, flag, script, , ...rest] = args;
      expect(node).toBe("node");
      expect(flag).toBe("-e");
      expect(script).toBe(CONTAINER_PINNED_ATTACHMENT_WRITE);
      writes.push(rest[1]!);
      return runCommand("node", ["-e", script!, workspace, ...rest], {
        stdin: options.stdin,
      });
    }
    if (args[1] === "-w") {
      const [, , , , command, ...rest] = args;
      return runCommand(command!, rest, { cwd: workspace, ...options });
    }
    const [, , command, ...rest] = args;
    return runCommand(command!, rest.map(local), options);
  }) as typeof runCommand;
  return { exec, writes };
}

async function harness(options: Parameters<typeof MailWorld.create>[0] = {}, exec = runCommand) {
  const world = await MailWorld.create(options);
  worlds.push(world);
  const commands = createCommandRegistry({ containerFileCopy: { runCommand: exec } });
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    drainAgentMail: () => world.mail.drainInjects(),
    runtime: {
      coordinatorRequests: world.coordinatorRequests,
      environments: { fence: { beginMutation: () => () => undefined } },
    },
  } as unknown as CommandContext;
  const main = await world.main();
  const scopeOf = (actor: MailActor) => ({
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: actor.conversationId!,
  });
  const paste = (actor: MailActor = main, name = "shot.png", data = PNG) =>
    world.storage.coordinators.writeCoordinatorAttachment(
      world.coordinatorId,
      actor.conversationId!,
      name,
      data.toString("base64"),
    );
  const send = (args: Record<string, unknown>, from: MailActor = main) =>
    commands.get("send_coordinator_agent_mail")!(
      { ...scopeOf(from), body: "See the image.", ...args },
      context,
    ) as Promise<Result>;
  const inbox = async (actor: { environmentId: string; tabId: string }) =>
    (await world.storage.getAgentMailMailbox(actor.environmentId, actor.tabId)).messages;
  /** A real Git worktree of the world's checkout. */
  const withWorktree = async (actor: { environmentId: string }, name = "worker") => {
    const worktree = path.join(world.root, name);
    await runCommand("git", ["worktree", "add", "-b", name, worktree], {
      cwd: path.join(world.root, "checkout"),
    });
    await world.storage.updateEnvironment(actor.environmentId, { worktreePath: worktree });
    return worktree;
  };
  return { world, commands, context, main, scopeOf, paste, send, inbox, withWorktree };
}

const git = async (worktree: string, ...args: string[]) =>
  (await runCommand("git", args, { cwd: worktree })).stdout;

describe("send_message with attachments, to an environment on this node", () => {
  test("the recipient can open the image from the path its message names", async () => {
    const { world, paste, send, inbox, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker", { launched: true });
    const worktree = await withWorktree(worker);
    const source = await paste();

    const sent = await send({
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [source],
    });

    const name = path.basename(source);
    expect(sent.attachments).toHaveLength(1);
    const attachment = sent.attachments[0];
    expect(attachment).toMatchObject({ name, mediaType: "image/png", bytes: PNG.length });
    expect(attachment.path.startsWith(`${worktree}/.orkestrator/mail-attachments/`)).toBe(true);
    expect((await fs.readFile(attachment.path)).equals(PNG)).toBe(true);

    const [message] = await inbox(worker);
    expect(message!.attachments).toEqual(sent.attachments);
    const stored = await world.storage.getAgentMailMessage(
      worker.environmentId,
      worker.tabId,
      message!.id,
    );
    const carrier = renderAgentMailCarrier(stored);
    expect(carrier).toContain(attachment.path);
    expect(carrier).toContain("on your own filesystem");
    // The body is the sender's own words: the tile shows it, without the path.
    expect(stored.body).toBe("See the image.");
    // Staged only for the moment it took.
    expect(
      await fs.readdir(path.join(world.storage.getDataDir(), "mail-attachment-spool")),
    ).toEqual([]);
  });

  test("a bare file name works as well as the path", async () => {
    const { world, main, paste, send, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker");
    await withWorktree(worker);
    const source = await paste(main, "clipboard.png");
    const prompt = coordinatorPromptWithAttachmentPaths("Forward", main.environmentId, [
      { type: "image", path: source, filename: "clipboard.png" },
    ]);
    const advertised = extractMarkedAttachmentReferences(prompt).attachments[0]!.name;
    expect(advertised).toBe(path.basename(source));
    const sent = await send({
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [advertised],
    });
    expect(sent.attachments).toHaveLength(1);
  });

  test("a sent image cannot reach a commit, and goes with the worktree", async () => {
    const { world, paste, send, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker");
    const worktree = await withWorktree(worker);
    const sent = await send({
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [await paste()],
    });
    const file = sent.attachments[0].path as string;

    expect(await git(worktree, "status", "--porcelain")).toBe("");
    await git(worktree, "add", "-A");
    expect(await git(worktree, "diff", "--cached", "--name-only")).toBe("");
    await git(worktree, "check-ignore", "--quiet", "--no-index", "--", file);

    await runCommand("git", ["worktree", "remove", "--force", worktree], {
      cwd: path.join(world.root, "checkout"),
    });
    await expect(fs.stat(file)).rejects.toThrow();
  });

  test("a retry with the same requestId neither delivers nor copies again", async () => {
    const { world, paste, send, inbox, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker", { launched: true });
    await withWorktree(worker);
    const source = await paste();
    const args = {
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [source],
    };
    const first = await send(args);
    const before = await fs.stat(first.attachments[0].path);

    const second = await send(args);

    expect(second.id).toBe(first.id);
    expect(await inbox(worker)).toHaveLength(1);
    const after = await fs.stat(first.attachments[0].path);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(await fs.readdir(path.dirname(first.attachments[0].path))).toHaveLength(1);
  });

  test("the same requestId with another image is a conflict, not a second message", async () => {
    const { world, paste, send, inbox, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker", { launched: true });
    await withWorktree(worker);
    const args = {
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
    };
    await send({ ...args, attachments: [await paste()] });
    const changed = Buffer.concat([PNG, Buffer.from([9])]);
    await expect(
      send({ ...args, attachments: [await paste(undefined, "other.png", changed)] }),
    ).rejects.toThrow(/different content/);
    await expect(send(args)).rejects.toThrow(/different content/);
    expect(await inbox(worker)).toHaveLength(1);
  });

  test("a failed copy means no message, and the caller is told why", async () => {
    const { world, paste, send, inbox, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker");
    const worktree = await withWorktree(worker);
    // The workspace's own directory points outside it.
    const outside = path.join(world.root, "outside");
    await fs.mkdir(outside);
    await fs.rm(path.join(worktree, ".orkestrator"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(worktree, ".orkestrator"));

    await expect(
      send({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await paste()],
      }),
    ).rejects.toThrow();
    expect(await inbox(worker)).toEqual([]);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  test("an environment with no workspace yet is refused, naming it", async () => {
    const { world, paste, send, inbox } = await harness();
    const worker = await world.addEnvironment("no-workspace");
    await expect(
      send({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await paste()],
      }),
    ).rejects.toThrow("no-workspace has no workspace yet");
    expect(await inbox(worker)).toEqual([]);
  });

  test("only this conversation's attachments; everything else is refused before any copy", async () => {
    const { world, main, paste, send, inbox, withWorktree } = await harness();
    const worker = await world.addEnvironment("worker");
    await withWorktree(worker);
    const side = await world.addSide();
    const theirs = await paste(side);
    const mine = await paste(main);
    const link = path.join(path.dirname(mine), "link.png");
    await fs.symlink(theirs, link);
    const notes = path.join(path.dirname(mine), "notes.txt");
    await fs.writeFile(notes, "plain text");
    const oversized = path.join(path.dirname(mine), "huge.png");
    await fs.writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));

    for (const [references, reason] of [
      [[theirs], /not one of this conversation's attachments/],
      [
        [path.join(path.dirname(mine), "..", path.basename(path.dirname(theirs)), "x.png")],
        /not one/,
      ],
      [[link], /not a regular file/],
      [[notes], /is not an image/],
      [[oversized], /larger than the 8 MiB/],
      [Array.from({ length: 9 }, () => mine), /at most 8 images/],
    ] as const) {
      await expect(
        send({
          requestId: "r1",
          toEnvironmentId: worker.environmentId,
          toTabId: worker.tabId,
          attachments: references,
        }),
      ).rejects.toThrow(reason);
    }
    expect(await inbox(worker)).toEqual([]);
  });

  test("a build pipeline worker gets it by its address", async () => {
    const provider = new ScriptedSteerProvider();
    const { world, paste, send, inbox, withWorktree } = await harness({
      pipelineWorkers: (storage) => pipelineWorkerPort(storage, provider).workerMail,
    });
    const environmentId = await addPipelineEnvironment(world);
    const worktree = await withWorktree({ environmentId });
    const build = stageSession("build", { key: "build", label: "Build Session" });
    await savePipeline(world.storage, pipelineSnapshot(environmentId, world.projectId, [build]));
    const tabId = pipelineWorkerTabId(build.sessionKey);

    const sent = await send({
      requestId: "r1",
      toEnvironmentId: environmentId,
      toTabId: tabId,
      attachments: [await paste()],
    });

    expect(sent.attachments[0].path.startsWith(worktree)).toBe(true);
    expect((await fs.readFile(sent.attachments[0].path)).equals(PNG)).toBe(true);
    expect((await inbox({ environmentId, tabId }))[0]!.attachments).toEqual(sent.attachments);
  });
});

describe("send_message with attachments, to a container", () => {
  async function containerHarness(stopped = false) {
    const seed = await MailWorld.create();
    worlds.push(seed);
    // The container's workspace: a real checkout, so the Git proof is real.
    const workspace = path.join(seed.root, "container-workspace");
    await runCommand("git", ["clone", path.join(seed.root, "checkout"), workspace]);
    const container = fakeContainer(workspace, stopped);
    const built = await harness({}, container.exec);
    const worker = await built.world.addEnvironment("boxed");
    await built.world.storage.updateEnvironment(worker.environmentId, {
      environmentType: "containerized",
      containerId: "container-1",
      status: stopped ? "stopped" : "running",
    } as Partial<Environment>);
    return { ...built, worker, workspace, container };
  }

  test("lands inside the container, readable, Git-excluded and not retried", async () => {
    const { worker, workspace, container, paste, send, inbox } = await containerHarness();
    const source = await paste();
    const args = {
      requestId: "r1",
      toEnvironmentId: worker.environmentId,
      toTabId: worker.tabId,
      attachments: [source],
    };

    const sent = await send(args);

    const attachment = sent.attachments[0];
    expect(attachment.path.startsWith("/workspace/.orkestrator/mail-attachments/")).toBe(true);
    const local = attachment.path.replace("/workspace", workspace);
    expect((await fs.readFile(local)).equals(PNG)).toBe(true);
    expect(await git(workspace, "status", "--porcelain")).toBe("");
    expect(await inbox(worker)).toHaveLength(1);

    await send(args);
    expect(await inbox(worker)).toHaveLength(1);
    expect(container.writes).toEqual([path.basename(source)]);
  });

  test("a stopped container is refused, with no message", async () => {
    const { worker, paste, send, inbox } = await containerHarness(true);
    await expect(
      send({
        requestId: "r1",
        toEnvironmentId: worker.environmentId,
        toTabId: worker.tabId,
        attachments: [await paste()],
      }),
    ).rejects.toThrow("boxed is not running");
    expect(await inbox(worker)).toEqual([]);
  });
});

describe("send_message with attachments, between a coordinator and its side agents", () => {
  test("a partial private write leaves no final file and the same send retries once", async () => {
    const { world, paste, send, inbox } = await harness();
    const side = await world.addSide();
    const source = await paste();
    const directory = world.storage.coordinators.coordinatorAttachmentDirectory(
      world.coordinatorId,
      side.conversationId!,
    );
    const original = fs.writeFile.bind(fs);
    const write = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (String(args[0]).includes(".mail-upload-")) {
        await original(args[0], PNG.subarray(0, 3), args[2]);
        throw new Error("injected partial write");
      }
      return original(...args);
    });
    const args = {
      requestId: "partial",
      toEnvironmentId: side.environmentId,
      toTabId: side.tabId,
      attachments: [source],
    };
    try {
      await expect(send(args)).rejects.toThrow("injected partial write");
      expect(await inbox(side)).toEqual([]);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      write.mockRestore();
    }
    const sent = await send(args);
    await send(args);
    expect((await fs.readFile(sent.attachments[0].path)).equals(PNG)).toBe(true);
    expect(await inbox(side)).toHaveLength(1);
  });

  test("concurrent sends of the same image share one intact private file", async () => {
    const { world, paste, send, inbox } = await harness();
    const side = await world.addSide();
    const source = await paste();
    const messages = await Promise.all(
      ["one", "two"].map((requestId) =>
        send({
          requestId,
          toEnvironmentId: side.environmentId,
          toTabId: side.tabId,
          attachments: [source],
        }),
      ),
    );
    expect(messages[0]!.attachments![0].path).toBe(messages[1]!.attachments![0].path);
    expect((await fs.readFile(messages[0]!.attachments![0].path)).equals(PNG)).toBe(true);
    expect(await fs.readdir(path.dirname(messages[0]!.attachments![0].path))).toEqual([
      path.basename(source),
    ]);
    expect(await inbox(side)).toHaveLength(2);
  });

  test("each lands in the other's own attachment directory", async () => {
    const { world, main, paste, send, inbox } = await harness();
    const side = await world.addSide();
    const directoryOf = (actor: MailActor) =>
      world.storage.coordinators.coordinatorAttachmentDirectory(
        world.coordinatorId,
        actor.conversationId!,
      );

    const down = await send({
      requestId: "down",
      toEnvironmentId: side.environmentId,
      toTabId: side.tabId,
      attachments: [await paste(main)],
    });
    expect(path.dirname(down.attachments[0].path)).toBe(directoryOf(side));
    expect((await fs.readFile(down.attachments[0].path)).equals(PNG)).toBe(true);
    expect((await inbox(side))[0]!.attachments).toHaveLength(1);

    const up = await send(
      {
        requestId: "up",
        toEnvironmentId: "coordinator",
        attachments: [await paste(side, "back.png", Buffer.concat([PNG, Buffer.from([1])]))],
      },
      side,
    );
    expect(path.dirname(up.attachments[0].path)).toBe(directoryOf(main));
    expect((await inbox(main))[0]!.attachments).toHaveLength(1);
  });

  test("what a conversation received, it can pass on as its own", async () => {
    const { world, main, paste, send, withWorktree } = await harness();
    const side = await world.addSide();
    const worker = await world.addEnvironment("worker");
    await withWorktree(worker);
    const down = await send({
      requestId: "down",
      toEnvironmentId: side.environmentId,
      toTabId: side.tabId,
      attachments: [await paste(main)],
    });
    // A side agent only talks to its main, so back up is its one route.
    const up = await send(
      { requestId: "up", toEnvironmentId: "coordinator", attachments: [down.attachments[0].path] },
      side,
    );
    expect(up.attachments[0].name).toBe(down.attachments[0].name);
  });

  test("a denied sibling send leaves its private directory unchanged", async () => {
    const { world, paste, send, inbox } = await harness();
    const sender = await world.addSide();
    const recipient = await world.addSide();
    const existing = await paste(recipient);
    const before = await fs.readdir(path.dirname(existing));
    await expect(
      send(
        {
          requestId: "sibling-denied",
          toEnvironmentId: recipient.environmentId,
          toTabId: recipient.tabId,
          attachments: [await paste(sender)],
        },
        sender,
      ),
    ).rejects.toThrow("A side agent can only message the main coordinator");
    expect(await fs.readdir(path.dirname(existing))).toEqual(before);
    expect(await inbox(recipient)).toEqual([]);
  });

  test("a side agent still cannot reach a worker, with or without an image", async () => {
    const { world, paste, send, inbox } = await harness();
    const side = await world.addSide();
    const worker = await world.addEnvironment("worker");
    await expect(
      send(
        {
          requestId: "r1",
          toEnvironmentId: worker.environmentId,
          toTabId: worker.tabId,
          attachments: [await paste(side)],
        },
        side,
      ),
    ).rejects.toThrow("A side agent can only message the main coordinator");
    expect(await inbox(worker)).toEqual([]);
  });
});
