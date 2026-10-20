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
  isCodexSpawnTool,
  normalizeCodexCollabToolCallItem,
  reconcileCodexSubagentTimeline,
} from "../codex-collaboration.js";
import { deriveTranscriptSubagentPartsForTurn } from "../subagent-transcript-parts.js";
import { indexAgentPaths } from "../subagent-spawn.js";
import {
  cachedTranscriptQueries,
  type TranscriptLike,
  type TranscriptQueries,
} from "../transcript-queries.js";
import {
  createSharedTranscriptMetaLoader,
  resolvePersistedChildThreadIds,
} from "../history/rollout.js";
import { isWithheldMachineOutput } from "@orkestrator/protocol/structured-output";
import { agentMessageDisplayText, isAuthoritativeAgentMessage } from "./agent-message.js";
import { hasVisibleText, itemToParts } from "./normalization.js";
import { withCommandChanges } from "../sessions/command-changes.js";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
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
   *
   * `commandChanges` is part of the key: a command's measurement lands after
   * the item completed, and must still reach its row.
   */
  completedItemParts: Map<
    string,
    {
      source: EngineItem | null;
      commandChanges?: MeasuredWorkspaceChange;
      parts: NormalizedPart[];
    }
  >;
  /** Machine-output classification cached by the accumulator mutation version. */
  machineOutputByItem: Map<
    string,
    { source: EngineItem | null; version: number; withheld: boolean }
  >;
  subagentParts: Map<string, NormalizedPart>;
  subagentFingerprints: Map<string, string>;
  /** Positive, ambiguous, and absent child-path lookups retained for this turn. */
  subagentPathIds: Map<string, string | null | undefined>;
  /** Cached misses already retried by the final authoritative probe. */
  subagentTerminalPathRetries: Set<string>;
  /**
   * The assistant row each sub-agent's card belongs to, shared by every row of
   * a turn. A row whose own item spawned the agent claims it outright; any
   * other row naming it (a later wait or send) defers to whichever row showed
   * it first, so one agent is one card per turn.
   */
  subagentOwners: Map<string, string>;
  /** When the rollout-transcript probe for sub-agent activity last ran. */
  subagentProbedAt: number;
  /**
   * The last render showed a sub-agent card or held an item that could give
   * it one, so a later transcript probe may still change the row. True until
   * the first render.
   */
  subagentActivity: boolean;
  /**
   * Every sub-agent the row shows has finished and every agent it spawned has
   * its card, so only new lifecycle evidence (`subagentEvidenceVersion`) can
   * move it again.
   */
  subagentSettled: boolean;
  /** `TurnAccumulator.subagentEvidenceVersion` as of the last probe. */
  subagentEvidenceVersion: number;
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
export const MAX_SUBAGENT_PATH_RESOLUTIONS_PER_TURN = 128;

export function createTurnRenderState(): TurnRenderState {
  return {
    timelineOrder: [],
    completedItemParts: new Map(),
    machineOutputByItem: new Map(),
    subagentParts: new Map(),
    subagentFingerprints: new Map(),
    subagentPathIds: new Map(),
    subagentTerminalPathRetries: new Set(),
    subagentOwners: new Map(),
    subagentProbedAt: 0,
    subagentActivity: true,
    subagentSettled: false,
    subagentEvidenceVersion: -1,
    fileChange: { cache: new Map() },
  };
}

/**
 * Render state for the next assistant row of the **same** turn.
 *
 * Row-scoped state (timeline, completed-part and sub-agent caches) starts
 * fresh; turn-scoped state is shared, the per-item diff cache included, so a
 * row still rendering an earlier change reuses that change's diff.
 */
export function beginAssistantRowRenderState(previous: TurnRenderState): TurnRenderState {
  const fresh = createTurnRenderState();
  fresh.fileChange = previous.fileChange;
  fresh.subagentPathIds = previous.subagentPathIds;
  fresh.subagentTerminalPathRetries = previous.subagentTerminalPathRetries;
  fresh.subagentOwners = previous.subagentOwners;
  return fresh;
}

