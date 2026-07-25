/**
 * Replays a recorded app-server stream through the real rendering pipeline.
 *
 * This is the regression net the migration plan's "golden fixtures" were meant to
 * be. The plan's original purpose — proving the app-server engine rendered
 * identically to the SDK engine — is gone with the SDK engine, so this does the
 * achievable and arguably more useful thing: it pins what a *real* recorded
 * session renders to, so a Codex upgrade that renames a field or adds an item
 * variant shows up as a diff in a committed snapshot rather than as a blank
 * transcript in the UI.
 *
 * The pipeline exercised here is the production one, not a reimplementation:
 *
 *     raw JSONL line
 *       → parseInboundLine        (envelope-validation.ts)
 *       → reduceNotification      (event-reducer.ts)
 *       → TurnAccumulator         (sessions/turn-accumulator.ts)
 *       → renderTurn              (messages/render-turn.ts)
 *
 * Sub-agent loading is stubbed by default: it reads rollout files from disk, which
 * a fixture cannot carry. Pass `loadSubagentParts` to exercise it.
 */
import { parseInboundLine } from "../app-server/envelope-validation.js";
import { reduceNotification } from "../app-server/event-reducer.js";
import { beginTurnRenderState, renderTurn } from "../messages/render-turn.js";
import { TurnAccumulator } from "../sessions/turn-accumulator.js";
import type { NormalizedPart } from "../messages/types.js";
import type { EngineEvent, EngineGeneration, EngineItem } from "../engine/types.js";
import type { RenderTurnOptions, TurnRenderState } from "../messages/render-turn.js";

export interface ReplayedTurn {
  threadId: string | null;
  turnId: string;
  phase: string;
  content: string;
  parts: NormalizedPart[];
  error?: { message: string; code?: string; details?: string };
  finalDiff?: string;
}

export interface ReplaySummary {
  /** Terminal turns in the order they completed, plus any still running at EOF. */
  turns: ReplayedTurn[];
  /** Notification methods the reducer did not recognise — the upgrade signal. */
  unknownMethods: string[];
  /** Item types that parsed but have no rendering — the other upgrade signal. */
  unsupportedItemTypes: string[];
  /** Lines that were not valid JSON-RPC at all. */
  invalidLines: number;
  /** Counts by envelope kind, so a fixture's shape is visible at a glance. */
  counts: { notifications: number; responses: number; serverRequests: number };
  /** Server-request methods seen — these are the approval-flow triggers. */
  serverRequestMethods: string[];
}

export interface ReplayOptions {
  cwd?: string;
  generation?: EngineGeneration;
  /** Stubbed by default; sub-agent parts live in rollout files a fixture lacks. */
  loadSubagentParts?: RenderTurnOptions["loadSubagentParts"];
  maxCommandOutputChars?: number;
}

const NO_SUBAGENT_PARTS = async (): Promise<NormalizedPart[]> => [];

/**
 * Applies one engine event to the accumulator set.
 *
 * Mirrors the runtime's dispatch, deliberately including its tolerance: a turn is
 * created on first sight of any event carrying a turn id, because a recording can
 * begin mid-turn and because deltas genuinely do arrive before `turn/started`.
 */
function applyEvent(
  event: EngineEvent,
  state: {
    turns: Map<string, TurnAccumulator>;
    order: string[];
    generation: EngineGeneration;
    renderState: TurnRenderState | undefined;
    maxCommandOutputChars: number | undefined;
  },
): void {
  const turnId = "turnId" in event ? event.turnId : undefined;
  if (!turnId) return;

  let turn = state.turns.get(turnId);
  if (!turn) {
    turn = new TurnAccumulator({
      threadId: ("threadId" in event ? event.threadId : null) ?? "",
      turnId,
      engineGeneration: state.generation,
      assistantMessageId: `replay-${turnId}`,
      startedAt: new Date(0).toISOString(),
      maxCommandOutputChars: state.maxCommandOutputChars,
    });
    state.turns.set(turnId, turn);
    state.order.push(turnId);
  }

  switch (event.kind) {
    case "turn.started":
      turn.markRunning(turnId);
      return;
    case "turn.completed":
      turn.complete(event.status, event.error);
      return;
    case "item.started":
      turn.onItemStarted(event.item as EngineItem);
      return;
    case "item.updated":
      turn.onItemUpdated(event.item as EngineItem);
      return;
    case "item.completed":
      turn.onItemCompleted(event.item as EngineItem);
      return;
    case "item.text.delta":
      turn.onTextDelta(event.itemId, event.delta);
      return;
    case "item.reasoning.delta":
      turn.onReasoningDelta(event.itemId, event.delta, event.channel, event.index);
      return;
    case "item.command.outputDelta":
      turn.onCommandOutputDelta(event.itemId, event.delta);
      return;
    case "turn.diff":
      turn.onTurnDiff(event.diff);
      return;
    case "error":
      turn.onError(event.error);
      return;
    default:
      return;
  }
}

