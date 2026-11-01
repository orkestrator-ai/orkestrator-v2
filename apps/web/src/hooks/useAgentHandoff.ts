import { useEffect, useMemo, useState } from "react";
import {
  buildAgentHandoffImportedMessages,
  isAgentHandoffBootstrapMessage,
  loadAgentHandoff,
  stripAgentHandoffCarriers,
  type AgentHandoffSnapshot,
  type AgentProvider,
} from "@/lib/agent-handoff";
import { getAgentHandoffCapabilities } from "@/lib/backend";
import { isClientOnlyNativeMessage } from "@/lib/chat/client-only-messages";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AgentHandoffState {
  handoffId: string | null;
  handoff: AgentHandoffSnapshot | null;
  loading: boolean;
  error: string | null;
  /** The backend delivers this handoff itself with the tab's first dispatch. */
  backendDelivers: boolean;
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
  backendDelivers: false,
};

/** What a request shows before its load settles; no request is the empty state. */
function pendingHandoffState(
  requestKey: string | null,
  handoffId: string | undefined,
): StoredAgentHandoffState {
  if (requestKey === null) return EMPTY_STATE;
  return {
    requestKey,
    handoffId: handoffId ?? null,
    handoff: null,
    loading: true,
    error: null,
    errorAt: null,
    backendDelivers: false,
  };
}

/**
 * Whether the backend delivers handoffs. An answer that cannot be read counts as
 * "no": this renderer then prepends the history, and a backend that delivers
 * recognises the carrier and does not add a second one, so the wrong guess costs
 * nothing, where assuming "yes" could drop the history.
 */
async function backendDeliversHandoffs(): Promise<boolean> {
  try {
    return (await getAgentHandoffCapabilities()).delivery;
  } catch {
    return false;
  }
}

export function useAgentHandoff(
  handoffId: string | undefined,
  destinationProvider: AgentProvider,
  environmentId: string,
  providerMessages: NativeMessage[],
  /**
   * A handoff this tab has already dispatched. Suppresses a second bootstrap
   * prepend if the tab remounts before the destination transcript loads. After
   * the snapshot is detached (resume of another session) it also keeps that
   * prompt hidden rather than dumping its JSON frame into the chat.
   */
  consumedHandoffId?: string,
): AgentHandoffState & {
  ready: boolean;
  /**
   * The transferred history while it is still waiting for the destination's
   * first prompt. Display state: the backend prepends it at dispatch, unless
   * `backendDelivers` is false (a backend that predates that).
   */
  pendingHistory?: string;
  displayMessages: NativeMessage[];
} {
  const requestKey = handoffId
    ? JSON.stringify([handoffId, destinationProvider, environmentId])
    : null;
  const [state, setState] = useState<StoredAgentHandoffState>(() =>
    pendingHandoffState(requestKey, handoffId),
  );

  /*
   * Effects run after paint, so the state from a previous/no handoff would
   * otherwise make the first render of a restored tab look ready. Reset to the
   * pending state while rendering whenever a request dimension changes, so the
   * composer and queue are closed before any asynchronous load starts.
   */
  if (state.requestKey !== requestKey) {
    setState(pendingHandoffState(requestKey, handoffId));
  }

  useEffect(() => {
    if (!handoffId) return;
    let cancelled = false;
    const fail = (message: string) => {
      setState({
        requestKey,
        handoffId,
        handoff: null,
        loading: false,
        error: message,
        errorAt: new Date().toISOString(),
        backendDelivers: false,
      });
    };
    void Promise.all([loadAgentHandoff(handoffId), backendDeliversHandoffs()])
      .then(([handoff, backendDelivers]) => {
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
          backendDelivers,
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
  }, [destinationProvider, environmentId, handoffId, requestKey]);

  const ready = !handoffId || !state.loading;

  /*
   * Keyed on the snapshot alone. `providerMessages` is a fresh array on every
   * streaming tick, and rebuilding the imported rows there would hand React new
   * objects each time, re-rendering the entire imported transcript per token.
   */
  const importedMessages = useMemo(
    () => (state.handoff ? buildAgentHandoffImportedMessages(state.handoff) : null),
    [state.handoff],
  );
  const carrierIds = useMemo(
    () => [state.handoff?.id, consumedHandoffId].filter((id): id is string => Boolean(id)),
    [state.handoff, consumedHandoffId],
  );

  const displayMessages = useMemo(() => {
    const visible =
      carrierIds.length > 0
        ? stripAgentHandoffCarriers(carrierIds, providerMessages)
        : providerMessages;
    if (state.error && handoffId) {
      return [
        {
          id: `handoff:${handoffId}:error`,
          role: "system" as const,
          content: state.error,
          parts: [{ type: "text" as const, content: state.error }],
          createdAt: state.errorAt ?? new Date(0).toISOString(),
        },
        ...visible,
      ];
    }
    return importedMessages ? [...importedMessages, ...visible] : visible;
  }, [carrierIds, state.error, state.errorAt, handoffId, importedMessages, providerMessages]);
  const destinationTranscriptStarted = providerMessages.some((message) => {
    /*
     * Optimistic sends and locally generated error/system rows are retained in
     * provider stores, but none proves that the provider accepted the handoff.
     * Keep the history pending so a definite rejection can be retried. A
     * structurally valid carrier is the exception: once that transport appears
     * in the transcript it represents the dispatched handoff even if it still
     * has an optimistic id while waiting for its authoritative echo.
     */
    if (state.handoff && isAgentHandoffBootstrapMessage(message, state.handoff.id)) {
      return true;
    }
    return !isClientOnlyNativeMessage(message);
  });

  return {
    handoffId: state.handoffId,
    handoff: state.handoff,
    loading: state.loading,
    error: state.error,
    backendDelivers: state.backendDelivers,
    ready,
    pendingHistory:
      ready && !destinationTranscriptStarted && !consumedHandoffId
        ? state.handoff?.bootstrapPrompt
        : undefined,
    displayMessages,
  };
}