/** Frees a thread's render state; recoverable, since the rollout is authoritative. */
export function releaseTurnRenderState(state: TurnRenderState): void {
  state.timelineOrder.length = 0;
  state.completedItemParts.clear();
  state.machineOutputByItem.clear();
  state.subagentParts.clear();
  state.subagentFingerprints.clear();
  state.subagentPathIds.clear();
  state.subagentTerminalPathRetries.clear();
  state.subagentOwners.clear();
  state.subagentProbedAt = 0;
  state.subagentSettled = false;
  state.fileChange.cache.clear();
}

function joinReasoning(summary: string[], content: string[]): string {
  const source = summary.some(hasVisibleText) ? summary : content;
  return source.filter(hasVisibleText).join("\n\n");
}

function terminalStructuredOutputItemId(turn: TurnAccumulator): string | undefined {
  if (!turn.expectsStructuredOutput || turn.phase !== "completed") return undefined;
  // Keep this selection identical to parseCodexStructuredOutput: the last
  // authoritative agent item wins even when its text is empty. Falling back to
  // an earlier non-empty item would promote a draft after parsing rejected the
  // actual final record.
  return turn
    .ordered()
    .filter((entry) => isAuthoritativeAgentMessage(entry.item))
    .at(-1)?.id;
}

function isMachineOutput(
  state: TurnRenderState,
  accumulator: ItemAccumulator | undefined,
  item: EngineItem,
): boolean {
  if (item.type !== "agent_message") return false;
  const version = accumulator?.version ?? -1;
  const source = accumulator?.item ?? null;
  const cached = state.machineOutputByItem.get(item.id);
  if (cached?.version === version && cached.source === source) return cached.withheld;
  const withheld = isWithheldMachineOutput(item.text);
  state.machineOutputByItem.set(item.id, { source, version, withheld });
  return withheld;
}

function suppressStructuredOutputDraft(
  turn: TurnAccumulator,
  state: TurnRenderState,
  accumulator: ItemAccumulator | undefined,
  item: EngineItem,
  finalItemId: string | undefined,
): boolean {
  return (
    turn.expectsStructuredOutput &&
    item.type === "agent_message" &&
    item.phase !== "commentary" &&
    item.id !== finalItemId &&
    isMachineOutput(state, accumulator, item)
  );
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
    case "agent_message": {
      const settled =
        item.text.length > 0 ? item : ({ ...item, text: accumulator.textDelta } as typeof item);
      // A response cut off before it said anything leaves nothing to show, and
      // nothing will ever arrive to fill the empty row in.
      if (accumulator.interrupted && !hasVisibleText(settled.text)) return null;
      return settled;
    }
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
  /**
   * Skip the sub-agent transcript probe, keeping the row's last snapshot. For
   * a frozen row with no sub-agent evidence, where a probe can find nothing.
   */
  skipSubagentProbe?: boolean;
}

