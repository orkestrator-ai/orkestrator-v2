/**
 * Renders a `TurnAccumulator` into Orkestrator's normalized message parts.
 *
 * Two things make this more than a map over items:
 *
 *  1. **Deltas versus authoritative items.** While a turn streams, an item may
 *     exist only as accumulated deltas. Once `item/completed` lands, the final
 *     item wins. The accumulator holds both; this decides which to draw.
 *
 *  2. **Sub-agent interleaving.** Child-agent activity is not an item in the
 *     parent's stream — it lives in rollout transcripts on disk. The same
 *     reconciler the SDK engine uses splices those parts into the timeline at the
 *     position they occurred, so sub-agent rendering is identical across engines.
 */
import {
  applyCodexCollabStateToSubagentParts,
  CODEX_TIMELINE_ITEM_PREFIX,
  CODEX_TIMELINE_SUBAGENT_PREFIX,
  getCodexSpawnedAgentIdsInOrder,
  normalizeCodexCollabToolCallItem,
  reconcileCodexSubagentTimeline,
} from "../codex-collaboration.js";
import { relative } from "node:path";
import { deriveTranscriptSubagentPartsForTurn } from "../subagent-transcript-parts.js";
import { readCachedTranscript } from "../transcript-cache.js";
import { createSharedTranscriptMetaLoader } from "../history/rollout.js";
import { BaselineMap, beginTurn, touchBaseline } from "./diff-budget.js";
import { hasVisibleText, itemToParts } from "./normalization.js";
import type { FileChangeDiffContext, NormalizedPart } from "./types.js";
import type { EngineItem } from "../engine/types.js";
import type {
  AssistantSegment,
  ItemAccumulator,
  TurnAccumulator,
} from "../sessions/turn-accumulator.js";

/** Marker appended when a command's output hit the UI cap. */
export const TRUNCATION_NOTICE = "\n… output truncated";

export interface TurnRenderState {
  /** Interleaved item + sub-agent keys, preserved across renders for stability. */
  timelineOrder: string[];
  /**
   * Completed items are immutable by the app-server contract. Retain their
   * normalized parts so a streaming update to the newest item does not rebuild
   * every older text/tool/diff object in the turn.
   */
  completedItemParts: Map<string, { source: EngineItem | null; parts: NormalizedPart[] }>;
  subagentParts: Map<string, NormalizedPart>;
  subagentFingerprints: Map<string, string>;
  /** When the rollout-transcript probe for sub-agent activity last ran. */
  subagentProbedAt: number;
  fileChange: FileChangeDiffContext;
}

/**
 * How often a streaming render pays for the sub-agent transcript probe.
 *
 * The probe reads the parent rollout (and every child rollout) from disk.
 * Renders happen ~10x/second while a turn streams, and the overwhelming
 * majority of turns spawn no agents at all, so probing on every render burned
 * tens of MB/s of file reads and parsing for nothing — the single largest
 * allocation source in the bridge. Between probes the previous snapshot is
 * retained, which is the same behavior as a probe that failed.
 */
export const SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS = 2_000;

export function createTurnRenderState(): TurnRenderState {
  return {
    timelineOrder: [],
    completedItemParts: new Map(),
    subagentParts: new Map(),
    subagentFingerprints: new Map(),
    subagentProbedAt: 0,
    fileChange: { baselines: new BaselineMap(), cache: new Map() },
  };
}

/**
 * Resets per-turn render state while **carrying baselines forward**.
 *
 * Baselines are what make a second edit to the same file diff against the
 * previous turn's content. Discarding them would make every turn diff against
 * git HEAD, so turn 3 would re-display the changes from turns 1 and 2 as if they
 * were new. The per-item cache *is* turn-scoped and is cleared.
 */
export function beginTurnRenderState(previous: TurnRenderState | undefined): TurnRenderState {
  const fresh = createTurnRenderState();
  if (!previous) return fresh;
  fresh.fileChange = previous.fileChange;
  beginTurn(fresh.fileChange);
  return fresh;
}

/** Frees a thread's render state; recoverable, since the rollout is authoritative. */
export function releaseTurnRenderState(state: TurnRenderState): void {
  state.timelineOrder.length = 0;
  state.completedItemParts.clear();
  state.subagentParts.clear();
  state.subagentFingerprints.clear();
  state.subagentProbedAt = 0;
  state.fileChange.baselines.clear();
  state.fileChange.cache.clear();
}

