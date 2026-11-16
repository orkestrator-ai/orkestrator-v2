import {
  autoSwitchNoticeText,
  type AgentAccountAutoSwitchedEvent,
} from "@orkestrator/protocol/agent-account-auto-switch";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  coordinatorMainConversation,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import { noticeText } from "@orkestrator/protocol/coordinator-notices";
import type { StorageService } from "./storage.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("agent-accounts");

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