/** Replays raw JSONL lines and renders every turn found. */
export async function replayRecording(
  lines: string[],
  options: ReplayOptions = {},
): Promise<ReplaySummary> {
  const generation = options.generation ?? 1;
  const cwd = options.cwd ?? "/replay/workspace";

  const state = {
    turns: new Map<string, TurnAccumulator>(),
    order: [] as string[],
    generation,
    renderState: undefined as TurnRenderState | undefined,
    maxCommandOutputChars: options.maxCommandOutputChars,
  };

  const unknownMethods: string[] = [];
  const unsupportedItemTypes: string[] = [];
  const serverRequestMethods: string[] = [];
  const counts = { notifications: 0, responses: 0, serverRequests: 0 };
  let invalidLines = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    // Recorder notices are metadata, not protocol.
    if (line.includes("__recorderNotice")) continue;

    const message = parseInboundLine(line);
    if (!message || message.kind === "invalid") {
      invalidLines += 1;
      continue;
    }
    if (message.kind === "response") {
      counts.responses += 1;
      continue;
    }
    if (message.kind === "server-request") {
      counts.serverRequests += 1;
      if (!serverRequestMethods.includes(message.method)) {
        serverRequestMethods.push(message.method);
      }
      continue;
    }

    counts.notifications += 1;
    const reduced = reduceNotification(message, generation);
    if (reduced.unknownMethod && !unknownMethods.includes(reduced.unknownMethod)) {
      unknownMethods.push(reduced.unknownMethod);
    }
    if (
      reduced.unsupportedItemType
      && !unsupportedItemTypes.includes(reduced.unsupportedItemType)
    ) {
      unsupportedItemTypes.push(reduced.unsupportedItemType);
    }
    for (const event of reduced.events) applyEvent(event, state);
  }

  const turns: ReplayedTurn[] = [];
  for (const turnId of state.order) {
    const turn = state.turns.get(turnId);
    if (!turn) continue;
    // Carried forward exactly as the runtime does, so a second edit to the same
    // file diffs against the previous turn rather than against git HEAD.
    state.renderState = beginTurnRenderState(state.renderState);
    const rendered = await renderTurn(turn, {
      threadId: turn.threadId || null,
      cwd,
      state: state.renderState,
      loadSubagentParts: options.loadSubagentParts ?? NO_SUBAGENT_PARTS,
    });
    turns.push({
      threadId: turn.threadId || null,
      turnId: turn.turnId,
      phase: turn.phase,
      content: rendered.content,
      parts: rendered.parts,
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.finalDiff ? { finalDiff: turn.finalDiff } : {}),
    });
  }

  return {
    turns,
    unknownMethods,
    unsupportedItemTypes,
    invalidLines,
    counts,
    serverRequestMethods,
  };
}

/**
 * Compact, snapshot-friendly shape.
 *
 * Deliberately lossy: raw diff bodies and command output are replaced by lengths.
 * A snapshot should fail when the *structure* changes, not when a recorded file's
 * contents shift by a line — and it must not become a second copy of the fixture's
 * payloads in the repo.
 */
export function summarizeForSnapshot(summary: ReplaySummary): unknown {
  return {
    counts: summary.counts,
    invalidLines: summary.invalidLines,
    unknownMethods: [...summary.unknownMethods].sort(),
    unsupportedItemTypes: [...summary.unsupportedItemTypes].sort(),
    serverRequestMethods: [...summary.serverRequestMethods].sort(),
    turns: summary.turns.map((turn) => ({
      phase: turn.phase,
      contentLength: turn.content.length,
      ...(turn.error ? { errorCode: turn.error.code ?? "none" } : {}),
      ...(turn.finalDiff ? { finalDiffLength: turn.finalDiff.length } : {}),
      parts: turn.parts.map((part) => ({
        type: part.type,
        ...(part.toolName ? { toolName: part.toolName } : {}),
        ...(part.toolState ? { toolState: part.toolState } : {}),
        ...(part.subagentName ? { subagentName: part.subagentName } : {}),
        contentLength: typeof part.content === "string" ? part.content.length : 0,
      })),
    })),
  };
}