function touchCachedPartBaselines(
  parts: readonly NormalizedPart[],
  cwd: string,
  baselines: BaselineMap,
): void {
  for (const part of parts) {
    const filePath = part.toolDiff?.filePath;
    if (!filePath) continue;
    touchBaseline(baselines, relative(cwd, filePath));
  }
}

function joinReasoning(summary: string[], content: string[]): string {
  const source = summary.some(hasVisibleText) ? summary : content;
  return source.filter(hasVisibleText).join("\n\n");
}

/**
 * The item to draw for one accumulator.
 *
 * Returns null when nothing renderable has arrived yet — e.g. a command-output
 * delta that raced ahead of its `item/started`, so we do not know the command.
 */
export function effectiveItem(
  turn: TurnAccumulator,
  accumulator: ItemAccumulator,
): EngineItem | null {
  const item = accumulator.item;

  if (!item) {
    // Deltas only: synthesize so streaming text is visible before completion.
    if (accumulator.textDelta.length > 0) {
      return {
        id: accumulator.id,
        type: "agent_message",
        text: accumulator.textDelta,
      } as EngineItem;
    }
    const reasoning = joinReasoning(
      [...accumulator.summaryDeltas.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text),
      [...accumulator.contentDeltas.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text),
    );
    if (reasoning.length > 0) {
      return { id: accumulator.id, type: "reasoning", text: reasoning } as EngineItem;
    }
    return null;
  }

  if (
    accumulator.rawFallback &&
    item.type === "dynamic_tool_call" &&
    item.tool.trim().toLowerCase() === "apply_patch" &&
    item.status !== "failed" &&
    !turn.isTerminal()
  ) {
    return null;
  }

  switch (item.type) {
    /**
     * An in-progress command reports no aggregated output; the live output only
     * exists as deltas. Splice it in so the user sees the command running rather
     * than an empty box that fills in at the end.
     */
    case "command_execution": {
      if (item.aggregated_output && item.aggregated_output.length > 0) return item;
      if (accumulator.outputDelta.length === 0) return item;
      return {
        ...item,
        aggregated_output:
          accumulator.outputDelta + (accumulator.outputTruncated ? TRUNCATION_NOTICE : ""),
      } as EngineItem;
    }
    // A final item with empty text can happen mid-stream; prefer the deltas.
    case "agent_message":
      return item.text.length > 0 ? item : ({ ...item, text: accumulator.textDelta } as EngineItem);
    case "reasoning": {
      if (item.text.length > 0) return item;
      const reasoning = turn.effectiveReasoning(accumulator);
      return { ...item, text: joinReasoning(reasoning.summary, reasoning.content) } as EngineItem;
    }
    default:
      return item;
  }
}

export interface RenderTurnOptions {
  threadId: string | null;
  cwd: string;
  state: TurnRenderState;
  /** Injected in tests to avoid touching the filesystem. */
  loadSubagentParts?: (options: SubagentPartsLoadOptions) => Promise<NormalizedPart[]>;
  /** Assistant row within the active turn being rendered. */
  segment?: AssistantSegment;
  /**
   * Minimum time between sub-agent transcript probes. Defaults to 0 (probe on
   * every render) so injected loaders in tests stay deterministic; the runtime
   * passes `SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS`. A terminal turn always
   * probes, so the final published snapshot is never stale.
   */
  subagentProbeIntervalMs?: number;
}

export interface SubagentPartsLoadOptions {
  threadId: string | null;
  turnStartedAt?: string;
  turnEndedAt?: string;
  items: EngineItem[];
}

/**
 * Agent ids this segment's own items claim, when every spawn among them names
 * one.
 *
 * This is what makes a steered turn's sub-agent rows line up with its item
 * rows: items are split by app-server's authoritative ordering, so scoping
 * spawns by the ids those items carry uses the same boundary. The timestamp
 * window is the fallback for the case the ids cannot supply — notably
 * multi-agent v2, whose spawn output no longer returns `agent_id`.
 */
function ownedSubagentIds(items: EngineItem[]): string[] | undefined {
  const claimed = getCodexSpawnedAgentIdsInOrder(items);
  if (claimed.length === 0) {
    // Codex's custom multi-agent wrapper can omit the native spawn item while
    // later wait/send collaboration items still name the child. Those receiver
    // ids are authoritative for this assistant segment and let transcript
    // hydration restore the child's nickname instead of rendering "subagent".
    const referenced = new Set<string>();
    for (const item of items) {
      const collab = normalizeCodexCollabToolCallItem(item);
      if (!collab) continue;
      for (const agentId of collab.receiver_thread_ids ?? []) referenced.add(agentId);
      for (const agentId of Object.keys(collab.agents_states ?? {})) referenced.add(agentId);
    }
    return referenced.size > 0 ? [...referenced] : undefined;
  }
  // A partially identified segment cannot be filtered without dropping the
  // spawns it failed to name, so fall back rather than lose them.
  if (claimed.some((agentId) => agentId === undefined)) return undefined;
  return claimed as string[];
}

