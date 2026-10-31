import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import type { CoordinatorRemoteAccess } from "./coordinator-remote.js";
import type { CoordinatorStatus } from "./coordinator-status-wakes.js";
import type { StorageService } from "./storage.js";

/** Read failure is never evidence that a launch finished. Pending dispatches
 * also outlive the start grace when the provider is slow or queued.
 */
export async function prAttemptActivity(
  storage: StorageService,
  remote: CoordinatorRemoteAccess | null | undefined,
  workerActivity:
    ((environmentId: string, tabId: string) => Promise<AgentActivityState | "unknown">) | undefined,
  association: CoordinatorWorkflowAssociation,
  tabId: string,
): Promise<AgentActivityState | "unknown" | "unavailable" | "pending"> {
  try {
    if (association.nodeId) {
      if (!remote) return "unavailable";
      const state = await remote.workerState(association.nodeId, association.resourceId, tabId);
      if (state === "unavailable") return state;
      if (state.requestPending || state.environment === "creating") return "pending";
      return state.tab === "stopped" ? "unknown" : state.tab;
    }
    if (await storage.hasUndeliveredCoordinatorRequest(association.resourceId, tabId))
      return "pending";
    const session = (await storage.listNativeAgentSessions()).find(
      (item) =>
        item.environmentId === association.resourceId &&
        item.logicalSessionKey === `env-${association.resourceId}:${tabId}`,
    );
    if (session?.pendingDispatch) return "pending";
    return (await workerActivity?.(association.resourceId, tabId)) ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Settle one publication attempt; delivery retries use the association's stable key. */
export async function observePublicationAttempt(
  storage: StorageService,
  remote: CoordinatorRemoteAccess | null | undefined,
  workerActivity: Parameters<typeof prAttemptActivity>[2],
  association: CoordinatorWorkflowAssociation,
  now: number,
  grace: number,
  report: () => Promise<boolean>,
): Promise<void> {
  const attempt = association.pullRequest?.publication;
  if (!attempt) return;
  const activity = await prAttemptActivity(
    storage,
    remote,
    workerActivity,
    association,
    attempt.tabId,
  );
  if (activity === "pending" || activity === "unavailable") return;
  if (activity === "working" || activity === "waiting") {
    if (!attempt.seenWorkingAt)
      await storage.coordinators.updateCoordinatorWorkflowAssociation(association.id, (current) => {
        if (!current.pullRequest?.publication || current.pullRequest.publication.seenWorkingAt)
          return false;
        current.pullRequest.publication.seenWorkingAt = new Date(now).toISOString();
        return true;
      });
    return;
  }
  if (!attempt.seenWorkingAt && !(now - Date.parse(attempt.requestedAt) >= grace)) return;
  if (await report()) await storage.coordinators.markCoordinatorWorkflowNotified(association.id, 0);
}

export function publicationFailedStatus(environmentId: string, tabId: string): CoordinatorStatus {
  return {
    key: `pr-no-url:${tabId}`,
    state: "pr-not-created",
    tone: "failure",
    terminal: true,
    headline: "PR tab finished without opening a pull request",
    details: [
      "The PR attempt ended without a PR URL. Read its transcript, fix the problem, and retry create_pr with a new requestId.",
    ],
    tools: [`get_tab_transcript { "environmentId": "${environmentId}", "tabId": "${tabId}" }`],
    mode: "settled",
  };
}

export async function updateResolve(
  storage: StorageService,
  associationId: string,
  tabId: string,
  patch: { seenWorkingAt?: string; finishedAt?: string },
): Promise<void> {
  await storage.coordinators.updateCoordinatorWorkflowAssociation(associationId, (current) => {
    const latest = current.pullRequest?.resolve;
    if (!current.pullRequest || latest?.tabId !== tabId || latest.notifiedAt) return false;
    if (
      (!patch.seenWorkingAt || latest.seenWorkingAt === patch.seenWorkingAt) &&
      latest.finishedAt === patch.finishedAt
    )
      return false;
    current.pullRequest = { ...current.pullRequest, resolve: { ...latest, ...patch } };
    return true;
  });
}
