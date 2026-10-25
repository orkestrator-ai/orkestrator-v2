/**
 * The assistant rows of an active turn: opening them, deciding which need a
 * render, and publishing them.
 *
 * A turn renders as one assistant row per model response, plus a row after
 * each steer. It used to be one row per turn, and a turn left running for
 * hours (thousands of parts, megabytes) then no longer fit any transcript
 * window: readers could only show a trimmed copy of it and lost it entirely
 * once a newer row pushed it out of the live tail. A reload from the rollout
 * splits at the same boundaries (`history/rollout.ts`).
 */
import {
  type HistoricalAssistantSegmentState,
  isSamePublishedPart,
  MAX_HELD_ASSISTANT_ROWS,
  MAX_TRACKED_ASSISTANT_ROWS,
  normalizedMessageSnapshotChars,
  type ReleasedAssistantRow,
  type RuntimeSseEvent,
  type ThreadRuntimeState,
} from "./app-server-runtime-base.js";
import {
  beginAssistantRowRenderState,
  renderTurn,
  SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
  type TurnRenderState,
} from "./messages/render-turn.js";
import {
  createMessageId,
  type MessagePatchEventData,
  type NormalizedMessage,
  type NormalizedPart,
} from "./messages/types.js";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { EngineEvent } from "./engine/types.js";
import type { ThreadContext } from "./sessions/thread-registry.js";
import type { AssistantSegment, TurnAccumulator } from "./sessions/turn-accumulator.js";

/** Apply a late measurement at any depth in a rendered subagent row. */
export function patchCommandChangePart(
  part: NormalizedPart,
  itemId: string,
  change: MeasuredWorkspaceChange,
): NormalizedPart {
  if (part.type === "tool-invocation" && part.toolUseId === itemId) {
    return part.commandChanges === change ? part : { ...part, commandChanges: change };
  }
  if (!part.subagentActions) return part;
  const actions = part.subagentActions.map((action) =>
    patchCommandChangePart(action, itemId, change),
  );
  return actions.some((action, index) => action !== part.subagentActions?.[index])
    ? { ...part, subagentActions: actions }
    : part;
}

/** The newest message with `id`; an active turn's rows are at the tail. */
export function findMessageFromTail(
  messages: readonly NormalizedMessage[],
  id: string,
): NormalizedMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.id === id) return messages[index];
  }
  return undefined;
}

/**
 * Looks up several rows in one backwards pass, stopping once all are found.
 * The rows of the active turn are the newest messages, so this costs the
 * turn's tail rather than the whole transcript.
 */
function findMessagesFromTail(
  messages: readonly NormalizedMessage[],
  ids: ReadonlySet<string>,
): Map<string, NormalizedMessage> {
  const found = new Map<string, NormalizedMessage>();
  for (let index = messages.length - 1; index >= 0 && found.size < ids.size; index -= 1) {
    const message = messages[index]!;
    if (ids.has(message.id) && !found.has(message.id)) found.set(message.id, message);
  }
  return found;
}

/**
 * Moves the streaming row into the tracked rows and opens the next row.
 *
 * Synchronous on purpose: a model-response split happens on the notification
 * path, which must never await rendering. The new message is in the
 * transcript at once; the caller decides when the client is told about it.
 * A publish already rendering the old row is unaffected, because it resolves
 * the row's publish state again once its render returns.
 */
export function openAssistantRow(
  context: ThreadContext,
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  options: {
    boundary: number;
    /** Lower sub-agent probe bound for the new row. */
    startedAt: string;
    createdAt: string;
    /**
     * The boundary left every item the row last rendered in place, so that
     * render stands. A steer can move items below itself; a new response
     * cannot.
     */
    keepsRenderedItems: boolean;
  },
): NormalizedMessage {
  const previousId = turn.assistantMessageId;
  const previous = findMessageFromTail(context.messages, previousId);
  const assistantMessage: NormalizedMessage = {
    id: createMessageId(),
    role: "assistant",
    content: "",
    parts: [],
    createdAt: options.createdAt,
    ...(turn.isUnconfirmed() ? {} : { turnId: turn.turnId }),
    revision: 1,
    ...(previous?.modelId ? { modelId: previous.modelId } : {}),
    ...(previous?.planReview ? { planReview: true } : {}),
  };
  context.messages.push(assistantMessage);
  state.historicalAssistantSegments.set(previousId, {
    render: state.render,
    publishedParts: state.publishedParts,
    ...(state.publishedModelId ? { publishedModelId: state.publishedModelId } : {}),
    announced: state.publishedMessageId === previousId,
    ...(options.keepsRenderedItems && state.renderedRow?.id === previousId
      ? { renderedItemVersion: state.renderedRow.itemVersion }
      : {}),
  });
  retireExcessRows(state, turn);
  turn.startAssistantSegment(assistantMessage.id, options.boundary, options.startedAt);
  state.render = beginAssistantRowRenderState(state.render);
  state.renderedRow = undefined;
  state.assistantMessageId = assistantMessage.id;
  // Not announced yet: the next publish sends the row whole, after the rows
  // above it, so it can never be patched before the client has seen it.
  state.publishedMessageId = undefined;
  state.publishedParts = [];
  state.publishedModelId = assistantMessage.modelId;
  return assistantMessage;
}

