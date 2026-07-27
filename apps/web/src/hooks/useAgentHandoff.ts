import { useEffect, useMemo, useState } from "react";
import {
  isAgentHandoffBootstrapMessage,
  loadAgentHandoff,
  mergeAgentHandoffDisplayMessages,
  type AgentHandoffSnapshot,
  type AgentProvider,
} from "@/lib/agent-handoff";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AgentHandoffState {
  handoffId: string | null;
  handoff: AgentHandoffSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface StoredAgentHandoffState extends AgentHandoffState {
  requestKey: string | null;
}

const EMPTY_STATE: StoredAgentHandoffState = {
  requestKey: null,
  handoffId: null,
  handoff: null,
  loading: false,
  error: null,
};

export function useAgentHandoff(
  handoffId: string | undefined,
  destinationProvider: AgentProvider,
  environmentId: string,
  providerMessages: NativeMessage[],
): AgentHandoffState & {
  ready: boolean;
  initialPrompt?: string;
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
    });
    void loadAgentHandoff(handoffId)
      .then((handoff) => {
        if (cancelled) return;
        if (!handoff) {
          setState({
            requestKey,
            handoffId,
            handoff: null,
            loading: false,
            error: "The transferred conversation could not be loaded.",
          });
          return;
        }
        if (handoff.destinationProvider !== destinationProvider) {
          setState({
            requestKey,
            handoffId,
            handoff: null,
            loading: false,
            error: "This transfer belongs to another agent.",
          });
          return;
        }
        if (handoff.environmentId !== environmentId) {
          setState({
            requestKey,
            handoffId,
            handoff: null,
            loading: false,
            error: "This transfer belongs to another environment.",
          });
          return;
        }
        setState({
          requestKey,
          handoffId,
          handoff,
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          requestKey,
          handoffId,
          handoff: null,
          loading: false,
          error: error instanceof Error
            ? error.message
            : "The transferred conversation could not be loaded.",
        });
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
        }
        : state;
  const ready = !handoffId || !currentState.loading;

  const displayMessages = useMemo(
    () => {
      if (currentState.error && handoffId) {
        const createdAt = new Date().toISOString();
        return [
          {
            id: `handoff:${handoffId}:error`,
            role: "system" as const,
            content: currentState.error,
            parts: [{ type: "text" as const, content: currentState.error }],
            createdAt,
          },
          ...providerMessages,
        ];
      }
      return mergeAgentHandoffDisplayMessages(currentState.handoff, providerMessages);
    },
    [currentState.error, currentState.handoff, handoffId, providerMessages],
  );
  const bootstrapAlreadyPresent = currentState.handoff
    ? providerMessages.some((message) =>
        isAgentHandoffBootstrapMessage(message, currentState.handoff!.id)
      )
    : false;
  const destinationTranscriptStarted = providerMessages.length > 0;

  return {
    handoffId: currentState.handoffId,
    handoff: currentState.handoff,
    loading: currentState.loading,
    error: currentState.error,
    ready,
    initialPrompt:
      ready && !destinationTranscriptStarted && !bootstrapAlreadyPresent
        ? currentState.handoff?.bootstrapPrompt
        : undefined,
    displayMessages,
  };
}
