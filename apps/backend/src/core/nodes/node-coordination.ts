import { randomUUID } from "node:crypto";

import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

import type { StorageService } from "../storage.js";
import {
  describeNodeAction,
  NodeActionRequests,
  type NodeActionKind,
  type NodeActionRequest,
  type NodeActionTarget,
} from "./node-action-requests.js";
import { NodeOutcomeUnknownError } from "./node-link.js";
import { NodeMailCollector } from "./node-mail-collector.js";
import {
  describeCoordinatorMail,
  emptyNodeMailState,
  LeafNodeMail,
  type CoordinatorMailbox,
  type NodeMailState,
  type NodeMailStore,
} from "./node-mail.js";
import { NodeFiles } from "./node-files.js";
import type { NodePortal } from "./node-portal.js";
import { NodeProjectFiles } from "./node-project-files.js";
import type { NodeService } from "./node-service.js";

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
    threads: root.threads && typeof root.threads === "object" ? root.threads : {},
    outbox: root.outbox && typeof root.outbox === "object" ? root.outbox : {},
  };
}

export class NodeCoordination {
  readonly leafMail: LeafNodeMail;
  readonly collector: NodeMailCollector;
  readonly actions: NodeActionRequests;
  readonly files: NodeFiles;
  readonly projectFiles: NodeProjectFiles;

  constructor(
    private readonly options: {
      storage: StorageService;
      nodes: NodeService;
      portal: NodePortal;
      /** This backend's own commands (local deletions, coordinator lookup). */
      invoke: Invoke;
      emit: (event: string, payload: unknown) => void;
    },
  ) {
    const { storage, nodes, portal } = options;
    const mailStore: NodeMailStore = {
      load: async () => parseMailState(await storage.loadNodeMail()),
      mutate: (mutate) =>
        storage.mutateNodeMail((current) => {
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
          })),
        mostRecentControllerId: () => nodes.mostRecentControllerId(),
      },
      options.emit,
    );
    storage.nodeMailRouter = {
      route: (input) => this.leafMail.route(input),
      enqueue: async (destination, item) => {
        const environment = await storage.getEnvironment(item.fromEnvironmentId).catch(() => null);
        const project = environment
          ? await storage.getProject(environment.projectId).catch(() => null)
          : null;
        const hint = repositoryHint(project?.gitUrl);
        const mailbox = destination as Partial<CoordinatorMailbox>;
        return this.leafMail.enqueue(destination.controllerId as BackendId, {
          ...item,
          ...(environment?.name ? { fromEnvironmentName: environment.name } : {}),
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
    });
    portal.readModel.onNodeEvent((event, payload, nodeId) =>
      this.collector.handleNodeEvent(event, payload, nodeId),
    );
    // Every (re)connect collects whatever waited while the link was down.
    let connected = new Set<string>();
    nodes.subscribe(() => {
      void nodes
        .listNodes()
        .then((list) => {
          const now = new Set(
            list.nodes
              .filter((node) => node.connection.state === "connected")
              .map((node) => node.nodeId),
          );
          for (const nodeId of now) if (!connected.has(nodeId)) void this.collector.collect(nodeId);
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
    portal.afterRouted = async (nodeId, command, args, result) => {
      if (command !== "create_environment" || typeof args.projectId !== "string") return;
      const environmentId = (result as { id?: unknown } | null)?.id;
      if (typeof environmentId !== "string") return;
      await this.projectFiles.seedEnvironment(nodeId, args.projectId, environmentId);
    };
    this.actions = new NodeActionRequests({
      load: () => storage.loadNodeActionRequests(),
      save: (requests) => storage.saveNodeActionRequests(requests),
      emit: options.emit,
      executors: {
        "delete-environment": (request) => this.executeDeletion(request),
        "update-project-files": (request) => this.projectFiles.executeUpdate(request),
        "reveal-env-value": (request) => this.projectFiles.executeReveal(request),
        "create-project": (request) => this.projectFiles.executeCreateProject(request),
      },
      notify: (request) => this.notifyRequester(request),
    });
  }

  /*
   * Leaf side
   */

  /** Mail from a command node's coordinator to an agent on this node. */
  async deliverIncoming(args: Record<string, unknown>): Promise<{ messageId: string }> {
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
    const message = await this.options.storage.sendAgentMail(
      { kind: "external" },
      {
        requestId: `node:${controllerId}:${requestId}`.slice(0, 256),
        toEnvironmentId,
        toTabId: typeof args.toTabId === "string" ? args.toTabId : "",
        ...(typeof args.subject === "string" ? { subject: args.subject.slice(0, 200) } : {}),
        body: describeCoordinatorMail(body, controller.displayName),
      },
    );
    await this.leafMail.recordThread(message.id, mailbox);
    // An environment the coordinator talks to reports back to it.
    const state = await this.options.storage.loadNodeMail();
    if (!parseMailState(state).origins[toEnvironmentId]) {
      await this.leafMail.recordOrigin(toEnvironmentId, mailbox);
    }
    return { messageId: message.id };
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
    requestId: string;
  }): Promise<void> {
    const storage = this.options.storage;
    let address = input.toCoordinator;
    if (address) {
      const workspaces = await storage.listCoordinatorWorkspaces();
      const valid = workspaces.some((workspace) =>
        workspace.conversations.some(
          (conversation) =>
            coordinatorRuntimeId(workspace.id, conversation.id) === address!.environmentId &&
            conversation.tabId === address!.tabId,
        ),
      );
      if (!valid)
        throw Object.assign(new Error("That destination is not a coordinator conversation."), {
          code: "no-coordinator",
        });
    }
    if (!address) {
      const projects = await storage.loadProjects();
      const project = projects.find(
        (candidate) =>
          input.repositoryHint && repositoryHint(candidate.gitUrl) === input.repositoryHint,
      );
      const workspace = project
        ? (await storage.listCoordinatorWorkspaces()).find(
            (entry) => entry.projectId === project.id,
          )
        : undefined;
      const main = workspace ? coordinatorMainConversation(workspace) : null;
      if (!workspace || !main) {
        throw Object.assign(new Error("No open coordinator for that project on this node."), {
          code: "no-coordinator",
        });
      }
      address = { environmentId: coordinatorRuntimeId(workspace.id, main.id), tabId: main.tabId };
    }
    await storage.sendAgentMail(
      { kind: "external" },
      {
        requestId: input.requestId,
        toEnvironmentId: address.environmentId,
        toTabId: address.tabId,
        ...(input.subject ? { subject: input.subject } : {}),
        body: input.body,
      },
    );
  }

  async createActionRequest(args: Record<string, unknown>): Promise<NodeActionRequest> {
    const kind = args.kind as NodeActionKind;
    if (
      ![
        "delete-environment",
        "create-project",
        "update-project-files",
        "reveal-env-value",
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
    return this.actions.create({
      kind,
      targets,
      requestedBy: {
        coordinatorEnvironmentId: by.coordinatorEnvironmentId,
        coordinatorTabId: by.coordinatorTabId,
        projectId: by.projectId,
      },
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    });
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

  private async notifyRequester(request: NodeActionRequest): Promise<void> {
    await this.options.storage.sendAgentMail(
      { kind: "external" },
      {
        requestId: `node-action:${request.requestId}:${request.state}`,
        toEnvironmentId: request.requestedBy.coordinatorEnvironmentId,
        toTabId: request.requestedBy.coordinatorTabId,
        subject: `Request ${request.state}: ${describeNodeAction(request)}`.slice(0, 200),
        body: `${describeNodeAction(request)}: ${request.state}. ${request.result?.message ?? ""}`.trim(),
      },
    );
  }
}