/** A row whose sub-agent card a transcript probe may still move. */
function awaitsSubagent(row: HistoricalAssistantSegmentState): boolean {
  return row.render.subagentActivity && !row.render.subagentSettled;
}

/**
 * Lets the least recently tracked rows past `MAX_TRACKED_ASSISTANT_ROWS` go.
 *
 * `Map` iterates in insertion order, so the first rows are the least recently
 * tracked. A row that still owes a render gets it, as `retiring`, then is
 * released; one that does not is released now. Its published parts stand, and
 * a later change to one of its items tracks it again (`trackChangedRows`).
 * Deliberately *not* `releaseTurnRenderState`: every row of a turn shares one
 * `fileChange` context, so releasing one would clear the live row's diff
 * cache.
 *
 * A row waiting on a sub-agent is held instead, up to
 * `MAX_HELD_ASSISTANT_ROWS`, because nothing but the probe would move its card.
 */
export function retireExcessRows(
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  now: number = Date.now(),
): void {
  const rows = state.historicalAssistantSegments;
  let excess = rows.size - MAX_TRACKED_ASSISTANT_ROWS;
  if (excess <= 0) return;
  const retire = (id: string, row: HistoricalAssistantSegmentState) => {
    const segment = turn.findAssistantSegment(id);
    if (segment && segmentNeedsRender(turn, segment, row, now)) row.retiring = true;
    else releaseRow(state, turn, id, row);
    excess -= 1;
  };
  for (const [id, row] of rows) {
    if (excess <= 0) return;
    if (row.retiring) excess -= 1;
    else if (!awaitsSubagent(row)) retire(id, row);
  }
  // Every row still past the bound is waiting on a sub-agent.
  for (const [id, row] of rows) {
    if (excess <= MAX_HELD_ASSISTANT_ROWS) return;
    if (!row.retiring) retire(id, row);
  }
}

/**
 * Drops a tracked row's render state, keeping in `releasedAssistantRows` what
 * tracking it again needs to render it as it was (`ReleasedAssistantRow`).
 */
function releaseRow(
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  id: string,
  row: HistoricalAssistantSegmentState,
): void {
  state.historicalAssistantSegments.delete(id);
  const render = row.render;
  let diffParts: TurnRenderState["completedItemParts"] | undefined;
  for (const [itemId, entry] of render.completedItemParts) {
    if (!entry.parts.some((part) => part.toolDiff)) continue;
    (diffParts ??= new Map()).set(itemId, entry);
  }
  const subagents =
    render.subagentParts.size > 0
      ? { timelineOrder: render.timelineOrder, parts: render.subagentParts }
      : undefined;
  // Its last render was before the turn ended, so a card it shows may read
  // as running after the agent finished, with nothing left to probe it.
  const awaitingSubagent = awaitsSubagent(row) && !(turn.isTerminal() && row.renderedTerminal);
  if (!diffParts && !subagents && !awaitingSubagent) {
    state.releasedAssistantRows.delete(id);
    return;
  }
  state.releasedAssistantRows.set(id, {
    ...(diffParts ? { diffParts } : {}),
    ...(subagents ? { subagents } : {}),
    awaitingSubagent,
  });
}

/**
 * Render state for a released row tracked again: fresh, sharing the turn's,
 * as a new row's is, seeded with what the row kept. A seeded item renders
 * again only if it changed since; a file change rendered anew would diff
 * against a file later edits have moved, and come out blank.
 */
function trackedAgainRenderState(
  state: ThreadRuntimeState,
  released: ReleasedAssistantRow | undefined,
): TurnRenderState {
  const render = beginAssistantRowRenderState(state.render);
  if (released?.diffParts) render.completedItemParts = released.diffParts;
  if (released?.subagents) {
    // A card whose fingerprint is unknown moves below every item, so its
    // place is kept with it.
    render.timelineOrder = released.subagents.timelineOrder;
    render.subagentParts = released.subagents.parts;
    for (const [key, part] of render.subagentParts) {
      render.subagentFingerprints.set(key, JSON.stringify(part));
    }
  }
  return render;
}

