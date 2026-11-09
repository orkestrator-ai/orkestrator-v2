import { ticketSyncOutboxReadyEvent } from "@orkestrator/protocol/contract/domains/events";
import type { BackendEmit } from "../backend-emit.js";
import {
  AGENT_MAIL_MAX_THREAD_HOPS,
  normalizeAgentMessagingSettings,
  type AgentMailAttachment,
} from "@orkestrator/protocol/agent-mail";
import { randomUUID } from "node:crypto";

import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import { parseAgentsMdChanges } from "@orkestrator/protocol/agents-md-orkestrator";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { CoordinatorNoticeRoute } from "@orkestrator/protocol/coordinator-notices";
import { parseProjectHomeMessage } from "@orkestrator/protocol/project-home-message";
import {
  parseWorkerQuestionRelay,
  workerQuestionAnswerProblem,
} from "@orkestrator/protocol/worker-question-relay";

import type { MailAttachmentRecipient } from "../coordinator-mail-attachments.js";
import {
  outboxMailAttachmentBatch,
  parseMailAttachmentBatch,
  removeMailAttachmentBatch,
  stageMailAttachments,
  type MailAttachmentBatch,
  type OwnAttachment,
} from "../mail-attachments.js";
import type { StorageService } from "../storage.js";
import { agentsMdBranchName, agentsMdRequestKey, type AgentsMdPrResult } from "../agents-md-pr.js";
import {
  describeNodeAction,
  NodeActionRequests,
  type NodeActionApproval,
  type NodeActionKind,
  type NodeActionRequest,
  type NodeActionTarget,
} from "./node-action-requests.js";
import { executeAgentAccountSwitch } from "./node-account-switch.js";
import { NodeOutcomeUnknownError, NodeUnavailableError } from "./node-link.js";
import { NodeMailCollector } from "./node-mail-collector.js";
import { NodeTicketSync } from "./node-ticket-sync.js";
import {
  coordinatorContactKey,
  describeCommandCoordinatorMail,
  describeCoordinatorMail,
  emptyNodeMailState,
  LeafNodeMail,
  type OutboxItem,
  type CoordinatorMailbox,
  type LocalCoordinatorContact,
  type NodeMailState,
  type NodeMailStore,
} from "./node-mail.js";
import { NodeFiles } from "./node-files.js";
import type { NodePortal } from "./node-portal.js";
import { NodeProjectFiles } from "./node-project-files.js";
import { NodeProjectCopies } from "./node-project-copy.js";
import type { ProjectCopyRecord } from "@orkestrator/protocol/project-copy";
import type { NodeService } from "./node-service.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("nodes");

/**
 * Cross-node coordination for one backend: leaf mail (incoming coordinator
 * mail, origins, the outbox) on the leaf side; collection of leaf mail into
 * coordinator mailboxes and the user-approved action requests on the
 * command-node side.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function parseMailState(value: unknown): NodeMailState {
  const root = value as Partial<NodeMailState> | null;
  if (!root || root.version !== 1) return emptyNodeMailState();
  return {
    version: 1,
    origins: root.origins && typeof root.origins === "object" ? root.origins : {},
    ...(root.contacts && typeof root.contacts === "object" ? { contacts: root.contacts } : {}),
    threads: root.threads && typeof root.threads === "object" ? root.threads : {},
    outbox: root.outbox && typeof root.outbox === "object" ? root.outbox : {},
    ...(root.noticeRoutes && typeof root.noticeRoutes === "object"
      ? { noticeRoutes: root.noticeRoutes }
      : {}),
    ...(root.acknowledgedAttachmentMail && typeof root.acknowledgedAttachmentMail === "object"
      ? { acknowledgedAttachmentMail: root.acknowledgedAttachmentMail }
      : {}),
  };
}

/** A local tab's mail display name ("Claude 2"), or undefined when it has no mailbox. */
async function mailboxDisplayName(
  storage: StorageService,
  environmentId: string,
  tabId: string,
): Promise<string | undefined> {
  if (!tabId) return undefined;
  const mailbox = await storage
    .getAgentMailMailbox(environmentId, tabId, { limit: 1 })
    .catch(() => null);
  return mailbox?.descriptor.displayName || undefined;
}

/** The environment a workflow a coordinator on this backend started runs in. */
async function workflowEnvironmentId(
  storage: StorageService,
  association: CoordinatorWorkflowAssociation,
): Promise<string | undefined> {
  if (association.kind === "build-pipeline")
    return storage.getBuildPipelineEnvironmentId(association.resourceId).catch(() => undefined);
  const snapshot =
    association.kind === "multi-review"
      ? (await storage.getMultiReviewWorkflow(association.resourceId).catch(() => null))?.snapshot
      : association.kind === "graph-run"
        ? await storage.graphRuns.getGraphRun(association.resourceId).catch(() => null)
        : undefined;
  const environmentId = (snapshot as { environmentId?: unknown } | null | undefined)?.environmentId;
  return typeof environmentId === "string" ? environmentId : undefined;
}

/**
 * When a coordinator on this backend last contacted a local environment's tab:
 * launched or delegated to the environment, started a workflow in it, or mailed
 * the tab. Associations with a `nodeId` are for environments on other nodes and
 * never count.
 */
export async function localCoordinatorContact(
  storage: StorageService,
  environmentId: string,
  tabId?: string,
): Promise<LocalCoordinatorContact> {
  const environment = await storage.getEnvironment(environmentId).catch(() => null);
  const [associations, mailbox] = await Promise.all([
    environment
      ? storage.coordinators
          .listCoordinatorWorkflowAssociations(environment.projectId)
          .catch(() => [])
      : [],
    tabId
      ? storage.getAgentMailMailbox(environmentId, tabId, { limit: 200 }).catch(() => null)
      : null,
  ]);
  let at: string | undefined;
  const consider = (value: string | undefined) => {
    if (value && (!at || value > at)) at = value;
  };
  for (const message of mailbox?.messages ?? []) {
    if (message.from.kind === "coordinator") consider(message.createdAt);
  }
  const workflows: CoordinatorWorkflowAssociation[] = [];
  for (const association of associations) {
    if (association.nodeId || association.pending) continue;
    if (association.kind === "environment") {
      if (association.resourceId !== environmentId) continue;
      if (association.baseCommit) consider(association.createdAt);
      consider(association.delegation?.requestedAt);
    } else workflows.push(association);
  }
  // A workflow cannot contribute a contact newer than its association. Once
  // the newest matching workflow is found, older records need no hydration.
  workflows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const association of workflows) {
    if (at && association.createdAt <= at) break;
    if ((await workflowEnvironmentId(storage, association)) === environmentId) {
      consider(association.createdAt);
    }
  }
  return at ? { at } : {};
}

/** What node mail needs from the coordinator notices; set once both exist. */
export interface NodeCoordinatorNotices {
  /** A leaf's notice, collected by this command node. */
  deliverFromLeaf(
    item: OutboxItem,
    node: { nodeId: string; name: string },
  ): Promise<"delivered" | "declined" | "deferred">;
  /** A notice this node queued that its own coordinator should take after all. */
  takeBack(item: OutboxItem): Promise<void>;
}