export interface SubagentPartsLoadOptions {
  threadId: string | null;
  turnStartedAt?: string;
  turnEndedAt?: string;
  items: EngineItem[];
  /**
   * Sub-agent lifecycle items from the turn's later rows. A child spawned in
   * this row reports back through waits and activity beats that arrive while
   * later responses stream; its card here still has to show their outcome.
   */
  followingItems?: EngineItem[];
  /** Per-turn cache; `has(path)` distinguishes a cached miss from no lookup. */
  childPathResolutions?: Map<string, string | null | undefined>;
  /** A terminal probe may retry each cached miss exactly once. */
  retryMissingChildPaths?: boolean;
  retriedMissingChildPaths?: Set<string>;
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
    // Multi-agent v2 send_message/followup_task emit no collab item at all, only
    // `subagent_activity` beats; without their ids a row that messages an
    // earlier turn's child gets a status-only card with no transcript behind it.
    const referenced = subagentIdsNamedBy(items);
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
  /**
   * Bounded rollout queries: the parent's current-turn records and each
   * child's incremental summary. Defaults to the shared rollout cache.
   */
  transcriptQueries?: TranscriptQueries;
  /** Whole in-memory transcripts instead of `transcriptQueries` (fixtures). */
  readTranscript?: (path: string) => Promise<TranscriptLike>;
  resolveChildPaths?: typeof resolvePersistedChildThreadIds;
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
    transcriptQueries: cachedTranscriptQueries,
    resolveChildPaths: resolvePersistedChildThreadIds,
  },
): Promise<NormalizedPart[]> {
  const loadSessionMeta = dependencies.createTranscriptMetaLoader();
  const owned = ownedSubagentIds(options.items);
  const resolveChildPaths = dependencies.resolveChildPaths ?? resolvePersistedChildThreadIds;
  const resolveChildPathsCached = options.childPathResolutions
    ? async (parentId: string, paths: readonly string[]) => {
        const remainingCapacity = Math.max(
          0,
          MAX_SUBAGENT_PATH_RESOLUTIONS_PER_TURN - options.childPathResolutions!.size,
        );
        const uncached = paths
          .filter((path) => !options.childPathResolutions!.has(path))
          .slice(0, remainingCapacity);
        const terminalRetries = options.retryMissingChildPaths
          ? paths.filter(
              (path) =>
                options.childPathResolutions!.has(path) &&
                options.childPathResolutions!.get(path) === undefined &&
                !options.retriedMissingChildPaths?.has(path),
            )
          : [];
        const lookupPaths = [...terminalRetries, ...uncached].slice(
          0,
          MAX_SUBAGENT_PATH_RESOLUTIONS_PER_TURN,
        );
        if (lookupPaths.length > 0) {
          const discovered = await resolveChildPaths(parentId, lookupPaths);
          for (const path of lookupPaths) {
            options.childPathResolutions!.set(
              path,
              discovered.has(path) ? discovered.get(path) : undefined,
            );
          }
          const terminalRetryPaths = new Set(terminalRetries);
          for (const path of lookupPaths) {
            if (terminalRetryPaths.has(path)) options.retriedMissingChildPaths?.add(path);
          }
        }
        const resolved = new Map<string, string | null>();
        for (const path of paths) {
          const value = options.childPathResolutions!.get(path);
          if (value !== undefined) resolved.set(path, value);
        }
        return resolved;
      }
    : resolveChildPaths;
  const transcriptParts = await dependencies.deriveTranscriptParts({
    threadId: options.threadId,
    currentTurnStartedAt: options.turnStartedAt,
    ...(options.turnEndedAt ? { currentTurnEndedAt: options.turnEndedAt } : {}),
    ...(owned ? { ownedSubagentIds: owned } : {}),
    fallbackAgentIdsInSpawnOrder: getCodexSpawnedAgentIdsInOrder(options.items),
    activityAgentIdsByPath: indexAgentPaths(options.items),
    resolveChildPaths: resolveChildPathsCached,
    loadSessionMeta,
    ...(dependencies.readTranscript
      ? { loadTranscript: dependencies.readTranscript }
      : { transcriptQueries: dependencies.transcriptQueries ?? cachedTranscriptQueries }),
  });
  // Native collab items carry live agent status; fold it onto the transcript parts.
  const reconciled = applyCodexCollabStateToSubagentParts(transcriptParts, [
    ...options.items,
    ...followingEvidenceFor(transcriptParts, options.items, options.followingItems ?? []),
  ]);
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
    ...(part.subagentModelId ? { subagentModelId: part.subagentModelId } : {}),
    ...(part.subagentReasoningEffort
      ? { subagentReasoningEffort: part.subagentReasoningEffort }
      : {}),
  }));
}

/**
 * The parts of later rows' lifecycle items that report on agents this row
 * already shows, narrowed to those agents.
 *
 * Narrowed so a later item can update this row's cards but never add one: a
 * wait on several agents must not pull in an agent a later row spawned, and a
 * spawn item is left out entirely because unidentified spawns are paired with
 * transcript rows by position.
 */
function followingEvidenceFor(
  transcriptParts: readonly { subagentId?: string }[],
  items: readonly EngineItem[],
  followingItems: readonly EngineItem[],
): EngineItem[] {
  if (followingItems.length === 0) return [];
  const shown = new Set<string>();
  for (const part of transcriptParts) if (part.subagentId) shown.add(part.subagentId);
  for (const agentId of subagentIdsNamedBy(items)) shown.add(agentId);
  if (shown.size === 0) return [];
  const evidence: EngineItem[] = [];
  for (const item of followingItems) {
    if (item.type === "subagent_activity") {
      if (shown.has(item.agent_thread_id)) evidence.push(item);
      continue;
    }
    const collab = normalizeCodexCollabToolCallItem(item);
    if (!collab || isCodexSpawnTool(collab.tool)) continue;
    const receivers = (collab.receiver_thread_ids ?? []).filter((agentId) => shown.has(agentId));
    if (receivers.length === 0) continue;
    const states = Object.fromEntries(
      Object.entries(collab.agents_states ?? {}).filter(([agentId]) => shown.has(agentId)),
    );
    evidence.push({ ...collab, receiver_thread_ids: receivers, agents_states: states });
  }
  return evidence;
}