/**
 * Tracks again every frozen row whose items moved after it was let go, so a
 * late change — a command finishing or streaming output, a raw patch settling,
 * a measurement, the turn ending around an unfinished call — reaches the row
 * holding it however far back that is. Once the turn has ended, so is every
 * row let go while a sub-agent card it shows could still read as running: the
 * end's probe is the last that can settle it.
 *
 * The row starts from the render state `trackedAgainRenderState` gives it,
 * and its last published parts as the baseline the next publish diffs
 * against. It was announced before it was let go, so it takes a patch.
 */
function trackChangedRows(
  context: ThreadContext,
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  now: number,
): void {
  const ids = turn.takeChangedFrozenRows();
  if (turn.isTerminal()) {
    for (const [id, released] of state.releasedAssistantRows) {
      if (released.awaitingSubagent) ids.push(id);
    }
  }
  let tracked = false;
  for (const id of ids) {
    if (id === turn.assistantMessageId || state.historicalAssistantSegments.has(id)) continue;
    const message = findMessageFromTail(context.messages, id);
    if (!message) continue;
    const released = state.releasedAssistantRows.get(id);
    state.releasedAssistantRows.delete(id);
    state.historicalAssistantSegments.set(id, {
      render: trackedAgainRenderState(state, released),
      publishedParts: message.parts.slice(),
      ...(message.modelId ? { publishedModelId: message.modelId } : {}),
      announced: true,
    });
    tracked = true;
  }
  if (tracked) retireExcessRows(state, turn, now);
}

/**
 * Gives the next model response a row of its own before `event` lands in it
 * (see `TurnAccumulator.opensModelStep`), returning whether it did.
 *
 * Runs on the notification path, so nothing here awaits: the row the response
 * leaves behind is published, then the new one announced, by the next
 * coalesced publish. The new row starts when app-server says its first item
 * did, which is also where the sub-agent probe of the row before it ends.
 */
export function openModelResponseRow(
  context: ThreadContext,
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  event: EngineEvent,
  now: number,
): boolean {
  if (!turn.opensModelStep(event)) return false;
  const startedAtMs = "startedAtMs" in event ? event.startedAtMs : undefined;
  const startedAt = new Date(startedAtMs ?? now).toISOString();
  const boundary = turn.freezeAssistantSegment(turn.itemOrder.length, startedAt);
  openAssistantRow(context, state, turn, {
    boundary,
    startedAt,
    createdAt: startedAt,
    keepsRenderedItems: true,
  });
  return true;
}

/**
 * True when re-rendering a frozen assistant row could produce a different
 * result than the render already published for it.
 *
 * Three things can move a frozen row: one of its items mutated, the turn
 * ended (raw patch fallbacks and structured output render differently once
 * it is terminal), or a sub-agent it shows reported progress. `renderTurn`
 * resolves everything else from `completedItemParts` and the retained
 * sub-agent map, so the output would be identical. A row whose sub-agents have
 * all finished is not probed again until a lifecycle item somewhere in the
 * turn (a wait, or a message reopening one of them) gives it new evidence.
 *
 * Note this asks "has anything changed *since the last render*", not "can
 * anything change from here". An item that completed a moment ago still owes
 * one render even though it can never move again.
 */
export function segmentNeedsRender(
  turn: TurnAccumulator,
  segment: AssistantSegment,
  historical: HistoricalAssistantSegmentState,
  now: number = Date.now(),
): boolean {
  if (turn.assistantSegmentVersion(segment.assistantMessageId) !== historical.renderedItemVersion) {
    return true;
  }
  if (turn.isTerminal()) return !historical.renderedTerminal;
  // Only a row with sub-agent activity has anything for the periodic
  // transcript probe to update.
  if (historical.retiring || !historical.render.subagentActivity) return false;
  if (
    historical.render.subagentSettled &&
    historical.render.subagentEvidenceVersion === turn.subagentEvidenceVersion
  ) {
    return false;
  }
  const probedAt = historical.render.subagentProbedAt;
  return probedAt === 0 || now - probedAt >= SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS;
}

export interface PublishAssistantRowsOptions {
  cwd: string;
  emit: (event: RuntimeSseEvent) => void;
  /** Bumps the transcript revision, noting `revised` rows for late readers. */
  bumpMessageRevision: (context: ThreadContext, revised: readonly NormalizedMessage[]) => void;
  /** Called after a row renders, for state derived from its parts. */
  onRendered: (message: NormalizedMessage) => void;
}

/**
 * Re-renders the rows of the active turn that may have moved and publishes a
 * sparse update for each.
 *
 * A tick costs the rows that actually need a render — the live row, plus any
 * frozen row whose items moved or whose sub-agents are due a probe — not every
 * row of the turn, so a turn of thousands of responses streams as cheaply as
 * one of a few.
 */
