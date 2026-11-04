/**
 * Who hears a notice addressed to a repository's coordinator. Status, pull
 * request, automatic switch and usage-limit notices all come through here, so
 * there is one rule (`routeCoordinatorNotice`) and each notice reaches exactly
 * one coordinator. See docs/architecture/coordinator.md ("Who hears a notice").
 *
 * - On a leaf, a notice goes to the command node's main coordinator for that
 *   repository, through the leaf's outbox, so it survives a link drop and a
 *   restart. A command node without the repository hands it back.
 * - Otherwise it goes to this machine's main coordinator.
 * - With no main running, a new event starts one. A sweep of older state and a
 *   machine-wide notice never do: they would start a provider turn nobody asked
 *   for, and a machine-wide one would start one per project on every switch.
 *
 * Neither direction counts against a pair budget of the node link, and a
 * delegating coordinator's replies from its own worker do not come through here.
 */
import { createHash } from "node:crypto";
import type { AgentAccountAutoSwitchedEvent } from "@orkestrator/protocol/agent-account-auto-switch";
import {
  AgentMailError,
  normalizeAgentMessagingSettings,
  type AgentMailNotice,
} from "@orkestrator/protocol/agent-mail";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import {
  describeRelayedNotice,
  noticeText,
  parseUpwardCoordinatorNotice,
  type CoordinatorNoticeRoute,
  type UpwardCoordinatorNotice,
  type UsageLimitStop,
} from "@orkestrator/protocol/coordinator-notices";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { mailAutoSwitchNotice } from "./agent-accounts-auto-switch-notices.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { NodeCoordinatorNotices, OutboxItem } from "./nodes/index.js";
import type { StorageService } from "./storage.js";

const log = createLogger("coordinator");

export type CoordinatorNoticeStorage = Pick<
  StorageService,
  "sendAgentMail" | "getProject" | "loadProjects" | "loadConfig"
> & {
  coordinators: Pick<
    StorageService["coordinators"],
    "getCoordinatorWorkspace" | "getCoordinatorReconciliationState"
  >;
};

/** This node's outbox to its command node; absent until the node services exist. */
export interface CoordinatorNoticeOutbox {
  routeNotice(projectId: string | null): Promise<CoordinatorNoticeRoute>;
  queueNotice(
    controllerId: string,
    item: Omit<OutboxItem, "seq" | "createdAt" | "bytes" | "repositoryHint">,
  ): Promise<void>;
}

