import { COORDINATOR_MAIL_ADDRESS } from "@orkestrator/protocol/coordinator";
import type { AgentMailMessageSummary } from "@orkestrator/protocol/agent-mail";
import type { StorageService } from "./storage.js";

export function stoppedWorkerMailHook(
  storage: StorageService,
  start: (environmentId: string) => Promise<void>,
) {
  return async (environmentId: string, message: AgentMailMessageSummary): Promise<void> => {
    const environment = await storage.getEnvironment(environmentId);
    if (
      !environment ||
      environment.deletionRequestedAt ||
      environment.status !== "stopped" ||
      message.from.kind !== "coordinator"
    )
      return;
    const mailbox = await storage.getAgentMailMailbox(environmentId, message.toTabId);
    if (mailbox.descriptor.coordinatorOrigin !== message.from.environmentId) return;
    if (environment.environmentType === "local") {
      if (await storage.claimAgentMailWorkerStart(environmentId, message.id))
        await start(environmentId);
      return;
    }
    const hour = Math.floor(Date.now() / 3_600_000);
    await storage.sendAgentMail(
      {
        kind: "system",
        projectId: environment.projectId,
        source: "workflow",
        resourceId: environmentId,
      },
      {
        requestId: `worker-stopped:${environmentId}:${hour}`,
        toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
        toTabId: "",
        subject: "Worker container is stopped",
        body: `Mail for worker environment ${environmentId} is waiting, but its container is stopped. Start it with start_environment to deliver the queued mail, or ask the user.`,
      },
    );
  };
}