/** Every agent id a row's own collaboration and activity items name. */
function subagentIdsNamedBy(items: readonly EngineItem[]): Set<string> {
  const named = new Set<string>();
  for (const item of items) {
    if (item.type === "subagent_activity") {
      named.add(item.agent_thread_id);
      continue;
    }
    const collab = normalizeCodexCollabToolCallItem(item);
    if (!collab) continue;
    for (const agentId of collab.receiver_thread_ids ?? []) named.add(agentId);
    for (const agentId of Object.keys(collab.agents_states ?? {})) named.add(agentId);
  }
  return named;
}

/**
 * True when a row's items could give it a sub-agent card: it spawned one, or
 * names one no other row of the turn shows. A row that only waits on agents
 * another row shows has nothing for a transcript probe to find.
 */
function rowMayShowSubagents(
  items: readonly EngineItem[],
  rowId: string,
  owners: ReadonlyMap<string, string>,
): boolean {
  const ownedHere = (agentId: string) => (owners.get(agentId) ?? rowId) === rowId;
  for (const item of items) {
    if (item.type === "subagent_activity") {
      if (ownedHere(item.agent_thread_id)) return true;
      continue;
    }
    const collab = normalizeCodexCollabToolCallItem(item);
    if (!collab) continue;
    if (isCodexSpawnTool(collab.tool)) return true;
    if ((collab.receiver_thread_ids ?? []).some(ownedHere)) return true;
    if (Object.keys(collab.agents_states ?? {}).some(ownedHere)) return true;
  }
  return false;
}

/**
 * True when every sub-agent card a row shows has finished and every agent it
 * spawned has its card, so no probe can change it. A card still pending, a
 * spawn still in flight, or one the probe has not found yet still can.
 *
 * A spawn that failed started no agent, so it waits for none. A spawn naming
 * no agent (multi-agent v2 returns no id) is paired with a transcript card by
 * position, which carries the agent's id instead, so it is matched by count:
 * one card no named spawn accounts for. Requiring an id of it, or a card of a
 * failed spawn, kept such a row probing for the rest of the turn.
 */
function subagentCardsSettled(
  items: readonly EngineItem[],
  cards: ReadonlyMap<string, NormalizedPart>,
): boolean {
  const shown = new Set<string>();
  for (const card of cards.values()) {
    if (card.toolState !== "success" && card.toolState !== "failure") return false;
    if (card.subagentId) shown.add(card.subagentId);
  }
  const named = new Set<string>();
  let unnamed = 0;
  let spawns = 0;
  for (const item of items) {
    const collab = normalizeCodexCollabToolCallItem(item);
    if (!collab || !isCodexSpawnTool(collab.tool)) continue;
    spawns += 1;
    if (collab.status === "failed") continue;
    if (collab.status === "in_progress") return false;
    const [agentId] = getCodexSpawnedAgentIdsInOrder([collab]);
    if (agentId === undefined) unnamed += 1;
    else if (shown.has(agentId)) named.add(agentId);
    else return false;
  }
  let unclaimed = 0;
  for (const card of cards.values()) {
    if (!card.subagentId || !named.has(card.subagentId)) unclaimed += 1;
  }
  if (unclaimed < unnamed) return false;
  // A row with no card yet settles only when every spawn it made failed.
  return cards.size > 0 || spawns > 0;
}

function isSubagentLifecycleItem(item: EngineItem): boolean {
  return item.type === "subagent_activity" || item.type === "collab_tool_call";
}

/**
 * Keeps one card per agent across a turn's rows. A row spawning an agent
 * claims it outright; a row merely naming one claims it only if no row has.
 */
function ownSubagentParts(
  parts: NormalizedPart[],
  items: readonly EngineItem[],
  rowId: string,
  owners: Map<string, string>,
): NormalizedPart[] {
  claimSpawnedSubagents(items, rowId, owners);
  return parts.filter((part) => {
    const agentId = part.subagentId;
    if (!agentId) return true;
    const owner = owners.get(agentId);
    if (owner === undefined) owners.set(agentId, rowId);
    return owner === undefined || owner === rowId;
  });
}

