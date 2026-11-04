/**
 * Real-stack QA for coordinator image mail across a real node link
 * (docs/architecture/coordinator.md, "Passing a pasted image on";
 * docs/architecture/command-nodes.md, "Images between nodes").
 *
 * Starts two isolated backends from source (`qa-command-nodes-support.ts`):
 * Desk, a command node, and Leaf, which Desk attaches over its real gateway
 * route. No agent runs and no provider turn is made: each coordinator is
 * created with no provider, an image is pasted through the same command the
 * composer uses, and the coordinator commands the Control MCP tools call are
 * invoked with that conversation's scope. Each step is asserted against what
 * the recipient's node itself reports and against the files on its disk.
 *
 * Only processes this script started are stopped; their data directories are
 * removed at the end. Backend output is scanned for the gateway tokens.
 *
 * Run: bun scripts/qa-coordinator-image-mail.ts
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

import {
  addNode,
  children,
  invoke,
  makeNode,
  project,
  qaRun,
  refusal,
  run,
  start,
  stop,
  until,
  type Node,
} from "./qa-command-nodes-support.js";

const { check, results, log } = qaRun("image-mail-qa");

/** A real, decodable 1x1 PNG, so content sniffing sees an image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

type Coordinator = {
  node: Node;
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  tabId: string;
  attachmentDir: string;
};

type Attachment = { name: string; path: string; bytes: number; sha256: string; mediaType: string };
type MailMessage = { id: string; requestId?: string; body: string; attachments?: Attachment[] };

/**
 * Pick the conversation's agent, as the composer's picker does: its mailbox
 * can then send. This starts nothing; there is no toolchain to start.
 */
function assignAgent(node: Node, projectId: string, conversationId: string) {
  return invoke(node, "assign_coordinator_conversation_agent", {
    projectId,
    conversationId,
    agent: "claude",
  });
}

async function coordinator(node: Node, projectId: string): Promise<Coordinator> {
  const snapshot = await invoke<{
    workspace: { id: string; conversations: Array<{ id: string; role: string; tabId: string }> };
  }>(node, "ensure_project_coordinator", { projectId });
  const main = snapshot.workspace.conversations.find((item) => item.role === "main")!;
  await assignAgent(node, projectId, main.id);
  return {
    node,
    projectId,
    coordinatorId: snapshot.workspace.id,
    conversationId: main.id,
    tabId: main.tabId,
    attachmentDir: path.join(
      node.dir,
      "data",
      "coordinator-attachments",
      snapshot.workspace.id,
      main.id,
    ),
  };
}

const scope = (from: Coordinator) => ({
  projectId: from.projectId,
  coordinatorId: from.coordinatorId,
  conversationId: from.conversationId,
});

/** Paste an image into the coordinator's composer, as the renderer does. */
function paste(into: Coordinator, name: string, data: Buffer): Promise<string> {
  return invoke<string>(into.node, "write_coordinator_attachment", {
    environmentId: coordinatorRuntimeId(into.coordinatorId, into.conversationId),
    filename: name,
    base64Data: data.toString("base64"),
  });
}

async function inbox(node: Node, environmentId: string, tabId: string): Promise<MailMessage[]> {
  const snapshot = await invoke<{ messages: MailMessage[] }>(node, "get_agent_mail_mailbox", {
    environmentId,
    tabId,
  });
  return snapshot.messages;
}

function coordinatorInbox(of: Coordinator) {
  return inbox(of.node, coordinatorRuntimeId(of.coordinatorId, of.conversationId), of.tabId);
}

async function sameFile(file: string, data: Buffer): Promise<boolean> {
  return existsSync(file) && sha256(await readFile(file)) === sha256(data);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}

/** A local bare clone as the checkout's `origin`, which a worktree branches from. */
async function withOrigin(checkout: string): Promise<void> {
  const bare = `${checkout}.git`;
  await run("git", ["clone", "-q", "--bare", checkout, bare], path.dirname(checkout));
  await run("git", ["remote", "add", "origin", bare], checkout);
  await run("git", ["fetch", "-q", "origin"], checkout);
}

