import { useCallback, useMemo, useState } from "react";
import {
  PROVIDER_FAILURE_RETRY_PROMPT,
  providerFailureRetryRequestId,
} from "@orkestrator/protocol/provider-failures";
import type { ProviderFailureActions } from "@/components/chat/provider-failure-actions";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { actionableProviderFailureId } from "@/lib/provider-failure";

export interface ProviderFailureRecoveryInput {
  /** The rows the transcript shows, in order. */
  messages: readonly Pick<NativeMessage, "id" | "parts" | "role">[];
  /**
   * Sends a prepared, literal prompt under a stable request id and refuses to
   * queue it (`AgentNativeTab`'s `submit`): every guard a typed prompt passes
   * applies to a retry too.
   */
  sendPrepared: (text: string, requestId: string) => Promise<boolean>;
  /** Whether a Retry is waiting on its pre-send check. */
  retryPending?: boolean;
  /** Whether the composer holds anything a retry would carry or overwrite. */
  draftInUse: boolean;
  /** Why sending is not possible right now, or undefined when it is. */
  sendUnavailableReason: string | undefined;
  /** Whether the model can be changed from the composer now. */
  modelChangeAvailable: boolean;
}

/**
 * The recovery actions a native tab offers on its latest failed turn.
 *
 * Retry sends one continuation prompt under a request id derived from the
 * exact failure it answers, through the same dispatch path (and so the same
 * at-most-once journal) as a typed prompt: pressing it twice, or in two views
 * of the tab, runs one turn. Anything the user does afterwards moves the last
 * row on, which retires the actions. Change model opens the composer's own
 * picker, so the choice is made, and applies, exactly as it always does.
 */
export function useProviderFailureRecovery({
  messages,
  sendPrepared,
  retryPending,
  draftInUse,
  sendUnavailableReason,
  modelChangeAvailable,
}: ProviderFailureRecoveryInput): {
  actions: ProviderFailureActions;
  modelPickerOpenRequest: number;
} {
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState(0);
  const actionableFailureId = useMemo(() => actionableProviderFailureId(messages), [messages]);
  const retry = useCallback(
    (failureId: string, occurredAt: string) => {
      void sendPrepared(
        PROVIDER_FAILURE_RETRY_PROMPT,
        providerFailureRetryRequestId(failureId, occurredAt),
      );
    },
    [sendPrepared],
  );
  const changeModel = useCallback(() => setModelPickerOpenRequest((request) => request + 1), []);
  const retryUnavailableReason = draftInUse
    ? "Send or clear the message in the composer first."
    : sendUnavailableReason;
  const actions = useMemo<ProviderFailureActions>(
    () => ({
      ...(actionableFailureId ? { actionableFailureId } : {}),
      retry,
      ...(retryPending ? { retryPending: true } : {}),
      ...(retryUnavailableReason ? { retryUnavailableReason } : {}),
      ...(modelChangeAvailable ? { changeModel } : {}),
    }),
    [
      actionableFailureId,
      changeModel,
      modelChangeAvailable,
      retry,
      retryPending,
      retryUnavailableReason,
    ],
  );
  return { actions, modelPickerOpenRequest };
}