export async function publishAssistantRows(
  context: ThreadContext,
  state: ThreadRuntimeState,
  turn: TurnAccumulator,
  options: PublishAssistantRowsOptions,
): Promise<void> {
  const now = Date.now();
  trackChangedRows(context, state, turn, now);
  const due: string[] = [];
  for (const [id, historical] of state.historicalAssistantSegments) {
    const segment = turn.findAssistantSegment(id);
    if (segment && segmentNeedsRender(turn, segment, historical, now)) {
      due.push(id);
    } else if (historical.retiring) {
      releaseRow(state, turn, id, historical);
    }
  }
  due.push(turn.assistantMessageId);
  const messages = findMessagesFromTail(context.messages, new Set(due));

  let snapshotChars = 0;
  for (const id of due) {
    const segment = turn.findAssistantSegment(id);
    const message = messages.get(id);
    if (!segment || !message) continue;
    const startedCurrent = id === turn.assistantMessageId;
    const startedHistorical = state.historicalAssistantSegments.get(id);
    if (!startedCurrent && !startedHistorical) continue;
    const renderState = startedCurrent ? state.render : startedHistorical!.render;
    const itemVersion = turn.assistantSegmentVersion(id);
    const rendered = await renderTurn(turn, {
      threadId: context.threadId,
      cwd: options.cwd,
      state: renderState,
      segment,
      subagentProbeIntervalMs: SUBAGENT_TRANSCRIPT_PROBE_INTERVAL_MS,
      ...(startedHistorical && !renderState.subagentActivity ? { skipSubagentProbe: true } : {}),
    });

    // Resolved again: a model response may have opened a new row while this
    // one rendered, which moves its publish state into the tracked rows.
    const isCurrent = id === turn.assistantMessageId;
    const historical = isCurrent ? undefined : state.historicalAssistantSegments.get(id);
    if (!isCurrent && !historical) continue;
    const row: { publishedParts: NormalizedPart[]; publishedModelId?: string } = isCurrent
      ? state
      : historical!;
    message.parts = rendered.parts;
    message.content = rendered.content;
    options.onRendered(message);
    snapshotChars += normalizedMessageSnapshotChars(message);
    // Sampled before the render, so an item that mutated while it was awaited
    // still shows as pending work rather than being recorded as rendered.
    if (isCurrent) state.renderedRow = { id, itemVersion };
    if (historical) {
      historical.renderedItemVersion = itemVersion;
      if (turn.isTerminal()) historical.renderedTerminal = true;
      if (historical.retiring) releaseRow(state, turn, id, historical);
    }

    // The announcement half of this guard is what makes the first publish of
    // any assistant row a whole snapshot. Without it a path that swaps the
    // streaming row without resetting `publishedParts` emits a patch for a
    // message the client has never seen, which it can only answer by
    // refetching the entire transcript.
    const announced = isCurrent ? state.publishedMessageId === id : historical!.announced;
    if (!announced || row.publishedModelId !== message.modelId) {
      if (isCurrent) state.publishedMessageId = id;
      else historical!.announced = true;
      row.publishedParts = message.parts.slice();
      row.publishedModelId = message.modelId;
      message.revision = (message.revision ?? 0) + 1;
      options.bumpMessageRevision(context, [message]);
      for (const sessionId of context.bridgeSessionIds) {
        options.emit({ type: "message.updated", sessionId, data: { message } });
      }
      continue;
    }

    const publishedParts = row.publishedParts;
    const changedParts: { index: number; part: NormalizedPart }[] = [];
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (part && !isSamePublishedPart(publishedParts[index], part)) {
        changedParts.push({ index, part });
      }
    }
    if (changedParts.length === 0 && message.parts.length === publishedParts.length) {
      continue;
    }

    row.publishedParts = message.parts.slice();
    message.revision = (message.revision ?? 0) + 1;
    options.bumpMessageRevision(context, [message]);
    const patch = {
      messageId: message.id,
      partCount: message.parts.length,
      changedParts,
      content: message.content,
      createdAt: message.createdAt,
      turnId: message.turnId,
      revision: message.revision,
    } satisfies MessagePatchEventData;
    for (const sessionId of context.bridgeSessionIds) {
      options.emit({ type: "message.patched", sessionId, data: patch });
    }
  }
  // Only what this tick rendered: a frozen row costs a publish nothing, so it
  // must not slow the cadence of the live one.
  state.lastPublishedSnapshotChars = snapshotChars;
  // A row held for a sub-agent it turned out not to have (every row is held
  // until its first render says) can go now.
  retireExcessRows(state, turn, now);
}
