import { useCallback, useSyncExternalStore } from "react";
import {
  getPromptQueueDispatchError,
  promptQueueKey,
  subscribePromptQueueDispatchErrors,
} from "@/lib/prompt-queue-persistence";
import { retryAgentPromptQueueDispatch } from "@/lib/prompt-queue-sources";

export function usePromptQueueDispatchRecovery(
  agent: string,
  sessionKey: string,
) {
  const queueKey = promptQueueKey(agent, sessionKey);
  const dispatchError = useSyncExternalStore(
    subscribePromptQueueDispatchErrors,
    () => getPromptQueueDispatchError(queueKey),
    () => undefined,
  );
  const retry = useCallback(
    () => retryAgentPromptQueueDispatch(agent, sessionKey),
    [agent, sessionKey],
  );
  return { dispatchError, retry };
}