export interface SubagentPartsLoaderDependencies {
  createTranscriptMetaLoader: typeof createSharedTranscriptMetaLoader;
  deriveTranscriptParts: typeof deriveTranscriptSubagentPartsForTurn;
  readTranscript: typeof readCachedTranscript;
}

/**
 * Reads sub-agent activity from rollout transcripts.
 *
 * Multi-agent collaboration tools emit no items on the parent's stream, so disk
 * is the only source. Deliberately shared with the SDK engine: it is also the
 * documented reconciliation fallback while native `collabAgentToolCall` items are
 * validated against it.
 */
export async function loadSubagentPartsFromTranscripts(
  options: SubagentPartsLoadOptions,
  dependencies: SubagentPartsLoaderDependencies = {
    createTranscriptMetaLoader: createSharedTranscriptMetaLoader,
    deriveTranscriptParts: deriveTranscriptSubagentPartsForTurn,
    readTranscript: readCachedTranscript,
  },
): Promise<NormalizedPart[]> {
  const loadSessionMeta = dependencies.createTranscriptMetaLoader();
  const owned = ownedSubagentIds(options.items);
  const transcriptParts = await dependencies.deriveTranscriptParts({
    threadId: options.threadId,
    currentTurnStartedAt: options.turnStartedAt,
    ...(options.turnEndedAt ? { currentTurnEndedAt: options.turnEndedAt } : {}),
    ...(owned ? { ownedSubagentIds: owned } : {}),
    fallbackAgentIdsInSpawnOrder: getCodexSpawnedAgentIdsInOrder(options.items),
    loadSessionMeta,
    loadTranscript: (path) => dependencies.readTranscript(path),
  });
  // Native collab items carry live agent status; fold it onto the transcript parts.
  const reconciled = applyCodexCollabStateToSubagentParts(transcriptParts, options.items);
  return reconciled.map((part) => ({
    type: "subagent" as const,
    content: part.content,
    toolState: part.toolState,
    subagentId: part.subagentId,
    subagentName: part.subagentName,
    subagentRole: part.subagentRole,
    subagentPrompt: part.subagentPrompt,
    subagentActions: part.subagentActions as NormalizedPart[],
    subagentActionCount: part.subagentActionCount,
  }));
}

export interface RenderedTurn {
  parts: NormalizedPart[];
  /** The final assistant text, which the UI shows as the message body. */
  content: string;
}

function collectTurnItems(
  turn: TurnAccumulator,
  segment?: AssistantSegment,
): {
  items: EngineItem[];
  itemsByKey: Map<string, EngineItem>;
  accumulatorsByKey: Map<string, ItemAccumulator>;
  itemKeys: string[];
} {
  const items: EngineItem[] = [];
  const itemsByKey = new Map<string, EngineItem>();
  const accumulatorsByKey = new Map<string, ItemAccumulator>();
  const itemKeys: string[] = [];

  for (const accumulator of turn.orderedForAssistantSegment(segment?.assistantMessageId)) {
    // Reserve every accumulator's position, even when it currently contains only
    // an unrenderable delta. If item/started arrives later, the row materializes
    // at its original position rather than being appended after newer activity.
    itemKeys.push(`${CODEX_TIMELINE_ITEM_PREFIX}${accumulator.id}`);
    accumulatorsByKey.set(accumulator.id, accumulator);
    const item = effectiveItem(turn, accumulator);
    if (!item) continue;
    items.push(item);
    itemsByKey.set(accumulator.id, item);
  }

  return { items, itemsByKey, accumulatorsByKey, itemKeys };
}

