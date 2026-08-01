import { useEffect, useMemo, useState } from "react";
import {
  buildAgentHandoffImportedMessages,
  isAgentHandoffBootstrapMessage,
  loadAgentHandoff,
  stripAgentHandoffCarriers,
  type AgentHandoffSnapshot,
  type AgentProvider,
} from "@/lib/agent-handoff";
import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AgentHandoffState {
  handoffId: string | null;
  handoff: AgentHandoffSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface StoredAgentHandoffState extends AgentHandoffState {
  requestKey: string | null;
  /**
   * Captured when `error` is set. Deriving it during render would mint a new
   * timestamp on every streaming tick, so the error row's displayed time — and
   * the response duration measured against it — would drift.
   */
  errorAt: string | null;
}

const EMPTY_STATE: StoredAgentHandoffState = {
  requestKey: null,
  handoffId: null,
  handoff: null,
  loading: false,
  error: null,
  errorAt: null,
};

export function useAgentHandoff(
  handoffId: string | undefined,
  destinationProvider: AgentProvider,
  environmentId: string,
  providerMessages: NativeMessage[],
  /**
   * A handoff this tab dispatched whose snapshot has since been deleted (the tab
   * resumed another session). The imported transcript is gone, but the bootstrap
   * prompt is still the provider transcript's first message and must stay hidden
   * rather than dumping its whole JSON frame into the chat.
   */
  consumedHandoffId?: string,
): AgentHandoffState & {
  ready: boolean;
  /** History to prepend only when the user submits the first destination prompt. */
  pendingHistory?: string;
  displayMessages: NativeMessage[];
} {
  const [state, setState] = useState<StoredAgentHandoffState>(EMPTY_STATE);
  const requestKey = handoffId
    ? JSON.stringify([handoffId, destinationProvider, environmentId])
    : null;

  useEffect(() => {
    if (!handoffId) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    setState({
      requestKey,
      handoffId,
      handoff: null,
      loading: true,
      error: null,
      errorAt: null,
    });
    const fail = (message: string) => {
      setState({
        requestKey,
        handoffId,
        handoff: null,
        loading: false,
        error: message,
        errorAt: new Date().toISOString(),
      });
    };
    void loadAgentHandoff(handoffId)
      .then((handoff) => {
        if (cancelled) return;
        if (!handoff) {
          fail("The transferred conversation could not be loaded.");
          return;
        }
        if (handoff.destinationProvider !== destinationProvider) {
          fail("This transfer belongs to another agent.");
          return;
        }
        if (handoff.environmentId !== environmentId) {
          fail("This transfer belongs to another environment.");
          return;
        }
        setState({
          requestKey,
          handoffId,
          handoff,
          loading: false,
          error: null,
          errorAt: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        fail(
          error instanceof Error
            ? error.message
            : "The transferred conversation could not be loaded.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [destinationProvider, environmentId, handoffId]);

  /*
   * Effects run after paint, so the state from a previous/no handoff would
   * otherwise make the first render of a restored tab look ready. Derive the
   * pending state synchronously from every request dimension so the composer
   * and queue are closed before any asynchronous load starts.
   */
  const currentState: StoredAgentHandoffState =
    requestKey === null
      ? state.requestKey === null
        ? state
        : EMPTY_STATE
      : state.requestKey !== requestKey
        ? {
          requestKey,
          handoffId: handoffId ?? null,
          handoff: null,
          loading: true,
          error: null,
          errorAt: null,
        }
        : state;
  const ready = !handoffId || !currentState.loading;

  /*
   * Keyed on the snapshot alone. `providerMessages` is a fresh array on every
   * streaming tick, and rebuilding the imported rows there would hand React new
   * objects each time, re-rendering the entire imported transcript per token.
   */
  const importedMessages = useMemo(
    () => (currentState.handoff
      ? buildAgentHandoffImportedMessages(currentState.handoff)
      : null),
    [currentState.handoff],
  );
  const carrierIds = useMemo(
    () => [currentState.handoff?.id, consumedHandoffId].filter(
      (id): id is string => Boolean(id),
    ),
    [currentState.handoff, consumedHandoffId],
  );

  const displayMessages = useMemo(
    () => {
      const visible = carrierIds.length > 0
        ? stripAgentHandoffCarriers(carrierIds, providerMessages)
        : providerMessages;
      if (currentState.error && handoffId) {
        return [
          {
            id: `handoff:${handoffId}:error`,
            role: "system" as const,
            content: currentState.error,
            parts: [{ type: "text" as const, content: currentState.error }],
            createdAt: currentState.errorAt ?? new Date(0).toISOString(),
          },
          ...visible,
        ];
      }
      return importedMessages ? [...importedMessages, ...visible] : visible;
    },
    [
      carrierIds,
      currentState.error,
      currentState.errorAt,
      handoffId,
      importedMessages,
      providerMessages,
    ],
  );
  const destinationTranscriptStarted = providerMessages.some((message) => {
    /*
     * Optimistic sends and locally generated error/system rows are retained in
     * provider stores, but none proves that the provider accepted the handoff.
     * Keep the history pending so a definite rejection can be retried. A
     * structurally valid carrier is the exception: once that transport appears
     * in the transcript it represents the dispatched handoff even if it still
     * has an optimistic id while waiting for its authoritative echo.
     */
    if (
      currentState.handoff
      && isAgentHandoffBootstrapMessage(message, currentState.handoff.id)
    ) {
      return true;
    }
    return !isClientOnlyNativeMessage(message);
  });

  return {
    handoffId: currentState.handoffId,
    handoff: currentState.handoff,
    loading: currentState.loading,
    error: currentState.error,
    ready,
    pendingHistory:
      ready && !destinationTranscriptStarted
        ? currentState.handoff?.bootstrapPrompt
        : undefined,
    displayMessages,
  };
}