function claimSpawnedSubagents(
  items: readonly EngineItem[],
  rowId: string,
  owners: Map<string, string>,
): void {
  for (const agentId of getCodexSpawnedAgentIdsInOrder(items as EngineItem[])) {
    if (agentId) owners.set(agentId, rowId);
  }
}

/** Lifecycle items in the turn's rows after `segment`, for its spawned agents. */
function followingLifecycleItems(turn: TurnAccumulator, segment?: AssistantSegment): EngineItem[] {
  if (segment?.endIndex === undefined) return [];
  const following: EngineItem[] = [];
  for (let index = segment.endIndex; index < turn.itemOrder.length; index += 1) {
    const item = turn.items.get(turn.itemOrder[index]!)?.item;
    if (item && isSubagentLifecycleItem(item)) following.push(item);
  }
  return following;
}

function subagentEvidenceFingerprint(items: readonly EngineItem[]): string {
  return JSON.stringify(
    items.flatMap((item) => {
      if (item.type === "subagent_activity") {
        return [[item.id, item.type, item.activity, item.agent_thread_id, item.agent_path]];
      }
      const collab = normalizeCodexCollabToolCallItem(item);
      return collab
        ? [
            [
              collab.id,
              collab.tool,
              collab.status,
              collab.receiver_thread_ids,
              collab.agents_states,
            ],
          ]
        : [];
    }),
  );
}

/**
 * Item kinds that are tool calls. A plan, todo list or error also renders as a
 * tool row, but it ran nothing, so a start-to-end gap is not a run time.
 */
const MEASURABLE_TOOL_ITEM_TYPES = new Set<EngineItem["type"]>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "web_search",
]);

/**
 * A finished tool call's run time from app-server's own lifecycle clocks, for
 * the calls whose item carries no duration of its own. Both stamps come from
 * the same backend clock (`item/started.startedAtMs`, `item/completed
 * .completedAtMs`), so the gap is the provider's measurement, not ours.
 */
function measuredToolDurationMs(
  item: EngineItem,
  accumulator: ItemAccumulator | undefined,
): number | undefined {
  if (!accumulator?.completed || !MEASURABLE_TOOL_ITEM_TYPES.has(item.type)) return undefined;
  const { startedAt, completedAt } = accumulator;
  if (typeof startedAt !== "number" || typeof completedAt !== "number") return undefined;
  return completedAt >= startedAt ? completedAt - startedAt : undefined;
}

