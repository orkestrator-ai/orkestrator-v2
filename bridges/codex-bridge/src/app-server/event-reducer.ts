/**
 * Translates app-server notifications into engine events.
 *
 * Pure and synchronous by design. It performs no I/O, holds no locks and awaits
 * nothing, so it is safe to call from the per-thread notification queue without
 * risking back-pressure onto app-server's bounded outbound queue.
 *
 * Unknown notification methods are reported rather than thrown: `app-server` is
 * experimental and a Codex upgrade may add methods mid-rollout. Crashing the
 * bridge on an unrecognised notification would take down every Codex tab in the
 * environment for something purely additive.
 */
import { adaptAppServerItem, planUpdateToTodoList } from "./item-adapter.js";
import { codexErrorInfoToCode } from "./errors.js";
import type { InboundNotification } from "./envelope-validation.js";
import type {
  EngineError,
  EngineEvent,
  EngineGeneration,
  EngineRateLimitWindow,
} from "../engine/types.js";

export interface ReduceResult {
  events: EngineEvent[];
  /** Set when the method is not in the pinned protocol. */
  unknownMethod?: string;
  /** Set when an item was structurally valid but has no rendering. */
  unsupportedItemType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * ECMAScript `Date` only represents ±8.64e15 ms around the epoch. `new Date(x)`
 * outside that range yields an Invalid Date and `toISOString()` *throws* — inside
 * a reducer this file's header promises is total, from a value app-server can
 * report as any JSON number. Out-of-range resets are dropped rather than clamped:
 * a fabricated boundary timestamp would be shown to the user as fact.
 */
const MAX_DATE_MS = 8.64e15;

function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = num(value);
  if (seconds === undefined) return undefined;
  const ms = seconds * 1_000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

/** app-server `TurnError` → engine error, keeping the structured code. */
export function toTurnError(raw: unknown): EngineError {
  if (!isRecord(raw)) {
    return { message: typeof raw === "string" ? raw : "Codex reported an error" };
  }
  const code = codexErrorInfoToCode(raw.codexErrorInfo);
  return {
    message: str(raw.message) ?? "Codex reported an error",
    ...(code ? { code } : {}),
    ...(str(raw.additionalDetails) ? { details: str(raw.additionalDetails) } : {}),
  };
}

/**
 * `turn/completed` carries the whole turn; the status decides how the bridge
 * finalizes. `inProgress` here would be a protocol contradiction, so it is
 * treated as completed rather than leaving the turn forever unresolved.
 */
function turnStatus(value: unknown): "completed" | "interrupted" | "failed" {
  return value === "interrupted" ? "interrupted" : value === "failed" ? "failed" : "completed";
}

/**
 * Notifications that are deliberately ignored.
 *
 * These are real, known methods that carry no information the normalized message
 * model represents. Listing them explicitly means a genuinely *new* method still
 * shows up as `unknownMethod` in metrics instead of hiding in a catch-all.
 */
const IGNORED_METHODS = new Set([
  // Connection/account scope, not thread scope.
  "account/updated",
  "account/login/completed",
  "app/list/updated",
  "remoteControl/status/changed",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "skills/changed",
  "fs/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  // Advisory only; surfaced through logs rather than the transcript.
  "warning",
  "guardianWarning",
  "deprecationNotice",
  "configWarning",
  "model/rerouted",
  "model/verification",
  "model/safetyBuffering/updated",
  "turn/moderationMetadata",
  // Raw response passthrough — the item stream is the rendered source of truth.
  "rawResponseItem/completed",
  "rawResponse/completed",
  // Bookkeeping the bridge tracks itself.
  "serverRequest/resolved",
  "thread/status/changed",
  "thread/settings/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
  "thread/closed",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "hook/started",
  "hook/completed",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  // Realtime voice sessions are not part of native chat.
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
]);

export function isIgnoredNotification(method: string): boolean {
  return IGNORED_METHODS.has(method);
}

/**
 * Reduces one notification.
 *
 * `handle` is threaded through so events can be routed to the right thread
 * context even before a `threadId` is known (a `turn/start` response can lose the
 * race with the notifications it triggers).
 */
export function reduceNotification(
  notification: InboundNotification,
  generation: EngineGeneration,
  handle?: string,
): ReduceResult {
  const params = notification.params;
  const base = { engineGeneration: generation, ...(handle ? { handle } : {}) };
  const threadId = isRecord(params) ? (str(params.threadId) ?? null) : null;
  const turnId = isRecord(params) ? str(params.turnId) : undefined;

  switch (notification.method) {
    case "thread/tokenUsage/updated": {
      if (!isRecord(params) || !threadId || !turnId || !isRecord(params.tokenUsage)) {
        return { events: [] };
      }
      const total = isRecord(params.tokenUsage.total) ? params.tokenUsage.total : {};
      const last = isRecord(params.tokenUsage.last) ? params.tokenUsage.last : {};
      const contextWindow = num(params.tokenUsage.modelContextWindow) ?? 0;
      const usedTokens = num(last.totalTokens) ?? 0;
      return {
        events: [{
          kind: "thread.usage.updated",
          threadId,
          turnId,
          usage: {
            usedTokens,
            totalTokens: contextWindow,
            percentUsed: contextWindow > 0
              ? Math.min(100, (usedTokens / contextWindow) * 100)
              : 0,
            inputTokens: num(total.inputTokens),
            outputTokens: num(total.outputTokens),
            cacheReadTokens: num(total.cachedInputTokens),
            cacheWriteTokens: num(total.cacheWriteInputTokens),
            reasoningTokens: num(total.reasoningOutputTokens),
            lastTurnTokens: usedTokens,
            sessionTokens: num(total.totalTokens),
            estimated: false,
            source: "provider",
            updatedAt: new Date().toISOString(),
          },
          ...base,
        }],
      };
    }

    /**
     * A **sparse** rolling update, per the generated protocol: only the fields
     * present carry information, and an absent one must not clear the last
     * observed value. The event therefore lists only the windows this update
     * actually carried, and omits `credits` entirely when it carried none —
     * merging into the retained snapshot is the consumer's job.
     */
    case "account/rateLimits/updated": {
      if (!isRecord(params) || !isRecord(params.rateLimits)) return { events: [] };
      const snapshot = params.rateLimits;
      const windows: EngineRateLimitWindow[] = [];
      for (const [key, label] of [["primary", "Primary"], ["secondary", "Secondary"]] as const) {
        const window = isRecord(snapshot[key]) ? snapshot[key] : undefined;
        if (!window) continue;
        const resetsAt = epochSecondsToIso(window.resetsAt);
        windows.push({
          slot: key,
          label: typeof snapshot.limitName === "string" && snapshot.limitName.length > 0
            && key === "primary"
            ? snapshot.limitName
            : label,
          usedPercent: num(window.usedPercent),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        });
      }
      const rawCredits = isRecord(snapshot.credits) ? snapshot.credits : null;
      const credits = rawCredits
        ? {
            ...(typeof rawCredits.balance === "string"
              ? { balance: rawCredits.balance }
              : {}),
            ...(typeof rawCredits.hasCredits === "boolean"
              ? { hasCredits: rawCredits.hasCredits }
              : {}),
            ...(typeof rawCredits.unlimited === "boolean"
              ? { unlimited: rawCredits.unlimited }
              : {}),
          }
        : undefined;
      return {
        events: [{
          kind: "account.rateLimits.updated",
          rateLimits: windows,
          // An empty credits object carries no information, and emitting one
          // would look like an update in a stream whose whole contract is
          // "present means changed".
          ...(credits && Object.keys(credits).length > 0 ? { credits } : {}),
          ...base,
        }],
      };
    }

    case "thread/started": {
      const thread = isRecord(params) ? params.thread : undefined;
      const id = isRecord(thread) ? str(thread.id) : undefined;
      if (!id) return { events: [] };
      return { events: [{ kind: "thread.started", threadId: id, ...base }] };
    }

    /**
     * The only terminal edge for `thread/compact/start`, which returns before the
     * rewrite has happened. Without it the bridge could never learn that
     * compaction finished, and the thread it marked busy would stay busy.
     *
     * The notification's `turnId` is deliberately dropped: the compaction turn is
     * never the thread's active turn, so a turn-scoped event would be parked and
     * then discarded as stale.
     */
    case "thread/compacted": {
      if (!threadId) return { events: [] };
      return { events: [{ kind: "thread.compacted", threadId, ...base }] };
    }

    case "thread/name/updated": {
      if (!threadId) return { events: [] };
      const name = isRecord(params) ? str(params.threadName) : undefined;
      return { events: [{ kind: "thread.name.updated", threadId, name, ...base }] };
    }

    case "turn/started": {
      const turn = isRecord(params) ? params.turn : undefined;
      const id = isRecord(turn) ? str(turn.id) : undefined;
      if (!id) return { events: [] };
      return { events: [{ kind: "turn.started", threadId, turnId: id, ...base }] };
    }

    case "turn/completed": {
      const turn = isRecord(params) ? params.turn : undefined;
      if (!isRecord(turn)) return { events: [] };
      const id = str(turn.id);
      if (!id) return { events: [] };
      const status = turnStatus(turn.status);
      return {
        events: [
          {
            kind: "turn.completed",
            threadId,
            turnId: id,
            status,
            // Only populated when the turn actually failed.
            ...(status === "failed" && turn.error ? { error: toTurnError(turn.error) } : {}),
            ...base,
          },
        ],
      };
    }

    /**
     * A standalone error. Deliberately *not* terminal: app-server can report a
     * retryable failure and still complete the turn, so treating this as the end
     * would strand a turn that is about to succeed.
     */
    case "error": {
      if (!isRecord(params)) return { events: [] };
      return {
        events: [
          {
            kind: "error",
            threadId,
            turnId: str(params.turnId),
            error: toTurnError(params.error),
            willRetry: params.willRetry === true,
            ...base,
          },
        ],
      };
    }

    case "item/started":
    case "item/completed": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const { item, unsupportedType } = adaptAppServerItem(params.item);
      if (!item) return { events: [], unsupportedItemType: unsupportedType };
      const completed = notification.method === "item/completed";
      return {
        events: [
          {
            kind: completed ? "item.completed" : "item.started",
            threadId,
            turnId,
            item,
            ...base,
          },
        ],
      };
    }

    case "item/agentMessage/delta": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const itemId = str(params.itemId);
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      if (!itemId || delta === undefined) return { events: [] };
      return {
        events: [{ kind: "item.text.delta", threadId, turnId, itemId, delta, ...base }],
      };
    }

    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const itemId = str(params.itemId);
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      if (!itemId || delta === undefined) return { events: [] };
      const summary = notification.method === "item/reasoning/summaryTextDelta";
      return {
        events: [
          {
            kind: "item.reasoning.delta",
            threadId,
            turnId,
            itemId,
            delta,
            channel: summary ? "summary" : "content",
            index: num(summary ? params.summaryIndex : params.contentIndex) ?? 0,
            ...base,
          },
        ],
      };
    }

    case "item/reasoning/summaryPartAdded":
      // Only a boundary marker; the index on subsequent deltas carries the split.
      return { events: [] };

    case "item/commandExecution/outputDelta": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const itemId = str(params.itemId);
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      if (!itemId || delta === undefined) return { events: [] };
      return {
        events: [
          { kind: "item.command.outputDelta", threadId, turnId, itemId, delta, ...base },
        ],
      };
    }

    /**
     * In-progress patch content. Re-emitted as an `item.updated` so the diff the
     * agent is building is visible before the patch is applied.
     */
    case "item/fileChange/patchUpdated": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const itemId = str(params.itemId);
      if (!itemId) return { events: [] };
      const { item } = adaptAppServerItem({
        id: itemId,
        type: "fileChange",
        changes: params.changes,
        status: "inProgress",
      });
      if (!item) return { events: [] };
      return { events: [{ kind: "item.updated", threadId, turnId, item, ...base }] };
    }

    case "turn/plan/updated": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const item = planUpdateToTodoList(turnId, params.plan);
      if (!item) return { events: [] };
      return { events: [{ kind: "item.updated", threadId, turnId, item, ...base }] };
    }

    case "turn/diff/updated": {
      if (!isRecord(params) || !turnId) return { events: [] };
      const diff = typeof params.diff === "string" ? params.diff : undefined;
      if (diff === undefined) return { events: [] };
      return { events: [{ kind: "turn.diff", threadId, turnId, diff, ...base }] };
    }

    default: {
      if (isIgnoredNotification(notification.method)) return { events: [] };
      // Additive protocol change. Counted, never fatal.
      return {
        events: [{ kind: "unknown.protocol", method: notification.method, ...base }],
        unknownMethod: notification.method,
      };
    }
  }
}

