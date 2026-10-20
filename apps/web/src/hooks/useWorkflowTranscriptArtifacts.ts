import { useMemo } from "react";
import { useArtifactPublications } from "@/hooks/useArtifactPublications";
import { useTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  ArtifactPublicationPlacements,
  mergeArtifactPublications,
} from "@/lib/chat/artifact-publication-merge";
import type { RichTranscriptScope } from "@/lib/chat/rich-identity";
import type { NativeMessage } from "@/lib/chat/native-message-types";

/** The conversation a workflow transcript renders: the session's own key in its environment. */
export interface WorkflowTranscriptConversation {
  environmentId: string;
  /** The workflow session's durable key; it owns the session's publications. */
  conversationKey: string;
  /** Changes when the provider session is replaced (a restarted reviewer or stage). */
  generation: string;
}

/**
 * Published transcript artifacts for a transcript that is not a native agent
 * tab: a Multi Review reviewer, a build-pipeline stage, feature planning.
 *
 * The same rules as the native tab (`AgentNativeTab.controller.tsx`): the
 * conversation's ledger is read through `useArtifactPublications` (on mount,
 * on a `transcript-artifact` hint for this conversation, on a full resync and
 * with bounded backoff while a publish call is unresolved) and merged into the
 * loaded rows with `mergeArtifactPublications`, which never adds a part the
 * backend already placed. The returned `scope` goes into a
 * `RichTranscriptScopeContext` around the rendered rows, so `ArtifactPart`
 * resolves each card in this conversation, with `backendId` from the
 * authenticated capabilities read. `conversation` null (session not recorded
 * yet) reads nothing and leaves the rows as they are.
 */
export function useWorkflowTranscriptArtifacts<T extends NativeMessage>(
  conversation: WorkflowTranscriptConversation | null,
  messages: readonly T[],
  options: { canLoadEarlier: boolean },
): { scope: RichTranscriptScope | null; messages: T[] } {
  const capabilities = useTranscriptArtifactCapabilities();
  const backendId = capabilities?.backendId ?? null;
  const environmentId = conversation?.environmentId;
  const conversationKey = conversation?.conversationKey;
  const generation = conversation?.generation;
  const scope = useMemo<RichTranscriptScope | null>(
    () =>
      environmentId && conversationKey && generation !== undefined
        ? { backendId, environmentId, logicalSessionKey: conversationKey, generation }
        : null,
    [backendId, conversationKey, environmentId, generation],
  );
  const placements = useMemo(() => new ArtifactPublicationPlacements(scope), [scope]);
  const publications = useArtifactPublications(scope, messages);
  const canLoadEarlier = options.canLoadEarlier;
  const merged = useMemo(
    () =>
      scope
        ? placements.stabilize(
            mergeArtifactPublications(messages, publications, { canLoadEarlier }),
          )
        : (messages as T[]),
    [canLoadEarlier, messages, placements, publications, scope],
  );
  return { scope, messages: merged };
}
