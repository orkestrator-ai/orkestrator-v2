import { randomUUID } from "node:crypto";

import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { parseAgentsMdChanges } from "@orkestrator/protocol/agents-md-orkestrator";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

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
import { NodeOutcomeUnknownError } from "./node-link.js";
import { NodeMailCollector } from "./node-mail-collector.js";
import {
  describeCoordinatorMail,
  emptyNodeMailState,
  LeafNodeMail,
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
  };
}

/**
 * When a coordinator on this backend last contacted a local environment's tab:
 * launched or delegated to the environment, or mailed the tab. Associations
 * with a `nodeId` are for environments on other nodes and never count.
 */
export async function localCoordinatorContact(
  storage: StorageService,
  environmentId: string,
  tabId?: string,
): Promise<LocalCoordinatorContact> {
  const environment = await storage.getEnvironment(environmentId).catch(() => null);
  const [associations, workspace, mailbox] = await Promise.all([
    environment
      ? storage.coordinators
          .listCoordinatorWorkflowAssociations(environment.projectId)
          .catch(() => [])
      : [],
    environment
      ? storage.coordinators.getCoordinatorWorkspace(environment.projectId).catch(() => null)
      : null,
    tabId
      ? storage.getAgentMailMailbox(environmentId, tabId, { limit: 200 }).catch(() => null)
      : null,
  ]);
  let at: string | undefined;
  const consider = (value: string | undefined) => {
    if (value && (!at || value > at)) at = value;
  };
  for (const association of associations) {
    if (
      association.kind !== "environment" ||
      association.resourceId !== environmentId ||
      association.nodeId ||
      association.pending
    ) {
      continue;
    }
    if (association.baseCommit) consider(association.createdAt);
    consider(association.delegation?.requestedAt);
  }
  for (const message of mailbox?.messages ?? []) {
    if (message.from.kind === "coordinator") consider(message.createdAt);
  }
  return { ...(at ? { at } : {}), hasCoordinator: Boolean(workspace) };
}

export class NodeCoordination {
  readonly leafMail: LeafNodeMail;
  readonly collector: NodeMailCollector;
  readonly actions: NodeActionRequests;
  readonly files: NodeFiles;
  readonly projectFiles: NodeProjectFiles;
  readonly copies: NodeProjectCopies;

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
          })),
        mostRecentControllerId: () => nodes.mostRecentControllerId(),
        localCoordinatorContact: (environmentId, tabId) =>
          localCoordinatorContact(storage, environmentId, tabId),
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
        "update-agents-md": (request, approval) => this.executeAgentsMdUpdate(request, approval),
      },
      notify: (request) => this.notifyRequester(request),
    });
  }

  /*
   * Leaf side
   */

  /** Mail from a command node's coordinator to an agent on this node. */
  async deliverIncoming(
    args: Record<string, unknown>,
  ): Promise<{ messageId: string; toTabId: string; placement: string }> {
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
    const environment = await this.options.storage.getEnvironment(toEnvironmentId);
    if (!environment) throw new Error("That environment does not exist on this node.");
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
      },
      {
        requestId: `node:${controllerId}:${requestId}`.slice(0, 256),
        toEnvironmentId,
        toTabId: typeof args.toTabId === "string" ? args.toTabId : "",
        ...(typeof args.subject === "string" ? { subject: args.subject.slice(0, 200) } : {}),
        body: describeCoordinatorMail(body, controller.displayName),
      },
      { newDelegation: true },
    );
    await this.leafMail.recordThread(message.id, mailbox);
    // An environment the coordinator talks to reports back to it, until
    // another coordinator contacts it.
    await this.leafMail.recordOrigin(toEnvironmentId, mailbox, { keepOrigin: true });
    return { messageId: message.id, toTabId: message.toTabId, placement: message.placement };
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
    /** A leaf agent; absent for this node's own notices. */
    from?: {
      nodeId: string;
      nodeName: string;
      environmentId: string;
      tabId: string;
      environmentName?: string;
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
      if (!workspace || !main) {
        throw Object.assign(new Error("No open coordinator for that project on this node."), {
          code: "no-coordinator",
        });
      }
      address = { environmentId: coordinatorRuntimeId(workspace.id, main.id), tabId: main.tabId };
      projectId = workspace.projectId;
    }
    // A worker on a node this one controls reports like a worker here: the
    // node link authenticates it, it wakes the coordinator, and while the
    // coordinator waits on that worker its report is held for the turn's end.
    await storage.sendAgentMail(
      input.from && projectId
        ? {
            kind: "node",
            nodeId: input.from.nodeId,
            nodeName: input.from.nodeName,
            role: "agent",
            projectId,
            environmentId: input.from.environmentId,
            tabId: input.from.tabId,
            title: input.from.environmentName ?? null,
          }
        : { kind: "external" },
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
        "apply-root-changes",
        "update-agents-md",
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
      ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
      kind,
      targets,
      requestedBy: {
        coordinatorEnvironmentId: by.coordinatorEnvironmentId,
        coordinatorTabId: by.coordinatorTabId,
        projectId: by.projectId,
      },
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
      ...(kind === "update-agents-md"
        ? { agentsMd: { changes: parseAgentsMdChanges(agentsMdPayload(args.agentsMd)) } }
        : {}),
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
  ): Promise<{ outcome: "ok"; result: T } | { outcome: "unknown" }> {
    if (nodeId === (await this.options.nodes.selfIdentity()))
      return { outcome: "ok", result: await this.options.invoke<T>(command, args) };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const routed = await this.options.portal.invokeOnNode({
          nodeId,
          command,
          args,
          requestKey: `${requestKey}:${attempt}`,
        });
        if (routed.outcome === "ok") return { outcome: "ok", result: routed.result as T };
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
        console.warn(
          "[nodes] Could not tell the coordinator a project copy finished:",
          error instanceof Error ? error.name : "unknown",
        );
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
        body: `${describeNodeAction(request)}: ${request.state}. ${request.result?.message ?? ""}`.trim(),
      },
    );
  }
}

function agentsMdPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("An AGENTS.md request carries its proposed changes.");
  return (value as Record<string, unknown>).changes;
}