function stampPart(
  part: NormalizedPart,
  createdAt: string | undefined,
  measuredDurationMs: number | undefined,
): NormalizedPart {
  const stampCreatedAt = createdAt !== undefined && !part.createdAt;
  const stampDuration =
    measuredDurationMs !== undefined &&
    part.type === "tool-invocation" &&
    part.toolDurationMs === undefined;
  if (!stampCreatedAt && !stampDuration) return part;
  return {
    ...part,
    ...(stampCreatedAt ? { createdAt } : {}),
    ...(stampDuration ? { toolDurationMs: measuredDurationMs } : {}),
  };
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
  const rowId = options.segment?.assistantMessageId ?? turn.assistantMessageId;
  const shouldProbe =
    !options.skipSubagentProbe &&
    (probeIntervalMs <= 0 ||
      turn.isTerminal() ||
      Date.now() - options.state.subagentProbedAt >= probeIntervalMs);
  let subagentParts: NormalizedPart[] | undefined;
  if (shouldProbe) {
    // Collected only here: streaming renders arrive ~10x/second while the probe
    // runs every couple of seconds, so a snapshot taken unconditionally would be
    // built and thrown away on the vast majority of renders.
    let loadSnapshot = collectTurnItems(turn, options.segment);
    const followingItems = followingLifecycleItems(turn, options.segment);
    options.state.subagentProbedAt = Date.now();
    // Sampled before the load, so evidence arriving while it is awaited still
    // reads as new to the next probe.
    options.state.subagentEvidenceVersion = turn.subagentEvidenceVersion;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const evidenceBefore = subagentEvidenceFingerprint(loadSnapshot.items);
        const loaded = await load({
          threadId: options.threadId,
          turnStartedAt: options.segment?.startedAt ?? turn.startedAt,
          ...(options.segment?.endedAt ? { turnEndedAt: options.segment.endedAt } : {}),
          items: loadSnapshot.items,
          ...(followingItems.length > 0 ? { followingItems } : {}),
          ...(!options.loadSubagentParts
            ? {
                childPathResolutions: options.state.subagentPathIds,
                retryMissingChildPaths: turn.isTerminal(),
                retriedMissingChildPaths: options.state.subagentTerminalPathRetries,
              }
            : {}),
        });
        const latestSnapshot = collectTurnItems(turn, options.segment);
        if (subagentEvidenceFingerprint(latestSnapshot.items) === evidenceBefore) {
          subagentParts = ownSubagentParts(
            loaded,
            latestSnapshot.items,
            rowId,
            options.state.subagentOwners,
          );
          break;
        }
        loadSnapshot = latestSnapshot;
      }
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
  claimSpawnedSubagents(items, rowId, options.state.subagentOwners);
  // app-server's output schema is turn-scoped, so both commentary and draft
  // final answers can be schema-shaped. Provider-labelled commentary is made
  // readable by `agentMessageDisplayText`; keep only unlabelled/final drafts out
  // of the transcript until the turn settles, then reveal the authoritative
  // final item read by structured-output parsing.
  const structuredOutputItemId = terminalStructuredOutputItemId(turn);

  // Reconcile the authoritative item set without rebuilding its order around
  // the sub-agent entries. New parent items belong at the end of the timeline;
  // a later sub-agent snapshot can then move its own row after them. Starting
  // from `[...itemKeys, ...existingSubagentKeys]` on every render would instead
  // pin even completed agents below every parent message that followed them.
  const currentItemKeys = new Set(itemKeys);
  for (const itemId of options.state.machineOutputByItem.keys()) {
    if (!currentItemKeys.has(`${CODEX_TIMELINE_ITEM_PREFIX}${itemId}`)) {
      options.state.machineOutputByItem.delete(itemId);
    }
  }
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
        const suppressDraft = suppressStructuredOutputDraft(
          turn,
          options.state,
          accumulator,
          item,
          structuredOutputItemId,
        );
        if (
          accumulator?.completed &&
          cached?.source === accumulator.item &&
          cached.commandChanges === accumulator.commandChanges
        ) {
          if (!suppressDraft) parts.push(...cached.parts);
        } else {
          const itemParts = withCommandChanges(
            await itemToParts(item, options.cwd, options.state.fileChange),
            itemId,
            accumulator?.commandChanges,
          );
          const createdAt =
            typeof accumulator?.startedAt === "number" && Number.isFinite(accumulator.startedAt)
              ? new Date(accumulator.startedAt).toISOString()
              : undefined;
          const measuredDurationMs = measuredToolDurationMs(item, accumulator);
          const stampedParts =
            createdAt || measuredDurationMs !== undefined
              ? itemParts.map((part) => stampPart(part, createdAt, measuredDurationMs))
              : itemParts;
          if (accumulator?.completed) {
            options.state.completedItemParts.set(itemId, {
              source: accumulator.item,
              ...(accumulator.commandChanges ? { commandChanges: accumulator.commandChanges } : {}),
              parts: stampedParts,
            });
          } else {
            options.state.completedItemParts.delete(itemId);
          }
          if (!suppressDraft) parts.push(...stampedParts);
          // A live progress line for a still-running item, in the same message
          // as the row it describes so the backend projection can fold it on.
          // Only for uncompleted items: the accumulator clears `progress` when
          // an item settles, and a settled row must not claim to be busy.
          if (accumulator?.progress && !accumulator.completed) {
            parts.push({
              type: "progress",
              content: accumulator.progress,
              toolUseId: itemId,
              ...(createdAt ? { createdAt } : {}),
            });
          }
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
        item.type === "agent_message" &&
        item.text.length > 0 &&
        !suppressStructuredOutputDraft(
          turn,
          options.state,
          accumulatorsByKey.get(item.id),
          item,
          structuredOutputItemId,
        ),
    )
    .map(agentMessageDisplayText)
    .at(-1);

  options.state.subagentActivity =
    options.state.subagentParts.size > 0 ||
    rowMayShowSubagents(items, rowId, options.state.subagentOwners);
  options.state.subagentSettled = subagentCardsSettled(items, options.state.subagentParts);

  return {
    parts,
    content: finalText || parts.find((part) => part.type === "text")?.content || "",
  };
}