export class NodeCoordination {
  readonly leafMail: LeafNodeMail;
  readonly collector: NodeMailCollector;
  /** Kanban sync with the leaves (command node) and the outbox announcements (leaf). */
  readonly ticketSync: NodeTicketSync;
  readonly actions: NodeActionRequests;
  readonly files: NodeFiles;
  readonly projectFiles: NodeProjectFiles;
  readonly copies: NodeProjectCopies;
  // Keep lookup, staging and enqueue in one admission section. A single tail
  // avoids retaining a growing registry of request keys after sends settle.
  private outboxSendTail: Promise<void> = Promise.resolve();
  private recoveryStarted = false;
  private sweepingAttachments = false;
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeNodes: (() => void) | undefined;
  private unsubscribeKanban: (() => void) | undefined;
  private ticketSyncTimer: ReturnType<typeof setInterval> | undefined;
  private coordinatorNotices: NodeCoordinatorNotices | null = null;
  private takingBack: Promise<void> | null = null;

  setCoordinatorNotices(notices: NodeCoordinatorNotices): void {
    this.coordinatorNotices = notices;
  }

  /**
   * Where a notice for this repository goes from this node, by the one rule.
   * A null project is a machine-wide notice.
   */
  async routeNotice(projectId: string | null): Promise<CoordinatorNoticeRoute> {
    const project = projectId
      ? await this.options.storage.getProject(projectId).catch(() => null)
      : null;
    return this.leafMail.routeNotice({
      ...(projectId ? { contactKey: coordinatorContactKey(projectId) } : {}),
      repositoryHint: repositoryHint(project?.gitUrl) ?? null,
      machineWide: projectId === null,
    });
  }

  /** Queue a notice for a command node's coordinator; refused, not dropped, when full. */
  async queueNotice(
    controllerId: BackendId,
    item: Omit<OutboxItem, "seq" | "createdAt" | "bytes" | "repositoryHint">,
  ): Promise<void> {
    const project = item.noticeProjectId
      ? await this.options.storage.getProject(item.noticeProjectId).catch(() => null)
      : null;
    const hint = repositoryHint(project?.gitUrl);
    await this.leafMail.enqueue(controllerId, {
      ...item,
      ...(hint ? { repositoryHint: hint } : {}),
    });
  }

  /** Hand this node's coordinator the notices no command node will take. One pass at a time. */
  takeBackNotices(): Promise<void> {
    this.takingBack ??= this.takeBackNoticesOnce().finally(() => {
      this.takingBack = null;
    });
    return this.takingBack;
  }

  private async takeBackNoticesOnce(): Promise<void> {
    const notices = this.coordinatorNotices;
    if (!notices) return;
    for (const { controllerId, item } of await this.leafMail.noticesToTakeBack()) {
      try {
        await notices.takeBack(item);
        await this.leafMail.settleTakenBack(controllerId, item.seq);
      } catch (error) {
        // It stays in the outbox, and the next pass tries again.
        log.warn("notices.take-back-failed", { error: formatLogError(error, { message: false }) });
      }
    }
  }