export interface RepositoryNotice {
  projectId: string;
  /** The coordinator the notice belongs to, when it was work one of them started. */
  coordinatorId?: string;
  /**
   * `delegator` keeps it with the coordinator waiting on that worker. Everything
   * else is addressed to the repository's coordinator, and the hierarchy decides.
   */
  audience?: "repository" | "delegator";
  /** True only for a new event; see the module comment. */
  createSession: boolean;
  resourceId: string;
  /** Fixed for one notice, and including the conversation it lands in. */
  requestId(mainConversationId: string): string;
  /** Fixed for one notice wherever it lands. */
  upwardRequestId: string;
  subject: string;
  body: string;
  notice?: AgentMailNotice;
  statusBudgetKey?: string;
  coalesceMs?: number;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export class CoordinatorNoticeRouter {
  private outbox: CoordinatorNoticeOutbox | null = null;
  private stopReceiver: ((stop: UsageLimitStop, projectId: string) => Promise<void>) | null = null;
  private stopTakeBack: ((stop: UsageLimitStop, projectId: string) => Promise<void>) | null = null;

  constructor(
    private readonly storage: CoordinatorNoticeStorage,
    /** Starts a main coordinator, and its workspace if the project has none. */
    private readonly startMain?: (
      projectId: string,
    ) => Promise<{ workspace: CoordinatorWorkspace; main: CoordinatorConversation }>,
  ) {}

  setOutbox(outbox: CoordinatorNoticeOutbox): void {
    this.outbox = outbox;
  }

  /** Where usage-limit stops land; `takeBack` is one a command node would not take. */
  setUsageLimitStops(handlers: {
    receive(stop: UsageLimitStop, projectId: string): Promise<void>;
    takeBack(stop: UsageLimitStop, projectId: string): Promise<void>;
  }): void {
    this.stopReceiver = (stop, projectId) => handlers.receive(stop, projectId);
    this.stopTakeBack = (stop, projectId) => handlers.takeBack(stop, projectId);
  }

  /** The one routing decision. A null project is a machine-wide notice. */
  async route(projectId: string | null): Promise<CoordinatorNoticeRoute> {
    const route: CoordinatorNoticeRoute = this.outbox
      ? await this.outbox.routeNotice(projectId)
      : { kind: "local", reason: "standalone" };
    if (route.kind === "local" && route.reason === "older-command-node") {
      compatibilityPathUsage.record("coordinator-notices.older-command-node");
    }
    return route;
  }

  /** Queue for the command node. False when its outbox is full: the notice stays on this node. */
  async sendUp(
    route: Extract<CoordinatorNoticeRoute, { kind: "command-node" }>,
    item: Omit<OutboxItem, "seq" | "createdAt" | "bytes" | "repositoryHint">,
  ): Promise<boolean> {
    try {
      await this.outbox!.queueNotice(route.controllerId, item);
      return true;
    } catch (error) {
      log.warn("notice.outbox-refused", { error: formatLogError(error, { message: false }) });
      return false;
    }
  }

  /** The main coordinator a notice lands on, started if this event may start one. */
  async mainFor(
    projectId: string,
    createSession: boolean,
    coordinatorId?: string,
  ): Promise<{ workspace: CoordinatorWorkspace; main: CoordinatorConversation } | null> {
    const workspace = await this.storage.coordinators.getCoordinatorWorkspace(projectId);
    if (workspace && coordinatorId && workspace.id !== coordinatorId) return null;
    const open = workspace ? coordinatorMainConversation(workspace) : undefined;
    const current = workspace && open ? { workspace, main: open } : null;
    if (open?.agent || !createSession || !this.startMain) return current;
    // Mail that is off would refuse the notice, so it must not cost a session first.
    const settings = normalizeAgentMessagingSettings(
      (await this.storage.loadConfig()).global.agentMessaging,
    );
    if (!settings.enabled) return current;
    try {
      return await this.startMain(projectId);
    } catch (error) {
      log.warn("notice.start-main-failed", { error: formatLogError(error, { message: false }) });
      throw error;
    }
  }

  /**
   * Deliver a notice about this repository. False means nothing took it: no main
   * is open and this event may not start one. A sweep sends the state again later.
   */
  async deliver(notice: RepositoryNotice): Promise<boolean> {
    if (notice.audience !== "delegator") {
      const route = await this.route(notice.projectId);
      if (
        route.kind === "command-node" &&
        (await this.sendUp(route, {
          requestId: notice.upwardRequestId.slice(0, 200),
          fromEnvironmentId: notice.resourceId,
          fromTabId: "notice",
          subject: notice.subject,
          body: notice.body,
          coordinatorNotice: {
            kind: "repository",
            createSession: notice.createSession,
            statusBudgetKey: notice.statusBudgetKey,
            coalesceMs: notice.coalesceMs,
          },
          noticeProjectId: notice.projectId,
        }))
      ) {
        return true;
      }
    }
    return this.deliverHere(notice);
  }

  private async deliverHere(notice: RepositoryNotice): Promise<boolean> {
    const target = await this.mainFor(notice.projectId, notice.createSession, notice.coordinatorId);
    if (!target) return false;
    try {
      await this.storage.sendAgentMail(
        {
          kind: "system",
          projectId: notice.projectId,
          source: "workflow",
          resourceId: notice.resourceId,
        },
        {
          requestId: notice.requestId(target.main.id),
          toEnvironmentId: coordinatorRuntimeId(target.workspace.id, target.main.id),
          toTabId: target.main.tabId,
          subject: notice.subject,
          body: notice.body,
        },
        {
          ...(notice.notice ? { notice: notice.notice } : {}),
          ...(notice.statusBudgetKey ? { statusBudgetKey: notice.statusBudgetKey } : {}),
          ...(notice.coalesceMs !== undefined ? { coalesceMs: notice.coalesceMs } : {}),
        },
      );
      return true;
    } catch (error) {
      // The same state was already placed under this request id with words
      // that have since changed (an excerpt, a timestamp): it was delivered.
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return true;
      throw error;
    }
  }

  /**
   * An automatic switch belongs to no repository, so it starts no session. On a
   * leaf the command node's open coordinators hear it once, and this machine's
   * only for repositories the command node lacks. A move made for one coordinator
   * skips that one, whose own notice already says so.
   */
  async deliverAutoSwitch(
    event: AgentAccountAutoSwitchedEvent,
    machineName: string,
    options: { quietProjectId?: string; coalesceMs?: number } = {},
  ): Promise<void> {
    const up = await this.route(null);
    if (up.kind === "command-node") {
      const queued = await this.sendUp(up, {
        requestId: `account-auto-switch:${event.platform}:${event.at}`.slice(0, 200),
        fromEnvironmentId: "machine",
        fromTabId: "notice",
        subject: `Automatic switch on ${machineName}`,
        body: `${event.platform} moved from ${event.from} to ${event.to}.`,
        coordinatorNotice: { kind: "auto-switch", event },
      });
      if (!queued) {
        await mailAutoSwitchNotice(this.storage, event, machineName, options);
        return;
      }
    }
    await mailAutoSwitchNotice(this.storage, event, machineName, {
      ...options,
      ...(up.kind === "command-node"
        ? {
            hearsHere: async (projectId: string) => (await this.route(projectId)).kind === "local",
          }
        : {}),
    });
  }

  /** The command node's side: a notice a leaf queued, collected over the node link. */
  readonly fromLeaf: NodeCoordinatorNotices = {
    deliverFromLeaf: (item, node) => this.deliverFromLeaf(item, node),
    takeBack: (item) => this.takeBack(item),
  };

  private async projectForHint(hint: string | undefined): Promise<string | null> {
    if (!hint) return null;
    const projects = await this.storage.loadProjects();
    return projects.find((project) => repositoryHint(project.gitUrl) === hint)?.id ?? null;
  }

  private async deliverFromLeaf(
    item: OutboxItem,
    node: { nodeId: string; name: string },
  ): Promise<"delivered" | "declined"> {
    const notice = parseUpwardCoordinatorNotice(item.coordinatorNotice);
    // Nothing a newer leaf sent is understood here, so its own coordinator takes it.
    if (!notice) return "declined";
    if (notice.kind === "auto-switch") {
      await mailAutoSwitchNotice(this.storage, notice.event, noticeText(node.name) ?? node.nodeId, {
        requireDelivery: true,
      });
      return "delivered";
    }
    const projectId = await this.projectForHint(item.repositoryHint);
    if (!projectId) return "declined";
    if (notice.kind === "usage-limit-stop") {
      if (!this.stopReceiver) throw new Error("Usage-limit notices are not ready.");
      await this.stopReceiver(
        {
          ...notice.stop,
          machine: noticeText(node.name) ?? notice.stop.machine,
          nodeId: node.nodeId,
        },
        projectId,
      );
      return "delivered";
    }
    await this.deliverRelayed(item, notice, node, projectId);
    return "delivered";
  }

  /**
   * A leaf's words reach this coordinator as an agent's mail, framed as untrusted,
   * without the pair budget that bounds an exchange between two agents.
   */
  private async deliverRelayed(
    item: OutboxItem,
    notice: Extract<UpwardCoordinatorNotice, { kind: "repository" }>,
    node: { nodeId: string; name: string },
    projectId: string,
  ): Promise<void> {
    const target = await this.mainFor(projectId, notice.createSession);
    // Older state with nobody to read it: it stays on the leaf until someone can.
    if (!target) throw new Error("No main coordinator is open for that notice yet.");
    try {
      await this.storage.sendAgentMail(
        {
          kind: "node",
          nodeId: node.nodeId,
          nodeName: node.name,
          role: "agent",
          projectId,
          environmentId: item.fromEnvironmentId,
          tabId: item.fromTabId,
          title: `Notice from ${noticeText(node.name) ?? node.nodeId}`,
        },
        {
          requestId: `node:${node.nodeId}:notice:${shortHash(item.requestId)}`,
          toEnvironmentId: coordinatorRuntimeId(target.workspace.id, target.main.id),
          toTabId: target.main.tabId,
          ...(item.subject ? { subject: item.subject } : {}),
          body: item.body,
        },
        {
          nodePrefix: describeRelayedNotice(node),
          relayedNotice: true,
          ...(notice.statusBudgetKey
            ? { statusBudgetKey: `node:${node.nodeId}:resource:${notice.statusBudgetKey}` }
            : {}),
          ...(notice.coalesceMs !== undefined ? { coalesceMs: notice.coalesceMs } : {}),
        },
      );
    } catch (error) {
      if (error instanceof AgentMailError && error.code === "idempotency-conflict") return;
      throw error;
    }
  }

  /** This node's coordinator takes a notice no command node will. */
  private async takeBack(item: OutboxItem): Promise<void> {
    const notice = parseUpwardCoordinatorNotice(item.coordinatorNotice);
    if (!notice) return;
    if (notice.kind === "auto-switch") {
      await mailAutoSwitchNotice(this.storage, notice.event, "this machine");
      return;
    }
    const projectId = item.noticeProjectId;
    if (!projectId) return;
    if (notice.kind === "usage-limit-stop") {
      await this.stopTakeBack?.(notice.stop, projectId);
      return;
    }
    const delivered = await this.deliverHere({
      projectId,
      createSession: notice.createSession,
      resourceId: item.fromEnvironmentId,
      statusBudgetKey: notice.statusBudgetKey,
      coalesceMs: notice.coalesceMs,
      requestId: () => `notice-back:${shortHash(item.requestId)}`,
      upwardRequestId: item.requestId,
      subject: item.subject ?? "Coordinator notice",
      body: item.body,
    });
    // Older state with no coordinator open: nothing here will ever read it.
    if (!delivered) log.warn("notice.take-back-unread", { projectId });
  }
}
