import { useCallback, useSyncExternalStore } from "react";
import {
  getPromptQueueDispatchError,
  promptQueueKey,
  subscribePromptQueueDispatchErrors,
} from "@/lib/prompt-queue-persistence";
import { retryAgentPromptQueueDispatch } from "@/lib/prompt-queue-sources";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

export function usePromptQueueDispatchRecovery(agent: string, sessionKey: string) {
  // The queue's node: the tab's (plan item 4007).
  const scope = useScopesWithCommandFallback().scope;
  const queueKey = promptQueueKey(agent, sessionKey);
  const dispatchError = useSyncExternalStore(
    subscribePromptQueueDispatchErrors,
    () => getPromptQueueDispatchError(queueKey),
    () => undefined,
  );
  const retry = useCallback(
    () => retryAgentPromptQueueDispatch(agent, sessionKey, scope),
    [agent, sessionKey, scope],
  );
  return { dispatchError, retry };
}
