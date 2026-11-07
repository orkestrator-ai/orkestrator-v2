import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AGENT_MAIL_ATTACHMENT_DIRECTORY,
  type AgentMailAttachment,
} from "@orkestrator/protocol/agent-mail";
import { BACKEND_CAPABILITIES } from "@orkestrator/protocol/backend-profile";
import {
  placeNodeMailAttachmentsCommand,
  prepareNodeMailAttachmentsCommand,
  type NodeMailApi,
} from "@orkestrator/protocol/contract/domains/node-mail";
import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";

import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { CommandContext } from "./commands-context.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import { CONTAINER_PINNED_ATTACHMENT_WRITE, writeConfinedLocalArtifact } from "./commands-files.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  createEnvironmentCommandRunner,
  ensureWorkspaceArtifactIsGitExcluded,
} from "./commands-review.js";
import {
  mailAttachmentBatchId,
  mailAttachmentFiles,
  parseMailAttachmentBatch,
  projectHomeMailAttachmentDir,
  readOwnAttachments,
  readSpooledAttachment,
  removeMailAttachmentBatch,
  stageMailAttachments,
  type MailAttachmentBatch,
  type MailAttachmentFile,
  type OwnAttachment,
} from "./mail-attachments.js";
import type { Environment } from "./models.js";
import type { NodeFileTransfer } from "./nodes/index.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";

/**
 * A coordinator's pasted images reaching whoever it mails
 * (docs/architecture/coordinator.md, "Attachments").
 *
 * The coordinator names an attachment of its own conversation; the backend
 * does every read and write, so no write access is handed to a read-only
 * agent. The copy finishes before the message exists, so a message can never
 * point at a file that did not arrive, and each message's files have one fixed
 * place, so a retry finds them there rather than copying them again.
 *
 * The same two commands do the receiving end on this node and on another:
 * - `prepare_node_mail_attachments` says which files are not there yet, and
 *   refuses a recipient that cannot take them before any bytes move;
 * - `place_node_mail_attachments` puts the batch's files where the recipient
 *   reads them: `.orkestrator/mail-attachments/<batch>/` in an environment
 *   (Git-excluded, and proved so first), a private directory in the data
 *   directory for the project home (never the user's checkout), or a
 *   coordinator conversation's own attachment directory, the one root its
 *   read-only rules let it read.
 */

type JsonRecord = Record<string, unknown>;
type Caller = { coordinatorId: string; conversationId: string };

/** The mailbox a batch is for: an environment or conversation, or a project's main coordinator. */
export type MailAttachmentRecipient = { environmentId: string } | { projectId: string };

/** Runs one receiving-end command, here or on another node. */
export type MailAttachmentInvoker = <T>(command: string, args: JsonRecord) => Promise<T>;

function differentFile(name: string): Error {
  return new Error(`${name} already exists at the destination with different content.`);
}

/** Whether a file with this content is already there; other content there is an error. */
async function alreadyHere(target: string, file: MailAttachmentFile): Promise<boolean> {
  const stats = await fs.lstat(target).catch(() => null);
  if (!stats) return false;
  if (!stats.isFile() || stats.size !== file.bytes) throw differentFile(file.name);
  const hash = createHash("sha256")
    .update(await fs.readFile(target))
    .digest("hex");
  if (hash !== file.sha256) throw differentFile(file.name);
  return true;
}

/** Where one recipient keeps a batch's files. */
interface AttachmentSink {
  pathOf(name: string): string;
  has(file: MailAttachmentFile): Promise<boolean>;
  /** Everything that must hold before a file is written. */
  ready(): Promise<void>;
  write(file: MailAttachmentFile, data: Buffer): Promise<void>;
  /** Stops holding the recipient, whatever happened. */
  release(): void;
}