/**
 * A local worker with an agent tab to receive mail, its worktree ready. The
 * tab is an Agent (native) tab; no agent ever starts in it, because these
 * backends have no toolchain and no credentials (`isolateHome`).
 */
async function worker(node: Node, projectId: string, name: string) {
  const created = await invoke<{ id: string }>(node, "create_environment", {
    projectId,
    name,
    environmentType: "local",
  });
  await invoke(node, "save_pane_layout", {
    environmentId: created.id,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: "worker-tab",
            type: "agent-native",
            nativeAgentData: { environmentId: created.id, platform: "claude" },
          },
        ],
        activeTabId: "worker-tab",
      },
    },
    expectedRevision: 0,
  });
  await invoke(node, "start_environment", { environmentId: created.id });
  const environment = await until(
    "the worker's worktree",
    () =>
      invoke<{ id: string; worktreePath?: string }>(node, "get_environment", {
        environmentId: created.id,
      }),
    (value) => Boolean(value.worktreePath) && existsSync(value.worktreePath!),
    90_000,
  );
  return {
    environmentId: environment.id,
    tabId: "worker-tab",
    worktree: environment.worktreePath!,
  };
}

/** A side agent of the project's coordinator. */
async function sideAgent(node: Node, projectId: string): Promise<Coordinator> {
  const snapshot = await invoke<{
    workspace: { id: string; conversations: Array<{ id: string; role: string; tabId: string }> };
  }>(node, "create_coordinator_conversation", { projectId, title: "Side" });
  const side = snapshot.workspace.conversations.find((item) => item.role === "side")!;
  await assignAgent(node, projectId, side.id);
  return {
    node,
    projectId,
    coordinatorId: snapshot.workspace.id,
    conversationId: side.id,
    tabId: side.tabId,
    attachmentDir: path.join(
      node.dir,
      "data",
      "coordinator-attachments",
      snapshot.workspace.id,
      side.id,
    ),
  };
}