/**
 * Reduces the turns returned by `thread/resume` / `thread/read` into the same
 * events a live stream would have produced.
 *
 * Sharing one path means a rehydrated transcript and a streamed one cannot drift:
 * resume-after-restart renders identically to the original turn.
 */
export function reduceHistoricalTurns(
  turns: unknown,
  generation: EngineGeneration,
  threadId: string,
  handle?: string,
): { events: EngineEvent[]; unsupportedItemTypes: string[] } {
  const events: EngineEvent[] = [];
  const unsupportedItemTypes: string[] = [];
  if (!Array.isArray(turns)) return { events, unsupportedItemTypes };

  const base = { engineGeneration: generation, ...(handle ? { handle } : {}) };

  for (const turn of turns) {
    if (!isRecord(turn)) continue;
    const turnId = str(turn.id);
    if (!turnId) continue;

    events.push({ kind: "turn.started", threadId, turnId, ...base });

    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const { item, unsupportedType } = adaptAppServerItem(rawItem);
      if (!item) {
        if (unsupportedType) unsupportedItemTypes.push(unsupportedType);
        continue;
      }
      // Historical items are final by definition.
      events.push({ kind: "item.completed", threadId, turnId, item, ...base });
    }

    // A turn still `inProgress` in persisted history is genuinely still running
    // (we are resuming into it), so it must not be finalized here.
    if (turn.status === "inProgress") continue;

    const status = turnStatus(turn.status);
    events.push({
      kind: "turn.completed",
      threadId,
      turnId,
      status,
      ...(status === "failed" && turn.error ? { error: toTurnError(turn.error) } : {}),
      ...base,
    });
  }

  return { events, unsupportedItemTypes };
}