/** A directory only the backend writes: a conversation's own, or a project home's. */
function privateDirectorySink(directory: string): AttachmentSink {
  const pathOf = (name: string) => path.join(directory, name);
  return {
    pathOf,
    has: (file) => alreadyHere(pathOf(file.name), file),
    ready: async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stats = await fs.lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("The recipient's attachment directory is not usable.");
      }
    },
    write: async (file, data) => {
      // A failed write must never expose a partial final file. Hard-linking
      // the finished sibling publishes exclusively without replacing a winner.
      const temporary = path.join(directory, `.mail-upload-${randomUUID()}`);
      try {
        await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
        try {
          await fs.link(temporary, pathOf(file.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!(await alreadyHere(pathOf(file.name), file))) throw error;
        }
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    release: () => undefined,
  };
}

function workspaceRelativePath(batch: string, name: string): string {
  return `${AGENT_MAIL_ATTACHMENT_DIRECTORY}/${batch}/${name}`;
}

function excludeFromGit(
  context: CommandContext,
  environment: Environment,
  execute: RegistryDependencies["runContainerFileCopyCommand"],
  batch: string,
) {
  return ensureWorkspaceArtifactIsGitExcluded(
    environment,
    createEnvironmentCommandRunner(
      environment,
      context.runtime.environments.fence,
      undefined,
      undefined,
      execute,
    ),
    `${AGENT_MAIL_ATTACHMENT_DIRECTORY}/${batch}`,
    "The mailed image's location",
  );
}

function localEnvironmentSink(
  context: CommandContext,
  environment: Environment,
  batch: string,
  dependencies: MailAttachmentDependencies,
  release: () => void,
): AttachmentSink {
  const root = environment.worktreePath;
  if (!root) throw new Error(`${environment.name} has no workspace yet; start it first.`);
  const pathOf = (name: string) => path.join(root, workspaceRelativePath(batch, name));
  return {
    pathOf,
    has: (file) => alreadyHere(pathOf(file.name), file),
    ready: () =>
      excludeFromGit(context, environment, dependencies.runContainerFileCopyCommand, batch),
    write: async (file, data) => {
      await writeConfinedLocalArtifact(root, workspaceRelativePath(batch, file.name), data);
    },
    release,
  };
}

function containerEnvironmentSink(
  context: CommandContext,
  environment: Environment,
  batch: string,
  dependencies: MailAttachmentDependencies,
  release: () => void,
): AttachmentSink {
  const containerId = environment.containerId;
  // A stopped container has no process to write the file, and mail that waited
  // for it would point at nothing until it started.
  if (!containerId || environment.status !== "running") {
    throw new Error(
      `${environment.name} is not running, so an image cannot be copied into its container; start it, then retry with the same requestId.`,
    );
  }
  const execute = dependencies.runContainerFileCopyCommand;
  const pathOf = (name: string) => `/workspace/${workspaceRelativePath(batch, name)}`;
  return {
    pathOf,
    has: async (file) => {
      const answer = await execute(
        "docker",
        ["exec", containerId, "sha256sum", "--", pathOf(file.name)],
        { timeoutMs: 30_000 },
      ).catch(() => null);
      if (!answer) return false;
      if (answer.stdout.split(/\s/)[0] !== file.sha256) throw differentFile(file.name);
      return true;
    },
    ready: () => excludeFromGit(context, environment, execute, batch),
    write: async (file, data) => {
      await execute(
        "docker",
        [
          "exec",
          "-i",
          containerId,
          "node",
          "-e",
          CONTAINER_PINNED_ATTACHMENT_WRITE,
          "/workspace",
          `${AGENT_MAIL_ATTACHMENT_DIRECTORY}/${batch}`,
          file.name,
          String(file.bytes),
          "",
          "exclusive",
          String(0o644),
          "create",
        ],
        {
          stdin: data.toString("base64"),
          timeoutMs: dependencies.containerFileCopyTimeoutMs,
        },
      );
    },
    release,
  };
}

function parseRecipient(value: unknown): MailAttachmentRecipient {
  const record = value as { environmentId?: unknown; projectId?: unknown } | null;
  if (typeof record?.environmentId === "string" && record.environmentId) {
    return { environmentId: record.environmentId };
  }
  if (typeof record?.projectId === "string" && record.projectId) {
    return { projectId: record.projectId };
  }
  throw new Error("Expected the environment or project the images are for.");
}

type MailAttachmentDependencies = Pick<
  RegistryDependencies,
  "runContainerFileCopyCommand" | "containerFileCopyTimeoutMs"
>;

async function sinkFor(
  context: CommandContext,
  recipient: MailAttachmentRecipient,
  batch: string,
  dependencies: MailAttachmentDependencies,
): Promise<AttachmentSink> {
  const { storage } = context;
  // A project's main coordinator resolves as mail to it does, reopening a
  // closed main and refusing a project with no coordinator.
  const address =
    "environmentId" in recipient
      ? recipient.environmentId
      : (
          await storage.resolveAgentMailRecipient(
            {
              kind: "system",
              projectId: recipient.projectId,
              source: "workflow",
              resourceId: "mail-attachments",
            },
            {
              requestId: "mail-attachments",
              toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
              toTabId: "",
              body: "mail-attachments",
            },
          )
        ).environmentId;
  const coordinatorId = coordinatorIdFromRuntimeId(address);
  const conversationId = coordinatorConversationIdFromRuntimeId(address);
  if (coordinatorId && conversationId) {
    const workspace = await storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
    if (!workspace?.conversations.some((item) => item.id === conversationId && !item.closedAt)) {
      throw new Error("The recipient's coordinator conversation is not open.");
    }
    return privateDirectorySink(
      storage.coordinators.coordinatorAttachmentDirectory(coordinatorId, conversationId),
    );
  }
  const environment = await storage.getEnvironment(address);
  if (!environment) throw new Error("That environment does not exist on this node.");
  // The project home is the user's own checkout, which nothing ever cleans up,
  // so its images stay out of it: in the data directory, removed with the
  // project home (or when the mail naming them passes retention).
  if (isProjectHomeEnvironment(environment)) {
    return privateDirectorySink(
      projectHomeMailAttachmentDir(storage.getDataDir(), environment.id, batch),
    );
  }
  if (environment.worktreeMove) {
    throw new Error(`${environment.name} is being moved, so an image cannot be copied into it.`);
  }
  const release = context.runtime.environments.fence.beginMutation(environment.id);
  try {
    return environment.environmentType === "local"
      ? localEnvironmentSink(context, environment, batch, dependencies, release)
      : containerEnvironmentSink(context, environment, batch, dependencies, release);
  } catch (error) {
    release();
    throw error;
  }
}

/** The receiving end of mailed images, on this node and for a command node's calls. */
export function registerMailAttachmentCommands(
  register: CommandRegistrar,
  dependencies: MailAttachmentDependencies,
): void {
  // Lenient keys (`node-mail` domain): `parseMailAttachmentBatch` and
  // `parseRecipient` check them with their own messages.
  register(
    prepareNodeMailAttachmentsCommand,
    async (args, context) => {
      const { batch, files } = parseMailAttachmentBatch(args.attachments);
      const sink = await sinkFor(context, parseRecipient(args.to), batch, dependencies);
      try {
        const missing: string[] = [];
        for (const file of files) if (!(await sink.has(file))) missing.push(file.name);
        return { missing };
      } finally {
        sink.release();
      }
    },
    ASYNC_HANDLER,
  );

  register(
    placeNodeMailAttachmentsCommand,
    async (args, context) => {
      const { batch, files } = parseMailAttachmentBatch(args.attachments);
      const dataDir = context.storage.getDataDir();
      let sink: AttachmentSink | undefined;
      try {
        sink = await sinkFor(context, parseRecipient(args.to), batch, dependencies);
        await sink.ready();
        const attachments: AgentMailAttachment[] = [];
        for (const file of files) {
          if (!(await sink.has(file))) {
            await sink.write(file, await readSpooledAttachment(dataDir, batch, file));
          }
          attachments.push({ ...file, path: sink.pathOf(file.name) });
        }
        return { attachments };
      } finally {
        sink?.release();
        await removeMailAttachmentBatch(dataDir, batch).catch(() => undefined);
      }
    },
    ASYNC_HANDLER,
  );
}

/** The attachment references in a command's arguments; absent means none. */
export function attachmentReferences(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("attachments must be a list of attachment names or paths.");
  }
  return value;
}