async function main() {
  const desk = await makeNode("Desk", true);
  const leaf = await makeNode("Leaf", false);
  const nodes = [desk, leaf];
  try {
    await Promise.all(nodes.map((node) => start(node, { isolateHome: true })));
    for (const node of nodes) {
      node.id = (await invoke<{ nodeId: string }>(node, "get_node_status")).nodeId;
      const profile = await invoke<{ revision: number }>(node, "get_backend_profile");
      await invoke(node, "update_backend_profile", {
        expectedRevision: profile.revision,
        displayName: node.name,
      });
    }
    const deskProject = await project(desk, {});
    const leafProject = await project(leaf, {});
    await withOrigin(deskProject.dir);
    await withOrigin(leafProject.dir);
    const attached = await addNode(desk, leaf);
    check(
      "IM-00",
      "Desk attaches Leaf over its real gateway",
      attached.connection.state === "connected",
    );

    const deskCoordinator = await coordinator(desk, deskProject.id);
    const leafCoordinator = await coordinator(leaf, leafProject.id);
    const leafWorker = await worker(leaf, leafProject.id, "leaf-worker");
    const deskWorker = await worker(desk, deskProject.id, "desk-worker");
    const deskSide = await sideAgent(desk, deskProject.id);
    log("coordinators, a side agent and a worker on each node are ready");

    // This node: Desk's coordinator mails its own worker's agent tab.
    const local = await paste(deskCoordinator, "local.png", PNG);
    const localArgs = {
      ...scope(deskCoordinator),
      requestId: "image-local",
      toEnvironmentId: deskWorker.environmentId,
      toTabId: deskWorker.tabId,
      body: "The screenshot, for you here.",
      attachments: [path.basename(local)],
    };
    const sentLocal = await invoke<{ id: string; attachments?: Attachment[] }>(
      desk,
      "send_coordinator_agent_mail",
      localArgs,
    );
    const placedLocal = sentLocal.attachments?.[0];
    check(
      "IM-11",
      "a worker's agent tab on this node gets the image in its Git-excluded folder",
      Boolean(placedLocal) &&
        placedLocal!.path.startsWith(`${deskWorker.worktree}/.orkestrator/mail-attachments/`) &&
        (await sameFile(placedLocal!.path, PNG)) &&
        (await gitOutput(deskWorker.worktree, "status", "--porcelain", "--untracked-files=all")) ===
          "",
      JSON.stringify(sentLocal.attachments),
    );
    await invoke(desk, "send_coordinator_agent_mail", localArgs);
    check(
      "IM-11",
      "the agent tab has one message naming it, after a retry",
      (await inbox(desk, deskWorker.environmentId, deskWorker.tabId)).filter(
        (message) => message.attachments?.[0]?.path === placedLocal!.path,
      ).length === 1,
    );

    // This node: Desk's coordinator mails its side agent.
    const sentSide = await invoke<{ attachments?: Attachment[] }>(
      desk,
      "send_coordinator_agent_mail",
      {
        ...scope(deskCoordinator),
        requestId: "image-side",
        toEnvironmentId: coordinatorRuntimeId(deskSide.coordinatorId, deskSide.conversationId),
        toTabId: deskSide.tabId,
        body: "For the side agent.",
        attachments: [path.basename(local)],
      },
    );
    check(
      "IM-12",
      "a side agent gets the image in its own attachment directory",
      path.dirname(sentSide.attachments?.[0]?.path ?? "") === deskSide.attachmentDir &&
        (await sameFile(sentSide.attachments![0]!.path, PNG)),
      JSON.stringify(sentSide.attachments),
    );
    const sideOwn = await paste(deskSide, "side-only.png", PNG);
    const foreign = await refusal(desk, "send_coordinator_agent_mail", {
      ...localArgs,
      requestId: "image-foreign-conversation",
      attachments: [sideOwn],
    });
    check(
      "IM-12",
      "the side agent's own attachment is refused to the main",
      foreign !== "",
      foreign,
    );
    log(`refusal text: ${foreign}`);
    const traversal = await refusal(desk, "send_coordinator_agent_mail", {
      ...localArgs,
      requestId: "image-traversal",
      attachments: ["../../../../etc/hostname"],
    });
    check("IM-12", "a traversal path is refused", traversal !== "", traversal);
    log(`refusal text: ${traversal}`);

    // Down: Desk's coordinator mails a worker on Leaf.
    const down = await paste(deskCoordinator, "screenshot.png", PNG);
    const downArgs = {
      scope: scope(deskCoordinator),
      nodeId: leaf.id,
      requestId: "image-down",
      toEnvironmentId: leafWorker.environmentId,
      toTabId: leafWorker.tabId,
      body: "The screenshot the user pasted.",
      attachments: [path.basename(down)],
    };
    const sentDown = await invoke<{ messageId: string; attachments?: Attachment[] }>(
      desk,
      "send_coordinator_node_mail",
      downArgs,
    );
    const placedDown = sentDown.attachments?.[0];
    check(
      "IM-01",
      "the worker's copy is in its worktree's mail-attachments folder",
      Boolean(placedDown) &&
        placedDown!.path.startsWith(`${leafWorker.worktree}/.orkestrator/mail-attachments/`),
      JSON.stringify(sentDown.attachments),
    );
    check(
      "IM-01",
      "the worker can open it: same bytes as the pasted image",
      await sameFile(placedDown!.path, PNG),
    );
    const workerMail = await inbox(leaf, leafWorker.environmentId, leafWorker.tabId);
    check(
      "IM-01",
      "Leaf stored one message naming the image",
      workerMail.length === 1 && workerMail[0]!.attachments?.[0]?.path === placedDown!.path,
    );
    check(
      "IM-02",
      "the copy cannot reach a commit: Git ignores it and the worktree is clean",
      (await gitOutput(leafWorker.worktree, "status", "--porcelain", "--untracked-files=all")) ===
        "" &&
        (await gitOutput(
          leafWorker.worktree,
          "check-ignore",
          "--no-index",
          "--",
          path.relative(leafWorker.worktree, placedDown!.path),
        )) !== "",
    );

    const retried = await invoke<{ messageId: string }>(
      desk,
      "send_coordinator_node_mail",
      downArgs,
    );
    check(
      "IM-03",
      "a retry with the same requestId sends nothing new",
      retried.messageId === sentDown.messageId &&
        (await inbox(leaf, leafWorker.environmentId, leafWorker.tabId)).length === 1,
    );

    // Down: Desk's coordinator mails Leaf's coordinator.
    const sentToLeafCoordinator = await invoke<{ attachments?: Attachment[] }>(
      desk,
      "send_coordinator_node_mail",
      {
        scope: scope(deskCoordinator),
        nodeId: leaf.id,
        requestId: "image-to-leaf-coordinator",
        toEnvironmentId: "coordinator",
        body: "For you, Leaf.",
        attachments: [path.basename(down)],
      },
    );
    const leafCoordinatorMail = await until(
      "the image mail in Leaf's coordinator inbox",
      () => coordinatorInbox(leafCoordinator),
      (messages) => messages.some((message) => message.attachments?.length),
    );
    const leafCopy = leafCoordinatorMail.find((message) => message.attachments?.length)!
      .attachments![0]!;
    check(
      "IM-04",
      "Leaf's coordinator gets the image in its own attachment directory",
      path.dirname(leafCopy.path) === leafCoordinator.attachmentDir &&
        (await sameFile(leafCopy.path, PNG)),
      JSON.stringify(sentToLeafCoordinator.attachments ?? leafCopy),
    );

    // Up: Leaf's coordinator mails the command node's coordinator.
    const upImage = Buffer.concat([PNG, Buffer.from("leaf")]);
    const up = await paste(leafCoordinator, "from-leaf.png", upImage);
    const sentUp = await invoke<{ placement: string }>(leaf, "send_coordinator_command_node_mail", {
      scope: scope(leafCoordinator),
      requestId: "image-up",
      body: "What the user pasted on Leaf.",
      attachments: [path.basename(up)],
    });
    check(
      "IM-05",
      "Leaf queues the upward image mail in its outbox",
      sentUp.placement === "node-outbox",
    );
    const deskMail = await until(
      "Desk collecting Leaf's image mail",
      () => coordinatorInbox(deskCoordinator),
      (messages) =>
        messages.some(
          (message) => message.requestId?.includes("image-up") || message.attachments?.length,
        ),
      90_000,
    );
    const deskCopy = deskMail.find((message) => message.attachments?.length)?.attachments?.[0];
    check(
      "IM-05",
      "Desk's coordinator gets Leaf's image in its own attachment directory",
      Boolean(deskCopy) &&
        path.dirname(deskCopy!.path) === deskCoordinator.attachmentDir &&
        (await sameFile(deskCopy!.path, upImage)),
      JSON.stringify(deskMail.map((message) => message.attachments)),
    );

    const leafSpool = path.join(leaf.dir, "data", "mail-attachment-spool");
    await until(
      "Leaf's outbox copy to go once collected",
      async () => (existsSync(leafSpool) ? (await readdir(leafSpool)).length : 0),
      (count) => count === 0,
      30_000,
    ).catch(() => undefined);
    check(
      "IM-05",
      "Leaf drops its outbox copy once Desk has collected the mail",
      !existsSync(leafSpool) || (await readdir(leafSpool)).length === 0,
    );

    // transfer_files from the conversation's attachments.
    const receipt = await invoke<{
      status: string;
      bytes: number;
      files: Array<{ path: string; destination: string }>;
      from: { attachments: boolean };
    }>(desk, "transfer_coordinator_attachments", {
      scope: scope(deskCoordinator),
      to: { nodeId: leaf.id, scope: { environmentId: leafWorker.environmentId } },
      files: [path.basename(down)],
    });
    check(
      "IM-06",
      "transfer_files from attachments answers a completed receipt",
      receipt.status === "completed" &&
        receipt.from.attachments === true &&
        receipt.bytes === PNG.length,
      JSON.stringify(receipt),
    );
    check(
      "IM-06",
      "the transferred image is in the worker's Git-excluded folder",
      receipt.files[0]!.destination.startsWith(
        `${leafWorker.worktree}/.orkestrator/mail-attachments/`,
      ) && (await sameFile(receipt.files[0]!.destination, PNG)),
    );

    // Refusals.
    const other = await paste(leafCoordinator, "theirs.png", PNG);
    check(
      "IM-07",
      "another conversation's attachment is refused",
      (await refusal(desk, "send_coordinator_node_mail", {
        ...downArgs,
        requestId: "image-foreign",
        attachments: [other],
      })) !== "",
    );
    const text = await paste(deskCoordinator, "notes.png", Buffer.from("not an image"));
    check(
      "IM-07",
      "a non-image is refused, naming why",
      /image/i.test(
        await refusal(desk, "send_coordinator_node_mail", {
          ...downArgs,
          requestId: "image-text",
          attachments: [path.basename(text)],
        }),
      ),
    );

    const many = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        paste(deskCoordinator, `many-${index}.png`, Buffer.concat([PNG, Buffer.from([index])])),
      ),
    );
    const tooMany = await refusal(desk, "send_coordinator_node_mail", {
      ...downArgs,
      requestId: "image-too-many",
      attachments: many.map((file) => path.basename(file)),
    });
    check(
      "IM-07",
      "more than eight images are refused, naming the limit",
      /8/.test(tooMany),
      tooMany,
    );
    log(`refusal text: ${tooMany}`);
    const large = await paste(
      deskCoordinator,
      "large.png",
      Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]),
    ).catch((error: unknown) => `paste refused: ${String(error)}`);
    const tooLarge = large.startsWith("paste refused")
      ? large
      : await refusal(desk, "send_coordinator_node_mail", {
          ...downArgs,
          requestId: "image-too-large",
          attachments: [path.basename(large)],
        });
    // The composer's own paste limit refuses it first; mail's cap is the second guard.
    check(
      "IM-07",
      "an image over 8 MiB is refused, naming the limit",
      /8 ?Mi?B/.test(tooLarge),
      tooLarge,
    );
    log(`refusal text: ${tooLarge}`);
    const outside = path.join(desk.dir, "outside.png");
    await writeFile(outside, PNG);
    await symlink(outside, path.join(deskCoordinator.attachmentDir, "linked.png"));
    const linked = await refusal(desk, "send_coordinator_node_mail", {
      ...downArgs,
      requestId: "image-symlink",
      attachments: ["linked.png"],
    });
    check("IM-07", "a symlink in the attachment directory is refused", linked !== "", linked);
    log(`refusal text: ${linked}`);
    check(
      "IM-07",
      "no refused send left a message",
      (await inbox(leaf, leafWorker.environmentId, leafWorker.tabId)).length === 1,
    );

    // Removed with the environment.
    await invoke(leaf, "delete_environment", { environmentId: leafWorker.environmentId });
    await until(
      "the worker's worktree to go",
      async () => existsSync(placedDown!.path),
      (present) => !present,
      90_000,
    );
    check("IM-08", "deleting the worker removes the mailed image", !existsSync(placedDown!.path));

    // A disconnected node is refused clearly, and nothing is left behind.
    await stop(leaf);
    await invoke(desk, "reconnect_node", { nodeId: leaf.id }).catch(() => undefined);
    await until(
      "Leaf unavailable on Desk",
      () =>
        invoke<{ nodes: Array<{ available: boolean }> }>(desk, "get_node_summaries", {
          nodeIds: [leaf.id],
        }),
      (value) => value.nodes[0]?.available === false,
    );
    const offline = await refusal(desk, "send_coordinator_node_mail", {
      ...downArgs,
      requestId: "image-offline",
      toEnvironmentId: "coordinator",
    });
    check("IM-09", "mail with an image to a disconnected node is refused", offline !== "", offline);
    log(`refusal text: ${offline}`);

    const leaked = nodes.filter((node) =>
      nodes.some((owner) => node.output.join("").includes(owner.token)),
    );
    check("IM-10", "no backend logged a gateway token", leaked.length === 0);
    check(
      "IM-10",
      "no backend logged the image bytes",
      !nodes.some((node) => node.output.join("").includes(PNG.toString("base64"))),
    );
  } finally {
    await Promise.all(nodes.map((node) => stop(node).catch(() => undefined)));
    await Promise.all(
      nodes.map((node) => rm(node.dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  }
  const failed = results.filter((entry) => !entry.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch(async (error: unknown) => {
  console.error("[image-mail-qa]", error instanceof Error ? error.message : error);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(1);
});
