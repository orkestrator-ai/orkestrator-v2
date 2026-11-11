import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import type { PersistedNativeAgentSession, PersistedPromptQueue } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { nativePromptQueueKey, nativeTabsOfLayout } from "./public-api/index.js";
import type { StorageService } from "./storage.js";

/**
 * Whether every open Resolve tab has finished its work, read from durable
 * state only (no provider call, no liveness touch).
 *
 * Auto-merge uses this to notice that the Resolve which holds the
 * environment's re-check token has ended, whoever started it: a manual press
 * records no request id the controller could match, and an automatic turn's
 * outcome can be recorded after the one completion edge that would have
 * matched it. Either way the token stayed armed and auto-merge waited forever.
 *
 * A Resolve tab is one whose job recorded the completion action, as in
 * `native-agent-job-tab-reuse.ts`. With no Resolve tab open nothing is
 * resolving, so the answer is `true`; the caller re-checks before acting, so a
 * launch caught between arming and opening its tab is not mistaken for a
 * finished one.
 */
export async function resolveTabsSettled(
  storage: Pick<StorageService, "getPaneLayout" | "getNativeAgentSession" | "getPromptQueue">,
  environmentId: string,
): Promise<boolean> {
  const tabs = nativeTabsOfLayout(await storage.getPaneLayout(environmentId)).filter(
    (tab) => tab.jobCompletionAction === "refresh-pr-after-agent-completion",
  );
  for (const tab of tabs) {
    const logicalSessionKey = nativeTabLogicalSessionKey(environmentId, tab.tabId);
    const [session, queue] = await Promise.all([
      storage.getNativeAgentSession(
        nativeAgentSessionStorageKey(environmentId, tab.agent, logicalSessionKey),
      ),
      storage.getPromptQueue(nativePromptQueueKey(tab.agent, logicalSessionKey)),
    ]);
    if (resolveConversationBusy(session, queue)) return false;
  }
  return true;
}

/**
 * Whether one conversation still has work in hand: a prompt waiting or being
 * dispatched, a dispatch whose admission is unconfirmed, or a latest turn that
 * has neither a recorded outcome nor a settled activity checkpoint.
 */
export function resolveConversationBusy(
  session: PersistedNativeAgentSession | null,
  queue: PersistedPromptQueue | null,
): boolean {
  if ((queue?.messages.length ?? 0) > 0 || queue?.outstandingClaim || queue?.inFlight) return true;
  if (session?.pendingDispatch || session?.pendingSteer) return true;
  const dispatched = session?.dispatchedRequestIds ?? [];
  if (
    queue?.jobReceipts?.some(
      (receipt) =>
        receipt.status === "unknown" &&
        !dispatched.includes(receipt.dispatchRequestId ?? receipt.requestId),
    )
  )
    return true;
  const latest = dispatched.at(-1);
  if (!session || !latest) return false;
  if (session.turnOutcomes?.some((outcome) => outcome.requestId === latest)) return false;
  return !(
    session.activityTurn?.state === "settled" &&
    session.activityTurn.providerSessionId === session.providerSessionId &&
    session.activityTurn.requestId === latest
  );
}