  /** Called after backend recovery, links and portal storage are ready. */
  start(): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.resumeActions();
    this.recoveryTimer = setInterval(() => this.resumeActions(), 30_000);
    this.recoveryTimer.unref?.();
    // A last resort for anything an event did not trigger; a node with nothing
    // new costs a cursor read and an empty collect.
    this.ticketSyncTimer = setInterval(() => {
      if (this.options.nodes.mode() === "command") {
        void this.ticketSync.syncAll().catch(() => undefined);
        // A collect also tells each leaf which repositories this node has now.
        void this.options.nodes
          .listNodes()
          .then((list) => {
            for (const node of list.nodes) {
              if (node.connection.state === "connected") void this.collector.collect(node.nodeId);
            }
          })
          .catch(() => undefined);
      }
      void this.takeBackNotices();
    }, 60_000);
    this.ticketSyncTimer.unref?.();
    // What a previous run queued or was handed back is still in the outbox.
    void this.takeBackNotices();
  }

  private resumeActions(): void {
    if (!this.recoveryStarted) return;
    if (!this.sweepingAttachments) {
      this.sweepingAttachments = true;
      void this.files
        .sweepMailAttachments()
        // Best-effort maintenance; the next backend pass retries.
        .catch(() => undefined)
        .finally(() => {
          this.sweepingAttachments = false;
        });
    }
    void this.actions.resumeInterrupted().catch(() => {
      log.warn("actions.resume-failed");
    });
  }

  dispose(): void {
    this.recoveryStarted = false;
    clearInterval(this.recoveryTimer);
    clearInterval(this.ticketSyncTimer);
    this.unsubscribeNodes?.();
    this.unsubscribeKanban?.();
    this.collector.dispose();
    this.ticketSync.dispose();
  }

  constructor(
    private readonly options: {
      storage: StorageService;
      nodes: NodeService;
      portal: NodePortal;
      /** This backend's own commands (local deletions, coordinator lookup). */
      invoke: Invoke;
      emit: BackendEmit;
    },
  ) {
    const { storage, nodes, portal } = options;
    const mailStore: NodeMailStore = {
      load: async () => parseMailState(await storage.nodes.loadNodeMail()),
      mutate: (mutate) =>
        storage.nodes.mutateNodeMail((current) => {
          const { next, result } = mutate(parseMailState(current));
          return { next, result };
        }),
    };
    this.leafMail = new LeafNodeMail(
      mailStore,
      {
        attachedControllers: () =>
          nodes.listControllers().map((entry) => ({
            controllerId: entry.controllerId,
            displayName: entry.displayName,
            lastContactAt: entry.lastContactAt,
          })),
        mostRecentControllerId: () => nodes.mostRecentControllerId(),
        localCoordinatorContact: (environmentId, tabId) =>
          localCoordinatorContact(storage, environmentId, tabId),
        noticesHandedBack: () => void this.takeBackNotices(),
      },
      options.emit,
      Date.now,
      // Fetched and acknowledged: the spooled copies are no longer anyone's.
      (items) => {
        for (const item of items) {
          if (!item.attachments) continue;
          void removeMailAttachmentBatch(
            storage.getDataDir(),
            outboxMailAttachmentBatch(item.attachments.batch),
          ).catch(() => undefined);
        }
      },
    );
    storage.nodeMailRouter = {
      route: (input) => this.leafMail.route(input),
      enqueue: async (destination, item) => {
        const environment = await storage.getEnvironment(item.fromEnvironmentId).catch(() => null);
        const project = environment
          ? await storage.getProject(environment.projectId).catch(() => null)
          : null;
        const tabName = await mailboxDisplayName(storage, item.fromEnvironmentId, item.fromTabId);
        const hint = repositoryHint(project?.gitUrl);
        const mailbox = destination as Partial<CoordinatorMailbox>;
        return this.leafMail.enqueue(destination.controllerId as BackendId, {
          ...item,
          ...(environment?.name ? { fromEnvironmentName: environment.name } : {}),
          ...(tabName ? { fromTabName: tabName } : {}),
          ...(hint ? { repositoryHint: hint } : {}),
          ...(mailbox.coordinatorEnvironmentId && mailbox.coordinatorTabId
            ? {
                toCoordinator: {
                  environmentId: mailbox.coordinatorEnvironmentId,
                  tabId: mailbox.coordinatorTabId,
                },
              }
            : {}),
        });
      },
    };
    this.collector = new NodeMailCollector({
      selfId: () => nodes.selfIdentity(),
      link: (nodeId) => nodes.link(nodeId),
      nodeName: async (nodeId) =>
        (await nodes.getNode(nodeId).catch(() => null))?.displayName ?? nodeId,
      deliver: (input) => this.deliverToCoordinator(input),
      notices: {
        // The repositories whose coordinator here can take a leaf's notice.
        repositoryHints: async () =>
          !normalizeAgentMessagingSettings((await storage.loadConfig()).global.agentMessaging)
            .enabled
            ? []
            : (await storage.loadProjects())
                .map((project) => repositoryHint(project.gitUrl))
                .filter((hint): hint is string => Boolean(hint)),
        deliver: (item, node) => {
          if (!this.coordinatorNotices) throw new Error("Coordinator notices are not ready.");
          return this.coordinatorNotices.deliverFromLeaf(item, node);
        },
      },
    });
    this.ticketSync = new NodeTicketSync({
      selfId: () => nodes.selfIdentity(),
      link: (nodeId) => (isBackendId(nodeId) ? nodes.link(nodeId) : null),
      nodes: async () =>
        (await portal.summaries()).nodes.map((node) => ({
          nodeId: node.nodeId,
          displayName: node.view.displayName,
          available: node.available,
          projects: node.projects.map((project) => ({
            projectId: project.ref.projectId,
            ...(project.repositoryHint ? { repositoryHint: project.repositoryHint } : {}),
          })),
        })),
      localProjects: () => storage.loadProjects(),
      ticketSync: storage.ticketSync,
      emit: options.emit,
    });
    portal.readModel.onNodeEvent((event, payload, nodeId) => {
      this.collector.handleNodeEvent(event, payload, nodeId);
      this.ticketSync.handleNodeEvent(event, payload, nodeId);
    });
    // A board change here goes to the leaves with the project (command node);
    // a change queued for a command node is announced to it (leaf). Test
    // fixtures may hand in partial services, hence the optional calls.
    this.unsubscribeKanban = storage.addResourceChangeListener?.((change) => {
      if (change.resource !== "kanban") return;
      if (nodes.mode?.() === "command") this.ticketSync.noteLocalChange(change.id);
      if (!nodes.listControllers?.().length) return;
      void storage.ticketSync
        .ticketSyncOutboxControllers()
        .then((controllers) => {
          for (const controllerId of controllers) {
            options.emit(ticketSyncOutboxReadyEvent, { controllerId });
          }
        })
        .catch(() => undefined);
    });
    nodes.onControllerDetached?.((controllerId) => {
      void storage.ticketSync.forgetTicketSyncController(controllerId).catch(() => {
        log.warn("ticket-sync.forget-failed");
      });
    });
    // Every (re)connect collects whatever waited while the link was down.
    let connected = new Set<string>();
    this.unsubscribeNodes = nodes.subscribe(() => {
      void nodes
        .listNodes()
        .then((list) => {
          const now = new Set(
            list.nodes
              .filter((node) => node.connection.state === "connected")
              .map((node) => node.nodeId),
          );
          for (const nodeId of now)
            if (!connected.has(nodeId)) {
              void this.collector.collect(nodeId);
              void this.ticketSync.sync(nodeId);
              this.resumeActions();
            }
          connected = now;
        })
        .catch(() => undefined);
    });
    this.files = new NodeFiles(storage);
    this.projectFiles = new NodeProjectFiles({
      storage,
      nodes,
      portal,
      local: this.files,
      localInvoke: (command, args) => options.invoke(command, args),
      deliverToConversation: (input) =>
        this.deliverToCoordinator({
          toCoordinator: { environmentId: input.environmentId, tabId: input.tabId },
          subject: input.subject,
          body: input.body,
          requestId: input.requestId,
        }),
    });
    this.copies = new NodeProjectCopies({
      selfId: () => nodes.selfIdentity(),
      selfName: async () => (await nodes.selfProfile()).displayName,
      summaries: (nodeIds) => portal.summaries(nodeIds),
      invokerFor: this.projectFiles.invokerFor,
      transfer: this.projectFiles.transfer,
      emit: options.emit,
      onFinished: (record) => {
        if (record.actionRequestId) void this.notifyCopyFinished(record);
      },
    });
    portal.afterRouted = async (nodeId, command, args, result) => {
      // A coordinator's launch creates through `create_controller_environment`.
      const input =
        command === "create_controller_environment" && args.input && typeof args.input === "object"
          ? (args.input as Record<string, unknown>)
          : command === "create_environment"
            ? args
            : null;
      if (!input || typeof input.projectId !== "string") return;
      const environmentId = (result as { id?: unknown } | null)?.id;
      if (typeof environmentId !== "string") return;
      await this.projectFiles.seedEnvironment(nodeId, input.projectId, environmentId);
    };
    this.actions = new NodeActionRequests({
      load: () => storage.nodes.loadNodeActionRequests(),
      save: (requests) => storage.nodes.saveNodeActionRequests(requests),
      emit: options.emit,
      executors: {
        "delete-environment": (request) => this.executeDeletion(request),
        "update-project-files": (request) => this.projectFiles.executeUpdate(request),
        "reveal-env-value": (request) => this.projectFiles.executeReveal(request),
        "create-project": (request, approval) => this.executeCreateProject(request, approval),
        "apply-root-changes": (request, approval) => this.executeRootChanges(request, approval),
        "answer-worker-question": (request, approval) =>
          this.executeWorkerAnswer(request, approval),
        "message-project-home": (request) => this.executeProjectHomeMessage(request),
        "update-agents-md": (request, approval) => this.executeAgentsMdUpdate(request, approval),
        "switch-agent-account": (request) =>
          executeAgentAccountSwitch(request, {
            selfId: () => this.options.nodes.selfIdentity(),
            invoke: (command, args) => this.options.invoke(command, args),
            invokeOnNode: (input) => this.options.portal.invokeOnNode(input),
          }),
      },
      notify: (request) => this.notifyRequester(request),
    });
  }

  /*
   * Leaf side
   */

  /**
   * Mail from a command node's coordinator to an agent on this node. `steer`
   * is its `deliverNow`: the pending entry is marked as a local coordinator's
   * would be, and the caller runs the one delivery pass that settles it.
   */
  async deliverIncoming(args: Record<string, unknown>): Promise<{
    messageId: string;
    toTabId: string;
    toEnvironmentName: string;
    toTabName?: string;
    placement: string;
    placementReason?: string;
    injectedVia?: "steer";
    attachments?: AgentMailAttachment[];
  }> {
    const controllerId = args.controllerId;
    if (!isBackendId(controllerId)) throw new Error("Expected controllerId.");
    const controller = this.options.nodes
      .listControllers()
      .find((entry) => entry.controllerId === controllerId);
    if (!controller)
      throw new Error("Only an attached command node can deliver coordinator mail here.");
    const mailbox = this.mailboxFrom(args, controllerId, controller.displayName);
    const toEnvironmentId = typeof args.toEnvironmentId === "string" ? args.toEnvironmentId : "";
    if (!toEnvironmentId) throw new Error("Expected toEnvironmentId.");
    const body = typeof args.body === "string" ? args.body : "";
    if (!body || Buffer.byteLength(body, "utf8") > 32 * 1024)
      throw new Error("Expected a body of at most 32 KiB.");
    const requestId =
      typeof args.requestId === "string" ? args.requestId.slice(0, 200) : randomUUID();
    if (toEnvironmentId === COORDINATOR_MAIL_ADDRESS) {
      return this.deliverToProjectCoordinator(args, controllerId, controller.displayName, mailbox, {
        requestId,
        body,
      });
    }
    const environment = await this.options.storage.getEnvironment(toEnvironmentId);
    if (!environment) throw new Error("That environment does not exist on this node.");
    // Before the message exists: if the files cannot be placed, there is no mail.
    const attachments = await this.placeIncomingAttachments(args.attachments, {
      environmentId: toEnvironmentId,
    });
    // The attached command node's coordinator, authenticated by the node link:
    // its mail is a delegation in this environment's project and wakes the
    // agent, as a coordinator's on this node would.
    const message = await this.options.storage.sendAgentMail(
      {
        kind: "node",
        nodeId: controllerId,
        nodeName: controller.displayName,
        role: "coordinator",
        projectId: environment.projectId,
        environmentId: mailbox.coordinatorEnvironmentId,
        tabId: mailbox.coordinatorTabId,
        title: "Project coordinator",
        ...(args.turnOrigin === "mail" ? { turnOrigin: "mail" as const } : {}),
      },
      {
        requestId: `node:${controllerId}:${requestId}`.slice(0, 256),
        toEnvironmentId,
        toTabId: typeof args.toTabId === "string" ? args.toTabId : "",
        ...(typeof args.subject === "string" ? { subject: args.subject.slice(0, 200) } : {}),
        body: describeCoordinatorMail(body, controller.displayName),
        ...(attachments.length ? { attachments } : {}),
      },
      { newDelegation: true, steer: args.steer === true },
    );
    await this.leafMail.recordThread(message.id, mailbox);
    // An environment the coordinator talks to reports back to it, until
    // another coordinator contacts it.
    await this.leafMail.recordOrigin(toEnvironmentId, mailbox, { keepOrigin: true });
    const toTabName = await mailboxDisplayName(
      this.options.storage,
      toEnvironmentId,
      message.toTabId,
    );
    return {
      messageId: message.id,
      toTabId: message.toTabId,
      // The command node names the recipient in its transcript by these.
      toEnvironmentName: environment.name,
      ...(toTabName ? { toTabName } : {}),
      placement: message.placement,
      ...(message.placementReason ? { placementReason: message.placementReason } : {}),
      ...(message.injectedVia ? { injectedVia: message.injectedVia } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    };
  }

  /** Put images a command node already pushed where this mail's recipient reads them. */
  private async placeIncomingAttachments(
    value: unknown,
    to: MailAttachmentRecipient,
  ): Promise<AgentMailAttachment[]> {
    if (value === undefined) return [];
    const placed = await this.options.invoke<{ attachments: AgentMailAttachment[] }>(
      "place_node_mail_attachments",
      { to, attachments: parseMailAttachmentBatch(value) },
    );
    return placed.attachments;
  }

  /**
   * The command node's coordinator asking this node's main coordinator for
   * the project. Stored as node mail from a coordinator, so it is
   * same-project, takes the coordinator route and wakes it; the address
   * resolves as local mail to "coordinator" does, starting a closed main with
   * the default agent. A project with no coordinator at all is refused.
   */
  private async deliverToProjectCoordinator(
    args: Record<string, unknown>,
    controllerId: BackendId,
    controllerName: string,
    mailbox: CoordinatorMailbox,
    input: { requestId: string; body: string },
  ): Promise<{
    messageId: string;
    toTabId: string;
    toEnvironmentId: string;
    toEnvironmentName: string;
    toTabName?: string;
    placement: string;
    placementReason?: string;
    attachments?: AgentMailAttachment[];
  }> {
    const storage = this.options.storage;
    const projectId = typeof args.projectId === "string" ? args.projectId : "";
    if (!projectId) throw new Error("Expected projectId for mail to this node's coordinator.");
    const project = await storage.getProject(projectId);
    if (!project) throw new Error("That project does not exist on this node.");
    if (!(await storage.coordinators.getCoordinatorWorkspace(projectId))) {
      throw new Error(
        `This node has no coordinator for ${project.name}; message a worker here instead, or ask the user to open one on this node.`,
      );
    }
    const attachments = await this.placeIncomingAttachments(args.attachments, { projectId });
    const message = await storage.sendAgentMail(
      {
        kind: "node",
        nodeId: controllerId,
        nodeName: controllerName,
        role: "coordinator",
        projectId,
        environmentId: mailbox.coordinatorEnvironmentId,
        tabId: mailbox.coordinatorTabId,
        title: `Coordinator on ${controllerName}`,
        ...(args.turnOrigin === "mail" ? { turnOrigin: "mail" as const } : {}),
      },
      {
        requestId: `node:${controllerId}:${input.requestId}`.slice(0, 256),
        toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
        toTabId: "",
        ...(typeof args.subject === "string" ? { subject: args.subject.slice(0, 200) } : {}),
        body: input.body,
        ...(attachments.length ? { attachments } : {}),
      },
      {
        newDelegation: true,
        nodePrefix: describeCommandCoordinatorMail("", controllerName),
        ...(args.nodeParent
          ? { nodeParent: args.nodeParent as { id: string; threadId: string; hopCount: number } }
          : {}),
      },
    );
    // Its answer goes back to this conversation; a new message from this
    // project's coordinator goes to the command node that mailed it last.
    await this.leafMail.recordThread(message.id, mailbox);
    await this.leafMail.recordContact(coordinatorContactKey(projectId), mailbox);
    const toTabName = await mailboxDisplayName(storage, message.toEnvironmentId, message.toTabId);
    return {
      messageId: message.id,
      toEnvironmentId: message.toEnvironmentId,
      toTabId: message.toTabId,
      toEnvironmentName: "Coordinator",
      ...(toTabName ? { toTabName } : {}),
      placement: message.placement,
      ...(message.placementReason ? { placementReason: message.placementReason } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    };
  }

  /**
   * A command node has no coordinator for an agent's repository: its mail to
   * "coordinator" goes to this node's own instead of waiting in the outbox for
   * one that may never exist. With none here either, the send fails and the
   * item stays queued. Addressed and coordinator mail is never handed back.
   */
  async returnOutboxMail(controllerId: BackendId, seq: number): Promise<void> {
    const storage = this.options.storage;
    const controller = this.options.nodes
      .listControllers()
      .find((entry) => entry.controllerId === controllerId);
    if (!controller) throw new Error("Only an attached command node can hand back its mail.");
    const item = await this.leafMail.queued(controllerId, seq);
    if (!item) return;
    if (item.fromCoordinator || item.toCoordinator || item.allowLocalFallback === false) {
      throw new Error("That mail was addressed to a coordinator conversation.");
    }
    const environment = await storage.getEnvironment(item.fromEnvironmentId);
    if (!environment) throw new Error("The environment that sent that mail no longer exists.");
    await storage.sendAgentMail(
      {
        kind: "tab",
        environmentId: environment.id,
        projectId: environment.projectId,
        tabId: item.fromTabId,
      },
      {
        requestId: item.requestId,
        toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
        toTabId: "",
        ...(item.subject ? { subject: item.subject } : {}),
        body: item.body,
      },
      {
        fallbackNotice: `${controller.displayName} has no coordinator for this repository, so this came to you instead.`,
      },
    );
    await this.leafMail.ack(controllerId, seq, [seq], true, true);
  }

  /** Whether a project here has a coordinator a command node's coordinator can mail. */
  async projectCoordinator(projectId: string): Promise<{
    hasCoordinator: boolean;
    main: { title: string; agent: string | null } | null;
  }> {
    const workspace = await this.options.storage.coordinators.getCoordinatorWorkspace(projectId);
    const main = workspace ? coordinatorMainConversation(workspace) : undefined;
    return {
      hasCoordinator: Boolean(workspace),
      main: main ? { title: main.title, agent: main.agent ?? null } : null,
    };
  }

  /**
   * This node's main coordinator writing to a command node's coordinator: a
   * reply to that coordinator's message, or a new message for the
   * repository's main coordinator there. Queued in the outbox like a worker's
   * report; the command node collects it.
   */
  async sendFromCoordinator(input: {
    projectId: string;
    coordinatorEnvironmentId: string;
    coordinatorTabId: string;
    requestId: string;
    subject?: string;
    body: string;
    replyToMessageId?: string;
    /** The images in this batch, read and checked; spooled only if this is a new request. */
    attachments?: MailAttachmentBatch;
    own?: readonly OwnAttachment[];
  }): Promise<{ item: OutboxItem; controllerId: BackendId; controllerName?: string }> {
    const destination = await this.leafMail.routeCoordinator({
      contactKey: coordinatorContactKey(input.projectId),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    });
    const project = await this.options.storage.getProject(input.projectId).catch(() => null);
    const hint = repositoryHint(project?.gitUrl);
    const tabName = await mailboxDisplayName(
      this.options.storage,
      input.coordinatorEnvironmentId,
      input.coordinatorTabId,
    );
    const mailbox = destination as Partial<CoordinatorMailbox>;
    const parent = input.replyToMessageId
      ? await this.options.storage.getAgentMailMessage(
          input.coordinatorEnvironmentId,
          input.coordinatorTabId,
          input.replyToMessageId,
        )
      : undefined;
    if (parent && (parent.hopCount ?? 0) >= AGENT_MAIL_MAX_THREAD_HOPS)
      throw new Error("Thread hop limit reached");
    const previous = this.outboxSendTail;
    let release!: () => void;
    this.outboxSendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // A retry finds its request queued, or already delivered, and copies nothing.
      const spooled =
        input.attachments && input.own
          ? !(await this.leafMail.knownRequest(destination.controllerId, {
              requestId: input.requestId,
              fromEnvironmentId: input.coordinatorEnvironmentId,
              fromTabId: input.coordinatorTabId,
            }))
          : false;
      try {
        if (spooled) {
          await stageMailAttachments(
            this.options.storage.getDataDir(),
            outboxMailAttachmentBatch(input.attachments!.batch),
            input.own!,
          );
        }
        const item = await this.leafMail.enqueue(destination.controllerId, {
          requestId: input.requestId,
          fromEnvironmentId: input.coordinatorEnvironmentId,
          fromTabId: input.coordinatorTabId,
          fromEnvironmentName: "Coordinator",
          ...(tabName ? { fromTabName: tabName } : {}),
          ...(hint ? { repositoryHint: hint } : {}),
          ...(mailbox.coordinatorEnvironmentId && mailbox.coordinatorTabId
            ? {
                toCoordinator: {
                  environmentId: mailbox.coordinatorEnvironmentId,
                  tabId: mailbox.coordinatorTabId,
                },
              }
            : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          body: input.body,
          fromCoordinator: true,
          ...(parent
            ? {
                nodeParent: {
                  id: parent.id,
                  threadId: parent.threadId,
                  hopCount: parent.hopCount ?? 0,
                },
              }
            : {}),
          ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
          ...(input.attachments ? { attachments: input.attachments } : {}),
        });
        return {
          item,
          controllerId: destination.controllerId,
          ...(destination.controllerName ? { controllerName: destination.controllerName } : {}),
        };
      } catch (error: unknown) {
        // Staging and admission both own this new batch until enqueue succeeds.
        if (spooled) {
          await removeMailAttachmentBatch(
            this.options.storage.getDataDir(),
            outboxMailAttachmentBatch(input.attachments!.batch),
          ).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  async recordOrigin(args: Record<string, unknown>): Promise<{ recorded: true }> {
    const controllerId = args.controllerId;
    if (!isBackendId(controllerId)) throw new Error("Expected controllerId.");
    const controller = this.options.nodes
      .listControllers()
      .find((entry) => entry.controllerId === controllerId);
    if (!controller) throw new Error("Only an attached command node can record an origin here.");
    if (typeof args.environmentId !== "string") throw new Error("Expected environmentId.");
    await this.leafMail.recordOrigin(
      args.environmentId,
      this.mailboxFrom(args, controllerId, controller.displayName),
    );
    return { recorded: true };
  }

  private mailboxFrom(
    args: Record<string, unknown>,
    controllerId: BackendId,
    name: string,
  ): CoordinatorMailbox {
    if (
      typeof args.coordinatorEnvironmentId !== "string" ||
      typeof args.coordinatorTabId !== "string"
    ) {
      throw new Error("Expected the coordinator's mailbox.");
    }
    return {
      controllerId,
      controllerName: name,
      coordinatorEnvironmentId: args.coordinatorEnvironmentId.slice(0, 256),
      coordinatorTabId: args.coordinatorTabId.slice(0, 256),
    };
  }

  /*
   * Command-node side
   */

  /** Deliver collected leaf mail to a coordinator conversation on this node. */
  private async deliverToCoordinator(input: {
    toCoordinator?: { environmentId: string; tabId: string };
    repositoryHint?: string;
    subject?: string;
    body: string;
    nodePrefix?: string;
    nodeParent?: { id: string; threadId: string; hopCount: number };
    requestId: string;
    /** Images waiting on the sender's node; absent for this node's own notices. */
    attachments?: MailAttachmentBatch;
    /** A leaf agent; absent for this node's own notices. */
    from?: {
      nodeId: string;
      nodeName: string;
      environmentId: string;
      tabId: string;
      environmentName?: string;
      tabName?: string;
      /** The leaf's main coordinator for the project, not an agent. */
      coordinator?: boolean;
    };
  }): Promise<void> {
    const storage = this.options.storage;
    let address = input.toCoordinator;
    let projectId: string | undefined;
    if (address) {
      const workspaces = await storage.coordinators.listCoordinatorWorkspaces();
      const owner = workspaces.find((workspace) =>
        workspace.conversations.some(
          (conversation) =>
            coordinatorRuntimeId(workspace.id, conversation.id) === address!.environmentId &&
            conversation.tabId === address!.tabId,
        ),
      );
      if (!owner)
        throw Object.assign(new Error("That destination is not a coordinator conversation."), {
          code: "no-coordinator",
        });
      projectId = owner.projectId;
    }
    if (!address) {
      const projects = await storage.loadProjects();
      const project = projects.find(
        (candidate) =>
          input.repositoryHint && repositoryHint(candidate.gitUrl) === input.repositoryHint,
      );
      const workspace = project
        ? (await storage.coordinators.listCoordinatorWorkspaces()).find(
            (entry) => entry.projectId === project.id,
          )
        : undefined;
      const main = workspace ? coordinatorMainConversation(workspace) : null;
      if (workspace && !main && input.from) {
        // Mail from a leaf reaches the main as local mail to "coordinator"
        // would, starting a closed one with the default agent.
        address = { environmentId: COORDINATOR_MAIL_ADDRESS, tabId: "" };
      } else if (!workspace || !main) {
        throw Object.assign(new Error("No open coordinator for that project on this node."), {
          code: "no-coordinator",
        });
      } else {
        address = {
          environmentId: coordinatorRuntimeId(workspace.id, main.id),
          tabId: main.tabId,
        };
      }
      projectId = workspace.projectId;
    }
    // Fetched and placed first: a failure leaves the item in the leaf's outbox
    // for the next attempt, and nothing delivered points at a missing file.
    const attachments =
      input.attachments && input.from && projectId
        ? await this.fetchLeafAttachments(
            input.attachments,
            input.from.nodeId,
            address.environmentId === COORDINATOR_MAIL_ADDRESS
              ? { projectId }
              : { environmentId: address.environmentId },
          )
        : [];
    // A worker on a node this one controls reports like a worker here: the
    // node link authenticates it, it wakes the coordinator, and while the
    // coordinator waits on that worker its report is held for the turn's end.
    await storage.sendAgentMail(
      input.from && projectId
        ? {
            kind: "node",
            nodeId: input.from.nodeId,
            nodeName: input.from.nodeName,
            // A leaf's coordinator too: it answers this node's coordinator
            // but has no authority over it, so its mail (and anything it
            // forwards from its workers) keeps an agent's untrusted framing.
            role: "agent",
            projectId,
            environmentId: input.from.environmentId,
            tabId: input.from.tabId,
            // Older leaves report no tab name; their environment's stands in.
            title: input.from.tabName ?? input.from.environmentName ?? null,
            ...(input.from.environmentName ? { environmentName: input.from.environmentName } : {}),
          }
        : { kind: "external" },
      {
        requestId: input.requestId,
        toEnvironmentId: address.environmentId,
        toTabId: address.tabId,
        ...(input.subject ? { subject: input.subject } : {}),
        body: input.body,
        ...(attachments.length ? { attachments } : {}),
      },
      { nodePrefix: input.nodePrefix, nodeParent: input.nodeParent },
    );
  }

  /** The other half of a leaf coordinator's images: copy them here, then place them. */
  private async fetchLeafAttachments(
    batch: MailAttachmentBatch,
    nodeId: string,
    to: MailAttachmentRecipient,
  ): Promise<AgentMailAttachment[]> {
    const attachments = parseMailAttachmentBatch(batch);
    const { missing } = await this.options.invoke<{ missing: string[] }>(
      "prepare_node_mail_attachments",
      { to, attachments },
    );
    if (missing.length) {
      const receipt = await this.projectFiles.transfer.transfer({
        from: {
          nodeId,
          scope: { mailAttachments: outboxMailAttachmentBatch(attachments.batch) },
        },
        to: {
          nodeId: await this.options.nodes.selfIdentity(),
          scope: { mailAttachments: attachments.batch },
        },
        files: missing,
        overwrite: true,
        actor: `node mail from ${nodeId}`,
      });
      if (receipt.status !== "completed") {
        throw new Error(receipt.error?.message ?? "The images could not be fetched.");
      }
    }
    const placed = await this.options.invoke<{ attachments: AgentMailAttachment[] }>(
      "place_node_mail_attachments",
      { to, attachments },
    );
    return placed.attachments;
  }

  async createActionRequest(args: Record<string, unknown>): Promise<NodeActionRequest> {
    const kind = args.kind as NodeActionKind;
    if (
      ![
        "delete-environment",
        "create-project",
        "update-project-files",
        "reveal-env-value",
        "apply-root-changes",
        "update-agents-md",
        "switch-agent-account",
        "answer-worker-question",
        "message-project-home",
      ].includes(kind)
    ) {
      throw new Error("Unknown request kind.");
    }
    if (!Array.isArray(args.targets)) throw new Error("Expected targets.");
    const by = args.requestedBy as Record<string, unknown> | undefined;
    if (
      !by ||
      typeof by.coordinatorEnvironmentId !== "string" ||
      typeof by.coordinatorTabId !== "string" ||
      typeof by.projectId !== "string"
    ) {
      throw new Error("Expected the requesting coordinator.");
    }
    const targets = (args.targets as Array<Record<string, unknown>>).map((target) => {
      if (typeof target.nodeId !== "string" || typeof target.nodeName !== "string") {
        throw new Error("Every target names its node.");
      }
      const clean: NodeActionTarget = {
        nodeId: target.nodeId,
        nodeName: target.nodeName.slice(0, 64),
      };
      for (const key of [
        "environmentId",
        "environmentName",
        "projectId",
        "projectName",
        "location",
        "gitRemote",
        "platform",
        "accountId",
        "accountLabel",
        "previousAccountId",
        "previousAccountLabel",
      ] as const) {
        if (typeof target[key] === "string") clean[key] = (target[key] as string).slice(0, 1024);
      }
      for (const key of ["files", "keys"] as const) {
        if (Array.isArray(target[key])) {
          clean[key] = (target[key] as unknown[])
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, 200)
            .map((entry) => entry.slice(0, 512));
        }
      }
      return clean;
    });
    const workerQuestion =
      kind === "answer-worker-question" ? parseWorkerQuestionRelay(args.workerQuestion) : undefined;
    if (kind === "answer-worker-question" && !workerQuestion)
      throw new Error("A worker question request carries the question and the proposed answer.");
    const projectHomeMessage =
      kind === "message-project-home"
        ? parseProjectHomeMessage(args.projectHomeMessage)
        : undefined;
    if (kind === "message-project-home" && (!projectHomeMessage || targets.length !== 1))
      throw new Error("A project home message request carries one target and the message.");
    return this.actions.create({
      ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
      kind,
      targets,
      requestedBy: {
        coordinatorEnvironmentId: by.coordinatorEnvironmentId,
        coordinatorTabId: by.coordinatorTabId,
        projectId: by.projectId,
      },
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      ...(typeof args.askedBecause === "string" ? { askedBecause: args.askedBecause } : {}),
      ...(kind === "update-agents-md"
        ? { agentsMd: { changes: parseAgentsMdChanges(agentsMdPayload(args.agentsMd)) } }
        : {}),
      ...(workerQuestion ? { workerQuestion } : {}),
      ...(projectHomeMessage ? { projectHomeMessage } : {}),
    });
  }

  /**
   * Run `command` on the node that owns a target's project copy: this node
   * directly, another through the node link. A lost answer is retried while
   * `idempotent`, which joins the run still going on that node.
   */
  private async onTargetNode<T>(
    nodeId: string,
    command: string,
    args: Record<string, unknown>,
    requestKey: string,
    previousRequestKey?: string,
  ): Promise<{ outcome: "ok"; result: T } | { outcome: "unknown" }> {
    if (nodeId === (await this.options.nodes.selfIdentity()))
      return { outcome: "ok", result: await this.options.invoke<T>(command, args) };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const routed = await this.options.portal.invokeOnNode({
          nodeId,
          command,
          args,
          requestKey,
        });
        if (routed.outcome === "ok") {
          // These retries join the same idempotent remote run. Its successful
          // answer settles earlier lost answers, including before a restart.
          const ledger = this.options.portal.outcomes;
          const keys = [requestKey, previousRequestKey?.slice(0, 128)];
          for (const record of ledger.list(nodeId)) {
            if (
              record.command === command &&
              keys.some(
                (key) =>
                  key && (record.requestKey === key || record.requestKey.startsWith(`${key}:`)),
              )
            )
              await ledger.dismiss(record.outcomeId);
          }
          return { outcome: "ok", result: routed.result as T };
        }
      } catch (error) {
        if (!(error instanceof NodeOutcomeUnknownError)) throw error;
      }
    }
    return { outcome: "unknown" };
  }

  /**
   * Approved: open the pull request for the AGENTS.md section on the node
   * that owns the project copy, with the entries the user settled on. The
   * command there is idempotent per request, so a retry after a lost answer
   * or a restart finds the pull request instead of opening a second.
   */
  private async executeAgentsMdUpdate(request: NodeActionRequest, approval: NodeActionApproval) {
    const [target] = request.targets;
    if (!target?.projectId || request.targets.length !== 1 || !request.agentsMd)
      throw new Error("The request names one project.");
    const changes = approval.changes ?? request.agentsMd.changes;
    const key = agentsMdRequestKey(request.requestId);
    const outcome = await this.onTargetNode<AgentsMdPrResult>(
      target.nodeId,
      "open_project_agents_md_pr",
      {
        projectId: target.projectId,
        requestKey: key,
        changes,
        reason: request.reason ?? "Approved in Orkestrator",
        nodeName: target.nodeName,
      },
      `agents-md:${key}`,
      `agents-md:${request.requestId}`,
    );
    if (outcome.outcome === "unknown")
      return {
        code: "outcome-unknown",
        message: `The connection to ${target.nodeName} was lost while it opened the pull request. Check GitHub for branch ${agentsMdBranchName(key)} before proposing again.`,
        outcomeUnknown: true,
      };
    const pr = outcome.result;
    if (pr.status === "unchanged")
      return {
        code: "unchanged",
        message: `AGENTS.md on ${pr.baseBranch} already has these entries; no pull request was needed.`,
      };
    return {
      code: pr.status === "existing" ? "pr-existing" : "pr-opened",
      message: `${pr.status === "existing" ? "The pull request was already open" : "Opened a pull request"} for the ## Orkestrator section of AGENTS.md: ${pr.url}`,
      ...(pr.url ? { url: pr.url } : {}),
    };
  }

  /** The section the approval dialog diffs against: the latest base on the owning node. */
  async previewAgentsMd(requestId: string): Promise<Record<string, unknown>> {
    const request = await this.actions.get(requestId);
    if (!request || request.kind !== "update-agents-md")
      throw new Error("That AGENTS.md request does not exist.");
    const [target] = request.targets;
    if (!target?.projectId) throw new Error("The request names no project.");
    const read = await this.onTargetNode<Record<string, unknown>>(
      target.nodeId,
      "read_project_agents_md_section",
      { projectId: target.projectId },
      `agents-md-preview:${requestId}`,
    );
    if (read.outcome !== "ok")
      throw new Error(`${target.nodeName} did not answer; try again when it is connected.`);
    return { ...read.result, nodeName: target.nodeName };
  }

  private async executeDeletion(request: NodeActionRequest) {
    const self = await this.options.nodes.selfIdentity();
    const done: string[] = [];
    for (const target of request.targets) {
      if (!target.environmentId) throw new Error("A deletion target names its environment.");
      if (target.nodeId === self) {
        await this.options.invoke("delete_environment", { environmentId: target.environmentId });
      } else {
        try {
          const routed = await this.options.portal.invokeOnNode({
            nodeId: target.nodeId,
            command: "delete_environment",
            args: { environmentId: target.environmentId },
            requestKey: `delete:${request.requestId}:${target.environmentId}`,
          });
          if (routed.outcome === "unknown") {
            return {
              code: "outcome-unknown",
              message: `${done.length ? `Already deleted ${done.join(", ")}. ` : ""}The connection to ${target.nodeName} was lost; check whether “${target.environmentName ?? target.environmentId}” was deleted.`,
              outcomeUnknown: true,
            };
          }
        } catch (error) {
          if (error instanceof NodeOutcomeUnknownError) {
            return {
              code: "outcome-unknown",
              message: `${done.length ? `Already deleted ${done.join(", ")}. ` : ""}${error.message}`,
              outcomeUnknown: true,
            };
          }
          throw error;
        }
      }
      done.push(`“${target.environmentName ?? target.environmentId}” on ${target.nodeName}`);
    }
    return { code: "deleted", message: `Deleted ${done.join(", ")}.` };
  }

  /**
   * Approved: apply the files the user picked (else the coordinator's
   * suggestion) from this node's checkout to a worker on this node.
   */
  private async executeRootChanges(request: NodeActionRequest, approval: NodeActionApproval) {
    const self = await this.options.nodes.selfIdentity();
    const [target] = request.targets;
    if (!target?.environmentId || !target.projectId || request.targets.length !== 1) {
      throw new Error("The request names one worker environment.");
    }
    if (target.nodeId !== self) throw new Error("Only a worker on this node can receive changes.");
    const paths = approval.paths ?? target.files ?? [];
    const applied = await this.options.invoke<{ files: string[] }>("apply_project_root_changes", {
      projectId: target.projectId,
      environmentId: target.environmentId,
      paths,
    });
    const count = applied.files.length;
    return {
      code: "applied",
      message: `Applied ${count} file${count === 1 ? "" : "s"} to “${target.environmentName ?? target.environmentId}”: ${applied.files.slice(0, 20).join(", ")}${count > 20 ? ", …" : ""}.`,
    };
  }

  /**
   * Approved: answer the worker's question with the answer the user settled
   * on (else the coordinator's proposal), where the worker lives. The node
   * that owns it re-reads the question and answers only the revision the
   * request named; a question that went away settles the request `stale`.
   * A lost answer from a node is never resent: the request settles
   * outcome-unknown and the coordinator is told to look at the tab.
   */
  private async executeWorkerAnswer(request: NodeActionRequest, approval: NodeActionApproval) {
    const [target] = request.targets;
    const relay = request.workerQuestion;
    if (!target?.environmentId || !target.projectId || request.targets.length !== 1 || !relay)
      throw new Error("The request names one worker question.");
    const answers = approval.answers ?? relay.proposed;
    // Malformed or incomplete answers never reach the worker.
    const problem = workerQuestionAnswerProblem(relay.questions, answers);
    if (problem) throw new Error(`${problem} Nothing was sent.`);
    const edited = JSON.stringify(answers) !== JSON.stringify(relay.proposed);
    const self = await this.options.nodes.selfIdentity();
    const local = target.nodeId === self;
    const where = `${relay.tabName ? `tab “${relay.tabName}” of ` : ""}“${target.environmentName ?? target.environmentId}”${local ? "" : ` on ${target.nodeName}`}`;
    const args = {
      projectId: target.projectId,
      environmentId: target.environmentId,
      tabId: relay.tabId,
      interactionId: relay.interactionId,
      revision: relay.revision,
      answers,
    };
    let outcome: { result?: unknown; reason?: unknown };
    if (local) {
      outcome = await this.options.invoke<typeof outcome>("answer_project_worker_question", args);
    } else {
      const lost = {
        code: "outcome-unknown",
        message: `The connection to ${target.nodeName} was lost while it answered the question in ${where}. It was not resent; check the worker's tab.`,
        outcomeUnknown: true,
      };
      try {
        const routed = await this.options.portal.invokeOnNode({
          nodeId: target.nodeId,
          command: "answer_controller_worker_question",
          args,
          requestKey: `worker-answer:${request.requestId}`,
        });
        if (routed.outcome !== "ok") return lost;
        outcome = (routed.result ?? {}) as typeof outcome;
      } catch (error) {
        if (error instanceof NodeOutcomeUnknownError) return lost;
        if (error instanceof NodeUnavailableError)
          throw new Error(`${target.nodeName} is not connected; nothing was sent.`);
        if (incompatibility(error, "answer_controller_worker_question")?.code === "unknown-command")
          throw new Error(
            `${target.nodeName} runs an older Orkestrator that cannot relay answers; update it. Nothing was sent.`,
          );
        throw error;
      }
    }
    if (outcome.result === "stale")
      return {
        code: "stale",
        stale: true,
        message: `${typeof outcome.reason === "string" ? outcome.reason.slice(0, 200) : "The question was no longer waiting."} Nothing was sent to ${where}.`,
      };
    if (outcome.result !== "answered") throw new Error("The worker's node gave no answer outcome.");
    return {
      code: "answered",
      message: `Answered the question in ${where} with ${edited ? "the answer as the user edited it" : "the coordinator's proposed answer"}.`,
    };
  }

  /**
   * Approved: send the held coordinator message to this node's project home,
   * through the same delivery as an ordinary coordinator message
   * (`send_approved_project_home_message`, which coordinators cannot call).
   */
  private async executeProjectHomeMessage(request: NodeActionRequest) {
    const outcome = await this.options.invoke<{ result?: unknown; reason?: unknown }>(
      "send_approved_project_home_message",
      { approvalRequestId: request.requestId },
    );
    const where = `“${request.targets[0]?.environmentName ?? request.targets[0]?.environmentId ?? "the project home"}”`;
    if (outcome?.result === "stale")
      return {
        code: "stale",
        stale: true,
        message: `${typeof outcome.reason === "string" ? outcome.reason.slice(0, 200) : "The project home is gone."} Nothing was sent.`,
      };
    if (outcome?.result !== "sent") throw new Error("The message gave no send outcome.");
    return {
      code: "sent",
      message: `Sent the coordinator's message to the project home ${where}.`,
    };
  }

  /**
   * Approved: copy the coordinator's project (this node's copy) to each
   * target, with the location and files the user settled on while approving.
   * The copy runs in the background; its outcome is mailed when it ends.
   */
  private async executeCreateProject(
    request: NodeActionRequest,
    approval: NodeActionApproval,
  ): Promise<{ code: string; message: string }> {
    const self = await this.options.nodes.selfIdentity();
    const started: string[] = [];
    for (const target of request.targets) {
      const record = await this.copies.start({
        requestKey: `node-action:${request.requestId}:${target.nodeId}`,
        source: { nodeId: self, projectId: request.requestedBy.projectId },
        target: {
          nodeId: target.nodeId,
          ...((approval.location ?? target.location)
            ? { location: approval.location ?? target.location }
            : {}),
        },
        paths: approval.paths ?? target.files ?? [],
        rememberFiles: approval.rememberFiles ?? false,
        actionRequestId: request.requestId,
      });
      started.push(
        `${record.source.projectName} to ${record.target.nodeName}${record.target.location ? ` at ${record.target.location}` : ""}`,
      );
    }
    return {
      code: "copying",
      message: `Started copying ${started.join(", ")}. You will get a message when it finishes.`,
    };
  }

  private async notifyCopyFinished(record: ProjectCopyRecord): Promise<void> {
    const request = await this.actions.get(record.actionRequestId!).catch(() => null);
    if (!request) return;
    const done = record.stage === "completed";
    const what = `${record.source.projectName} to ${record.target.nodeName}${record.target.location ? ` at ${record.target.location}` : ""}`;
    await this.options.storage
      .sendAgentMail(
        // A system notice in the coordinator's own project, so it wakes the
        // conversation that asked rather than waiting unread.
        {
          kind: "system",
          projectId: request.requestedBy.projectId,
          source: "workflow",
          resourceId: `node-copy:${record.copyId}`,
        },
        {
          requestId: `node-copy:${record.copyId}:${record.stage}:${record.finishedAt ?? ""}`.slice(
            0,
            256,
          ),
          toEnvironmentId: request.requestedBy.coordinatorEnvironmentId,
          toTabId: request.requestedBy.coordinatorTabId,
          subject: `Project copy ${done ? "finished" : "failed"}: ${what}`.slice(0, 200),
          body: done
            ? `Copied ${what}: ${record.progress.files - (record.progress.existing ?? 0)} file(s) besides the clone${record.tooLarge.length ? `; ${record.tooLarge.length} file(s) over 64 MiB were not copied` : ""}. Its environments can now be launched there with nodeId ${record.target.nodeId}.`
            : `Copying ${what} failed: ${record.error?.message ?? "unknown error"}`,
        },
      )
      .catch((error: unknown) => {
        log.warn("project-copy.notify-failed", {
          error: formatLogError(error, { message: false }),
        });
      });
  }

  private async notifyRequester(request: NodeActionRequest): Promise<void> {
    await this.options.storage.sendAgentMail(
      // The coordinator asked and was told it would hear back: a system notice
      // in its project wakes it, where external mail would wait unread.
      {
        kind: "system",
        projectId: request.requestedBy.projectId,
        source: "workflow",
        resourceId: `node-action:${request.requestId}`,
      },
      {
        requestId: `node-action:${request.requestId}:${request.state}`,
        toEnvironmentId: request.requestedBy.coordinatorEnvironmentId,
        toTabId: request.requestedBy.coordinatorTabId,
        subject: `Request ${request.state}: ${describeNodeAction(request)}`.slice(0, 200),
        body: `${describeNodeAction(request)}: ${request.state}. ${request.result?.message ?? ""}${requesterFollowUp(request)}`.trim(),
      },
    );
  }
}

/** What the requesting coordinator does next, by kind and outcome. */
function requesterFollowUp(request: NodeActionRequest): string {
  if (request.kind === "update-agents-md" && request.state === "rejected")
    return " Do not propose these AGENTS.md entries again in this conversation unless the user asks.";
  if (request.kind === "answer-worker-question" && request.state === "rejected")
    return " The question is still waiting in the worker's tab for the user; do not propose the same answer again unless the user asks.";
  if (request.kind === "answer-worker-question" && request.state === "executed")
    return " Its delegation still wakes you when the worker's turn ends.";
  // Nothing resumes a tab a limit stopped but a new prompt.
  if (request.kind === "switch-agent-account" && request.state === "executed")
    return " Now resume the tabs that stopped on that provider's usage limit: call get_usage_limits (with that machine's nodeId if the switch was on another machine) and send each listed tab of that provider one short prompt with send_prompt_to_tab, for example 'continue'. Only those tabs; a busy tab was already resumed.";
  if (request.kind === "message-project-home" && request.state === "executed")
    return " For the next 3 hours your messages to the project home are sent without approval, but working there is still discouraged: prefer an isolated environment.";
  if (request.kind === "message-project-home")
    return " The message was not sent. Do the work in an isolated environment instead (start_build_pipeline or launch_environment), or ask the user.";
  return "";
}

function agentsMdPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("An AGENTS.md request carries its proposed changes.");
  return (value as Record<string, unknown>).changes;
}
