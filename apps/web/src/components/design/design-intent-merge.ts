import {
  DESIGN_INTENT_LIMITS,
  type DesignIntentDraft,
  type DesignIntentList,
  type DesignStoredIntent,
} from "@orkestrator/protocol/design-operations";
import type { DesignIntent } from "@/stores/designStore";

/**
 * Converts between this window's intent projection and the backend's durable
 * intent queue. The backend is authoritative for every intent it holds; this
 * window only keeps what it is sending right now and drafts it has not saved.
 */
export function toIntentDraft(intent: DesignIntent): DesignIntentDraft {
  return {
    id: intent.id,
    lane: intent.lane,
    label: intent.label.slice(0, 200),
    createdAt: intent.createdAt,
    descriptor: intent.descriptor,
    ...(intent.preview ? { preview: intent.preview } : {}),
    ...(intent.gestureKey ? { gestureKey: intent.gestureKey } : {}),
  };
}

export function fromStoredIntent(
  stored: DesignStoredIntent,
  environmentId: string,
  canvasId: string,
): DesignIntent {
  return {
    id: stored.id,
    environmentId,
    canvasId,
    lane: stored.lane,
    descriptor: stored.descriptor,
    label: stored.label,
    createdAt: stored.createdAt,
    // Admitted without an outcome: prepared and not started.
    phase: stored.phase === "admitted" && !stored.outcome ? "prepared" : stored.phase,
    ...(stored.token ? { token: stored.token } : {}),
    ...(stored.outcome ? { outcome: stored.outcome } : {}),
    ...(stored.failure ? { failure: stored.failure } : {}),
    ...(stored.result ? { result: stored.result } : {}),
    ...(stored.preview ? { preview: stored.preview } : {}),
    ...(stored.gestureKey ? { gestureKey: stored.gestureKey } : {}),
  };
}

export function settledOk(intent: Pick<DesignIntent, "phase" | "outcome">) {
  return (
    intent.phase === "settled" && (intent.outcome === "committed" || intent.outcome === "no-op")
  );
}

export interface IntentMergeContext {
  environmentId: string;
  canvasId: string;
  /** This window's client id; an intent another window resumed is no longer ours. */
  clientId: string;
  /** Intents with a run call in flight in this window. */
  running: ReadonlySet<string>;
  /** Unsent drafts not yet confirmed saved by the backend. */
  unsaved: { has(id: string): boolean };
  /** Discarded here; a stale server copy must not bring them back. */
  discarded: ReadonlySet<string>;
}

/**
 * Another window's edit it is still working on. It is not this window's to
 * review until that window stops: otherwise every edit it makes would flash
 * through this window's "Needs review" list.
 */
function foreignInFlight(
  stored: DesignStoredIntent,
  listed: DesignIntentList,
  clientId: string,
): boolean {
  if (stored.clientId === clientId) return false;
  if (stored.phase === "preparing" || listed.sending.includes(stored.id)) return true;
  return (
    stored.phase === "draft" &&
    listed.now - stored.updatedAt < DESIGN_INTENT_LIMITS.foreignDraftQuietMs
  );
}

export interface IntentMergeResult {
  intents: DesignIntent[];
  changed: boolean;
  /** Local sends whose run never reached the backend: run them again after a backoff. */
  retry: string[];
  /** Restored edits the backend proved were saved. */
  savedElsewhere: string[];
  /** This window's own edits the queue reports failed (a lost response, say). */
  failed: DesignIntent[];
}

/** Sent, but whether the backend received the run is not known yet. */
function uncertain(intent: DesignIntent) {
  return intent.phase === "admitted" && intent.outcome === "unknown" && !intent.token;
}

/**
 * Folds the backend's queue into this window's intents. Intents this window
 * did not create appear as `restored`: they never run without an explicit
 * Resume, whichever window made them.
 */
export function mergeIntents(
  local: DesignIntent[],
  listed: DesignIntentList,
  context: IntentMergeContext,
): IntentMergeResult {
  const server = listed.intents;
  const byId = new Map(server.map((intent) => [intent.id, intent]));
  const retry: string[] = [];
  const savedElsewhere: string[] = [];
  const failed: DesignIntent[] = [];
  const intents: DesignIntent[] = [];
  for (const intent of local) {
    const stored = byId.get(intent.id);
    if (context.running.has(intent.id) || settledOk(intent)) {
      intents.push(intent);
      continue;
    }
    if (!stored) {
      if (uncertain(intent)) {
        // The run never recorded the edit, so it was never prepared: send it again.
        intents.push({ ...intent, phase: "draft", outcome: undefined });
        retry.push(intent.id);
      } else if (intent.phase === "draft" && context.unsaved.has(intent.id)) {
        intents.push(intent);
      }
      // Anything else was discarded or resolved by another window.
      continue;
    }
    if (uncertain(intent) && stored.phase === "draft") {
      // Saved earlier, but the run never reached the backend: send it again after a backoff.
      intents.push({ ...intent, phase: "draft", outcome: undefined });
      retry.push(intent.id);
      continue;
    }
    // Listed earlier, and its window is working on it again.
    if (intent.restored && foreignInFlight(stored, listed, context.clientId)) continue;
    if (stored.clientId !== context.clientId && !intent.restored) {
      // Another window resumed it: it is theirs to send now.
      intents.push({
        ...fromStoredIntent(stored, context.environmentId, context.canvasId),
        restored: true,
      });
      continue;
    }
    if (intent.phase === "draft" && stored.phase === "draft") {
      // A newer local sample of the same draft wins until it is saved.
      intents.push(intent);
      continue;
    }
    const next: DesignIntent = {
      ...fromStoredIntent(stored, context.environmentId, context.canvasId),
      ...(intent.restored ? { restored: true } : {}),
      ...(intent.blocked && stored.phase === "draft" ? { blocked: true } : {}),
    };
    if (settledOk(next)) {
      next.awaitRevision = stored.result?.canvasRevision ?? intent.awaitRevision;
      // Only an edit this window was showing as unresolved needs saying so.
      if (intent.restored && intent.phase !== "draft") savedElsewhere.push(intent.label);
    } else if (next.phase === "settled" && next.failure && intent.phase !== "settled") {
      if (!intent.restored) failed.push(next);
    }
    intents.push(next);
  }
  const known = new Set(local.map((intent) => intent.id));
  for (const stored of server) {
    if (known.has(stored.id) || context.discarded.has(stored.id) || settledOk(stored)) continue;
    if (foreignInFlight(stored, listed, context.clientId)) continue;
    intents.push({
      ...fromStoredIntent(stored, context.environmentId, context.canvasId),
      restored: true,
    });
  }
  // As when a run answers with a failure: dependent edits pause for review.
  for (const failure of failed)
    for (const [index, intent] of intents.entries())
      if (
        intent.lane === failure.lane &&
        intent.phase === "draft" &&
        !intent.restored &&
        intent.createdAt >= failure.createdAt
      )
        intents[index] = { ...intent, blocked: true };
  const changed = JSON.stringify(intents) !== JSON.stringify(local);
  return { intents: changed ? intents : local, changed, retry, savedElsewhere, failed };
}
