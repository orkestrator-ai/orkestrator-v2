import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { promptQueueKey } from "@/lib/prompt-queue-persistence";
import { createSessionKey } from "@/lib/utils";
import {
  diffCommentsStore,
  environmentDiffComments,
  isDiffCommentOutdated,
  type DiffCommentSettlement,
} from "@/stores/diffCommentsStore";
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
  label: string;
}

/** Agent chat tabs of an environment that can take a queued prompt, in tab order. */
export function diffCommentDestinations(tabs: readonly TabInfo[]): DiffCommentDestination[] {
  const destinations: DiffCommentDestination[] = [];
  const totals = new Map<string, number>();
  for (const tab of tabs) {
    if (tab.isReviewTab) continue;
    const platform = getNativeAgentData(tab)?.platform;
    if (!platform) continue;
    const label = tab.displayTitle?.trim() || AGENT_PLATFORM_LABELS[platform];
    totals.set(label, (totals.get(label) ?? 0) + 1);
    destinations.push({ tabId: tab.id, platform, label });
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

/** The request text for the comments currently selected, with their outdated state. */
export function selectedDiffCommentRequest(scope: NodeScope, environmentId: string): string | null {
  const environment = environmentDiffComments(
    scope.store(diffCommentsStore).getState(),
    environmentId,
  );
  const selected = environment.comments.filter((comment) => comment.selected);
  if (selected.length === 0) return null;
  return buildDiffCommentRequest(
    selected.map((comment) => ({
      comment,
      outdated: isDiffCommentOutdated(environment, comment),
    })),
  );
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
  const selected = environment.comments.filter((comment) => comment.selected);
  if (selected.length === 0) return { kind: "empty" };
  const text = buildDiffCommentRequest(
    selected.map((comment) => ({
      comment,
      outdated: isDiffCommentOutdated(environment, comment),
    })),
  );
  if (text.length > MAX_DIFF_COMMENT_REQUEST_CHARACTERS) return { kind: "too-long" };
  const items = selected.map((comment) => ({ id: comment.id, revision: comment.revision }));
  const requestId = diffCommentRequestId(environmentId, destination.tabId, items);
  if (!store.getState().beginSend(environmentId, { requestId, tabId: destination.tabId, items })) {
    return { kind: "busy" };
  }
  try {
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
      },
    );
  } catch (error) {
    const message = errorMessage(error);
    store.getState().failSend(environmentId, requestId, message);
    return { kind: "failed", message };
  }
  return { kind: "sent", ...store.getState().completeSend(environmentId, requestId) };
}
