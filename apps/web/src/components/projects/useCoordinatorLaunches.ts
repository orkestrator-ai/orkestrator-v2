import { useCallback, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorRuntimeId, type CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** What the composer chose for a conversation's first turn. */
export interface CoordinatorLaunchOptions {
  modelId?: string;
  reasoningId?: string;
  fastMode: boolean;
  mode?: "build" | "plan";
  executionProfileId?: string;
}

export interface PendingCoordinatorLaunch extends CoordinatorLaunchOptions {
  conversationId: string;
  prompt: string;
}

interface UseCoordinatorLaunchesOptions {
  projectId: string;
  snapshot: CoordinatorSnapshot | null;
  setSnapshot: (snapshot: CoordinatorSnapshot) => void;
  /** Resolves `false` when the send must not go ahead. */
  confirmUpstreamMerge: (conversation: { role?: string }) => Promise<false | undefined>;
}

const NO_LAUNCHES: ReadonlyMap<string, PendingCoordinatorLaunch> = new Map();

/**
 * Whether a held first prompt is finished with: its turn has been seen, or its
 * conversation closed, so no tab will ever consume it. Either half of the turn
 * is enough: a turn that has started, or a message already in the transcript.
 * A slow first read shows neither, which is precisely when the prompt still has
 * to be held. Only phases a turn produces count: the first read of a new session
 * is the backend's `recovering` placeholder while the provider mapping settles,
 * and an `error` with no transcript is a failed start. Releasing on either
 * dropped the prompt before it was ever sent.
 */
function launchFinished(
  conversationId: string,
  snapshot: CoordinatorSnapshot,
  projections: ReadonlyMap<string, NativeAgentSessionProjection>,
): boolean {
  const conversation = snapshot.workspace.conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.closedAt) return true;
  // The conversation's own tab id, never a reconstructed one: the workspace
  // assigns it, and a key that does not match leaves the prompt held for good.
  const projection = projections.get(
    createSessionKey(
      coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
      conversation.tabId,
    ),
  );
  if (!projection) return false;
  const phase = projection.turn.phase;
  return (
    phase === "running" ||
    phase === "blocked" ||
    phase === "cancelling" ||
    projection.messages.length > 0
  );
}

/**
 * Each conversation's first prompt, from the send that binds its agent until its
 * turn exists. One slot per conversation: tab groups put several composers on
 * screen, and a second first send must not take the place of one still held.
 */
export function useCoordinatorLaunches({
  projectId,
  snapshot,
  setSnapshot,
  confirmUpstreamMerge,
}: UseCoordinatorLaunchesOptions) {
  const nodeBackend = useScopeBackend();
  const [pendingLaunches, setPendingLaunches] = useState(NO_LAUNCHES);
  const assignAgent = useCallback(
    async (
      conversationId: string,
      platform: AgentPlatform,
      launch: CoordinatorLaunchOptions,
      prompt: string,
    ) => {
      const next = await nodeBackend.assignCoordinatorConversationAgent(
        projectId,
        conversationId,
        platform,
      );
      // Held only until the assigned tab mounts and consumes them. They are not
      // durable state: the backend owns the conversation, and a reload before
      // the first dispatch legitimately returns the user to the composer with
      // their draft rather than replaying a prompt that was never sent.
      setPendingLaunches((current) =>
        new Map(current).set(conversationId, { conversationId, prompt, ...launch }),
      );
      setSnapshot(next);
    },
    [projectId, setSnapshot, nodeBackend],
  );
  const startConversation = useCallback(
    async (
      conversation: { id: string; role?: string },
      platform: AgentPlatform,
      launch: CoordinatorLaunchOptions,
      prompt: string,
    ) => {
      if ((await confirmUpstreamMerge(conversation)) === false) return;
      await assignAgent(conversation.id, platform, launch, prompt);
    },
    [assignAgent, confirmUpstreamMerge],
  );
  // One id at a time, so the selector answers a stable value however often the
  // projections change; releasing it re-renders, which finds the next.
  const finishedId = useNativeAgentProjectionStore((state) => {
    if (!snapshot) return null;
    for (const conversationId of pendingLaunches.keys()) {
      if (launchFinished(conversationId, snapshot, state.projections)) return conversationId;
    }
    return null;
  });
  /*
   * Held until the turn is observed, not until the tab has rendered once.
   *
   * The agent tab dispatches an opening prompt only after its first
   * authoritative read, so dropping the prompt on the next render — which the
   * snapshot poll triggers within a second or two — raced that read and left
   * the text sitting in the composer unsent. Evidence of the turn is the
   * authoritative signal, and re-dispatch is safe in the meantime because the
   * opening submit carries a deterministic idempotency key.
   */
  if (finishedId !== null) {
    const remaining = new Map(pendingLaunches);
    remaining.delete(finishedId);
    setPendingLaunches(remaining);
  }
  return { pendingLaunches, startConversation };
}
