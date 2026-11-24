import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { CoordinatorOpeningPrompt } from "@/components/native-agent/startup-prompt-preview";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** What the composer chose for a conversation's first turn. */
export interface CoordinatorLaunchOptions {
  modelId?: string;
  reasoningId?: string;
  fastMode: boolean;
  mode?: "build" | "plan";
  executionProfileId?: string;
}

export interface PendingCoordinatorLaunch
  extends CoordinatorLaunchOptions, CoordinatorOpeningPrompt {
  /**
   * The upstream check is over and the agent is bound, so the tab may send it.
   * Until then the prompt is only drawn, whatever binds the conversation.
   */
  ready: boolean;
}

interface UseCoordinatorLaunchesOptions {
  projectId: string;
  snapshot: CoordinatorSnapshot | null;
  setSnapshot: (snapshot: CoordinatorSnapshot) => void;
  /** Resolves `false` when the send must not go ahead. */
  confirmUpstreamMerge: (conversation: { role?: string }) => Promise<false | undefined>;
}

const NO_LAUNCHES: ReadonlyMap<string, PendingCoordinatorLaunch> = new Map();

/** Owns first prompts across conversation pane remounts until their own send settles. */
export function useCoordinatorLaunches({
  projectId,
  snapshot,
  setSnapshot,
  confirmUpstreamMerge,
}: UseCoordinatorLaunchesOptions) {
  const nodeBackend = useScopeBackend();
  const [pendingLaunches, setPendingLaunches] = useState(NO_LAUNCHES);
  const [launchErrors, setLaunchErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const launchClaims = useRef(new Map<string, { requestId: string; dispatched: boolean }>());
  const clearLaunchError = useCallback((conversationId: string) => {
    setLaunchErrors((current) => {
      if (!current.has(conversationId)) return current;
      const remaining = new Map(current);
      remaining.delete(conversationId);
      return remaining;
    });
  }, []);
  const claimLaunch = useCallback((conversationId: string, requestId: string) => {
    const claim = launchClaims.current.get(conversationId);
    if (claim?.requestId !== requestId || claim.dispatched) return false;
    claim.dispatched = true;
    return true;
  }, []);
  const settleLaunch = useCallback((conversationId: string, requestId: string, error?: string) => {
    if (launchClaims.current.get(conversationId)?.requestId !== requestId) return;
    launchClaims.current.delete(conversationId);
    setPendingLaunches((current) => {
      if (current.get(conversationId)?.requestId !== requestId) return current;
      const remaining = new Map(current);
      remaining.delete(conversationId);
      return remaining;
    });
    if (error) setLaunchErrors((current) => new Map(current).set(conversationId, error));
  }, []);
  const startConversation = useCallback(
    async (
      conversation: { id: string; role?: string },
      platform: AgentPlatform,
      options: CoordinatorLaunchOptions,
      prompt: string,
    ) => {
      const { id } = conversation;
      if (launchClaims.current.has(id)) return;
      const requestId = crypto.randomUUID();
      launchClaims.current.set(id, { requestId, dispatched: false });
      clearLaunchError(id);
      const launch = {
        requestId,
        text: prompt,
        createdAt: new Date().toISOString(),
        ready: false,
        ...options,
      };
      try {
        if (conversation.role !== "side") {
          setPendingLaunches((current) => new Map(current).set(id, launch));
        }
        if ((await confirmUpstreamMerge(conversation)) === false) {
          settleLaunch(id, requestId);
          return;
        }
        if (launchClaims.current.get(id)?.requestId !== requestId) return;
        const next = await nodeBackend.assignCoordinatorConversationAgent(projectId, id, platform);
        if (launchClaims.current.get(id)?.requestId !== requestId) return;
        setPendingLaunches((current) => new Map(current).set(id, { ...launch, ready: true }));
        setSnapshot(next);
      } catch (error) {
        settleLaunch(
          id,
          requestId,
          error instanceof Error ? error.message : "This conversation could not be started.",
        );
      }
    },
    [clearLaunchError, confirmUpstreamMerge, nodeBackend, projectId, setSnapshot, settleLaunch],
  );

  // A closed conversation has no pane left to settle its prompt.
  useEffect(() => {
    if (!snapshot) return;
    const openIds = new Set(
      snapshot.workspace.conversations.filter((item) => !item.closedAt).map((item) => item.id),
    );
    for (const [id, { requestId }] of Array.from(launchClaims.current)) {
      if (!openIds.has(id)) settleLaunch(id, requestId);
    }
  }, [snapshot, settleLaunch]);
  return {
    pendingLaunches,
    launchErrors,
    startConversation,
    claimLaunch,
    settleLaunch,
    clearLaunchError,
  };
}