/** Read this conversation's own attachments, refusing anything else with a reason. */
export function readCallerAttachments(
  context: CommandContext,
  caller: Caller,
  references: readonly string[],
): Promise<OwnAttachment[]> {
  if (references.length === 0) return Promise.resolve([]);
  return readOwnAttachments(
    context.storage.coordinators.coordinatorAttachmentDirectory(
      caller.coordinatorId,
      caller.conversationId,
    ),
    references,
  );
}

function batchFor(caller: Caller, requestId: string, own: readonly OwnAttachment[]) {
  return {
    batch: mailAttachmentBatchId([caller.coordinatorId, caller.conversationId, requestId]),
    files: mailAttachmentFiles(own),
  };
}

/**
 * Copy a message's images to a recipient on this node, or find them there from
 * an earlier attempt. Answers with what the message records.
 */
export async function placeCallerAttachments(
  context: CommandContext,
  invoke: MailAttachmentInvoker,
  caller: Caller,
  requestId: string,
  own: readonly OwnAttachment[],
  to: MailAttachmentRecipient,
): Promise<AgentMailAttachment[]> {
  if (own.length === 0) return [];
  const attachments = batchFor(caller, requestId, own);
  const { missing } = await invoke<{ missing: string[] }>("prepare_node_mail_attachments", {
    to,
    attachments,
  });
  await stageMailAttachments(
    context.storage.getDataDir(),
    attachments.batch,
    own.filter((file) => missing.includes(file.name)),
  );
  const placed = await invoke<{ attachments: AgentMailAttachment[] }>(
    "place_node_mail_attachments",
    { to, attachments },
  );
  return placed.attachments;
}

