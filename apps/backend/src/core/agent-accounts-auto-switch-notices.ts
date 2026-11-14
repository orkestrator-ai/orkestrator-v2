import {
  AGENT_ACCOUNT_AUTO_SWITCHED_EVENT,
  autoSwitchNoticeText,
  isAgentAccountAutoSwitchedEvent,
  type AgentAccountAutoSwitchedEvent,
} from "@orkestrator/protocol/agent-account-auto-switch";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import { noticeText } from "@orkestrator/protocol/coordinator-notices";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { StorageService } from "./storage.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("agent-accounts");

/**
 * An older machine this one controls moved by itself: tell this node's
 * coordinators. A link that is down when it happens loses the notice; the
 * machine's own `lastSwitch` still records it. A machine that takes
 * `coordinator-notices` sends its notice through the outbox instead, which
 * keeps it across a link drop, so its event is ignored here.
 */
export function bridgeRemoteAutoSwitchNotices(input: {
  onNodeEvent(listener: (event: string, payload: unknown, nodeId: string) => void): () => void;
  nodeName(nodeId: string): Promise<string>;
  mail(event: AgentAccountAutoSwitchedEvent, machineName: string): Promise<void>;
  /** Whether that machine's notices arrive through its outbox. */
  sendsThroughOutbox?(nodeId: string): boolean;
}): () => void {
  return input.onNodeEvent((event, payload, nodeId) => {
    if (event !== AGENT_ACCOUNT_AUTO_SWITCHED_EVENT) return;
    if (!isAgentAccountAutoSwitchedEvent(payload)) return;
    if (input.sendsThroughOutbox?.(nodeId)) return;
    compatibilityPathUsage.record("coordinator-notices.older-leaf");
    void input
      .nodeName(nodeId)
      .catch(() => nodeId)
      .then((machineName) => input.mail(payload, machineName))
      .catch(() => {
        log.warn("switch-notice.failed", { audience: "other-machine" });
      });
  });
}

/**
 * Tell the open main coordinators on this node about an automatic switch, as a
 * workflow notice through the mail store. It belongs to no repository, so it
 * starts no coordinator (`CoordinatorNoticeRouter`), and the switch never waits on
 * one. Mail that is turned off or refused for one coordinator does not stop the
 * others hearing, unless `requireDelivery` asks for a failure to be raised so the
 * sender can try again.
 */
export async function mailAutoSwitchNotice(
  storage: Pick<StorageService, "sendAgentMail"> & {
    coordinators: Pick<StorageService["coordinators"], "getCoordinatorReconciliationState">;
  },
  event: AgentAccountAutoSwitchedEvent,
  machineName: string,
  options: {
    /** On a leaf, whether this project's coordinator is the one that hears it. */
    hearsHere?(projectId: string): Promise<boolean>;
    /** The coordinator this move was made for. */
    quietProjectId?: string;
    /** Let notices about one limit, such as this and its stop, land as one wake. */
    coalesceMs?: number;
    requireDelivery?: boolean;
  } = {},
): Promise<void> {
  const { workspaces } = await storage.coordinators.getCoordinatorReconciliationState();
  const platformLabel = AGENT_PLATFORM_LABELS[event.platform];
  const { subject, body } = autoSwitchNoticeText({
    platformLabel,
    machineName,
    from: event.from,
    to: event.to,
    reason: event.reason,
  });
  // The transcript draws this as one line from these facts, and it rides in
  // the coordinator's next batch instead of starting a turn that only
  // acknowledges it.
  const notice: AgentMailNotice = {
    resource: {
      kind: "account-switch",
      id: event.platform,
      label: noticeText(machineName, 120) ?? "this machine",
    },
    accountSwitch: {
      provider: platformLabel,
      from: noticeText(event.from, 120) ?? "another account",
      to: noticeText(event.to, 120) ?? "another account",
    },
    state: "account-switched",
    tone: "info",
  };
  await Promise.all(
    workspaces.map(async (workspace) => {
      const main = coordinatorMainConversation(workspace);
      if (!main || workspace.projectId === options.quietProjectId) return;
      if (options.hearsHere && !(await options.hearsHere(workspace.projectId))) return;
      await storage
        .sendAgentMail(
          {
            kind: "system",
            projectId: workspace.projectId,
            source: "workflow",
            resourceId: `account-auto-switch:${event.platform}`,
          },
          {
            requestId:
              `account-auto-switch:${main.id}:${machineName}:${event.platform}:${event.at}`.slice(
                0,
                200,
              ),
            toEnvironmentId: coordinatorRuntimeId(workspace.id, main.id),
            toTabId: main.tabId,
            subject,
            body,
          },
          {
            notice,
            rideAlong: true,
            ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
          },
        )
        .catch((error: unknown) => {
          log.warn("switch-notice.failed", { audience: "coordinator" });
          if (options.requireDelivery) throw error;
        });
    }),
  );
}
