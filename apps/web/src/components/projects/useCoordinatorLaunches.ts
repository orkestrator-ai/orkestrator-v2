import { useCallback, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { coordinatorRuntimeId, type CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import * as backend from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";

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

/** The first prompt of a conversation, from the send that binds its agent until its turn exists. */
export function useCoordinatorLaunches({
  projectId,
  snapshot,
  setSnapshot,
  confirmUpstreamMerge,
}: UseCoordinatorLaunchesOptions) {
  const [pendingLaunch, setPendingLaunch] = useState<PendingCoordinatorLaunch | null>(null);
  const assignAgent = useCallback(
    async (
      conversationId: string,
      platform: AgentPlatform,
      launch: CoordinatorLaunchOptions,
      prompt: string,
    ) => {
      const next = await backend.assignCoordinatorConversationAgent(
        projectId,
        conversationId,
        platform,
      );
      // Held only until the assigned tab mounts and consumes them. They are not
      // durable state: the backend owns the conversation, and a reload before
      // the first dispatch legitimately returns the user to the composer with
      // their draft rather than replaying a prompt that was never sent.
      setPendingLaunch({ conversationId, prompt, ...launch });
      setSnapshot(next);
    },
    [projectId, setSnapshot],
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
  // The conversation's own tab id, never a reconstructed one: the workspace
  // assigns it, and a key that does not match leaves the prompt held for good.
  const launchConversation = pendingLaunch
    ? snapshot?.workspace.conversations.find((item) => item.id === pendingLaunch.conversationId)
    : undefined;
  const launchSessionKey =
    snapshot && launchConversation
      ? createSessionKey(
          coordinatorRuntimeId(snapshot.workspace.id, launchConversation.id),
          launchConversation.tabId,
        )
      : null;
  // Either half is enough: a turn that has started, or a message already in the
  // transcript. A slow first read shows neither, which is precisely when the
  // prompt still has to be held. Only phases a turn produces count: the first
  // read of a new session is the backend's `recovering` placeholder while the
  // provider mapping settles, and an `error` with no transcript is a failed
  // start. Releasing on either dropped the prompt before it was ever sent.
  const launchObserved = useNativeAgentProjectionStore((state) => {
    if (!launchSessionKey) return false;
    const projection = state.projections.get(launchSessionKey);
    if (!projection) return false;
    const phase = projection.turn.phase;
    return (
      phase === "running" ||
      phase === "blocked" ||
      phase === "cancelling" ||
      projection.messages.length > 0
    );
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
  if (pendingLaunch && launchObserved) setPendingLaunch(null);
  return { pendingLaunch, startConversation };
}
