import {
  isChangeProjection,
  type CanonicalToolPresentation,
} from "@orkestrator/protocol/change-resources";
import * as backend from "@/lib/backend";
import {
  AGENT_HANDOFF_CHANGE_SUMMARY_CHARACTERS,
  AGENT_HANDOFF_MAX_CHANGE_SUMMARIES,
  collectAgentHandoffToolCallIds,
} from "@/lib/agent-handoff";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { toolPresentationKey, useChangeProjectionStore } from "@/stores/changeProjectionStore";

/** Same scope the transcript rows pass to `useToolChangePresentation`. */
export interface HandoffChangeScope {
  environmentId: string;
  provider: string;
  conversationId: string;
}

const PRESENTATION_BATCH = 200;
const HANDOFF_CONCURRENCY = 4;

/**
 * Measurement ids of a tool call's selected projections, primary first.
 * Payload, effect and observation stay separate measurements; the backend
 * serializer labels each with its own scope and provenance.
 */
function measurementIdsFor(presentation: CanonicalToolPresentation | null | undefined): string[] {
  if (!presentation) return [];
  const projections = useChangeProjectionStore.getState().projections;
  const ordered = [...presentation.changes].sort(
    (a, b) => Number(b.prominence === "primary") - Number(a.prominence === "primary"),
  );
  const ids: string[] = [];
  for (const change of ordered) {
    const id = projections.get(change.resourceKey)?.measurementId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Presentations the store does not hold yet are read once from the backend. */
async function ensurePresentations(scope: HandoffChangeScope, callIds: string[]): Promise<void> {
  const held = useChangeProjectionStore.getState().toolPresentations;
  const missing = callIds.filter(
    (callId) =>
      !held.has(
        toolPresentationKey(scope.environmentId, scope.provider, scope.conversationId, callId),
      ),
  );
  for (let index = 0; index < missing.length; index += PRESENTATION_BATCH) {
    const slice = missing.slice(index, index + PRESENTATION_BATCH);
    const result = await backend.getToolChangePresentations({ ...scope, callIds: slice });
    const store = useChangeProjectionStore.getState();
    store.applyToolPresentations(
      slice.map((callId) => [
        toolPresentationKey(scope.environmentId, scope.provider, scope.conversationId, callId),
        result.presentations[callId] ?? null,
      ]),
    );
    for (const projection of Object.values(result.projections)) {
      if (isChangeProjection(projection)) store.applyProjection(projection);
    }
  }
}

/**
 * Backend-serialized change text for the tool calls of a handoff transcript,
 * keyed by tool call id, for `createAgentHandoffSnapshot({ changeSummaries })`.
 *
 * Every number in the result is written by the backend
 * (`changes_get_handoff`) from its selected measurements, with scope,
 * provenance and quality. A call without a measurement is simply absent, and
 * the serializer then writes "changes: not measured" for it. On an older
 * backend without change tracking the result is empty.
 */
export async function resolveAgentHandoffChangeSummaries(
  scope: HandoffChangeScope,
  messages: NativeMessage[],
): Promise<Record<string, string>> {
  // The newest calls best describe the state being handed off.
  const callIds = collectAgentHandoffToolCallIds(messages).slice(
    -AGENT_HANDOFF_MAX_CHANGE_SUMMARIES,
  );
  if (callIds.length === 0) return {};
  try {
    await ensurePresentations(scope, callIds);
  } catch {
    // Older backend: nothing was measured.
    return {};
  }
  const presentations = useChangeProjectionStore.getState().toolPresentations;
  const work = callIds.flatMap((callId) => {
    const ids = measurementIdsFor(
      presentations.get(
        toolPresentationKey(scope.environmentId, scope.provider, scope.conversationId, callId),
      ),
    );
    return ids.length > 0 ? [{ callId, ids }] : [];
  });

  const summaries: Record<string, string> = {};
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const item = work[next++]!;
      try {
        const result = await backend.getChangeHandoff(
          item.ids,
          AGENT_HANDOFF_CHANGE_SUMMARY_CHARACTERS,
        );
        if (result.kind === "handoff" && result.text.trim()) summaries[item.callId] = result.text;
      } catch {
        // This call stays "not measured".
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HANDOFF_CONCURRENCY, work.length) }, worker));
  return summaries;
}
