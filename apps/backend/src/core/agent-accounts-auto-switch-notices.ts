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
import type { StorageService } from "./storage.js";

/**
 * A machine this one controls moved by itself: tell this node's coordinators,
 * which are the ones a user of that machine works with. A link that is down when
 * it happens loses the notice; the machine's own `lastSwitch` still records it.
 */
export function bridgeRemoteAutoSwitchNotices(input: {
  onNodeEvent(listener: (event: string, payload: unknown, nodeId: string) => void): () => void;
  nodeName(nodeId: string): Promise<string>;
  mail(event: AgentAccountAutoSwitchedEvent, machineName: string): Promise<void>;
}): () => void {
  return input.onNodeEvent((event, payload, nodeId) => {
    if (event !== AGENT_ACCOUNT_AUTO_SWITCHED_EVENT) return;
    if (!isAgentAccountAutoSwitchedEvent(payload)) return;
    void input
      .nodeName(nodeId)
      .catch(() => nodeId)
      .then((machineName) => input.mail(payload, machineName))
      .catch(() => {
        console.warn("[agent-accounts] Another machine's automatic switch notice failed");
      });
  });
}

/**
 * Tell every main coordinator on this node about an automatic switch, as a
 * workflow notice through the mail store. Like other status notices it does not
 * start a coordinator, and the switch never waits on one. Mail that is turned off
 * or refused for one coordinator does not stop the others hearing.
 */
export async function mailAutoSwitchNotice(
  storage: Pick<StorageService, "sendAgentMail"> & {
    coordinators: Pick<StorageService["coordinators"], "getCoordinatorReconciliationState">;
  },
  event: AgentAccountAutoSwitchedEvent,
  machineName: string,
): Promise<void> {
  const { workspaces } = await storage.coordinators.getCoordinatorReconciliationState();
  const { subject, body } = autoSwitchNoticeText({
    platformLabel: AGENT_PLATFORM_LABELS[event.platform],
    machineName,
    from: event.from,
    to: event.to,
    reason: event.reason,
  });
  await Promise.all(
    workspaces.map(async (workspace) => {
      const main = coordinatorMainConversation(workspace);
      if (!main) return;
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
        )
        .catch(() => {
          console.warn("[agent-accounts] A coordinator's automatic switch notice failed");
        });
    }),
  );
}