export async function renderTurn(
  turn: TurnAccumulator,
  options: RenderTurnOptions,
): Promise<RenderedTurn> {
  const load = options.loadSubagentParts ?? loadSubagentPartsFromTranscripts;
  const probeIntervalMs = options.subagentProbeIntervalMs ?? 0;
  const shouldProbe =
    probeIntervalMs <= 0 ||
    turn.isTerminal() ||
    Date.now() - options.state.subagentProbedAt >= probeIntervalMs;
  let subagentParts: NormalizedPart[] | undefined;
  if (shouldProbe) {
    // Collected only here: streaming renders arrive ~10x/second while the probe
    // runs every couple of seconds, so a snapshot taken unconditionally would be
    // built and thrown away on the vast majority of renders.
    const loadSnapshot = collectTurnItems(turn, options.segment);
    options.state.subagentProbedAt = Date.now();
    try {
      subagentParts = await load({
        threadId: options.threadId,
        turnStartedAt: options.segment?.startedAt ?? turn.startedAt,
        ...(options.segment?.endedAt ? { turnEndedAt: options.segment.endedAt } : {}),
        items: loadSnapshot.items,
      });
    } catch (error) {
      // Sub-agent detail is additive; losing it must not blank the transcript.
      console.error("[codex-bridge] Failed to load sub-agent activity:", error);
    }
  }

  // The loader performs filesystem I/O. Parent events can arrive while it is
  // awaited, so take the render snapshot only after it settles. This prevents a
  // newer sub-agent fingerprint from being committed against stale parent keys.
  const { items, itemsByKey, accumulatorsByKey, itemKeys } = collectTurnItems(
    turn,
    options.segment,
  );

  // Reconcile the authoritative item set without rebuilding its order around
  // the sub-agent entries. New parent items belong at the end of the timeline;
  // a later sub-agent snapshot can then move its own row after them. Starting
  // from `[...itemKeys, ...existingSubagentKeys]` on every render would instead
  // pin even completed agents below every parent message that followed them.
  const currentItemKeys = new Set(itemKeys);
  const timelineOrder = options.state.timelineOrder.filter(
    (key) => key.startsWith(CODEX_TIMELINE_SUBAGENT_PREFIX) || currentItemKeys.has(key),
  );
  const timelineKeys = new Set(timelineOrder);
  for (const key of itemKeys) {
    if (timelineKeys.has(key)) continue;
    timelineOrder.push(key);
    timelineKeys.add(key);
  }

  // An empty successful snapshot is authoritative and removes stale rows. A
  // failed load is not authoritative, so retain the last successful snapshot
  // until a later render can reconcile it.
  if (subagentParts) {
    reconcileCodexSubagentTimeline(
      subagentParts,
      timelineOrder,
      options.state.subagentParts,
      options.state.subagentFingerprints,
    );
  }
  options.state.timelineOrder = timelineOrder;

  const parts: NormalizedPart[] = [];
  for (const key of timelineOrder) {
    if (key.startsWith(CODEX_TIMELINE_ITEM_PREFIX)) {
      const item = itemsByKey.get(key.slice(CODEX_TIMELINE_ITEM_PREFIX.length));
      if (item) {
        const itemId = key.slice(CODEX_TIMELINE_ITEM_PREFIX.length);
        const accumulator = accumulatorsByKey.get(itemId);
        const cached = options.state.completedItemParts.get(itemId);
        if (accumulator?.completed && cached?.source === accumulator.item) {
          // `itemToParts` touches a file's baseline while rendering its diff.
          // A completed-item cache hit skips that function, so without the
          // equivalent touch here an actively re-rendered file looks cold to
          // the LRU and can be evicted ahead of truly unused baselines.
          touchCachedPartBaselines(cached.parts, options.cwd, options.state.fileChange.baselines);
          parts.push(...cached.parts);
        } else {
          const itemParts = await itemToParts(item, options.cwd, options.state.fileChange);
          const createdAt =
            typeof accumulator?.startedAt === "number" && Number.isFinite(accumulator.startedAt)
              ? new Date(accumulator.startedAt).toISOString()
              : undefined;
          const stampedParts = createdAt
            ? itemParts.map((part) => (part.createdAt ? part : { ...part, createdAt }))
            : itemParts;
          if (accumulator?.completed) {
            options.state.completedItemParts.set(itemId, {
              source: accumulator.item,
              parts: stampedParts,
            });
          } else {
            options.state.completedItemParts.delete(itemId);
          }
          parts.push(...stampedParts);
        }
      }
      continue;
    }
    const subagentPart = options.state.subagentParts.get(key);
    if (subagentPart) parts.push(subagentPart);
  }

  // The message body is the last agent message; tool output stays in parts.
  const finalText = items
    .filter(
      (item): item is Extract<EngineItem, { type: "agent_message" }> =>
        item.type === "agent_message" && item.text.length > 0,
    )
    .at(-1)?.text;

  return {
    parts,
    content: finalText || parts.find((part) => part.type === "text")?.content || "",
  };
}
