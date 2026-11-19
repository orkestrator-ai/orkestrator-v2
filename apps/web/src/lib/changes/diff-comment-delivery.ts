import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { promptQueueKey } from "@/lib/prompt-queue-persistence";
import { createSessionKey } from "@/lib/utils";
import {
  diffCommentsStore,
  environmentDiffComments,
  diffCommentFreshness,
  isDiffCommentSelected,
  type DiffCommentSettlement,
  type DiffComment,
} from "@/stores/diffCommentsStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { readLiveCommentContent } from "./diff-comment-freshness";
import { getNativeAgentData, type TabInfo } from "@/types/paneLayout";
import {
  buildDiffCommentRequest,
  diffCommentRequestId,
  MAX_DIFF_COMMENT_REQUEST_CHARACTERS,
} from "./diff-comment-request";

/**
 * Sends the selected diff comments of one environment to one of its agent
 * tabs as a single prompt.
 *
 * The prompt goes into the tab's backend-owned prompt queue, the same queue
 * a composer send while the agent is busy uses: the backend sends it when the
 * session is free, whether or not the tab, or the environment, is on screen.
 *
 * Only comments at the revision the request carried are removed once the
 * queue accepts it (`diffCommentsStore.completeSend`). A failure keeps every
 * comment; retrying the same batch reuses its request id, which the queue
 * recognises while the first copy is still waiting.
 */

export interface DiffCommentDestination {
  tabId: string;
  platform: AgentPlatform;
  sessionId: string;
  label: string;
}

/** Agent chat tabs of an environment that can take a queued prompt, in tab order. */
export function diffCommentDestinations(tabs: readonly TabInfo[]): DiffCommentDestination[] {
  const destinations: DiffCommentDestination[] = [];
  const totals = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.isReviewTab) continue;
    const data = getNativeAgentData(tab);
    if (!data?.platform || !data.sessionId) continue;
    const { platform, sessionId } = data;
    const label = tab.displayTitle?.trim() || AGENT_PLATFORM_LABELS[platform];
    totals.set(label, (totals.get(label) ?? 0) + 1);
    destinations.push({ tabId: tab.id, platform, sessionId, label });
  }
  // Name repeats by position so two "Claude Code" tabs can be told apart.
  const positions = new Map<string, number>();
  return destinations.map((destination) => {
    if ((totals.get(destination.label) ?? 0) <= 1) return destination;
    const position = (positions.get(destination.label) ?? 0) + 1;
    positions.set(destination.label, position);
    return { ...destination, label: `${destination.label} ${position}` };
  });
}

/** The remembered tab when it still exists, else the first agent tab. */
export function defaultDiffCommentDestination(
  destinations: readonly DiffCommentDestination[],
  rememberedTabId: string | null,
): DiffCommentDestination | null {
  return (
    destinations.find((destination) => destination.tabId === rememberedTabId) ??
    destinations[0] ??
    null
  );
}

async function freshRequest(
  scope: NodeScope,
  environmentId: string,
  selected: readonly DiffComment[],
): Promise<string> {
  const liveContent = await readLiveCommentContent(
    scope,
    environmentId,
    selected.map(({ anchor }) => anchor),
  );
  return buildDiffCommentRequest(
    selected.map((comment) => ({
      comment,
      freshness: diffCommentFreshness({ liveContent }, comment),
    })),
  );
}

/** The request text for the selected snapshot, with freshly checked anchors. */
export async function selectedDiffCommentRequest(
  scope: NodeScope,
  environmentId: string,
): Promise<string | null> {
  const environment = environmentDiffComments(
    scope.store(diffCommentsStore).getState(),
    environmentId,
  );
  const selected = environment.comments.filter(isDiffCommentSelected);
  return selected.length ? freshRequest(scope, environmentId, selected) : null;
}

export type DiffCommentDeliveryResult =
  | ({ kind: "sent" } & DiffCommentSettlement)
  | { kind: "busy" }
  | { kind: "empty" }
  | { kind: "too-long" }
  | { kind: "failed"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sendDiffComments(
  scope: NodeScope,
  environmentId: string,
  destination: DiffCommentDestination,
): Promise<DiffCommentDeliveryResult> {
  // Held before the await: the scope may be disposed by the time it answers.
  const store = scope.store(diffCommentsStore);
  const backend = backendForScope(scope);
  const environment = environmentDiffComments(store.getState(), environmentId);
  if (environment.sending) return { kind: "busy" };
  // The snapshot: exactly these comments at exactly these revisions.
  const selected = environment.comments.filter(isDiffCommentSelected);
  if (selected.length === 0) return { kind: "empty" };
  const items = selected.map((comment) => ({ id: comment.id, revision: comment.revision }));
  const requestId = diffCommentRequestId(
    environmentId,
    destination.tabId,
    items,
    destination.sessionId,
  );
  if (!store.getState().beginSend(environmentId, { requestId, tabId: destination.tabId, items })) {
    return { kind: "busy" };
  }
  try {
    const text = await freshRequest(scope, environmentId, selected);
    if (text.length > MAX_DIFF_COMMENT_REQUEST_CHARACTERS) {
      store.getState().failSend(environmentId, requestId, "Send fewer comments at a time.");
      return { kind: "too-long" };
    }
    const current = diffCommentDestinations(
      scope.store(paneLayoutStore).getState().getAllTabs(environmentId),
    ).find((candidate) => candidate.tabId === destination.tabId);
    if (
      !current ||
      current.platform !== destination.platform ||
      current.sessionId !== destination.sessionId
    ) {
      throw new Error(
        "The destination conversation changed. Choose a started agent chat and try again.",
      );
    }
    await backend.enqueuePromptQueueMessage(
      promptQueueKey(destination.platform, createSessionKey(environmentId, destination.tabId)),
      environmentId,
      {
        id: requestId,
        requestId,
        text,
        // A correction keeps the session's own mode and model; the dispatcher
        // must not switch a session the user put in Plan mode to Build.
        preserveSessionMode: true,
        requireProviderSessionId: destination.sessionId,
      },
    );
  } catch (error) {
    const message = errorMessage(error);
    store.getState().failSend(environmentId, requestId, message);
    return { kind: "failed", message };
  }
  return { kind: "sent", ...store.getState().completeSend(environmentId, requestId) };
}