/** The node a batch is pushed to; `coordinatorNodeTarget` answers this. */
export interface MailAttachmentNode {
  selfId: string;
  nodeId: string;
  nodeName: string;
  /** That node's `node-mail` domain client: version 1 takes images, a pre-contract node by capability. */
  nodeMail(): Pick<NodeMailApi, "supports" | "prepareAttachments">;
}

/** Refuse a node that would drop or reject the images, and say what to do. */
export function assertNodeTakesMailAttachments(node: MailAttachmentNode): void {
  if (node.nodeMail().supports(BACKEND_CAPABILITIES.nodeMailAttachments)) return;
  compatibilityPathUsage.record("node-mail-attachments.older-node");
  throw new Error(
    `${node.nodeName} runs an older Orkestrator that cannot receive images by mail; update that machine, then retry. Nothing was sent.`,
  );
}

/**
 * Move a message's images to another node's spool, ready for its
 * `deliver_node_mail` to place. A failure here means no message was sent, and a
 * retry skips whatever that node already has. Answers with the batch to name.
 */
export async function pushCallerAttachmentsToNode(
  context: CommandContext,
  transfer: Pick<NodeFileTransfer, "transfer">,
  node: MailAttachmentNode,
  caller: Caller,
  requestId: string,
  own: readonly OwnAttachment[],
  to: MailAttachmentRecipient,
): Promise<MailAttachmentBatch> {
  assertNodeTakesMailAttachments(node);
  const attachments = batchFor(caller, requestId, own);
  const { missing } = await node.nodeMail().prepareAttachments({ to, attachments });
  if (missing.length === 0) return attachments;
  const dataDir = context.storage.getDataDir();
  await stageMailAttachments(
    dataDir,
    attachments.batch,
    own.filter((file) => missing.includes(file.name)),
  );
  try {
    const receipt = await transfer.transfer({
      from: { nodeId: node.selfId, scope: { mailAttachments: attachments.batch } },
      to: { nodeId: node.nodeId, scope: { mailAttachments: attachments.batch } },
      files: missing,
      overwrite: true,
      actor: `coordinator ${caller.coordinatorId}`,
    });
    if (receipt.status !== "completed") {
      throw new Error(
        `The images could not be copied to ${node.nodeName}: ${receipt.error?.message ?? "the transfer failed"}. Nothing was sent; retry with the same requestId.`,
      );
    }
  } finally {
    await removeMailAttachmentBatch(dataDir, attachments.batch).catch(() => undefined);
  }
  return attachments;
}
