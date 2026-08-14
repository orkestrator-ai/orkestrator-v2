import { useCallback, useMemo, useRef } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

interface UseNativeAgentSessionOptions {
  platform: AgentPlatform;
  environmentId: string;
  tabId: string;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
}

/**
 * Shared provider-neutral lifecycle state. Provider controllers still own
 * transport reconciliation, but identity and one-shot launch acknowledgement
 * must behave identically across them.
 */
export function useNativeAgentSession({
  platform,
  environmentId,
  tabId,
  initialAgentModel,
  initialReasoningEffort,
}: UseNativeAgentSessionOptions) {
  const sessionKey = useMemo(
    () => createSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialAgentModel || initialReasoningEffort),
  );
  // These lifecycle fences have identical semantics for every provider. They
  // live in the shared hook so reconnect/fork behavior cannot drift merely
  // because a transport controller was copied at a different point in time.
  const isInitializedRef = useRef(false);
  const lastInitTimeRef = useRef(0);
  const forkInFlightRef = useRef(false);
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  const projection = useMemo<Pick<
    NativeAgentSessionProjection,
    "platform" | "environmentId" | "sessionId"
  >>(() => ({ platform, environmentId }), [environmentId, platform]);

  return {
    sessionKey,
    projection,
    initialLaunchOptionsRef,
    initialLaunchOptionsPendingRef,
    acknowledgeInitialLaunchOptions,
    isInitializedRef,
    lastInitTimeRef,
    forkInFlightRef,
  };
}
