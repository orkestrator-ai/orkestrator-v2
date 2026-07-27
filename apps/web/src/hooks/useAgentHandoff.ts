import { useEffect, useMemo, useState } from "react";
import {
  loadAgentHandoff,
  mergeAgentHandoffDisplayMessages,
  type AgentHandoffSnapshot,
  type AgentProvider,
} from "@/lib/agent-handoff";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AgentHandoffState {
  handoff: AgentHandoffSnapshot | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: AgentHandoffState = {
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
  initialPrompt?: string;
  displayMessages: NativeMessage[];
} {
  const [state, setState] = useState<AgentHandoffState>(EMPTY_STATE);

  useEffect(() => {
    if (!handoffId) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    setState({ handoff: null, loading: true, error: null });
    void loadAgentHandoff(handoffId)
      .then((handoff) => {
        if (cancelled) return;
        if (!handoff) {
          setState({
            handoff: null,
            loading: false,
            error: "The transferred conversation could not be loaded.",
          });
          return;
        }
        if (handoff.destinationProvider !== destinationProvider) {
          setState({
            handoff: null,
            loading: false,
            error: "This transfer belongs to another agent.",
          });
          return;
        }
        if (handoff.environmentId !== environmentId) {
          setState({
            handoff: null,
            loading: false,
            error: "This transfer belongs to another environment.",
          });
          return;
        }
        setState({ handoff, loading: false, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
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

  const displayMessages = useMemo(
    () => {
      if (state.error && handoffId) {
        const createdAt = new Date().toISOString();
        return [
          {
            id: `handoff:${handoffId}:error`,
            role: "system" as const,
            content: state.error,
            parts: [{ type: "text" as const, content: state.error }],
            createdAt,
          },
          ...providerMessages,
        ];
      }
      return mergeAgentHandoffDisplayMessages(state.handoff, providerMessages);
    },
    [handoffId, providerMessages, state.error, state.handoff],
  );

  return {
    ...state,
    initialPrompt: state.handoff?.bootstrapPrompt,
    displayMessages,
  };
}
