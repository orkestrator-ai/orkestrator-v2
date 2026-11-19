import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  PROVIDER_FAILURE_RETRY_PROMPT,
  providerFailureRetryRequestId,
} from "@orkestrator/protocol/provider-failures";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  useProviderFailureRecovery,
  type ProviderFailureRecoveryInput,
} from "./useProviderFailureRecovery";

const failure: NativeMessage = {
  id: "native-terminal:error:abc",
  role: "system",
  content: "fetch failed",
  parts: [],
  createdAt: "2026-11-19T10:00:00.000Z",
};

function input(
  overrides: Partial<ProviderFailureRecoveryInput> = {},
): ProviderFailureRecoveryInput {
  return {
    messages: [failure],
    sendPrepared: mock(async () => true),
    draftInUse: false,
    sendUnavailableReason: undefined,
    modelChangeAvailable: true,
    ...overrides,
  };
}

describe("useProviderFailureRecovery", () => {
  test("Retry sends the retry prompt under the failure's own request id", () => {
    const sendPrepared = mock(async (_text: string, _id: string) => true);
    const { result } = renderHook(() => useProviderFailureRecovery(input({ sendPrepared })));
    expect(result.current.actions.actionableFailureId).toBe(failure.id);
    result.current.actions.retry?.(failure.id, failure.createdAt);
    result.current.actions.retry?.(failure.id, failure.createdAt);
    const requestId = providerFailureRetryRequestId(failure.id, failure.createdAt);
    // Both presses carry one id, so the dispatch journal runs one turn.
    expect(sendPrepared.mock.calls).toEqual([
      [PROVIDER_FAILURE_RETRY_PROMPT, requestId],
      [PROVIDER_FAILURE_RETRY_PROMPT, requestId],
    ]);
  });

  test("Retry says why it cannot run while the composer holds a draft or sending is held", () => {
    const { result, rerender } = renderHook(
      (props: ProviderFailureRecoveryInput) => useProviderFailureRecovery(props),
      { initialProps: input({ draftInUse: true }) },
    );
    expect(result.current.actions.retryUnavailableReason).toBe(
      "Send or clear the message in the composer first.",
    );
    rerender(input({ sendUnavailableReason: "Wait for the current turn to finish." }));
    expect(result.current.actions.retryUnavailableReason).toBe(
      "Wait for the current turn to finish.",
    );
    rerender(input());
    expect(result.current.actions.retryUnavailableReason).toBeUndefined();
  });

  test("Change model asks the picker to open, and is absent when the model cannot change", () => {
    const { result, rerender } = renderHook(
      (props: ProviderFailureRecoveryInput) => useProviderFailureRecovery(props),
      { initialProps: input() },
    );
    expect(result.current.modelPickerOpenRequest).toBe(0);
    act(() => result.current.actions.changeModel?.());
    expect(result.current.modelPickerOpenRequest).toBe(1);
    rerender(input({ modelChangeAvailable: false }));
    expect(result.current.actions.changeModel).toBeUndefined();
  });

  test("a later row retires the failure's actions", () => {
    const { result } = renderHook(() =>
      useProviderFailureRecovery(
        input({
          messages: [failure, { ...failure, id: "u1", role: "user", content: "next" }],
        }),
      ),
    );
    expect(result.current.actions.actionableFailureId).toBeUndefined();
  });
});
